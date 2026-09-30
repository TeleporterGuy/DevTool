import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptKey, upgradeToWebSocket } from '../src/ws/connection.ts'
import type { WebSocketConnection } from '../src/ws/connection.ts'
import { FrameParser, Opcode, WebSocketProtocolError, encodeFrame } from '../src/ws/frames.ts'
import { sleep } from './helpers.ts'

/** Masked client frame, as a browser would send it. */
function clientFrame(opcode: number, payload: Uint8Array | string, options: { fin?: boolean; mask?: boolean; rsv?: number; length?: number } = {}): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  const fin = options.fin ?? true
  const mask = options.mask ?? true
  const length = options.length ?? body.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0, length])
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | ((options.rsv ?? 0) << 4) | opcode
  if (!mask) return Buffer.concat([header, body])
  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3]
  return Buffer.concat([header, key, masked])
}

interface ServerFrame {
  opcode: number
  payload: Buffer
}

/** Parses unmasked server frames. */
function parseServerFrames(data: Buffer): ServerFrame[] {
  const out: ServerFrame[] = []
  let i = 0
  while (i + 2 <= data.length) {
    let len = data[i + 1] & 0x7f
    let off = 2
    if (len === 126) {
      len = data.readUInt16BE(i + 2)
      off = 4
    } else if (len === 127) {
      len = Number(data.readBigUInt64BE(i + 2))
      off = 10
    }
    if (i + off + len > data.length) break
    out.push({ opcode: data[i] & 0x0f, payload: data.subarray(i + off, i + off + len) })
    i += off + len
  }
  return out
}

interface Echo {
  port: number
  events: string[]
  last: WebSocketConnection | null
  close(): Promise<void>
}

const echoes: Echo[] = []
afterEach(async () => {
  for (const e of echoes.splice(0)) await e.close()
})

/** An http server whose WebSocket echoes every message back, text as text and binary as binary. */
async function echoServer(maxPayload = 1024): Promise<Echo> {
  const sockets = new Set<Socket>()
  const echo: Echo = { port: 0, events: [], last: null, close: async () => {} }
  const http = createServer((_req, res) => res.end())
  http.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  http.on('upgrade', (req, socket, head) => {
    const ws = upgradeToWebSocket(req, socket, head, { maxPayload, closeTimeoutMs: 500 })
    if (!ws) return
    echo.last = ws
    ws.attach({
      message: (data, isBinary) => {
        echo.events.push(`${isBinary ? 'binary' : 'text'}:${data.length}`)
        if (isBinary) ws.sendBinary(data)
        else ws.sendText(data.toString('utf8'))
      },
      close: (code, reason) => echo.events.push(`close:${code}:${reason}`)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  echo.port = (http.address() as AddressInfo).port
  echo.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy()
      http.close(() => resolve())
    })
  echoes.push(echo)
  return echo
}

/** A raw TCP client that completes the opening handshake and collects server bytes. */
async function rawClient(port: number): Promise<{ socket: Socket; received: () => Buffer; ended: Promise<void> }> {
  const socket = netConnect(port, '127.0.0.1')
  let buf = Buffer.alloc(0)
  let upgraded = false
  const ended = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buf.subarray(0, end).toString('latin1')
        expect(head).toContain('101 Switching Protocols')
        expect(head).toContain(`Sec-WebSocket-Accept: ${acceptKey('dGhlIHNhbXBsZSBub25jZQ==')}`)
        buf = buf.subarray(end + 4)
        upgraded = true
        resolve()
      }
    })
    socket.write(
      'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
    )
  })
  return { socket, received: () => buf, ended }
}

describe('frame parser', () => {
  it('matches the RFC 6455 accept-key example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('parses frames split at every byte boundary, with all three length encodings', () => {
    const payloads = [Buffer.from('hi'), randomBytes(300), randomBytes(70_000)]
    const wire = Buffer.concat(payloads.map((p) => clientFrame(Opcode.Binary, p)))
    const parser = new FrameParser(100_000)
    const frames: Array<{ payload: Buffer }> = []
    for (let i = 0; i < wire.length; i += 997) frames.push(...parser.push(wire.subarray(i, i + 997)))
    expect(frames.map((f) => Buffer.compare(f.payload, payloads[frames.indexOf(f)]))).toEqual([0, 0, 0])
    const single = new FrameParser(10)
    const one = clientFrame(Opcode.Text, 'abc')
    const got: Array<{ payload: Buffer }> = []
    for (const byte of one) got.push(...single.push(Buffer.from([byte])))
    expect(got).toHaveLength(1)
    expect(got[0].payload.toString()).toBe('abc')
  })

  it('rejects oversize, unmasked, RSV, unknown-opcode and bad control frames', () => {
    const cases: Array<[Buffer, number]> = [
      [clientFrame(Opcode.Binary, new Uint8Array(0), { length: 2 ** 40 }).subarray(0, 10), 1009],
      [clientFrame(Opcode.Text, 'x', { mask: false }), 1002],
      [clientFrame(Opcode.Text, 'x', { rsv: 4 }), 1002],
      [clientFrame(0x3, 'x'), 1002],
      [clientFrame(0xb, 'x'), 1002],
      [clientFrame(Opcode.Ping, 'x', { fin: false }), 1002],
      [clientFrame(Opcode.Ping, randomBytes(126)), 1002]
    ]
    for (const [bytes, code] of cases) {
      let error: unknown
      try {
        new FrameParser(1024).push(bytes)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(WebSocketProtocolError)
      expect((error as WebSocketProtocolError).code).toBe(code)
    }
  })

  it('encodes server frames with the right length form', () => {
    for (const size of [0, 125, 126, 65535, 65536]) {
      const frame = parseServerFrames(encodeFrame(Opcode.Binary, new Uint8Array(size)))
      expect(frame[0].payload.length).toBe(size)
    }
  })
})

describe('websocket connection', () => {
  it('talks to Node\'s own WebSocket client: text, binary, and a clean close', async () => {
    const echo = await echoServer(200_000)
    const ws = new WebSocket(`ws://127.0.0.1:${echo.port}/`)
    ws.binaryType = 'arraybuffer'
    const received: Array<string | number> = []
    const done = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)))
    ws.addEventListener('message', (e) => {
      received.push(typeof e.data === 'string' ? e.data : (e.data as ArrayBuffer).byteLength)
      if (received.length === 3) ws.close(4000, 'bye')
    })
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    ws.send('héllo')
    ws.send(new Uint8Array(100_000))
    ws.send('x'.repeat(70_000))
    expect(await done).toBe(4000)
    expect(received).toEqual(['héllo', 100_000, 'x'.repeat(70_000)])
    await sleep(20)
    expect(echo.events.at(-1)).toBe('close:4000:bye')
  })

  it('reassembles fragmented messages and answers pings in between', async () => {
    const echo = await echoServer()
    const c = await rawClient(echo.port)
    c.socket.write(clientFrame(Opcode.Text, 'hel', { fin: false }))
    c.socket.write(clientFrame(Opcode.Ping, 'p'))
    c.socket.write(clientFrame(Opcode.Continuation, 'lo', { fin: false }))
    c.socket.write(clientFrame(Opcode.Continuation, '!'))
    await sleep(50)
    const frames = parseServerFrames(c.received())
    expect(frames.map((f) => [f.opcode, f.payload.toString()])).toEqual([
      [Opcode.Pong, 'p'],
      [Opcode.Text, 'hello!']
    ])
    c.socket.destroy()
  })

  it('fails the connection with 1009 when a fragmented message grows past the limit', async () => {
    const echo = await echoServer(10)
    const c = await rawClient(echo.port)
    c.socket.write(clientFrame(Opcode.Text, '123456', { fin: false }))
    c.socket.write(clientFrame(Opcode.Continuation, '789012'))
    await c.ended
    const frames = parseServerFrames(c.received())
    expect(frames.at(-1)?.opcode).toBe(Opcode.Close)
    expect(frames.at(-1)?.payload.readUInt16BE(0)).toBe(1009)
    await sleep(20)
    expect(echo.events).toEqual(['close:1009:message exceeds the maximum payload'])
  })

  it('fails with 1009 from the header alone, before the payload is sent', async () => {
    const echo = await echoServer(1024)
    const c = await rawClient(echo.port)
    c.socket.write(clientFrame(Opcode.Binary, new Uint8Array(0), { length: 10_000_000 }).subarray(0, 14))
    await c.ended
    expect(parseServerFrames(c.received()).at(-1)?.payload.readUInt16BE(0)).toBe(1009)
  })

  it('fails with 1002 on an unmasked frame and 1007 on invalid UTF-8', async () => {
    const echo = await echoServer()
    const a = await rawClient(echo.port)
    a.socket.write(clientFrame(Opcode.Text, 'x', { mask: false }))
    await a.ended
    expect(parseServerFrames(a.received()).at(-1)?.payload.readUInt16BE(0)).toBe(1002)
    const b = await rawClient(echo.port)
    b.socket.write(clientFrame(Opcode.Text, new Uint8Array([0xff, 0xfe])))
    await b.ended
    expect(parseServerFrames(b.received()).at(-1)?.payload.readUInt16BE(0)).toBe(1007)
    const c = await rawClient(echo.port)
    c.socket.write(clientFrame(Opcode.Continuation, 'x'))
    await c.ended
    expect(parseServerFrames(c.received()).at(-1)?.payload.readUInt16BE(0)).toBe(1002)
  })

  it('echoes a client close and ends the TCP connection', async () => {
    const echo = await echoServer()
    const c = await rawClient(echo.port)
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(1000)
    c.socket.write(clientFrame(Opcode.Close, payload))
    await c.ended
    const last = parseServerFrames(c.received()).at(-1)
    expect(last?.opcode).toBe(Opcode.Close)
    expect(last?.payload.readUInt16BE(0)).toBe(1000)
    await sleep(20)
    expect(echo.events).toEqual(['close:1000:'])
  })

  it('drops the socket if the peer never answers a server close', async () => {
    const echo = await echoServer()
    const c = await rawClient(echo.port)
    await sleep(20)
    echo.last!.close(4001, 'go')
    await c.ended
    expect(parseServerFrames(c.received()).at(-1)?.payload.readUInt16BE(0)).toBe(4001)
    await sleep(20)
    expect(echo.events).toEqual(['close:1006:'])
  })

  it('rejects non-WebSocket and wrong-version upgrades', async () => {
    const echo = await echoServer()
    const status = (request: string): Promise<string> =>
      new Promise((resolve) => {
        const s = netConnect(echo.port, '127.0.0.1', () => s.write(request))
        s.on('data', (d) => {
          resolve(d.toString('latin1').split('\r\n')[0])
          s.destroy()
        })
      })
    const base = 'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    expect(await status(base + 'Sec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')).toBe('HTTP/1.1 426 Upgrade Required')
    expect(await status(base + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: short\r\n\r\n')).toBe('HTTP/1.1 400 Bad Request')
  })
})
