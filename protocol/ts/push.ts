import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { b64uDecode, b64uEncode, concatBytes, hexDecode, toBytes, utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, ed25519Sign, ed25519Verify } from './keys.ts'

/**
 * Push (SPEC.md §7): gateway registration, the sealed push capability, the payload a
 * desktop encrypts for a phone, and the `push.*` op params. Everything that crosses a
 * wire is here so the relay, the desktop and the Swift tests agree on bytes.
 */

export const PUSH_REGISTER_CONTEXT = 'devtool-push-register-v1'
export const PUSH_CAP_AAD = 'devtool-pushcap-v1'
export const PUSH_CAP_VERSION = 0x01
export const PUSH_REGISTER_PATH = '/v1/push/register'
export const PUSH_SEND_PATH = '/v1/push/send'
export const DEFAULT_PUSH_GATEWAY = 'https://relay.devtool.awantech.sk'

export const PushLimits = {
  /** Registration `ts` must be this close to the gateway's clock. */
  registerSkewSeconds: 300,
  tokenMinBytes: 32,
  tokenMaxBytes: 100,
  capChars: 1024,
  dataChars: 3072,
  title: 120,
  body: 400,
  keyIdBytes: 8,
  /** Per device: 60 an hour with a burst of 20 (§7.3). */
  perDevicePerHour: 60,
  perDeviceBurst: 20,
  /** Registrations per IP per hour. */
  registerPerIpPerHour: 30,
  /** A non-gateway relay gives the upstream gateway this long. */
  upstreamTimeoutMs: 10_000
} as const

export type PushEnv = 'production' | 'sandbox'
export const PUSH_ENVS: readonly PushEnv[] = ['production', 'sandbox']

/** What a phone can ask for in `push.register`. Plans ride on `question`. */
export type PushKind = 'permission' | 'question' | 'done'
export const PUSH_KINDS: readonly PushKind[] = ['permission', 'question', 'done']

/** What a payload can be about. */
export type PushPayloadKind = 'permission' | 'question' | 'plan' | 'done'
export const PUSH_PAYLOAD_KINDS: readonly PushPayloadKind[] = ['permission', 'question', 'plan', 'done']

export type PushResult = 'ok' | 'gone' | 'rate' | 'unavailable' | 'bad-request' | 'error'
export const PUSH_RESULTS: readonly PushResult[] = ['ok', 'gone', 'rate', 'unavailable', 'bad-request', 'error']

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function asObject(value: unknown, what: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`)
  return value as Obj
}

function str(o: Obj, key: string): string {
  const value = o[key]
  if (typeof value !== 'string') fail(`${key} must be a string`)
  return value
}

function int(o: Obj, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative integer`)
  return value
}

function b64uBytes(o: Obj, key: string, length: number): Uint8Array {
  const value = str(o, key)
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(value)
  } catch {
    fail(`${key} must be base64url`)
  }
  if (bytes.length !== length) fail(`${key} must be ${length} bytes`)
  return bytes
}

function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  return concatBytes(toBytes(cipher.update(plaintext)), toBytes(cipher.final()), toBytes(cipher.getAuthTag()))
}

/** Null when it doesn't authenticate. */
function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null {
  if (sealed.length < 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    decipher.setAAD(aad)
    decipher.setAuthTag(sealed.subarray(sealed.length - 16))
    return concatBytes(toBytes(decipher.update(sealed.subarray(0, sealed.length - 16))), toBytes(decipher.final()))
  } catch {
    return null
  }
}

function nonceOr(nonce: Uint8Array | undefined): Uint8Array {
  if (nonce === undefined) return toBytes(randomBytes(12))
  if (nonce.length !== 12) throw new ProtocolError('nonce must be 12 bytes')
  return nonce
}

// ---- §7.1 Registration -----------------------------------------------------------

export interface PushRegisterRequest {
  pub: string
  token: string
  env: PushEnv
  ts: number
  sig: string
}

export function pushRegisterMessage(token: string, env: PushEnv, ts: number): Uint8Array {
  return utf8Encode(`${PUSH_REGISTER_CONTEXT}\n${token}\n${env}\n${ts}`)
}

/** The phone's side: a signed registration body for `POST /v1/push/register`. */
export function signPushRegister(seed: Uint8Array, pub: Uint8Array, token: string, env: PushEnv, ts: number): PushRegisterRequest {
  return { pub: b64uEncode(pub), token, env, ts, sig: b64uEncode(ed25519Sign(seed, pushRegisterMessage(token, env, ts))) }
}

/** Throws ProtocolError (→ 400) on a malformed body. Unknown fields are dropped. */
export function parsePushRegisterRequest(value: unknown): PushRegisterRequest {
  const o = asObject(value, 'body')
  b64uBytes(o, 'pub', 32)
  b64uBytes(o, 'sig', 64)
  const token = str(o, 'token')
  if (!/^(?:[0-9a-f]{2})+$/.test(token)) fail('token must be lowercase hex')
  const bytes = token.length / 2
  if (bytes < PushLimits.tokenMinBytes || bytes > PushLimits.tokenMaxBytes) fail('token has the wrong length')
  const env = str(o, 'env')
  if (!PUSH_ENVS.includes(env as PushEnv)) fail('env has an unknown value')
  return { pub: str(o, 'pub'), token, env: env as PushEnv, ts: int(o, 'ts'), sig: str(o, 'sig') }
}

/** The gateway's side: the device ID the registration is for, or null (→ 401). */
export function verifyPushRegister(request: PushRegisterRequest, nowSeconds: number): string | null {
  if (Math.abs(nowSeconds - request.ts) > PushLimits.registerSkewSeconds) return null
  const pub = b64uDecode(request.pub)
  if (!ed25519Verify(pub, pushRegisterMessage(request.token, request.env, request.ts), b64uDecode(request.sig))) return null
  return deviceId(pub)
}

// ---- §7.1 Capability ---------------------------------------------------------------

export interface PushCapPayload {
  /** Device ID. */
  d: string
  /** Generation at registration. */
  g: number
  /** APNs token, hex. */
  t: string
  e: PushEnv
}

export function sealPushCap(sealKey: Uint8Array, payload: PushCapPayload, nonce?: Uint8Array): string {
  const n = nonceOr(nonce)
  const body = utf8Encode(JSON.stringify({ d: payload.d, g: payload.g, t: payload.t, e: payload.e }))
  return b64uEncode(concatBytes(new Uint8Array([PUSH_CAP_VERSION]), n, aesGcmSeal(sealKey, n, body, utf8Encode(PUSH_CAP_AAD))))
}

/** Null for anything that isn't a cap this key sealed. */
export function openPushCap(sealKey: Uint8Array, cap: string): PushCapPayload | null {
  if (cap.length === 0 || cap.length > PushLimits.capChars) return null
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(cap)
  } catch {
    return null
  }
  if (bytes.length < 1 + 12 + 16 || bytes[0] !== PUSH_CAP_VERSION) return null
  const plain = aesGcmOpen(sealKey, bytes.subarray(1, 13), bytes.subarray(13), utf8Encode(PUSH_CAP_AAD))
  if (!plain) return null
  try {
    const o = asObject(JSON.parse(utf8Decode(plain)), 'cap')
    const e = str(o, 'e')
    if (!PUSH_ENVS.includes(e as PushEnv)) return null
    return { d: str(o, 'd'), g: int(o, 'g'), t: str(o, 't'), e: e as PushEnv }
  } catch {
    return null
  }
}

// ---- §7.4 Ops ----------------------------------------------------------------------

export const PushOp = {
  Register: 'push.register',
  Unregister: 'push.unregister'
} as const

export type PushOpName = typeof PushOp[keyof typeof PushOp]
export const PUSH_OPS: readonly string[] = [PushOp.Register, PushOp.Unregister]

export interface PushRegisterParams {
  cap: string
  /** b64u, 32 bytes. */
  key: string
  /** b64u, 8 bytes. */
  keyId: string
  kinds: PushKind[]
}

export type PushParams = PushRegisterParams | Record<string, never>

/** Null when `op` isn't a push op; throws ProtocolError (→ `bad-request`) on bad params. */
export function parsePushParams(op: string, params: unknown): PushParams | null {
  if (!PUSH_OPS.includes(op)) return null
  if (op === PushOp.Unregister) return {}
  const o = asObject(params, 'params')
  const cap = str(o, 'cap')
  if (cap.length === 0 || cap.length > PushLimits.capChars) fail('cap has the wrong length')
  b64uBytes(o, 'key', 32)
  b64uBytes(o, 'keyId', PushLimits.keyIdBytes)
  if (!Array.isArray(o.kinds)) fail('kinds must be an array')
  const kinds = PUSH_KINDS.filter((kind) => (o.kinds as unknown[]).includes(kind))
  return { cap, key: str(o, 'key'), keyId: str(o, 'keyId'), kinds }
}

// ---- §7.5 Payload ------------------------------------------------------------------

export interface PushPayload {
  v: 1
  kind: PushPayloadKind
  desktop: string
  tab: string
  prompt?: string
  title: string
  body: string
  at: number
}

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

function payloadJson(payload: PushPayload): Uint8Array {
  const out: Obj = { v: 1, kind: payload.kind, desktop: payload.desktop, tab: payload.tab }
  if (payload.prompt !== undefined) out.prompt = payload.prompt
  out.title = payload.title
  out.body = payload.body
  out.at = payload.at
  return utf8Encode(JSON.stringify(out))
}

/** 8-byte key ID, 12-byte nonce, AES-GCM sealed JSON with the key ID as AAD. */
export function sealPushPayloadBytes(key: Uint8Array, keyId: Uint8Array, plaintext: Uint8Array, nonce?: Uint8Array): string {
  if (keyId.length !== PushLimits.keyIdBytes) throw new ProtocolError('keyId must be 8 bytes')
  const n = nonceOr(nonce)
  return b64uEncode(concatBytes(keyId, n, aesGcmSeal(key, n, plaintext, keyId)))
}

/**
 * The desktop's side. Cuts `title` and `body` to their limits, then shortens `body`
 * until the encoded data fits in 3072 characters.
 */
export function sealPushPayload(key: Uint8Array, keyId: Uint8Array, payload: PushPayload, nonce?: Uint8Array): string {
  let body = cut(payload.body, PushLimits.body)
  const title = cut(payload.title, PushLimits.title)
  for (;;) {
    const data = sealPushPayloadBytes(key, keyId, payloadJson({ ...payload, title, body }), nonce)
    if (data.length <= PushLimits.dataChars) return data
    const chars = [...body]
    if (chars.length <= 1) throw new ProtocolError('push payload does not fit')
    body = cut(body, Math.max(1, Math.floor(chars.length * 0.8)))
  }
}

/** The key ID a `data` string was sealed under, or null if it is malformed. */
export function pushPayloadKeyId(data: string): string | null {
  try {
    const bytes = b64uDecode(data)
    return bytes.length >= 8 + 12 + 16 ? b64uEncode(bytes.subarray(0, 8)) : null
  } catch {
    return null
  }
}

/** The phone's side (and tests): the payload, or null if it doesn't decrypt or parse. */
export function openPushPayload(key: Uint8Array, data: string): PushPayload | null {
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(data)
  } catch {
    return null
  }
  if (bytes.length < 8 + 12 + 16) return null
  const keyId = bytes.subarray(0, 8)
  const plain = aesGcmOpen(key, bytes.subarray(8, 20), bytes.subarray(20), keyId)
  if (!plain) return null
  try {
    return parsePushPayload(JSON.parse(utf8Decode(plain)))
  } catch {
    return null
  }
}

/** Throws ProtocolError. Unknown `kind` is kept as is; the phone shows it without actions. */
export function parsePushPayload(value: unknown): PushPayload {
  const o = asObject(value, 'payload')
  if (o.v !== 1) fail('v must be 1')
  const out: PushPayload = {
    v: 1,
    kind: str(o, 'kind') as PushPayloadKind,
    desktop: str(o, 'desktop'),
    tab: str(o, 'tab'),
    title: str(o, 'title'),
    body: str(o, 'body'),
    at: int(o, 'at')
  }
  if (o.prompt !== undefined && o.prompt !== null) out.prompt = str(o, 'prompt')
  return out
}

/** Hex APNs token check shared by the phone tooling and the gateway. */
export function isPushToken(token: string): boolean {
  try {
    const bytes = hexDecode(token)
    return token === token.toLowerCase() && bytes.length >= PushLimits.tokenMinBytes && bytes.length <= PushLimits.tokenMaxBytes
  } catch {
    return false
  }
}
