import {
  b64uDecode,
  b64uEncode,
  buildHello,
  decodePairingUri,
  deriveRelayToken,
  encodeRelayMessage,
  parseServerMessage
} from '../../protocol/ts/index.ts'
import type { ClientMessage, PairingPayload, ServerMessage } from '../../protocol/ts/index.ts'
import { FakePhone } from './fake-phone'

/**
 * A FakePhone on a real relay socket (the runtime's global WebSocket): answers the
 * relay challenge as a phone, then shuttles envelopes to and from one desktop.
 */
export class RelayPhone {
  readonly phone: FakePhone
  readonly relayMessages: ServerMessage[] = []
  private socket: WebSocket | null = null
  private readonly desktop: PairingPayload
  ready = false

  constructor(pairingUri: string, name = 'Test iPhone') {
    this.desktop = decodePairingUri(pairingUri)
    this.phone = new FakePhone(b64uDecode(this.desktop.x), name)
  }

  get desktopId(): string {
    return this.desktop.id
  }

  get secret(): Uint8Array {
    return b64uDecode(this.desktop.s)
  }

  /** Connect as a pending phone (with the QR's relay token) or as an already-paired one. */
  connect(mode: 'pair' | 'resume'): Promise<void> {
    this.ready = false
    const socket = new WebSocket(`${this.desktop.relay}/v1`)
    this.socket = socket
    return new Promise((resolve, reject) => {
      socket.onerror = () => reject(new Error('phone socket failed'))
      socket.onclose = () => { this.ready = false }
      socket.onmessage = (event) => {
        const message = parseServerMessage(String(event.data))
        if (!message) return
        this.relayMessages.push(message)
        if (message.t === 'challenge') {
          this.send(buildHello({
            role: 'phone',
            nonce: message.nonce,
            ed25519Priv: this.phone.ed.priv,
            ed25519Pub: this.phone.ed.pub,
            ...(mode === 'pair' ? { pair: { to: this.desktop.id, token: deriveRelayToken(this.secret) } } : {})
          }))
        } else if (message.t === 'ready') {
          this.ready = true
          resolve()
        } else if (message.t === 'frame' && message.from === this.desktop.id) {
          this.phone.receiveB64(message.data)
        } else if (message.t === 'error' && message.code === 'auth') {
          reject(new Error('relay refused the phone'))
        }
      }
    })
  }

  /** Send everything the phone has queued for the desktop. */
  flush(): void {
    for (const envelope of this.phone.outbox.splice(0)) {
      this.send({ t: 'frame', to: this.desktop.id, data: b64uEncode(envelope) })
    }
  }

  send(message: ClientMessage): void {
    this.socket?.send(encodeRelayMessage(message))
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
