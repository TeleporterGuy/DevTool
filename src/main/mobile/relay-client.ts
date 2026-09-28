import {
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_PATH,
  RELAY_PING_INTERVAL_MS,
  RelayCloseCode,
  buildHello,
  encodeRelayMessage,
  parseServerMessage
} from '../../../protocol/ts/index.ts'
import type { ClientMessage, KeyPair, ServerMessage } from '../../../protocol/ts/index.ts'
import type { RelayDesktopMessage, RelayServerMessage, RelayTransport, RelayTransportState } from './mobile-service'

/** The slice of the WHATWG WebSocket the client uses (Node ≥ 22's global, or a fake). */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

const OPEN = 1

export interface RelayClientTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface RelayClientOptions {
  /** Our Ed25519 keypair (read lazily: the identity loads on first use). */
  ed25519: () => KeyPair
  /** Our device ID, to check the relay's `ready`. */
  deviceId: () => string
  createSocket?: (url: string) => WebSocketLike
  log?: (message: string) => void
  timers?: RelayClientTimers
  /** Reconnect backoff bounds (plan: 1 s → 30 s). */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** How long challenge → ready may take before the attempt is abandoned. */
  authTimeoutMs?: number
  pingIntervalMs?: number
  idleTimeoutMs?: number
}

const realTimers: RelayClientTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

function defaultSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!Ctor) throw new Error('WebSocket is not available in this runtime')
  return new Ctor(url)
}

function describeClose(code: number, reason: string): string {
  switch (code) {
    case RelayCloseCode.Auth: return 'Relay refused this desktop'
    case RelayCloseCode.HelloTimeout: return 'Relay timed out waiting for this desktop'
    case RelayCloseCode.Replaced: return 'Another connection took over'
    case RelayCloseCode.Rate: return 'Rate limited by the relay'
    case RelayCloseCode.TooBig: return 'Message too large for the relay'
    case RelayCloseCode.GoingAway: return 'Relay went away'
  }
  return reason || 'Connection lost'
}

/**
 * The desktop's connection to the relay (SPEC.md §3): opens `<relay>/v1`, answers the
 * challenge, keeps the socket alive with pings, notices a silent one, and reconnects
 * with exponential backoff until `close()`. Only `frame`, `peer` and `error` reach
 * the service, and only after `ready`.
 */
export class RelayClient implements RelayTransport {
  private readonly timers: RelayClientTimers
  private readonly createSocket: (url: string) => WebSocketLike
  private readonly log: (message: string) => void
  private readonly minBackoff: number
  private readonly maxBackoff: number
  private state: RelayTransportState = { kind: 'idle' }
  private socket: WebSocketLike | null = null
  private url: string | null = null
  private ready = false
  private backoff: number
  private lastError: string | undefined
  private reconnectTimer: unknown = null
  private authTimer: unknown = null
  private pingTimer: unknown = null
  private lastReceivedAt = 0
  private readonly messageListeners = new Set<(message: RelayServerMessage) => void>()
  private readonly stateListeners = new Set<(state: RelayTransportState) => void>()

  constructor(private readonly options: RelayClientOptions) {
    this.timers = options.timers ?? realTimers
    this.createSocket = options.createSocket ?? defaultSocket
    this.log = options.log ?? (() => {})
    this.minBackoff = options.minBackoffMs ?? 1000
    this.maxBackoff = options.maxBackoffMs ?? 30_000
    this.backoff = this.minBackoff
  }

  connect(relayUrl: string): void {
    this.url = relayUrl.replace(/\/+$/, '') + RELAY_PATH
    this.backoff = this.minBackoff
    this.open()
  }

  close(): void {
    this.url = null
    this.clearTimers()
    this.dropSocket(1000, 'closing')
    this.setState({ kind: 'idle' })
  }

  send(message: RelayDesktopMessage): boolean {
    if (!this.ready) return false
    return this.write(message)
  }

  getState(): RelayTransportState {
    return this.state
  }

  onMessage(listener: (message: RelayServerMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  onStateChange(listener: (state: RelayTransportState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  // ---- connection lifecycle ------------------------------------------------------

  private open(): void {
    if (!this.url) return
    this.clearTimers()
    this.dropSocket(1000, 'reconnecting')
    this.setState({ kind: 'connecting' })
    let socket: WebSocketLike
    try {
      socket = this.createSocket(this.url)
    } catch (err) {
      this.failed(err instanceof Error ? err.message : String(err))
      return
    }
    this.socket = socket
    this.lastReceivedAt = this.timers.now()
    const authTimeout = this.options.authTimeoutMs ?? 15_000
    this.authTimer = this.timers.setTimeout(() => {
      this.authTimer = null
      if (this.socket === socket && !this.ready) this.failed('Relay did not answer')
    }, authTimeout)
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastReceivedAt = this.timers.now()
      if (typeof event.data !== 'string') return
      this.handle(event.data)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.failed(describeClose(event.code, event.reason))
    }
    socket.onerror = () => {
      // `close` follows with the code; remember that the attempt itself failed.
      if (this.socket === socket && !this.ready) this.lastError = 'Relay unreachable'
    }
  }

  private handle(text: string): void {
    let message: ServerMessage | null
    try {
      message = parseServerMessage(text)
    } catch (err) {
      this.log(`relay sent a malformed message: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!message) return
    switch (message.t) {
      case 'challenge': {
        const keys = this.options.ed25519()
        this.write(buildHello({ role: 'desktop', nonce: message.nonce, ed25519Priv: keys.priv, ed25519Pub: keys.pub }))
        return
      }
      case 'ready':
        if (message.id !== this.options.deviceId()) {
          this.log(`relay says our id is ${message.id}, expected ${this.options.deviceId()}`)
        }
        this.onReady()
        return
      case 'ping':
        this.write({ t: 'pong' })
        return
      case 'pong':
        return
      case 'frame':
      case 'peer':
      case 'error':
        if (!this.ready) {
          if (message.t === 'error') this.lastError = message.message ?? `Relay error: ${message.code}`
          return
        }
        for (const listener of this.messageListeners) listener(message)
        return
    }
  }

  private onReady(): void {
    this.ready = true
    this.backoff = this.minBackoff
    this.lastError = undefined
    if (this.authTimer !== null) {
      this.timers.clearTimeout(this.authTimer)
      this.authTimer = null
    }
    const pingEvery = this.options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS
    const idleAfter = this.options.idleTimeoutMs ?? RELAY_IDLE_TIMEOUT_MS
    this.pingTimer = this.timers.setInterval(() => {
      if (this.timers.now() - this.lastReceivedAt >= idleAfter) {
        this.failed('Relay stopped responding')
        return
      }
      this.write({ t: 'ping' })
    }, pingEvery)
    this.setState({ kind: 'online' })
  }

  /** This attempt is over: tell the service and schedule the next one. */
  private failed(reason: string): void {
    const error = this.lastError && !this.ready ? this.lastError : reason
    this.lastError = undefined
    this.clearTimers()
    this.dropSocket(1000, 'retrying')
    if (!this.url) return
    this.setState({ kind: 'offline', error })
    const delay = this.backoff
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2)
    this.log(`relay offline (${error}); retrying in ${delay} ms`)
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private dropSocket(code: number, reason: string): void {
    const socket = this.socket
    this.socket = null
    this.ready = false
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try { socket.close(code, reason) } catch { /* already closed */ }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.authTimer !== null) { this.timers.clearTimeout(this.authTimer); this.authTimer = null }
    if (this.pingTimer !== null) { this.timers.clearInterval(this.pingTimer); this.pingTimer = null }
  }

  private write(message: ClientMessage): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    try {
      socket.send(encodeRelayMessage(message))
      return true
    } catch {
      return false
    }
  }

  private setState(state: RelayTransportState): void {
    const same = this.state.kind === state.kind
      && (this.state as { error?: string }).error === (state as { error?: string }).error
    this.state = state
    if (same) return
    for (const listener of this.stateListeners) listener(state)
  }
}
