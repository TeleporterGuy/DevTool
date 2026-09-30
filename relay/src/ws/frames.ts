import { Buffer } from 'node:buffer'

/**
 * RFC 6455 framing, server side: parses masked client frames incrementally and encodes
 * unmasked server frames. No extensions (permessage-deflate is never negotiated), so
 * the RSV bits must always be zero.
 */

export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa
} as const

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode]

/** Close codes RFC 6455 §7.4.1 defines and that the relay sends itself. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  NoStatus: 1005,
  Abnormal: 1006,
  InvalidPayload: 1007,
  PolicyViolation: 1008,
  TooBig: 1009,
  InternalError: 1011
} as const

/** A code a peer may legitimately put in a close frame (RFC 6455 §7.4). */
export function isValidCloseCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014)
}

export interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** Thrown by the parser; `code` is the close code to fail the connection with. */
export class WebSocketProtocolError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'WebSocketProtocolError'
    this.code = code
  }
}

/**
 * Incremental frame parser. `push` takes whatever bytes the socket delivered and
 * returns every complete frame in them; a partial frame waits for the next push.
 *
 * `maxPayload` is enforced from the header alone, before any payload is buffered, so a
 * client announcing a huge frame costs us nothing but the header.
 */
export class FrameParser {
  readonly #maxPayload: number
  #chunks: Buffer[] = []
  #buffered = 0

  constructor(maxPayload: number) {
    this.#maxPayload = maxPayload
  }

  push(chunk: Buffer): Frame[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
    const frames: Frame[] = []
    for (;;) {
      const frame = this.#next()
      if (!frame) return frames
      frames.push(frame)
    }
  }

  #peek(length: number): Buffer {
    if (this.#chunks[0].length >= length) return this.#chunks[0]
    const joined = Buffer.concat(this.#chunks)
    this.#chunks = [joined]
    return joined
  }

  #consume(length: number): Buffer {
    const head = this.#peek(length)
    const out = head.subarray(0, length)
    const rest = head.subarray(length)
    this.#chunks[0] = rest
    if (rest.length === 0) this.#chunks.shift()
    this.#buffered -= length
    return out
  }

  #next(): Frame | null {
    if (this.#buffered < 2) return null
    const head = this.#peek(Math.min(this.#buffered, 14))
    const b0 = head[0]
    const b1 = head[1]
    const fin = (b0 & 0x80) !== 0
    if ((b0 & 0x70) !== 0) throw new WebSocketProtocolError(CloseCode.ProtocolError, 'RSV bits set without an extension')
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    if (!masked) throw new WebSocketProtocolError(CloseCode.ProtocolError, 'client frames must be masked')
    const isControl = opcode >= 0x8
    if (opcode !== Opcode.Continuation && opcode !== Opcode.Text && opcode !== Opcode.Binary && !isControl) {
      throw new WebSocketProtocolError(CloseCode.ProtocolError, `unknown opcode ${opcode}`)
    }
    if (isControl && opcode !== Opcode.Close && opcode !== Opcode.Ping && opcode !== Opcode.Pong) {
      throw new WebSocketProtocolError(CloseCode.ProtocolError, `unknown opcode ${opcode}`)
    }
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (head.length < 4) return null
      length = head.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (head.length < 10) return null
      const high = head.readUInt32BE(2)
      const low = head.readUInt32BE(6)
      // Anything past 2^53 is certainly over the limit; keep the arithmetic exact below it.
      length = high >= 0x200000 ? Number.MAX_SAFE_INTEGER : high * 0x100000000 + low
      offset = 10
    }
    if (isControl) {
      if (!fin) throw new WebSocketProtocolError(CloseCode.ProtocolError, 'control frames must not be fragmented')
      if (length > 125) throw new WebSocketProtocolError(CloseCode.ProtocolError, 'control frame payload over 125 bytes')
    } else if (length > this.#maxPayload) {
      throw new WebSocketProtocolError(CloseCode.TooBig, 'frame exceeds the maximum payload')
    }
    if (head.length < offset + 4) return null
    const total = offset + 4 + length
    if (this.#buffered < total) return null
    const frameBytes = this.#consume(total)
    const mask = frameBytes.subarray(offset, offset + 4)
    const payload = Buffer.from(frameBytes.subarray(offset + 4))
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    return { fin, opcode, payload }
  }
}

/** Encodes one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, payload])
}

/** Payload of a close frame: the 2-byte code and an optional UTF-8 reason (≤ 123 bytes). */
export function encodeClosePayload(code: number, reason: string): Buffer {
  let reasonBytes = Buffer.from(reason, 'utf8')
  if (reasonBytes.length > 123) reasonBytes = reasonBytes.subarray(0, 123)
  const out = Buffer.alloc(2 + reasonBytes.length)
  out.writeUInt16BE(code, 0)
  reasonBytes.copy(out, 2)
  return out
}
