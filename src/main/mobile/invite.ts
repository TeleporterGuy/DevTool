import { randomBytes } from 'crypto'
import {
  PAIRING_TTL_SECONDS,
  b64uEncode,
  derivePairProof,
  deriveRelayToken,
  encodePairingUri,
  toBytes,
  tokenHash
} from '../../../protocol/ts/index.ts'
import type { DesktopIdentity } from './identity'
import type { CreateInviteOptions, PairingInvite } from './mobile-service'

/** A fresh single-use pairing offer (SPEC.md §2): the QR payload plus what the relay and handshake need. */
export function createInvite(
  identity: DesktopIdentity,
  { relayUrl, desktopName, now }: CreateInviteOptions,
  randomSecret: () => Uint8Array = () => toBytes(randomBytes(32))
): PairingInvite {
  const secret = randomSecret()
  const exp = Math.floor(now / 1000) + PAIRING_TTL_SECONDS
  const uri = encodePairingUri({
    v: 1,
    relay: relayUrl,
    id: identity.id,
    x: b64uEncode(identity.x25519.pub),
    e: b64uEncode(identity.ed25519.pub),
    s: b64uEncode(secret),
    n: desktopName,
    exp
  })
  return {
    uri,
    exp,
    tokenHash: b64uEncode(tokenHash(deriveRelayToken(secret))),
    pairProof: derivePairProof(secret)
  }
}
