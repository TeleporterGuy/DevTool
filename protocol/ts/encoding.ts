import { Buffer } from 'node:buffer'
import { ProtocolError } from './errors.ts'

/**
 * Byte helpers shared by the whole protocol. Everything returns plain `Uint8Array`
 * (never a `Buffer`) so values compare equal in tests regardless of how they were
 * produced, and so nothing here leaks Node types into callers' signatures.
 */

const B64U_RE = /^[A-Za-z0-9_-]*$/
const HEX_RE = /^(?:[0-9a-f]{2})*$/

/** View a Buffer as a plain Uint8Array without copying. */
export function toBytes(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** base64url without padding — the only binary encoding used in protocol JSON. */
export function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
}

/**
 * Strict decode: Node's own decoder silently skips junk characters, which would let two
 * different strings name the same key. Padding is rejected because the spec forbids it
 * and Swift's decoder needs to agree with ours on what is valid.
 */
export function b64uDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || !B64U_RE.test(text) || text.length % 4 === 1) {
    throw new ProtocolError('invalid base64url')
  }
  const bytes = toBytes(Buffer.from(text, 'base64url'))
  // Non-canonical trailing bits (e.g. "AB" vs "AA") decode to the same bytes; refuse them.
  if (b64uEncode(bytes) !== text) throw new ProtocolError('non-canonical base64url')
  return bytes
}

/** Decode b64u and insist on an exact length (keys, secrets, nonces are all 32 bytes). */
export function b64uDecodeLength(text: string, length: number, what = 'value'): Uint8Array {
  const bytes = b64uDecode(text)
  if (bytes.length !== length) throw new ProtocolError(`${what} must be ${length} bytes`)
  return bytes
}

/** Lowercase hex; used by the test vectors and device IDs. */
export function hexEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

export function hexDecode(text: string): Uint8Array {
  const lower = text.toLowerCase()
  if (!HEX_RE.test(lower)) throw new ProtocolError('invalid hex')
  return toBytes(Buffer.from(lower, 'hex'))
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Fatal decoding: a peer sending invalid UTF-8 is malformed, not something to paper over. */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (err) {
    throw new ProtocolError('invalid UTF-8', { cause: err })
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
