import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'
import { concatBytes, toBytes, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { generateX25519, x25519Dh } from './keys.ts'
import type { KeyPair } from './keys.ts'

/**
 * Noise_IK_25519_AESGCM_SHA256, written against the Noise spec revision 34
 * (https://noiseprotocol.org/noise.html) and checked against the cacophony, snow and
 * noise-c vectors in `protocol/vectors/official/`. Only IK is implemented: the phone
 * (initiator) already knows the desktop's static key from the QR code.
 *
 * Section numbers in comments refer to the Noise spec.
 */

export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_AESGCM_SHA256'
/** Prologue for the DevTool phone ↔ desktop channel (§4.2); pass it UTF-8 encoded. */
export const DEVTOOL_NOISE_PROLOGUE = 'devtool-mobile-v1'
/** §3: every Noise message, handshake or transport, is at most 65535 bytes. */
export const NOISE_MAX_MESSAGE = 65535
const DHLEN = 32
const HASHLEN = 32
const TAGLEN = 16
/** 2^64 - 1 is reserved (§5.1), so this is the first nonce we refuse to use. */
const MAX_NONCE = (1n << 64n) - 1n
const EMPTY = new Uint8Array(0)

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return toBytes(hash.digest())
}

function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const hmac = createHmac('sha256', key)
  for (const part of parts) hmac.update(part)
  return toBytes(hmac.digest())
}

/** §4.3 HKDF with two outputs (Noise's own construction, not RFC 5869's API). */
function noiseHkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmacSha256(chainingKey, ikm)
  const out1 = hmacSha256(tempKey, Uint8Array.of(1))
  const out2 = hmacSha256(tempKey, out1, Uint8Array.of(2))
  return [out1, out2]
}

/*
 * The cipher is AES-256-GCM rather than ChaChaPoly because Electron's main process is
 * built on BoringSSL, whose Node `crypto` has no chacha20-poly1305. AES-GCM is available
 * in Electron, Node and CryptoKit alike, so nothing has to be hand-rolled. The whole
 * cipher is the `aeadEncrypt`/`aeadDecrypt` pair below.
 */

/** Noise spec "The AESGCM cipher functions": 32 bits of zeros followed by the 64-bit counter, big-endian (AESGCM, unlike ChaChaPoly). */
function aeadNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, n, false)
  return nonce
}

function aeadEncrypt(key: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', key, aeadNonce(n), { authTagLength: TAGLEN })
  cipher.setAAD(ad)
  const body = cipher.update(plaintext)
  cipher.final()
  return concatBytes(toBytes(body), toBytes(cipher.getAuthTag()))
}

function aeadDecrypt(key: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < TAGLEN) throw new ProtocolError('ciphertext too short')
  const body = ciphertext.subarray(0, ciphertext.length - TAGLEN)
  const decipher = createDecipheriv('aes-256-gcm', key, aeadNonce(n), { authTagLength: TAGLEN })
  decipher.setAAD(ad)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN))
  const plaintext = decipher.update(body)
  try {
    decipher.final()
  } catch (err) {
    throw new ProtocolError('decryption failed', { cause: err })
  }
  return toBytes(plaintext)
}

/** §5.1 */
export class CipherState {
  #k: Uint8Array | null = null
  #n = 0n

  constructor(key?: Uint8Array) {
    if (key) this.initializeKey(key)
  }

  initializeKey(key: Uint8Array | null): void {
    this.#k = key ? Uint8Array.from(key) : null
    this.#n = 0n
  }

  hasKey(): boolean {
    return this.#k !== null
  }

  /** Exposed for tests and diagnostics; the next nonce this state will use. */
  get nonce(): bigint {
    return this.#n
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#k) return Uint8Array.from(plaintext)
    if (this.#n >= MAX_NONCE) throw new ProtocolError('nonce exhausted')
    const out = aeadEncrypt(this.#k, this.#n, ad, plaintext)
    this.#n++
    return out
  }

  /** On failure the nonce does not advance (§5.1), so a forged frame can't desync us. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#k) return Uint8Array.from(ciphertext)
    if (this.#n >= MAX_NONCE) throw new ProtocolError('nonce exhausted')
    const out = aeadDecrypt(this.#k, this.#n, ad, ciphertext)
    this.#n++
    return out
  }
}

/** §5.2 */
export class SymmetricState {
  readonly cipher = new CipherState()
  #ck: Uint8Array
  #h: Uint8Array

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName)
    // Names up to HASHLEN are zero-padded; longer ones (ours is 32+) are hashed.
    if (name.length <= HASHLEN) {
      this.#h = new Uint8Array(HASHLEN)
      this.#h.set(name)
    } else {
      this.#h = sha256(name)
    }
    this.#ck = Uint8Array.from(this.#h)
  }

  get handshakeHash(): Uint8Array {
    return Uint8Array.from(this.#h)
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf2(this.#ck, ikm)
    this.#ck = ck
    this.cipher.initializeKey(tempK)
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(this.#h, data)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.#h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.#h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf2(this.#ck, EMPTY)
    return [new CipherState(k1), new CipherState(k2)]
  }
}

/**
 * The two directions of an established session. The phone (initiator) sends with `k1`
 * and the desktop sends with `k2` (SPEC.md §4.2), which `split()` sorts out.
 */
export class NoiseTransport {
  readonly handshakeHash: Uint8Array
  readonly remoteStatic: Uint8Array
  readonly #send: CipherState
  readonly #recv: CipherState

  constructor(send: CipherState, recv: CipherState, handshakeHash: Uint8Array, remoteStatic: Uint8Array) {
    this.#send = send
    this.#recv = recv
    this.handshakeHash = handshakeHash
    this.remoteStatic = remoteStatic
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length + TAGLEN > NOISE_MAX_MESSAGE) throw new ProtocolError('message too large for Noise')
    return this.#send.encryptWithAd(EMPTY, plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length > NOISE_MAX_MESSAGE) throw new ProtocolError('message too large for Noise')
    return this.#recv.decryptWithAd(EMPTY, ciphertext)
  }

  /** Counters of the next message in each direction; handy for tests and logging. */
  get sendNonce(): bigint {
    return this.#send.nonce
  }

  get recvNonce(): bigint {
    return this.#recv.nonce
  }
}

export interface HandshakeOptions {
  prologue: Uint8Array
  /** Our long-term X25519 keypair. */
  s: KeyPair
  /** Injected ephemeral key; only for test vectors. Omit in real use. */
  e?: KeyPair
}

export interface InitiatorOptions extends HandshakeOptions {
  /** The responder's static public key, known in advance (from the QR code). */
  rs: Uint8Array
}

/**
 * §5.3 specialised to IK:
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 * Each instance is single-use: once the two messages are done, call `split()`.
 */
export class HandshakeState {
  readonly initiator: boolean
  readonly #ss: SymmetricState
  readonly #s: KeyPair
  #e: KeyPair | null
  #rs: Uint8Array | null
  #re: Uint8Array | null = null
  /** 0 = expecting message 1, 1 = expecting message 2, 2 = done. */
  #step = 0

  constructor(initiator: boolean, options: HandshakeOptions & { rs?: Uint8Array }) {
    this.initiator = initiator
    this.#s = options.s
    this.#e = options.e ?? null
    this.#rs = options.rs ? Uint8Array.from(options.rs) : null
    if (initiator && !this.#rs) throw new ProtocolError('IK initiator needs the responder static key')
    this.#ss = new SymmetricState(NOISE_PROTOCOL_NAME)
    this.#ss.mixHash(options.prologue)
    // Pre-message pattern `<- s`: both sides hash the responder's static key.
    this.#ss.mixHash(initiator ? this.#rs! : this.#s.pub)
  }

  get isComplete(): boolean {
    return this.#step === 2
  }

  get handshakeHash(): Uint8Array {
    return this.#ss.handshakeHash
  }

  /** The peer's static key; for the responder it's known only after reading message 1. */
  get remoteStatic(): Uint8Array | null {
    return this.#rs ? Uint8Array.from(this.#rs) : null
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    const writing = this.#step === 0 ? this.initiator : !this.initiator
    if (this.#step >= 2 || !writing) throw new ProtocolError('not our turn to write a handshake message')
    const parts: Uint8Array[] = []
    const e = this.#e ?? generateX25519()
    this.#e = e
    parts.push(e.pub)
    this.#ss.mixHash(e.pub)
    if (this.#step === 0) {
      this.#ss.mixKey(x25519Dh(e.priv, this.#rs!)) // es
      parts.push(this.#ss.encryptAndHash(this.#s.pub)) // s
      this.#ss.mixKey(x25519Dh(this.#s.priv, this.#rs!)) // ss
    } else {
      this.#ss.mixKey(x25519Dh(e.priv, this.#re!)) // ee
      this.#ss.mixKey(x25519Dh(e.priv, this.#rs!)) // se (responder side: e with initiator's s)
    }
    parts.push(this.#ss.encryptAndHash(payload))
    const message = concatBytes(...parts)
    if (message.length > NOISE_MAX_MESSAGE) throw new ProtocolError('handshake message too large')
    this.#step++
    return message
  }

  readMessage(message: Uint8Array): Uint8Array {
    const reading = this.#step === 0 ? !this.initiator : this.initiator
    if (this.#step >= 2 || !reading) throw new ProtocolError('not our turn to read a handshake message')
    if (message.length > NOISE_MAX_MESSAGE) throw new ProtocolError('handshake message too large')
    let offset = 0
    const take = (length: number): Uint8Array => {
      if (message.length - offset < length) throw new ProtocolError('handshake message truncated')
      const out = message.subarray(offset, offset + length)
      offset += length
      return out
    }
    const re = Uint8Array.from(take(DHLEN))
    this.#re = re
    this.#ss.mixHash(re)
    if (this.#step === 0) {
      this.#ss.mixKey(x25519Dh(this.#s.priv, re)) // es
      this.#rs = Uint8Array.from(this.#ss.decryptAndHash(take(DHLEN + TAGLEN))) // s
      this.#ss.mixKey(x25519Dh(this.#s.priv, this.#rs)) // ss
    } else {
      this.#ss.mixKey(x25519Dh(this.#e!.priv, re)) // ee
      this.#ss.mixKey(x25519Dh(this.#s.priv, re)) // se (initiator side: s with responder's e)
    }
    const payload = this.#ss.decryptAndHash(message.subarray(offset))
    this.#step++
    return payload
  }

  split(): NoiseTransport {
    if (this.#step !== 2) throw new ProtocolError('handshake not complete')
    const [c1, c2] = this.#ss.split()
    const [send, recv] = this.initiator ? [c1, c2] : [c2, c1]
    return new NoiseTransport(send, recv, this.#ss.handshakeHash, this.#rs!)
  }
}

export function createInitiator(options: InitiatorOptions): HandshakeState {
  return new HandshakeState(true, options)
}

export function createResponder(options: HandshakeOptions): HandshakeState {
  return new HandshakeState(false, options)
}
