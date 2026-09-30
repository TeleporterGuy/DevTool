import CryptoKit
import Foundation

/// A raw 32-byte keypair (X25519 scalar or Ed25519 seed, plus the public key).
/// Mirrors `KeyPair` in `protocol/ts/keys.ts`.
public struct KeyPair: Sendable, Equatable {
    public let priv: Data
    public let pub: Data

    public init(priv: Data, pub: Data) {
        self.priv = priv
        self.pub = pub
    }
}

/// The primitives the protocol is built from, all on CryptoKit.
public enum Primitives {
    // MARK: Hashes

    public static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    public static func hmacSha256(key: Data, _ parts: Data...) -> Data {
        var hmac = HMAC<SHA256>(key: SymmetricKey(data: key))
        for part in parts { hmac.update(data: part) }
        return Data(hmac.finalize())
    }

    /// RFC 5869 HKDF-SHA256 with an empty salt (which RFC 5869 treats as
    /// HashLen zero bytes), as `hkdfSha256` in `protocol/ts/derive.ts`.
    public static func hkdfSha256(ikm: Data, info: String, length: Int = 32) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data(),
            info: Data(info.utf8),
            outputByteCount: length
        )
        return key.withUnsafeBytes { Data($0) }
    }

    /// Constant-time on equal lengths; differing lengths return false at once.
    public static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    // MARK: X25519

    public static func generateX25519() -> KeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(priv: key.rawRepresentation, pub: key.publicKey.rawRepresentation)
    }

    public static func x25519(fromPrivate priv: Data) throws(ProtocolError) -> KeyPair {
        guard priv.count == 32 else { throw ProtocolError("X25519 private key must be 32 bytes") }
        do {
            let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
            return KeyPair(priv: priv, pub: key.publicKey.rawRepresentation)
        } catch {
            throw ProtocolError("invalid X25519 private key")
        }
    }

    /// Raw X25519. An all-zero shared secret (a low-order peer key) is refused,
    /// as Node does and as Noise recommends.
    public static func x25519(priv: Data, pub: Data) throws(ProtocolError) -> Data {
        guard priv.count == 32 else { throw ProtocolError("X25519 private key must be 32 bytes") }
        guard pub.count == 32 else { throw ProtocolError("X25519 public key must be 32 bytes") }
        let shared: Data
        do {
            let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
            let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub)
            shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey).withUnsafeBytes { Data($0) }
        } catch {
            throw ProtocolError("X25519 failed")
        }
        guard shared.contains(where: { $0 != 0 }) else { throw ProtocolError("X25519 produced an all-zero secret") }
        return shared
    }

    // MARK: Ed25519

    public static func generateEd25519() -> KeyPair {
        let key = Curve25519.Signing.PrivateKey()
        return KeyPair(priv: key.rawRepresentation, pub: key.publicKey.rawRepresentation)
    }

    public static func ed25519(fromSeed seed: Data) throws(ProtocolError) -> KeyPair {
        guard seed.count == 32 else { throw ProtocolError("Ed25519 seed must be 32 bytes") }
        do {
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            return KeyPair(priv: seed, pub: key.publicKey.rawRepresentation)
        } catch {
            throw ProtocolError("invalid Ed25519 seed")
        }
    }

    /// Ed25519 signature. CryptoKit's signatures are randomized (hedged), not
    /// the deterministic RFC 8032 ones Node produces, but both verify the same.
    public static func ed25519Sign(seed: Data, message: Data) throws(ProtocolError) -> Data {
        guard seed.count == 32 else { throw ProtocolError("Ed25519 seed must be 32 bytes") }
        do {
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
            return try key.signature(for: message)
        } catch {
            throw ProtocolError("Ed25519 signing failed")
        }
    }

    /// Never throws: a malformed key or signature is simply "not verified".
    public static func ed25519Verify(pub: Data, message: Data, signature: Data) -> Bool {
        guard signature.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub)
        else { return false }
        return key.isValidSignature(signature, for: message)
    }

    // MARK: AEAD: AES-256-GCM with the Noise nonce
    //
    // The whole cipher lives in this function pair (and `Noise.protocolName`),
    // so swapping the suite touches nothing else.

    static let tagLength = 16

    /// Noise §12.4 (AESGCM): 32 bits of zeros followed by the 64-bit counter, big-endian.
    static func aeadNonce(_ n: UInt64) -> Data {
        var nonce = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { nonce.append(contentsOf: $0) }
        return nonce
    }

    /// `ciphertext || tag`.
    static func aeadEncrypt(key: Data, n: UInt64, ad: Data, plaintext: Data) throws(ProtocolError) -> Data {
        do {
            let box = try AES.GCM.seal(
                plaintext,
                using: SymmetricKey(data: key),
                nonce: try AES.GCM.Nonce(data: aeadNonce(n)),
                authenticating: ad
            )
            return Data.concat(box.ciphertext, box.tag)
        } catch {
            throw ProtocolError("encryption failed")
        }
    }

    static func aeadDecrypt(key: Data, n: UInt64, ad: Data, ciphertext: Data) throws(ProtocolError) -> Data {
        guard ciphertext.count >= tagLength else { throw ProtocolError("ciphertext too short") }
        let body = ciphertext.prefix(ciphertext.count - tagLength)
        let tag = ciphertext.suffix(tagLength)
        do {
            let box = try AES.GCM.SealedBox(
                nonce: try AES.GCM.Nonce(data: aeadNonce(n)),
                ciphertext: body,
                tag: tag
            )
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: ad)
        } catch {
            throw ProtocolError("decryption failed")
        }
    }
}
