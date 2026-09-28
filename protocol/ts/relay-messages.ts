import { b64uDecode, b64uEncode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, ed25519Sign, ed25519Verify, isDeviceId } from './keys.ts'

/**
 * Relay protocol v1 (SPEC.md §3): one JSON object per WebSocket text frame,
 * discriminated by `t`. The parsers return fresh objects holding only the fields the
 * spec defines, so unknown fields from a newer peer are dropped rather than passed on.
 */

export const RELAY_PATH = '/v1'
export const RELAY_MAX_FRAME_BYTES = 256 * 1024
export const RELAY_HELLO_TIMEOUT_MS = 10_000
export const RELAY_PING_INTERVAL_MS = 25_000
export const RELAY_IDLE_TIMEOUT_MS = 60_000
export const RELAY_RATE_PER_SECOND = 50
export const RELAY_RATE_BURST = 200
export const RELAY_CONNECTIONS_PER_IP_PER_MINUTE = 20

/** WebSocket close codes the relay uses (§3.1, §3.5, §3.7). */
export const RelayCloseCode = {
  /** Idle timeout, or the server is shutting down. */
  GoingAway: 1001,
  TooBig: 1009,
  Auth: 4401,
  /** A pending phone's pairing window lapsed and it has no other desktop. */
  PairingExpired: 4403,
  HelloTimeout: 4408,
  Replaced: 4409,
  Rate: 4429
} as const

export type Role = 'desktop' | 'phone'
export type PeerState = 'online' | 'offline' | 'revoked'
export type RelayErrorCode = 'auth' | 'offline' | 'forbidden' | 'rate' | 'bad-request'
/**
 * An error `code` as received. Clients keep codes a newer relay may add and treat them
 * as a generic error, so compare against the `RelayErrorCode` values you handle.
 */
export type RelayErrorCodeValue = RelayErrorCode | (string & {})

export interface ChallengeMessage { t: 'challenge'; nonce: string }
export interface HelloMessage {
  t: 'hello'
  role: Role
  pub: string
  sig: string
  pair?: { to: string; token: string }
}
export interface ReadyMessage { t: 'ready'; id: string }
export interface OfferMessage { t: 'offer'; tokenHash: string; exp: number }
export interface AuthorizeMessage { t: 'authorize'; phone: string; pub: string }
export interface RevokeMessage { t: 'revoke'; phone: string }
export interface WatchMessage { t: 'watch'; desktops: string[] }
/** Client → server: route `data` to `to`. */
export interface FrameOutMessage { t: 'frame'; to: string; data: string }
/** Server → client: `data` arrived from `from`. */
export interface FrameInMessage { t: 'frame'; from: string; data: string }
export interface PeerMessage { t: 'peer'; id: string; state: PeerState; lastSeen?: number }
export interface PingMessage { t: 'ping' }
export interface PongMessage { t: 'pong' }
export interface ErrorMessage { t: 'error'; code: RelayErrorCodeValue; message?: string; to?: string }

/** Everything a client may send to the relay. */
export type ClientMessage =
  | HelloMessage
  | OfferMessage
  | AuthorizeMessage
  | RevokeMessage
  | WatchMessage
  | FrameOutMessage
  | PingMessage
  | PongMessage

/** Everything the relay may send to a client. */
export type ServerMessage =
  | ChallengeMessage
  | ReadyMessage
  | FrameInMessage
  | PeerMessage
  | ErrorMessage
  | PingMessage
  | PongMessage

export type RelayMessage = ClientMessage | ServerMessage

const ROLES: readonly string[] = ['desktop', 'phone']
const PEER_STATES: readonly string[] = ['online', 'offline', 'revoked']

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function str(o: Obj, key: string): string {
  const value = o[key]
  if (typeof value !== 'string') fail(`${key} must be a string`)
  return value
}

function optStr(o: Obj, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key)
}

/** Unix seconds/ms: a non-negative safe integer. */
function int(o: Obj, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative integer`)
  return value
}

function id(o: Obj, key: string): string {
  const value = str(o, key)
  if (!isDeviceId(value)) fail(`${key} must be a device ID`)
  return value
}

/** b64u of exactly `length` bytes, or of any non-empty length when omitted. */
function b64u(o: Obj, key: string, length?: number): string {
  const value = str(o, key)
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(value)
  } catch {
    fail(`${key} must be base64url`)
  }
  if (length !== undefined ? bytes.length !== length : bytes.length === 0) {
    fail(length !== undefined ? `${key} must be ${length} bytes` : `${key} must not be empty`)
  }
  return value
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly string[]): T {
  const value = str(o, key)
  if (!allowed.includes(value)) fail(`${key} has an unknown value`)
  return value as T
}

function asObject(value: unknown): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('message must be a JSON object')
  return value as Obj
}

function parseJsonObject(text: string): Obj {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ProtocolError('message is not JSON', { cause: err })
  }
  return asObject(value)
}

function parseClientObject(o: Obj): ClientMessage {
  switch (o.t) {
    case 'hello': {
      const msg: HelloMessage = { t: 'hello', role: oneOf<Role>(o, 'role', ROLES), pub: b64u(o, 'pub', 32), sig: b64u(o, 'sig', 64) }
      if (o.pair !== undefined) {
        const pair = asObject(o.pair)
        msg.pair = { to: id(pair, 'to'), token: b64u(pair, 'token', 32) }
      }
      return msg
    }
    case 'offer':
      return { t: 'offer', tokenHash: b64u(o, 'tokenHash', 32), exp: int(o, 'exp') }
    case 'authorize':
      return { t: 'authorize', phone: id(o, 'phone'), pub: b64u(o, 'pub', 32) }
    case 'revoke':
      return { t: 'revoke', phone: id(o, 'phone') }
    case 'watch': {
      if (!Array.isArray(o.desktops)) fail('desktops must be an array')
      const desktops = o.desktops.map((d) => {
        if (!isDeviceId(d)) fail('desktops must hold device IDs')
        return d
      })
      return { t: 'watch', desktops }
    }
    case 'frame':
      if (o.from !== undefined) fail('client frames carry `to`, not `from`')
      return { t: 'frame', to: id(o, 'to'), data: b64u(o, 'data') }
    case 'ping':
      return { t: 'ping' }
    case 'pong':
      return { t: 'pong' }
    default:
      return fail('unknown client message type')
  }
}

function parseServerObject(o: Obj): ServerMessage | null {
  switch (o.t) {
    case 'challenge':
      return { t: 'challenge', nonce: b64u(o, 'nonce', 32) }
    case 'ready':
      return { t: 'ready', id: id(o, 'id') }
    case 'frame':
      if (o.to !== undefined) fail('server frames carry `from`, not `to`')
      return { t: 'frame', from: id(o, 'from'), data: b64u(o, 'data') }
    case 'peer': {
      const peerId = id(o, 'id')
      // A state a newer relay added: ignore the message rather than guess what it means.
      if (!PEER_STATES.includes(str(o, 'state'))) return null
      const msg: PeerMessage = { t: 'peer', id: peerId, state: oneOf<PeerState>(o, 'state', PEER_STATES) }
      if (o.lastSeen !== undefined) msg.lastSeen = int(o, 'lastSeen')
      return msg
    }
    case 'error': {
      const code = str(o, 'code')
      if (code === '') fail('code must not be empty')
      const msg: ErrorMessage = { t: 'error', code }
      const message = optStr(o, 'message')
      if (message !== undefined) msg.message = message
      if (o.to !== undefined) msg.to = id(o, 'to')
      return msg
    }
    case 'ping':
      return { t: 'ping' }
    case 'pong':
      return { t: 'pong' }
    default:
      return fail('unknown server message type')
  }
}

/** What the relay uses on every incoming text frame. Throws ProtocolError (→ `bad-request`). */
export function parseClientMessage(text: string): ClientMessage {
  return parseClientObject(parseJsonObject(text))
}

/**
 * What desktops and phones use on every frame from the relay. Returns null for a
 * message to ignore: a `peer` with a state this version doesn't know (forward
 * compatibility). An unknown error `code` is kept as a string.
 */
export function parseServerMessage(text: string): ServerMessage | null {
  return parseServerObject(parseJsonObject(text))
}

/**
 * Direction-agnostic parse, for tools that log both sides. `frame` is told apart by
 * whether it carries `to` (client → server) or `from` (server → client).
 */
export function parseRelayMessage(text: string): RelayMessage | null {
  const o = parseJsonObject(text)
  switch (o.t) {
    case 'challenge':
    case 'ready':
    case 'peer':
    case 'error':
      return parseServerObject(o)
    case 'frame':
      return o.from !== undefined ? parseServerObject(o) : parseClientObject(o)
    default:
      return parseClientObject(o)
  }
}

export function encodeRelayMessage(message: RelayMessage): string {
  return JSON.stringify(message)
}

const AUTH_CONTEXT = 'devtool-relay-v1'

/**
 * §3.1: the exact bytes signed in `hello`. `nonce` is the b64u string as received, not
 * its decoded bytes, so neither side has to agree on a decoding before verifying.
 */
export function relayAuthPayload(role: Role, nonce: string): Uint8Array {
  return utf8Encode(`${AUTH_CONTEXT}\n${role}\n${nonce}`)
}

export interface HelloInput {
  role: Role
  nonce: string
  ed25519Priv: Uint8Array
  ed25519Pub: Uint8Array
  pair?: { to: string; token: Uint8Array }
}

/** Builds a signed `hello` for the challenge `nonce`. */
export function buildHello(input: HelloInput): HelloMessage {
  const msg: HelloMessage = {
    t: 'hello',
    role: input.role,
    pub: b64uEncode(input.ed25519Pub),
    sig: b64uEncode(ed25519Sign(input.ed25519Priv, relayAuthPayload(input.role, input.nonce)))
  }
  if (input.pair) msg.pair = { to: input.pair.to, token: b64uEncode(input.pair.token) }
  return msg
}

/**
 * Relay side of §3.1: checks the signature against the nonce we issued and returns the
 * device ID to answer `ready` with, or null if the hello is not authentic.
 */
export function verifyHello(hello: HelloMessage, nonce: string): string | null {
  const pub = b64uDecode(hello.pub)
  const ok = ed25519Verify(pub, relayAuthPayload(hello.role, nonce), b64uDecode(hello.sig))
  return ok ? deviceId(pub) : null
}
