import type { AgentActivity } from '../../shared/agent-activity'
import {
  normalizeRelayUrl,
  type MobileConfig,
  type MobileConnectionState,
  type MobilePairedDevice,
  type MobilePairingInvite,
  type MobilePendingRequest,
  type MobileState
} from '../../shared/mobile'
import type { ProjectsData, TabStatusValue } from '../../shared/types'
import { buildInbox, inboxContentKey } from './inbox'
import type { MobilePairing } from './pairings-store'
import {
  AppErrorCode,
  AppOp,
  b64uDecode,
  b64uEncode,
  constantTimeEqual,
  deviceId
} from '../../../protocol/ts/index.ts'
import type {
  AppMessage,
  AuthorizeMessage,
  ErrorMessage,
  FrameInMessage,
  FrameOutMessage,
  HandshakeResult,
  Inbox as MobileInbox,
  OfferMessage,
  PeerMessage,
  PhoneHello,
  RevokeMessage
} from '../../../protocol/ts/index.ts'

/** What the service sends through the relay once authenticated (SPEC.md §3.2, §3.4). */
export type RelayDesktopMessage = OfferMessage | AuthorizeMessage | RevokeMessage | FrameOutMessage
/** What the relay client hands the service (§3.4); challenge/ready/ping/pong stay inside it. */
export type RelayServerMessage = FrameInMessage | PeerMessage | ErrorMessage
/** Every app message the desktop sends (§4.4). */
export type DesktopAppMessage = AppMessage

/** Message 1's parsed payload plus the phone's Noise static key the handshake authenticated. */
export interface VerifiedHello {
  hello: PhoneHello
  remoteStatic: Uint8Array
}

// ---- Seams phase C2 fills in ---------------------------------------------------

/**
 * The relay connection (SPEC.md §3). Owns the socket, the challenge/hello/ready
 * exchange, ping/pong and reconnect backoff; the service only sees what comes
 * after `ready`.
 */
export type RelayTransportState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'online' }
  | { kind: 'offline'; error?: string }

export interface RelayTransport {
  /** Start connecting to `<relayUrl>/v1` and keep reconnecting until `close()`. */
  connect(relayUrl: string): void
  /** Stop for good: close the socket, cancel reconnects. State goes to `idle`. */
  close(): void
  /** False when the message could not be sent (not online). Nothing is queued. */
  send(message: RelayDesktopMessage): boolean
  getState(): RelayTransportState
  onMessage(listener: (message: RelayServerMessage) => void): () => void
  onStateChange(listener: (state: RelayTransportState) => void): () => void
}

/** What a phone's channel asks of the service. */
export interface ChannelHooks {
  /** Send one envelope (`[kind:u8] || body`, SPEC.md §4.1) to this phone as a relay frame. */
  sendFrame(data: Uint8Array): void
  /**
   * Message 1 decrypted, its version negotiated and its payload parsed: decide what
   * message 2 says. Called synchronously, before message 2 is written.
   */
  onHello(hello: VerifiedHello): HandshakeResult
  /** Message 2 went out; transport messages may flow (for `ok` and `pending`). */
  onEstablished(result: HandshakeResult): void
  /** A decrypted, parsed app message (SPEC.md §4.4). Unknown types never reach here. */
  onAppMessage(message: AppMessage): void
  /** The session is gone (reset, decrypt failure, closed). A new handshake may follow. */
  onSessionLost(): void
}

/** A Noise IK responder for one phone ID (SPEC.md §4.2). */
export interface PhoneChannel {
  /** An envelope received from this phone. */
  receive(data: Uint8Array): void
  /** Encrypt and send an app message. False when there is no session. */
  send(message: DesktopAppMessage): boolean
  readonly established: boolean
  /** Forget the session; no further hooks fire. */
  close(): void
}

export interface ChannelFactory {
  create(phoneId: string, hooks: ChannelHooks): PhoneChannel
}

/** A freshly minted pairing offer (SPEC.md §2). */
export interface PairingInvite {
  /** `devtool://pair?d=…` — the QR payload. */
  uri: string
  /** Unix seconds. */
  exp: number
  /** b64u SHA-256(relayToken): what the relay's `offer` carries. */
  tokenHash: string
  /** HKDF(s, "devtool-pair-proof-v1"): what a phone must present in message 1. */
  pairProof: Uint8Array
}

export interface CreateInviteOptions {
  relayUrl: string
  desktopName: string
  /** Epoch ms. */
  now: number
}

export interface PairingsStoreLike {
  list(): MobilePairing[]
  get(id: string): MobilePairing | null
  add(pairing: MobilePairing): void
  remove(id: string): boolean
  touchLastSeen(id: string, at: number): void
  /** Revocations the relay has not acknowledged yet; kept across restarts. */
  pendingRevokes(): string[]
  setPendingRevoke(id: string, pending: boolean): void
}

export interface MobileTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface MobileServiceDeps {
  getConfig(): MobileConfig
  /** Persist a new mobile config (and let the windows know). */
  saveConfig(config: MobileConfig): void
  projects: {
    peek(): ProjectsData
    subscribe(listener: () => void): () => void
  }
  activity: {
    getStatus(tabId: string): TabStatusValue
    getActivity(tabId: string): AgentActivity | null
    getSince(tabId: string): number | null
    subscribe(listener: (tabId: string) => void): () => void
  }
  pairings: PairingsStoreLike
  /** This desktop's device ID, or null while there is no identity yet. */
  getDesktopId(): string | null
  /** Fallback display name (the host name). */
  defaultDesktopName(): string
  createTransport(): RelayTransport
  channels: ChannelFactory
  createInvite(options: CreateInviteOptions): PairingInvite | Promise<PairingInvite>
  broadcastState(state: MobileState): void
  log(message: string): void
  timers?: MobileTimers
}

// ---- The service -----------------------------------------------------------------

/** Inbox events go out at most this often per phone, trailing edge included. */
export const INBOX_THROTTLE_MS = 1000

const defaultTimers: MobileTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

type SessionRole = 'handshaking' | 'paired' | 'pending' | 'refused'

interface Session {
  phoneId: string
  channel: PhoneChannel
  role: SessionRole
  /** Inbox event counter; restarts with every handshake (SPEC.md §4.4). */
  seq: number
  lastInboxKey: string | null
}

interface PendingRequest extends Omit<MobilePendingRequest, 'online'> {
  x25519Pub: string
  ed25519Pub: string
  /** The proof it presented: a reconnect inside the window re-handshakes with it (see decideHandshake). */
  pairProof: Uint8Array
  /** The consumed offer's `exp` (unix s). The relay keeps the phone pending until then (§3.7). */
  exp: number
}

/** A phone accepted from the Settings while it was away; its next `pair` handshake is let in. */
interface AcceptedWhileAway {
  phoneId: string
  pairProof: Uint8Array
  exp: number
}

interface LiveInvite extends PairingInvite {
  relayUrl: string
}

export class MobileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileError'
  }
}

/**
 * Desktop half of the mobile client: owns the relay connection, the pairing
 * offer and the per-phone channels, and turns projects + tab activity into the
 * inbox each paired phone sees. Everything network- and crypto-shaped is behind
 * `RelayTransport` and `ChannelFactory`, so the orchestration is testable alone.
 */
export class MobileService {
  private readonly timers: MobileTimers
  private transport: RelayTransport | null = null
  private transportUnsubs: (() => void)[] = []
  private storeUnsubs: (() => void)[] = []
  private readonly sessions = new Map<string, Session>()
  private readonly online = new Set<string>()
  private invite: LiveInvite | null = null
  private inviteTimer: unknown = null
  /** Bumped by every start/cancel so a slow `createInvite` cannot resurrect a cancelled one. */
  private inviteGeneration = 0
  private pending: PendingRequest | null = null
  private pendingTimer: unknown = null
  private acceptedWhileAway: AcceptedWhileAway | null = null
  private inboxTimer: unknown = null
  private lastInboxFlushAt = Number.NEGATIVE_INFINITY
  private lastBroadcastKey: string | null = null
  private started = false

  constructor(private readonly deps: MobileServiceDeps) {
    this.timers = deps.timers ?? defaultTimers
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.storeUnsubs = [
      this.deps.projects.subscribe(() => this.scheduleInbox()),
      this.deps.activity.subscribe(() => this.scheduleInbox())
    ]
    if (this.deps.getConfig().enabled) this.connect()
    this.emitState()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const unsub of this.storeUnsubs) unsub()
    this.storeUnsubs = []
    this.disconnect()
    this.clearInvite()
    this.clearPending()
    this.clearInboxTimer()
  }

  getState(): MobileState {
    const config = this.deps.getConfig()
    const pairings = this.deps.pairings.list()
    const devices: MobilePairedDevice[] = pairings
      .map((p) => ({ id: p.id, name: p.name, pairedAt: p.pairedAt, lastSeen: p.lastSeen, online: this.online.has(p.id) }))
      .sort((a, b) => a.pairedAt - b.pairedAt)
    return {
      enabled: config.enabled,
      relayUrl: config.relayUrl,
      desktopName: this.desktopName(),
      connection: this.connectionState(),
      invite: this.invite ? { uri: this.invite.uri, exp: this.invite.exp } : null,
      pending: this.pending
        ? {
            phoneId: this.pending.phoneId,
            name: this.pending.name,
            receivedAt: this.pending.receivedAt,
            online: this.online.has(this.pending.phoneId) || this.sessions.has(this.pending.phoneId)
          }
        : null,
      devices
    }
  }

  setEnabled(enabled: boolean): void {
    const config = this.deps.getConfig()
    if (config.enabled !== enabled) this.deps.saveConfig({ ...config, enabled })
    if (enabled) {
      if (this.started && !this.transport) this.connect()
    } else {
      this.disconnect()
      this.clearInvite()
      this.clearPending()
    }
    this.emitState()
  }

  setRelayUrl(relayUrl: string): void {
    const url = normalizeRelayUrl(relayUrl)
    const config = this.deps.getConfig()
    if (config.relayUrl === url) return
    this.deps.saveConfig({ ...config, relayUrl: url })
    // The QR code names the relay, and the phones are on the old one.
    this.clearInvite()
    this.clearPending()
    if (this.transport) {
      this.disconnect()
      this.connect()
    }
    this.emitState()
  }

  /**
   * Mint a fresh QR code, replacing any previous one. Turns Mobile on: a phone
   * can only reach this desktop through the relay.
   */
  async startPairing(): Promise<MobilePairingInvite> {
    if (!this.deps.getConfig().enabled) this.setEnabled(true)
    const config = this.deps.getConfig()
    this.clearInvite()
    const generation = ++this.inviteGeneration
    const invite = await this.deps.createInvite({
      relayUrl: config.relayUrl,
      desktopName: this.desktopName(),
      now: this.timers.now()
    })
    if (generation !== this.inviteGeneration) throw new MobileError('Pairing was cancelled')
    this.invite = { ...invite, relayUrl: config.relayUrl }
    this.inviteTimer = this.timers.setTimeout(() => {
      this.inviteTimer = null
      if (this.invite?.uri === invite.uri) {
        this.invite = null
        this.emitState()
      }
    }, Math.max(0, invite.exp * 1000 - this.timers.now()))
    this.sendOffer()
    this.emitState()
    return { uri: invite.uri, exp: invite.exp }
  }

  cancelPairing(): void {
    this.inviteGeneration++
    this.clearInvite()
    this.emitState()
  }

  accept(phoneId: string): void {
    const pending = this.pending
    if (!pending || pending.phoneId !== phoneId) throw new MobileError('No pairing request from that phone')
    const now = this.timers.now()
    this.clearPending()
    this.deps.pairings.add({
      id: pending.phoneId,
      name: pending.name,
      x25519Pub: pending.x25519Pub,
      ed25519Pub: pending.ed25519Pub,
      pairedAt: now,
      lastSeen: now
    })
    this.deps.pairings.setPendingRevoke(pending.phoneId, false)
    this.transport?.send({ t: 'authorize', phone: pending.phoneId, pub: pending.ed25519Pub })
    const session = this.sessions.get(phoneId)
    if (session && session.role === 'pending') {
      session.role = 'paired'
      session.channel.send({ t: 'evt', e: 'pairing', status: 'accepted' })
      this.sendInbox(session, this.currentInbox())
      this.acceptedWhileAway = null
    } else {
      // The phone is between connections and will come back with its `pair` handshake.
      this.acceptedWhileAway = { phoneId, pairProof: pending.pairProof, exp: pending.exp }
    }
    this.log(`accept phone=${phoneId}`)
    this.emitState()
  }

  reject(phoneId: string): void {
    const pending = this.pending
    if (!pending || pending.phoneId !== phoneId) throw new MobileError('No pairing request from that phone')
    this.clearPending()
    const session = this.sessions.get(phoneId)
    if (session && session.role === 'pending') {
      session.channel.send({ t: 'evt', e: 'pairing', status: 'rejected' })
      session.role = 'refused'
    }
    // The relay drops the phone when the offer's lifetime runs out.
    this.log(`reject phone=${phoneId}`)
    this.emitState()
  }

  revoke(phoneId: string): void {
    const session = this.sessions.get(phoneId)
    if (session) {
      if (session.role === 'paired') session.channel.send({ t: 'evt', e: 'pairing', status: 'revoked' })
      this.dropSession(phoneId)
    }
    const removed = this.deps.pairings.remove(phoneId)
    if (!removed) throw new MobileError('No such paired device')
    // Kept until the relay has it: a phone the relay still routes could keep talking.
    if (!this.transport?.send({ t: 'revoke', phone: phoneId })) this.deps.pairings.setPendingRevoke(phoneId, true)
    this.online.delete(phoneId)
    this.log(`revoke phone=${phoneId}`)
    this.emitState()
  }

  // ---- connection ----------------------------------------------------------------

  private connect(): void {
    const transport = this.deps.createTransport()
    this.transport = transport
    this.transportUnsubs = [
      transport.onStateChange((state) => this.handleTransportState(state)),
      transport.onMessage((message) => this.handleRelayMessage(message))
    ]
    transport.connect(this.deps.getConfig().relayUrl)
    this.emitState()
  }

  private disconnect(): void {
    for (const unsub of this.transportUnsubs) unsub()
    this.transportUnsubs = []
    const transport = this.transport
    this.transport = null
    this.dropAllSessions()
    this.online.clear()
    transport?.close()
  }

  private handleTransportState(state: RelayTransportState): void {
    if (state.kind === 'online') {
      for (const phone of this.deps.pairings.pendingRevokes()) {
        if (this.transport?.send({ t: 'revoke', phone })) this.deps.pairings.setPendingRevoke(phone, false)
      }
      this.sendOffer()
    } else {
      // Every channel is bound to the socket that carried its handshake (SPEC.md §4.2).
      this.dropAllSessions()
      this.online.clear()
      // A pending request outlives the socket: the relay keeps the phone pending until
      // the offer's exp (§3.7), and the phone handshakes again when we're back.
    }
    this.emitState()
  }

  private connectionState(): MobileConnectionState {
    if (!this.deps.getConfig().enabled) return { kind: 'disabled' }
    const state = this.transport?.getState() ?? { kind: 'idle' as const }
    switch (state.kind) {
      case 'online':
        return { kind: 'online' }
      case 'offline':
        return state.error ? { kind: 'offline', error: state.error } : { kind: 'offline' }
      default:
        return { kind: 'connecting' }
    }
  }

  private sendOffer(): void {
    const invite = this.invite
    if (!invite || !this.transport) return
    if (invite.exp * 1000 <= this.timers.now()) return
    this.transport.send({ t: 'offer', tokenHash: invite.tokenHash, exp: invite.exp })
  }

  private handleRelayMessage(message: RelayServerMessage): void {
    switch (message.t) {
      case 'frame': {
        let bytes: Uint8Array
        try {
          bytes = b64uDecode(message.data)
        } catch {
          return
        }
        if (bytes.length === 0) return
        this.sessionFor(message.from).channel.receive(bytes)
        return
      }
      case 'peer':
        if (message.state === 'online') {
          this.online.add(message.id)
        } else {
          this.phoneGone(message.id, message.lastSeen)
        }
        this.emitState()
        return
      case 'error':
        if (message.code === 'offline' && message.to) {
          this.phoneGone(message.to)
          this.emitState()
        } else {
          this.log(`relayError code=${message.code}${message.message ? ` message=${message.message}` : ''}`)
        }
        return
    }
  }

  private phoneGone(phoneId: string, lastSeen?: number): void {
    const wasOnline = this.online.delete(phoneId)
    this.dropSession(phoneId)
    // A pending request survives a blip: the relay keeps the phone pending until the
    // offer's exp (§3.7), and the phone re-handshakes with the same proof. The request
    // is dropped when that window closes (clearPending via pendingTimer).
    if (wasOnline || lastSeen !== undefined) {
      this.deps.pairings.touchLastSeen(phoneId, lastSeen ?? this.timers.now())
    }
  }

  // ---- channels ------------------------------------------------------------------

  private sessionFor(phoneId: string): Session {
    const existing = this.sessions.get(phoneId)
    if (existing) return existing
    const session: Session = {
      phoneId,
      channel: undefined as unknown as PhoneChannel,
      role: 'handshaking',
      seq: 0,
      lastInboxKey: null
    }
    session.channel = this.deps.channels.create(phoneId, {
      sendFrame: (data) => {
        this.transport?.send({ t: 'frame', to: phoneId, data: b64uEncode(data) })
      },
      onHello: (hello) => {
        // A new handshake on an existing channel starts a new session.
        session.seq = 0
        session.lastInboxKey = null
        const result = this.decideHandshake(phoneId, hello)
        session.role = result === 'ok' ? 'paired' : result === 'pending' ? 'pending' : 'refused'
        this.log(`handshake phone=${phoneId} kind=${hello.hello.kind} result=${result}`)
        return result
      },
      onEstablished: (result) => {
        if (result === 'ok') {
          this.online.add(phoneId)
          this.deps.pairings.touchLastSeen(phoneId, this.timers.now())
        }
        this.emitState()
      },
      onAppMessage: (message) => this.handleAppMessage(session, message),
      onSessionLost: () => {
        if (this.sessions.get(phoneId) === session) {
          session.role = 'handshaking'
          session.seq = 0
          session.lastInboxKey = null
        }
      }
    })
    this.sessions.set(phoneId, session)
    return session
  }

  private decideHandshake(phoneId: string, { hello, remoteStatic }: VerifiedHello): HandshakeResult {
    // The relay authenticated `phoneId` by its Ed25519 key; a payload naming another key is lying (§4.3).
    let claimedId: string
    try {
      claimedId = deviceId(b64uDecode(hello.ed))
    } catch {
      return 'rejected'
    }
    if (claimedId !== phoneId) return 'rejected'

    if (hello.kind === 'resume') {
      const pairing = this.deps.pairings.get(phoneId)
      if (!pairing || pairing.x25519Pub !== b64uEncode(remoteStatic) || pairing.ed25519Pub !== hello.ed) {
        return 'unknown-device'
      }
      return 'ok'
    }

    if (!hello.proof) return 'rejected'
    let proof: Uint8Array
    try {
      proof = b64uDecode(hello.proof)
    } catch {
      return 'rejected'
    }
    const now = this.timers.now()
    const x25519Pub = b64uEncode(remoteStatic)

    // The same phone coming back inside the pairing window (its socket blipped, or ours
    // did) re-handshakes with the proof it already used; the offer is spent by now.
    const pending = this.pending
    if (pending && pending.phoneId === phoneId && pending.exp * 1000 > now && constantTimeEqual(proof, pending.pairProof)) {
      if (pending.x25519Pub !== x25519Pub || pending.ed25519Pub !== hello.ed) return 'rejected'
      this.emitState()
      return 'pending'
    }
    const accepted = this.acceptedWhileAway
    if (accepted && accepted.phoneId === phoneId && accepted.exp * 1000 > now && constantTimeEqual(proof, accepted.pairProof)) {
      const pairing = this.deps.pairings.get(phoneId)
      if (!pairing || pairing.x25519Pub !== x25519Pub || pairing.ed25519Pub !== hello.ed) return 'rejected'
      this.acceptedWhileAway = null
      return 'ok'
    }

    const invite = this.invite
    if (!invite || invite.exp * 1000 <= now) return 'rejected'
    if (!constantTimeEqual(proof, invite.pairProof)) return 'rejected'
    if (pending && pending.phoneId !== phoneId) return 'rejected'
    // Single use: the relay consumed the offer too.
    this.clearInvite()
    this.clearPending()
    this.pending = {
      phoneId,
      name: hello.deviceName.trim().slice(0, 100) || 'Phone',
      receivedAt: now,
      x25519Pub,
      ed25519Pub: hello.ed,
      pairProof: invite.pairProof,
      exp: invite.exp
    }
    this.pendingTimer = this.timers.setTimeout(() => {
      this.pendingTimer = null
      if (this.pending?.phoneId === phoneId) {
        this.pending = null
        this.log(`pending lapsed phone=${phoneId}`)
        this.emitState()
      }
    }, Math.max(0, invite.exp * 1000 - now))
    this.emitState()
    return 'pending'
  }

  private handleAppMessage(session: Session, message: AppMessage): void {
    if (message.t !== 'req') return
    const { id } = message
    if (session.role !== 'paired') {
      session.channel.send({ t: 'res', id, ok: false, error: { code: AppErrorCode.NotAuthorized, message: 'Pairing not accepted yet' } })
      return
    }
    if (message.op === AppOp.InboxGet) {
      const inbox = this.currentInbox()
      if (session.channel.send({ t: 'res', id, ok: true, result: inbox })) {
        session.lastInboxKey = inboxContentKey(inbox)
      } else {
        // In M1 an app message above the Noise limit is an error, not a split.
        session.channel.send({ t: 'res', id, ok: false, error: { code: AppErrorCode.Internal, message: 'Inbox too large' } })
      }
      return
    }
    session.channel.send({ t: 'res', id, ok: false, error: { code: AppErrorCode.Unsupported, message: `Unknown op ${message.op}` } })
  }

  private dropSession(phoneId: string): void {
    const session = this.sessions.get(phoneId)
    if (!session) return
    this.sessions.delete(phoneId)
    session.channel.close()
  }

  private dropAllSessions(): void {
    for (const phoneId of [...this.sessions.keys()]) this.dropSession(phoneId)
  }

  // ---- inbox -----------------------------------------------------------------------

  private currentInbox(): MobileInbox {
    const activity = this.deps.activity
    return buildInbox(
      this.deps.projects.peek(),
      {
        statusOf: (tabId) => activity.getStatus(tabId),
        activityOf: (tabId) => activity.getActivity(tabId),
        sinceOf: (tabId) => activity.getSince(tabId)
      },
      { id: this.deps.getDesktopId() ?? '', name: this.desktopName() },
      this.timers.now()
    )
  }

  private pairedSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => s.role === 'paired' && s.channel.established)
  }

  /**
   * Coalesce every change in a window into one inbox per phone: the first change
   * after a quiet second goes out on the next tick, later ones wait for the
   * window to close, and the trailing flush always carries the latest state.
   */
  private scheduleInbox(): void {
    if (this.inboxTimer !== null) return
    if (this.pairedSessions().length === 0) return
    const wait = Math.max(0, this.lastInboxFlushAt + INBOX_THROTTLE_MS - this.timers.now())
    this.inboxTimer = this.timers.setTimeout(() => {
      this.inboxTimer = null
      this.flushInbox()
    }, wait)
  }

  private flushInbox(): void {
    const sessions = this.pairedSessions()
    if (sessions.length === 0) return
    this.lastInboxFlushAt = this.timers.now()
    const inbox = this.currentInbox()
    for (const session of sessions) this.sendInbox(session, inbox)
  }

  private sendInbox(session: Session, inbox: MobileInbox): void {
    const key = inboxContentKey(inbox)
    if (key === session.lastInboxKey) return
    const seq = session.seq + 1
    if (session.channel.send({ t: 'evt', e: 'inbox', seq, inbox })) {
      session.seq = seq
      session.lastInboxKey = key
    }
  }

  private clearInboxTimer(): void {
    if (this.inboxTimer !== null) {
      this.timers.clearTimeout(this.inboxTimer)
      this.inboxTimer = null
    }
  }

  // ---- misc ------------------------------------------------------------------------

  private clearInvite(): void {
    if (this.inviteTimer !== null) {
      this.timers.clearTimeout(this.inviteTimer)
      this.inviteTimer = null
    }
    this.invite = null
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) {
      this.timers.clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.pending = null
  }

  private desktopName(): string {
    return this.deps.getConfig().desktopName?.trim() || this.deps.defaultDesktopName()
  }

  private emitState(): void {
    if (!this.started) return
    const state = this.getState()
    const key = JSON.stringify(state)
    if (key === this.lastBroadcastKey) return
    this.lastBroadcastKey = key
    this.deps.broadcastState(state)
  }

  private log(message: string): void {
    this.deps.log(`mobile ${message}`)
  }
}
