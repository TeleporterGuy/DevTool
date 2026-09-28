import { b64uDecode, b64uEncode, utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, isDeviceId } from './keys.ts'

/**
 * The QR payload (§2). Field names stay as short as they are on the wire, because the
 * QR code has to stay scannable and Swift decodes the same JSON.
 */

export const PAIRING_URI_PREFIX = 'devtool://pair?d='
export const PAIRING_VERSION = 1
/** How long a pairing offer lives, in seconds. */
export const PAIRING_TTL_SECONDS = 300

export interface PairingPayload {
  v: 1
  /** Relay base URL (ws:// or wss://), without the `/v1` path. */
  relay: string
  /** Desktop device ID; must equal deviceId(e). */
  id: string
  /** b64u desktop X25519 public key. */
  x: string
  /** b64u desktop Ed25519 public key. */
  e: string
  /** b64u 32-byte one-time secret. */
  s: string
  /** Desktop display name. */
  n: string
  /** Expiry, unix seconds. */
  exp: number
}

function fail(message: string): never {
  throw new ProtocolError(message)
}

function key32(o: Record<string, unknown>, field: string): string {
  const value = o[field]
  if (typeof value !== 'string') fail(`${field} must be a string`)
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(value)
  } catch {
    fail(`${field} must be base64url`)
  }
  if (bytes.length !== 32) fail(`${field} must be 32 bytes`)
  return value
}

/**
 * Validates everything that can be checked offline, including that `id` really is the
 * device ID of `e` — otherwise a tampered QR could pair you with keys the relay would
 * route to a different desktop. Expiry is left to `isPairingExpired` so callers can
 * say "this code has expired" instead of "invalid code".
 */
export function validatePairingPayload(value: unknown): PairingPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('pairing payload must be an object')
  const o = value as Record<string, unknown>
  if (o.v !== PAIRING_VERSION) fail('unsupported pairing version')
  if (typeof o.relay !== 'string') fail('relay must be a string')
  let relayUrl: URL
  try {
    relayUrl = new URL(o.relay)
  } catch {
    fail('relay must be a URL')
  }
  if (relayUrl.protocol !== 'ws:' && relayUrl.protocol !== 'wss:') fail('relay must be a ws:// or wss:// URL')
  if (!isDeviceId(o.id)) fail('id must be a device ID')
  const x = key32(o, 'x')
  const e = key32(o, 'e')
  const s = key32(o, 's')
  if (deviceId(b64uDecode(e)) !== o.id) fail('id does not match the Ed25519 key')
  if (typeof o.n !== 'string') fail('n must be a string')
  if (typeof o.exp !== 'number' || !Number.isSafeInteger(o.exp) || o.exp < 0) fail('exp must be unix seconds')
  // Fixed key order keeps the encoded URI deterministic (the vectors depend on it).
  return { v: 1, relay: o.relay, id: o.id, x, e, s, n: o.n, exp: o.exp }
}

export function encodePairingUri(payload: PairingPayload): string {
  const valid = validatePairingPayload(payload)
  return PAIRING_URI_PREFIX + b64uEncode(utf8Encode(JSON.stringify(valid)))
}

/** Unknown extra JSON fields are dropped; unknown query parameters are ignored. */
export function decodePairingUri(uri: string): PairingPayload {
  let url: URL
  try {
    url = new URL(uri.trim())
  } catch {
    fail('not a pairing link')
  }
  if (url.protocol !== 'devtool:' || url.hostname !== 'pair') fail('not a pairing link')
  const d = url.searchParams.get('d')
  if (!d) fail('pairing link has no payload')
  let json: unknown
  try {
    json = JSON.parse(utf8Decode(b64uDecode(d)))
  } catch (err) {
    throw new ProtocolError('pairing payload is not valid', { cause: err })
  }
  return validatePairingPayload(json)
}

export function isPairingExpired(payload: Pick<PairingPayload, 'exp'>, nowMs: number = Date.now()): boolean {
  return nowMs >= payload.exp * 1000
}
