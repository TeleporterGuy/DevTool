import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { RELAY_PATH } from '../../protocol/ts/index.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import { createRelay } from './relay.ts'
import type { Clock, Relay, RelayLimits } from './relay.ts'
import type { RelayStore } from './store.ts'
import { upgradeToWebSocket } from './ws/connection.ts'

/**
 * Binds the relay core to `node:http` and our own RFC 6455 implementation.
 * `GET /healthz` answers 200 "ok"; the WebSocket lives at `/v1`; everything else is 404.
 */

export interface RelayServerOptions {
  store: RelayStore
  /** 0 picks a free port (tests). */
  port?: number
  host?: string
  limits?: Partial<RelayLimits>
  clock?: Clock
  logger?: Logger
  /** Take the client IP from `X-Forwarded-For` (set only behind a trusted reverse proxy). */
  trustProxy?: boolean
}

export interface RelayServer {
  readonly relay: Relay
  readonly http: Server
  readonly port: number
  /** `ws://host:port`, without the `/v1` path. */
  readonly url: string
  close(): Promise<void>
}

/**
 * The client address. Behind a proxy we take the **last** `X-Forwarded-For` entry: it is
 * the one our own proxy appended, while anything to its left came from the client and
 * can be forged.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    const value = Array.isArray(header) ? header.join(',') : header
    const last = value?.split(',').map((s) => s.trim()).filter(Boolean).at(-1)
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://relay').pathname
  } catch {
    return ''
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`)
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const log = options.logger ?? silentLogger
  const trustProxy = options.trustProxy ?? false
  const relay = createRelay({ store: options.store, limits: options.limits, clock: options.clock, logger: log })
  const sockets = new Set<Socket>()

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req)
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      res.end('ok')
      return
    }
    if (path === RELAY_PATH) {
      res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', Connection: 'Upgrade' })
      res.end('websocket upgrade required')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  http.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  http.on('clientError', (_err, socket: Duplex) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    if (pathOf(req) !== RELAY_PATH) return rejectUpgrade(socket, 404, 'Not Found')
    const ip = clientIp(req, trustProxy)
    if (!relay.admit(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests')
    const ws = upgradeToWebSocket(req, socket, head, { maxPayload: relay.limits.maxFrameBytes })
    if (!ws) return
    const handle = relay.open(
      {
        send: (text) => ws.sendText(text),
        close: (code, reason) => ws.close(code, reason)
      },
      { ip }
    )
    ws.attach({
      message: (data, isBinary) => handle.message(data, isBinary),
      close: (code) => {
        log.debug('socket-closed', { ip, code })
        handle.closed()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const port = (http.address() as AddressInfo).port
  const host = options.host && options.host !== '0.0.0.0' && options.host !== '::' ? options.host : '127.0.0.1'

  let closing: Promise<void> | null = null
  return {
    relay,
    http,
    port,
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        relay.shutdown()
        http.close(() => resolve())
        // Give sockets a moment to finish their close handshake, then force them.
        const force = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, 1000)
        force.unref()
        http.once('close', () => clearTimeout(force))
      })
      return closing
    }
  }
}
