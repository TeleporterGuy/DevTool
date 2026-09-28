import { describe, expect, it } from 'vitest'
import { b64uDecode, b64uDecodeLength, b64uEncode, bytesEqual, concatBytes, hexDecode, hexEncode, utf8Decode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { constantTimeEqual, derivePairProof, deriveRelayToken, hkdfSha256, sha256, tokenHash } from './derive.ts'
import {
  deviceId, ed25519FromPrivate, ed25519Sign, ed25519Verify, generateEd25519, generateX25519, isDeviceId, x25519Dh, x25519FromPrivate
} from './keys.ts'
import { FrameKind, decodeEnvelope, encodeEnvelope } from './envelope.ts'

describe('encoding', () => {
  it('b64u round-trips without padding', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      const text = b64uEncode(bytes)
      expect(text).not.toMatch(/[=+/]/)
      expect(b64uDecode(text)).toEqual(bytes)
    }
  })

  it('b64u rejects padding, foreign alphabets and non-canonical tails', () => {
    for (const bad of ['AA==', 'a+b/', 'A', 'AB', 'ab cd', 'ab\n']) expect(() => b64uDecode(bad), bad).toThrow(ProtocolError)
    expect(b64uDecode('AA')).toEqual(Uint8Array.of(0))
  })

  it('checks lengths', () => {
    expect(() => b64uDecodeLength(b64uEncode(new Uint8Array(31)), 32, 'key')).toThrow('key must be 32 bytes')
    expect(b64uDecodeLength(b64uEncode(new Uint8Array(32)), 32)).toHaveLength(32)
  })

  it('hex, utf8, concat and equality', () => {
    expect(hexEncode(hexDecode('00ff10'))).toBe('00ff10')
    expect(hexDecode('ABcd')).toEqual(Uint8Array.of(0xab, 0xcd))
    expect(() => hexDecode('abc')).toThrow(ProtocolError)
    expect(() => hexDecode('zz')).toThrow(ProtocolError)
    expect(utf8Decode(utf8Encode('kůň 🐴'))).toBe('kůň 🐴')
    expect(() => utf8Decode(Uint8Array.of(0xff))).toThrow(ProtocolError)
    expect(concatBytes(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3))).toEqual(Uint8Array.of(1, 2, 3))
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true)
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false)
  })

  it('never hands out Buffers', () => {
    expect(Object.getPrototypeOf(b64uDecode('AAAA'))).toBe(Uint8Array.prototype)
    expect(Object.getPrototypeOf(sha256(new Uint8Array(0)))).toBe(Uint8Array.prototype)
  })
})

describe('keys', () => {
  it('rebuilds keypairs from raw private keys', () => {
    const x = generateX25519()
    expect(x25519FromPrivate(x.priv)).toEqual(x)
    const ed = generateEd25519()
    expect(ed25519FromPrivate(ed.priv)).toEqual(ed)
    expect(x.pub).toHaveLength(32)
    expect(ed.pub).toHaveLength(32)
  })

  it('matches RFC 7748 §6.1 (X25519)', () => {
    const alice = x25519FromPrivate(hexDecode('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'))
    const bob = x25519FromPrivate(hexDecode('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'))
    expect(hexEncode(alice.pub)).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
    expect(hexEncode(bob.pub)).toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
    const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'
    expect(hexEncode(x25519Dh(alice.priv, bob.pub))).toBe(shared)
    expect(hexEncode(x25519Dh(bob.priv, alice.pub))).toBe(shared)
  })

  it('matches RFC 8032 §7.1 test 2 (Ed25519)', () => {
    const key = ed25519FromPrivate(hexDecode('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'))
    expect(hexEncode(key.pub)).toBe('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')
    const sig = ed25519Sign(key.priv, Uint8Array.of(0x72))
    expect(hexEncode(sig)).toBe(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
    )
    expect(ed25519Verify(key.pub, Uint8Array.of(0x72), sig)).toBe(true)
    expect(ed25519Verify(key.pub, Uint8Array.of(0x73), sig)).toBe(false)
    expect(ed25519Verify(key.pub, Uint8Array.of(0x72), sig.subarray(1))).toBe(false)
    expect(ed25519Verify(new Uint8Array(3), Uint8Array.of(0x72), sig)).toBe(false)
  })

  it('rejects a low-order X25519 point', () => {
    expect(() => x25519Dh(generateX25519().priv, new Uint8Array(32))).toThrow(ProtocolError)
  })

  it('derives device IDs', () => {
    const pub = generateEd25519().pub
    const id = deviceId(pub)
    expect(isDeviceId(id)).toBe(true)
    expect(id).toBe(hexEncode(sha256(pub).subarray(0, 16)))
    expect(isDeviceId(id.toUpperCase())).toBe(false)
    expect(() => deviceId(new Uint8Array(31))).toThrow(ProtocolError)
  })
})

describe('derive', () => {
  it('matches RFC 5869 test case 3 (empty salt and info)', () => {
    const okm = hkdfSha256(hexDecode('0b'.repeat(22)), '', 42)
    expect(hexEncode(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8')
  })

  it('keeps relayToken and pairProof independent', () => {
    const s = new Uint8Array(32).fill(9)
    expect(deriveRelayToken(s)).not.toEqual(derivePairProof(s))
    expect(tokenHash(deriveRelayToken(s))).toEqual(sha256(deriveRelayToken(s)))
  })

  it('compares in constant time and handles length mismatches', () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true)
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false)
    expect(constantTimeEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false)
  })
})

describe('envelope', () => {
  it('round-trips each kind', () => {
    for (const kind of [FrameKind.Handshake1, FrameKind.Handshake2, FrameKind.Transport]) {
      const bytes = encodeEnvelope(kind, Uint8Array.of(9, 8))
      expect(bytes).toEqual(Uint8Array.of(kind, 9, 8))
      expect(decodeEnvelope(bytes)).toEqual({ kind, body: Uint8Array.of(9, 8) })
    }
    expect(encodeEnvelope(FrameKind.Reset)).toEqual(Uint8Array.of(4))
    expect(decodeEnvelope(Uint8Array.of(4, 1))).toEqual({ kind: FrameKind.Reset, body: new Uint8Array(0) })
  })

  it('rejects empty frames, unknown kinds and a reset with a body', () => {
    expect(() => decodeEnvelope(new Uint8Array(0))).toThrow(ProtocolError)
    expect(() => decodeEnvelope(Uint8Array.of(5))).toThrow(ProtocolError)
    expect(() => decodeEnvelope(Uint8Array.of(0))).toThrow(ProtocolError)
    expect(() => encodeEnvelope(FrameKind.Reset, Uint8Array.of(1))).toThrow(ProtocolError)
  })
})
