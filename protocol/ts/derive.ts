import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto'
import { toBytes, utf8Encode } from './encoding.ts'

/**
 * Values derived from the pairing secret `s` (§2). The relay gets `relayToken` (and only
 * ever stores its hash), while `pairProof` goes inside the Noise handshake, so a relay
 * that sees the token still can't forge the proof.
 */

export const RELAY_TOKEN_INFO = 'devtool-relay-token-v1'
export const PAIR_PROOF_INFO = 'devtool-pair-proof-v1'

/** HKDF-SHA256 with an empty salt (RFC 5869 treats that as HashLen zero bytes). */
export function hkdfSha256(ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array(0), utf8Encode(info), length))
}

export function sha256(data: Uint8Array): Uint8Array {
  return toBytes(createHash('sha256').update(data).digest())
}

export function deriveRelayToken(secret: Uint8Array): Uint8Array {
  return hkdfSha256(secret, RELAY_TOKEN_INFO)
}

export function derivePairProof(secret: Uint8Array): Uint8Array {
  return hkdfSha256(secret, PAIR_PROOF_INFO)
}

/** What the desktop puts in its relay `offer`, and what the relay compares a phone's token against. */
export function tokenHash(relayToken: Uint8Array): Uint8Array {
  return sha256(relayToken)
}

/** Constant-time on equal lengths; differing lengths return false immediately (length isn't secret). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
