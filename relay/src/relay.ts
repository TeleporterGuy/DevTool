import { randomBytes } from 'node:crypto'
import {
  ProtocolError,
  RELAY_CONNECTIONS_PER_IP_PER_MINUTE,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_RATE_BURST,
  RELAY_RATE_PER_SECOND,
  RelayCloseCode,
  b64uDecode,
  b64uEncode,
  constantTimeEqual,
  deviceId,
  encodeRelayMessage,
  parseClientMessage,
  sha256,
  verifyHello
} from '../../protocol/ts/index.ts'
import type {
  AuthorizeMessage,
  ClientMessage,
  FrameOutMessage,
  HelloMessage,
  OfferMessage,
  PeerState,
  RelayErrorCode,
  RevokeMessage,
  Role,
  ServerMessage,
  WatchMessage
} from '../../protocol/ts/index.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import { IpLimiter, TokenBucket } from './rate.ts'
import type { RelayStore } from './store.ts'

/**
 * The relay core (§3), independent of any socket library: `server.ts` feeds it bytes
 * and close events, and it answers through the `Connection` it was given. All routing
 * state except the pairs table lives here, in memory.
 */

export interface RelayLimits {
  /** §3.5: larger messages close the socket with 1009. */
  maxFrameBytes: number
  helloTimeoutMs: number
  idleTimeoutMs: number
  ratePerSecond: number
  rateBurst: number
  /** A second rate violation within this window of the first closes with 4429. */
  rateStrikeWindowMs: number
  connectionsPerIpPerMinute: number
  /** Offers whose `exp` is further out than this are clamped to it. */
  maxOfferTtlSeconds: number
  /** Most IDs one `watch` may carry. */
  maxWatch: number
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxFrameBytes: RELAY_MAX_FRAME_BYTES,
  helloTimeoutMs: RELAY_HELLO_TIMEOUT_MS,
  idleTimeoutMs: RELAY_IDLE_TIMEOUT_MS,
  ratePerSecond: RELAY_RATE_PER_SECOND,
  rateBurst: RELAY_RATE_BURST,
  rateStrikeWindowMs: 10_000,
  connectionsPerIpPerMinute: RELAY_CONNECTIONS_PER_IP_PER_MINUTE,
  maxOfferTtlSeconds: 900,
  maxWatch: 256
}

export interface Clock {
  /** Unix ms. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** What the core needs from a socket. */
export interface Connection {
  send(text: string): void
  close(code: number, reason: string): void
}

/** What the socket layer calls on the core for one connection. */
export interface ConnectionHandle {
  message(data: Uint8Array, isBinary: boolean): void
  /** The socket is gone (for whatever reason). Idempotent. */
  closed(): void
}

export interface RelayOptions {
  store: RelayStore
  clock?: Clock
  limits?: Partial<RelayLimits>
  logger?: Logger
}

export interface RelayStats {
  connections: number
  online: number
  offers: number
  pending: number
}

export interface Relay {
  readonly limits: RelayLimits
  /** Per-IP connection budget; call before accepting a socket. */
  admit(ip: string): boolean
  open(conn: Connection, info: { ip: string }): ConnectionHandle
  stats(): RelayStats
  /** Closes every connection with 1001 and stops all timers. */
  shutdown(): void
}

interface Client {
  readonly conn: Connection
  readonly ip: string
  readonly nonce: string
  readonly bucket: TokenBucket
  id: string | null
  role: Role | null
  pub: string | null
  closed: boolean
  helloTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  rateStrikeAt: number | null
  /** Phones only: authorized desktops whose presence this phone asked for. */
  watched: Set<string>
}

interface Offer {
  tokenHash: Uint8Array
  expMs: number
}

interface Pending {
  desktopId: string
  phoneId: string
  phonePub: string
  expMs: number
  timer: ReturnType<typeof setTimeout>
}

const decoder = new TextDecoder()

export function createRelay(options: RelayOptions): Relay {
  const store = options.store
  const clock = options.clock ?? systemClock
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const log = options.logger ?? silentLogger
  const ipLimiter = new IpLimiter(limits.connectionsPerIpPerMinute)

  const clients = new Set<Client>()
  /** Authenticated connections by device ID. */
  const online = new Map<string, Client>()
  /** Live offer per desktop ID. */
  const offers = new Map<string, Offer>()
  /** Pending phones, keyed `desktopId:phoneId`. Survive a phone reconnect until `expMs`. */
  const pending = new Map<string, Pending>()
  /** When each device last disconnected (unix ms). Memory only. */
  const lastSeen = new Map<string, number>()

  const pruneTimer = setInterval(() => ipLimiter.prune(clock.now()), 60_000)
  pruneTimer.unref?.()

  const pendingKey = (desktopId: string, phoneId: string): string => `${desktopId}:${phoneId}`

  function send(client: Client, message: ServerMessage): void {
    if (client.closed) return
    client.conn.send(encodeRelayMessage(message))
  }

  function sendError(client: Client, code: RelayErrorCode, message?: string, to?: string): void {
    const msg: ServerMessage = { t: 'error', code }
    if (message !== undefined) msg.message = message
    if (to !== undefined) msg.to = to
    send(client, msg)
  }

  function onlineAs(id: string, role: Role): Client | null {
    const client = online.get(id)
    return client && client.role === role && !client.closed ? client : null
  }

  function livePending(desktopId: string, phoneId: string): Pending | null {
    const p = pending.get(pendingKey(desktopId, phoneId))
    return p && p.expMs > clock.now() ? p : null
  }

  function isLinked(desktopId: string, phoneId: string): boolean {
    return store.getPair(desktopId, phoneId) !== null || livePending(desktopId, phoneId) !== null
  }

  function pendingDesktopsOf(phoneId: string): string[] {
    const out: string[] = []
    for (const p of pending.values()) if (p.phoneId === phoneId) out.push(p.desktopId)
    return out
  }

  function pendingPhonesOf(desktopId: string): string[] {
    const out: string[] = []
    for (const p of pending.values()) if (p.desktopId === desktopId) out.push(p.phoneId)
    return out
  }

  function peerMessage(id: string, state: PeerState, seen?: number): ServerMessage {
    const msg: ServerMessage = { t: 'peer', id, state }
    if (seen !== undefined) msg.lastSeen = seen
    return msg
  }

  /** Tells everyone entitled to this device's presence that it came online or went offline. */
  function announce(client: Client, state: 'online' | 'offline'): void {
    const id = client.id!
    const msg = peerMessage(id, state, state === 'offline' ? lastSeen.get(id) : undefined)
    if (client.role === 'phone') {
      const desktops = new Set([...store.desktopsForPhone(id), ...pendingDesktopsOf(id)])
      for (const d of desktops) {
        const desktop = onlineAs(d, 'desktop')
        if (desktop) send(desktop, msg)
      }
    } else {
      for (const other of online.values()) {
        if (other.role === 'phone' && other.watched.has(id)) send(other, msg)
      }
    }
  }

  /** On a desktop's `ready`: where its authorized and pending phones stand right now. */
  function sendRoster(desktop: Client): void {
    const phones = new Set([...store.phonesForDesktop(desktop.id!), ...pendingPhonesOf(desktop.id!)])
    for (const p of phones) {
      if (onlineAs(p, 'phone')) send(desktop, peerMessage(p, 'online'))
      else if (lastSeen.has(p)) send(desktop, peerMessage(p, 'offline', lastSeen.get(p)))
    }
  }

  function clearTimers(client: Client): void {
    if (client.helloTimer) clearTimeout(client.helloTimer)
    if (client.idleTimer) clearTimeout(client.idleTimer)
    client.helloTimer = null
    client.idleTimer = null
  }

  /** Forgets a connection. Presence and offers go with it unless a newer socket took over the ID. */
  function cleanup(client: Client): void {
    if (!clients.has(client)) return
    clients.delete(client)
    client.closed = true
    clearTimers(client)
    const id = client.id
    if (id === null || online.get(id) !== client) return
    online.delete(id)
    lastSeen.set(id, clock.now())
    if (client.role === 'desktop') offers.delete(id)
    announce(client, 'offline')
    log.info('disconnected', { id, role: client.role })
  }

  function drop(client: Client, code: number, reason: string): void {
    if (client.closed) return
    cleanup(client)
    client.conn.close(code, reason)
  }

  function authFail(client: Client, message: string): void {
    log.info('auth-failed', { ip: client.ip, reason: message })
    sendError(client, 'auth', message)
    drop(client, RelayCloseCode.Auth, 'auth failed')
  }

  function onHello(client: Client, text: string): void {
    let msg: ClientMessage
    try {
      msg = parseClientMessage(text)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return authFail(client, 'malformed hello')
    }
    if (msg.t !== 'hello') return authFail(client, 'expected hello')
    const id = verifyHello(msg, client.nonce)
    if (id === null) return authFail(client, 'bad signature')
    if (client.helloTimer) clearTimeout(client.helloTimer)
    client.helloTimer = null
    client.id = id
    client.role = msg.role
    client.pub = msg.pub

    const previous = online.get(id)
    online.set(id, client)
    if (previous) {
      if (previous.role === 'desktop') offers.delete(id)
      drop(previous, RelayCloseCode.Replaced, 'replaced by a newer connection')
      log.info('replaced', { id, role: msg.role })
    }
    send(client, { t: 'ready', id })
    log.info('connected', { id, role: msg.role, ip: client.ip })

    if (msg.role === 'phone' && msg.pair) attachPending(client, msg)
    if (msg.role === 'desktop') sendRoster(client)
    announce(client, 'online')
  }

  /** A phone's hello carried `pair`: make it pending under that desktop's live offer. */
  function attachPending(phone: Client, hello: HelloMessage): void {
    const phoneId = phone.id!
    const desktopId = hello.pair!.to
    if (store.getPair(desktopId, phoneId)) return
    const existing = livePending(desktopId, phoneId)
    if (existing && existing.phonePub === phone.pub) return
    const offer = offers.get(desktopId)
    const now = clock.now()
    const presented = sha256(b64uDecode(hello.pair!.token))
    if (!offer || offer.expMs <= now || !constantTimeEqual(presented, offer.tokenHash)) {
      log.info('pair-refused', { phone: phoneId, desktop: desktopId })
      sendError(phone, 'forbidden', 'no live pairing offer matches this token', desktopId)
      return
    }
    // One use: the next phone needs the desktop's next offer.
    offers.delete(desktopId)
    const key = pendingKey(desktopId, phoneId)
    const old = pending.get(key)
    if (old) clearTimeout(old.timer)
    const timer = setTimeout(() => lapse(key), Math.max(0, offer.expMs - now))
    timer.unref?.()
    pending.set(key, { desktopId, phoneId, phonePub: phone.pub!, expMs: offer.expMs, timer })
    log.info('pending', { phone: phoneId, desktop: desktopId })
  }

  /** A pending phone's offer lifetime ran out without `authorize`. */
  function lapse(key: string): void {
    const p = pending.get(key)
    if (!p) return
    pending.delete(key)
    log.info('pending-expired', { phone: p.phoneId, desktop: p.desktopId })
    const phone = onlineAs(p.phoneId, 'phone')
    if (!phone) return
    const desktop = onlineAs(p.desktopId, 'desktop')
    if (desktop) send(desktop, peerMessage(p.phoneId, 'offline', clock.now()))
    sendError(phone, 'forbidden', 'pairing window expired', p.desktopId)
    // A phone that is also paired elsewhere keeps its socket for those desktops.
    if (store.desktopsForPhone(p.phoneId).length === 0 && pendingDesktopsOf(p.phoneId).length === 0) {
      drop(phone, RelayCloseCode.PairingExpired, 'pairing window expired')
    }
  }

  function onOffer(desktop: Client, msg: OfferMessage): void {
    const now = clock.now()
    const expMs = Math.min(msg.exp * 1000, now + limits.maxOfferTtlSeconds * 1000)
    offers.set(desktop.id!, { tokenHash: b64uDecode(msg.tokenHash), expMs })
    log.debug('offer', { desktop: desktop.id, ttlMs: expMs - now })
  }

  function onAuthorize(desktop: Client, msg: AuthorizeMessage): void {
    const desktopId = desktop.id!
    const phoneId = msg.phone
    if (deviceId(b64uDecode(msg.pub)) !== phoneId) return sendError(desktop, 'bad-request', 'pub does not match phone', phoneId)
    const p = livePending(desktopId, phoneId)
    const existing = store.getPair(desktopId, phoneId)
    const knownPub = p?.phonePub ?? existing?.phonePub
    if (knownPub === undefined) return sendError(desktop, 'forbidden', 'phone is neither pending nor authorized', phoneId)
    if (knownPub !== msg.pub) return sendError(desktop, 'forbidden', 'pub does not match the authenticated phone', phoneId)
    store.putPair({ desktopId, phoneId, phonePub: msg.pub, desktopPub: desktop.pub!, createdAt: existing?.createdAt ?? clock.now() })
    if (p) {
      clearTimeout(p.timer)
      pending.delete(pendingKey(desktopId, phoneId))
    }
    log.info('authorized', { desktop: desktopId, phone: phoneId })
  }

  function onRevoke(desktop: Client, msg: RevokeMessage): void {
    const desktopId = desktop.id!
    const phoneId = msg.phone
    const deleted = store.deletePair(desktopId, phoneId)
    const key = pendingKey(desktopId, phoneId)
    const p = pending.get(key)
    if (p) {
      clearTimeout(p.timer)
      pending.delete(key)
    }
    if (!deleted && !p) return
    log.info('revoked', { desktop: desktopId, phone: phoneId })
    const phone = onlineAs(phoneId, 'phone')
    if (phone) {
      phone.watched.delete(desktopId)
      send(phone, peerMessage(desktopId, 'revoked'))
    }
  }

  function onWatch(phone: Client, msg: WatchMessage): void {
    if (msg.desktops.length > limits.maxWatch) return sendError(phone, 'bad-request', `watch at most ${limits.maxWatch} desktops`)
    const phoneId = phone.id!
    const authorized = [...new Set(msg.desktops)].filter((d) => store.getPair(d, phoneId) !== null)
    phone.watched = new Set(authorized)
    for (const d of authorized) {
      if (onlineAs(d, 'desktop')) send(phone, peerMessage(d, 'online'))
      else send(phone, peerMessage(d, 'offline', lastSeen.get(d)))
    }
  }

  function onFrame(sender: Client, msg: FrameOutMessage): void {
    const to = msg.to
    const senderId = sender.id!
    const linked =
      to !== senderId && (sender.role === 'desktop' ? isLinked(senderId, to) : isLinked(to, senderId))
    if (!linked) return sendError(sender, 'forbidden', 'not paired', to)
    const recipient = onlineAs(to, sender.role === 'desktop' ? 'phone' : 'desktop')
    if (!recipient) return sendError(sender, 'offline', undefined, to)
    send(recipient, { t: 'frame', from: senderId, data: msg.data })
  }

  function onMessage(client: Client, text: string): void {
    let msg: ClientMessage
    try {
      msg = parseClientMessage(text)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return sendError(client, 'bad-request', err.message)
    }
    const role = client.role
    switch (msg.t) {
      case 'frame':
        return onFrame(client, msg)
      case 'ping':
        return send(client, { t: 'pong' })
      case 'pong':
        return
      case 'hello':
        return sendError(client, 'bad-request', 'already authenticated')
      case 'offer':
        return role === 'desktop' ? onOffer(client, msg) : sendError(client, 'forbidden', 'desktops only')
      case 'authorize':
        return role === 'desktop' ? onAuthorize(client, msg) : sendError(client, 'forbidden', 'desktops only')
      case 'revoke':
        return role === 'desktop' ? onRevoke(client, msg) : sendError(client, 'forbidden', 'desktops only')
      case 'watch':
        return role === 'phone' ? onWatch(client, msg) : sendError(client, 'forbidden', 'phones only')
    }
  }

  function receive(client: Client, data: Uint8Array, isBinary: boolean): void {
    if (client.closed) return
    if (data.length > limits.maxFrameBytes) return drop(client, RelayCloseCode.TooBig, 'message too big')
    const now = clock.now()
    if (!client.bucket.take(now)) {
      if (client.rateStrikeAt !== null && now - client.rateStrikeAt < limits.rateStrikeWindowMs) {
        log.info('rate-closed', { id: client.id, ip: client.ip })
        sendError(client, 'rate', 'too many messages')
        return drop(client, RelayCloseCode.Rate, 'rate limit')
      }
      client.rateStrikeAt = now
      return sendError(client, 'rate', 'too many messages; slow down')
    }
    client.idleTimer?.refresh()
    if (isBinary) {
      if (client.id === null) return authFail(client, 'expected hello')
      return sendError(client, 'bad-request', 'text frames only')
    }
    const text = decoder.decode(data)
    if (client.id === null) onHello(client, text)
    else onMessage(client, text)
  }

  return {
    limits,
    admit(ip) {
      const ok = ipLimiter.admit(ip, clock.now())
      if (!ok) log.info('ip-limited', { ip })
      return ok
    },
    open(conn, info) {
      const client: Client = {
        conn,
        ip: info.ip,
        nonce: b64uEncode(randomBytes(32)),
        bucket: new TokenBucket(limits.ratePerSecond, limits.rateBurst, clock.now()),
        id: null,
        role: null,
        pub: null,
        closed: false,
        helloTimer: null,
        idleTimer: null,
        rateStrikeAt: null,
        watched: new Set()
      }
      clients.add(client)
      client.helloTimer = setTimeout(() => {
        log.info('hello-timeout', { ip: client.ip })
        drop(client, RelayCloseCode.HelloTimeout, 'hello timeout')
      }, limits.helloTimeoutMs)
      client.idleTimer = setTimeout(() => {
        log.info('idle-timeout', { id: client.id, ip: client.ip })
        drop(client, RelayCloseCode.GoingAway, 'idle timeout')
      }, limits.idleTimeoutMs)
      send(client, { t: 'challenge', nonce: client.nonce })
      return {
        message: (data, isBinary) => receive(client, data, isBinary),
        closed: () => cleanup(client)
      }
    },
    stats() {
      return { connections: clients.size, online: online.size, offers: offers.size, pending: pending.size }
    },
    shutdown() {
      clearInterval(pruneTimer)
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear()
      for (const client of [...clients]) drop(client, RelayCloseCode.GoingAway, 'server shutting down')
    }
  }
}
