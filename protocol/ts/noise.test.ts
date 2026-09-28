import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hexDecode, hexEncode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { generateX25519, x25519FromPrivate } from './keys.ts'
import { NOISE_MAX_MESSAGE, createInitiator, createResponder } from './noise.ts'
import type { NoiseTransport } from './noise.ts'

interface OfficialVector {
  source: string
  init_prologue: string
  init_static: string
  init_ephemeral: string
  init_remote_static: string
  resp_prologue: string
  resp_static: string
  resp_ephemeral: string
  handshake_hash?: string
  messages: { payload: string; ciphertext: string }[]
}

const official = JSON.parse(
  readFileSync(new URL('../vectors/official/noise-ik-25519-aesgcm-sha256.json', import.meta.url), 'utf8')
) as { vectors: OfficialVector[] }

describe('official Noise_IK_25519_AESGCM_SHA256 vectors', () => {
  it('has vectors to check', () => {
    expect(official.vectors.length).toBeGreaterThanOrEqual(3)
  })

  for (const v of official.vectors) {
    it(`matches ${v.source} byte-for-byte`, () => {
      const respStatic = x25519FromPrivate(hexDecode(v.resp_static))
      expect(hexEncode(respStatic.pub)).toBe(v.init_remote_static)
      const initiator = createInitiator({
        prologue: hexDecode(v.init_prologue),
        s: x25519FromPrivate(hexDecode(v.init_static)),
        e: x25519FromPrivate(hexDecode(v.init_ephemeral)),
        rs: hexDecode(v.init_remote_static)
      })
      const responder = createResponder({
        prologue: hexDecode(v.resp_prologue),
        s: respStatic,
        e: x25519FromPrivate(hexDecode(v.resp_ephemeral))
      })

      const [m1, m2, ...rest] = v.messages
      const c1 = initiator.writeMessage(hexDecode(m1.payload))
      expect(hexEncode(c1)).toBe(m1.ciphertext)
      expect(hexEncode(responder.readMessage(c1))).toBe(m1.payload)
      const c2 = responder.writeMessage(hexDecode(m2.payload))
      expect(hexEncode(c2)).toBe(m2.ciphertext)
      expect(hexEncode(initiator.readMessage(c2))).toBe(m2.payload)

      if (v.handshake_hash) {
        expect(hexEncode(initiator.handshakeHash)).toBe(v.handshake_hash)
        expect(hexEncode(responder.handshakeHash)).toBe(v.handshake_hash)
      }
      const it = initiator.split()
      const rt = responder.split()
      rest.forEach((m, i) => {
        // Messages keep alternating: initiator, responder, initiator, ...
        const [sender, receiver] = i % 2 === 0 ? [it, rt] : [rt, it]
        const ct = sender.encrypt(hexDecode(m.payload))
        expect(hexEncode(ct)).toBe(m.ciphertext)
        expect(hexEncode(receiver.decrypt(ct))).toBe(m.payload)
      })
    })
  }
})

function handshake(): { phone: NoiseTransport; desktop: NoiseTransport; phoneStatic: Uint8Array } {
  const prologue = utf8Encode('devtool-mobile-v1')
  const desktopStatic = generateX25519()
  const phoneStatic = generateX25519()
  const initiator = createInitiator({ prologue, s: phoneStatic, rs: desktopStatic.pub })
  const responder = createResponder({ prologue, s: desktopStatic })
  expect(responder.remoteStatic).toBeNull()
  responder.readMessage(initiator.writeMessage(utf8Encode('hi')))
  expect(responder.remoteStatic).toEqual(phoneStatic.pub)
  initiator.readMessage(responder.writeMessage())
  return { phone: initiator.split(), desktop: responder.split(), phoneStatic: phoneStatic.pub }
}

describe('Noise IK behaviour', () => {
  it('round-trips transport messages both ways and exposes the peer static', () => {
    const { phone, desktop, phoneStatic } = handshake()
    expect(desktop.remoteStatic).toEqual(phoneStatic)
    expect(phone.handshakeHash).toEqual(desktop.handshakeHash)
    for (let i = 0; i < 5; i++) {
      expect(desktop.decrypt(phone.encrypt(utf8Encode(`p${i}`)))).toEqual(utf8Encode(`p${i}`))
      expect(phone.decrypt(desktop.encrypt(utf8Encode(`d${i}`)))).toEqual(utf8Encode(`d${i}`))
    }
    expect(phone.sendNonce).toBe(5n)
  })

  it('rejects a tampered frame without advancing the receive nonce', () => {
    const { phone, desktop } = handshake()
    const ct = phone.encrypt(utf8Encode('hello'))
    const bad = Uint8Array.from(ct)
    bad[0] ^= 1
    expect(() => desktop.decrypt(bad)).toThrow(ProtocolError)
    expect(desktop.recvNonce).toBe(0n)
    expect(desktop.decrypt(ct)).toEqual(utf8Encode('hello'))
  })

  it('rejects a replayed frame', () => {
    const { phone, desktop } = handshake()
    const ct = phone.encrypt(utf8Encode('once'))
    desktop.decrypt(ct)
    expect(() => desktop.decrypt(ct)).toThrow(ProtocolError)
  })

  it('fails the handshake when the initiator has the wrong responder key', () => {
    const prologue = utf8Encode('devtool-mobile-v1')
    const initiator = createInitiator({ prologue, s: generateX25519(), rs: generateX25519().pub })
    const responder = createResponder({ prologue, s: generateX25519() })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(ProtocolError)
  })

  it('fails the handshake on a prologue mismatch', () => {
    const desktopStatic = generateX25519()
    const initiator = createInitiator({ prologue: utf8Encode('a'), s: generateX25519(), rs: desktopStatic.pub })
    const responder = createResponder({ prologue: utf8Encode('b'), s: desktopStatic })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(ProtocolError)
  })

  it('enforces the 65535-byte message limit', () => {
    const { phone } = handshake()
    expect(() => phone.encrypt(new Uint8Array(NOISE_MAX_MESSAGE - 16))).not.toThrow()
    expect(() => phone.encrypt(new Uint8Array(NOISE_MAX_MESSAGE - 15))).toThrow(ProtocolError)
    const initiator = createInitiator({ prologue: new Uint8Array(0), s: generateX25519(), rs: generateX25519().pub })
    expect(() => initiator.writeMessage(new Uint8Array(NOISE_MAX_MESSAGE))).toThrow(ProtocolError)
  })

  it('refuses out-of-order handshake calls', () => {
    const responder = createResponder({ prologue: new Uint8Array(0), s: generateX25519() })
    expect(() => responder.writeMessage()).toThrow(ProtocolError)
    expect(() => responder.split()).toThrow(ProtocolError)
    expect(() => responder.readMessage(new Uint8Array(10))).toThrow(ProtocolError)
  })
})
