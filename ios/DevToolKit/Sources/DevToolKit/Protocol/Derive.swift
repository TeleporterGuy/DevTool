import Foundation

/// Values derived from the pairing secret `s` (SPEC.md §2), as `protocol/ts/derive.ts`.
/// The relay gets `relayToken` (and only ever stores its hash); `pairProof`
/// goes inside the Noise handshake, so a relay that sees the token still can't
/// forge the proof.
public enum Derive {
    public static let relayTokenInfo = "devtool-relay-token-v1"
    public static let pairProofInfo = "devtool-pair-proof-v1"

    public static func relayToken(secret: Data) -> Data {
        Primitives.hkdfSha256(ikm: secret, info: relayTokenInfo)
    }

    public static func pairProof(secret: Data) -> Data {
        Primitives.hkdfSha256(ikm: secret, info: pairProofInfo)
    }

    /// What the desktop puts in its relay `offer`.
    public static func tokenHash(relayToken: Data) -> Data {
        Primitives.sha256(relayToken)
    }

    /// §1: lowercase hex of the first 16 bytes of SHA-256(ed25519Pub).
    public static func deviceId(ed25519Pub: Data) throws(ProtocolError) -> String {
        guard ed25519Pub.count == 32 else { throw ProtocolError("Ed25519 public key must be 32 bytes") }
        return DeviceId(ed25519PublicKey: ed25519Pub).rawValue
    }
}
