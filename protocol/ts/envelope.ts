import { ProtocolError } from './errors.ts'

/**
 * §4.1: the bytes inside a relay `frame.data` are `[kind:u8] || body`. The relay never
 * looks inside; this byte is how the two ends tell handshake from transport.
 */
export const FrameKind = {
  /** Noise handshake message 1, phone → desktop. */
  Handshake1: 0x01,
  /** Noise handshake message 2, desktop → phone. */
  Handshake2: 0x02,
  /** Noise transport message, either direction. */
  Transport: 0x03,
  /** "I have no session, handshake again"; empty body. */
  Reset: 0x04
} as const

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

export interface Envelope {
  kind: FrameKind
  body: Uint8Array
}

const KINDS: readonly number[] = Object.values(FrameKind)

export function encodeEnvelope(kind: FrameKind, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!KINDS.includes(kind)) throw new ProtocolError('unknown frame kind')
  if (kind === FrameKind.Reset && body.length > 0) throw new ProtocolError('reset frames have no body')
  const out = new Uint8Array(1 + body.length)
  out[0] = kind
  out.set(body, 1)
  return out
}

/**
 * Unknown kinds throw so the caller can answer with a reset. A reset that somehow carries
 * a body is still a reset: the body is dropped rather than failing the whole frame.
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length === 0) throw new ProtocolError('empty frame')
  const kind = bytes[0]
  if (!KINDS.includes(kind)) throw new ProtocolError('unknown frame kind')
  const body = kind === FrameKind.Reset ? new Uint8Array(0) : bytes.slice(1)
  return { kind: kind as FrameKind, body }
}
