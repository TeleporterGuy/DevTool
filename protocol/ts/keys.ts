import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { b64uDecode, b64uEncode, concatBytes, hexDecode, hexEncode, toBytes } from './encoding.ts'
import { ProtocolError } from './errors.ts'

/**
 * Long-term device keys (§1). Every key crosses the wire, the Keychain and the test
 * vectors as raw 32 bytes, so this module is the only place that deals in KeyObjects.
 *
 * Private keys are imported as PKCS#8 DER rather than JWK: Node's JWK importer insists
 * on the public `x` alongside `d`, and we only have `d` until we've derived `x`.
 * Public keys are imported as JWK (`kty: 'OKP'`), which takes raw bytes directly.
 */

export interface KeyPair {
  /** Raw 32-byte private key (X25519 scalar or Ed25519 seed). */
  priv: Uint8Array
  /** Raw 32-byte public key. */
  pub: Uint8Array
}

type Curve = 'X25519' | 'Ed25519'

// RFC 8410 PKCS#8 wrappers; the raw key follows as a 32-byte OCTET STRING.
const PKCS8_PREFIX: Record<Curve, Uint8Array> = {
  X25519: hexDecode('302e020100300506032b656e04220420'),
  Ed25519: hexDecode('302e020100300506032b657004220420')
}

function checkKeyLength(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new ProtocolError(`${what} must be 32 bytes`)
  }
}

function privateKeyObject(curve: Curve, priv: Uint8Array): KeyObject {
  checkKeyLength(priv, `${curve} private key`)
  return createPrivateKey({ key: Buffer.from(concatBytes(PKCS8_PREFIX[curve], priv)), format: 'der', type: 'pkcs8' })
}

function publicKeyObject(curve: Curve, pub: Uint8Array): KeyObject {
  checkKeyLength(pub, `${curve} public key`)
  return createPublicKey({ key: { kty: 'OKP', crv: curve, x: b64uEncode(pub) }, format: 'jwk' })
}

function rawPublic(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: 'jwk' })
  return b64uDecode(jwk.x as string)
}

function rawPrivate(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: 'jwk' })
  return b64uDecode(jwk.d as string)
}

function keyPairFromPrivate(curve: Curve, priv: Uint8Array): KeyPair {
  const key = privateKeyObject(curve, priv)
  return { priv: Uint8Array.from(priv), pub: rawPublic(createPublicKey(key)) }
}

function generate(curve: Curve): KeyPair {
  const { privateKey, publicKey } = curve === 'X25519' ? generateKeyPairSync('x25519') : generateKeyPairSync('ed25519')
  return { priv: rawPrivate(privateKey), pub: rawPublic(publicKey) }
}

export function generateX25519(): KeyPair {
  return generate('X25519')
}

export function x25519FromPrivate(priv: Uint8Array): KeyPair {
  return keyPairFromPrivate('X25519', priv)
}

/**
 * Raw X25519. Node rejects an all-zero shared secret (a low-order peer key), which is
 * the behaviour Noise recommends anyway; it surfaces as a ProtocolError here.
 */
export function x25519Dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  try {
    return toBytes(diffieHellman({ privateKey: privateKeyObject('X25519', priv), publicKey: publicKeyObject('X25519', pub) }))
  } catch (err) {
    if (err instanceof ProtocolError) throw err
    throw new ProtocolError('X25519 failed', { cause: err })
  }
}

export function generateEd25519(): KeyPair {
  return generate('Ed25519')
}

export function ed25519FromPrivate(seed: Uint8Array): KeyPair {
  return keyPairFromPrivate('Ed25519', seed)
}

/** Deterministic (RFC 8032), which is what lets `relay-auth.json` pin exact signatures. */
export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return toBytes(sign(null, message, privateKeyObject('Ed25519', seed)))
}

/** Never throws: a malformed key or signature is simply "not verified". */
export function ed25519Verify(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (signature.length !== 64) return false
    return verify(null, message, publicKeyObject('Ed25519', pub), signature)
  } catch {
    return false
  }
}

/** §1: lowercase hex of the first 16 bytes of SHA-256(ed25519Pub). */
export function deviceId(ed25519Pub: Uint8Array): string {
  checkKeyLength(ed25519Pub, 'Ed25519 public key')
  return hexEncode(toBytes(createHash('sha256').update(ed25519Pub).digest()).subarray(0, 16))
}

const DEVICE_ID_RE = /^[0-9a-f]{32}$/

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value)
}
