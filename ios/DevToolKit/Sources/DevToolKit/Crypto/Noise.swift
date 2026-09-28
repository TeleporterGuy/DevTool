import Foundation

/// Noise_IK_25519_AESGCM_SHA256, written against the Noise spec revision 34
/// (https://noiseprotocol.org/noise.html) and checked against the cacophony,
/// snow and noise-c vectors in `protocol/vectors/official/`. A line-by-line
/// port of `protocol/ts/noise.ts`. Section numbers refer to the Noise spec.
public enum Noise {
    public static let protocolName = "Noise_IK_25519_AESGCM_SHA256"
    /// Prologue for the DevTool phone ↔ desktop channel (SPEC.md §4.2).
    public static let devtoolPrologue = Data("devtool-mobile-v1".utf8)
    /// §3: every Noise message, handshake or transport, is at most 65535 bytes.
    public static let maxMessageLength = 65535

    static let dhLength = 32
    static let hashLength = 32

    /// §4.3: HKDF with two outputs (Noise's own HMAC construction, not RFC 5869's API).
    static func hkdf2(chainingKey: Data, ikm: Data) -> (Data, Data) {
        let tempKey = Primitives.hmacSha256(key: chainingKey, ikm)
        let out1 = Primitives.hmacSha256(key: tempKey, Data([1]))
        let out2 = Primitives.hmacSha256(key: tempKey, out1, Data([2]))
        return (out1, out2)
    }
}

/// §5.1
public struct CipherState: Sendable {
    /// 2^64 - 1 is reserved (§5.1), so this is the first nonce we refuse to use.
    static let maxNonce = UInt64.max

    private var k: Data?
    /// The next nonce this state will use.
    public private(set) var nonce: UInt64 = 0

    public init(key: Data? = nil) {
        k = key
    }

    public mutating func initializeKey(_ key: Data?) {
        k = key
        nonce = 0
    }

    public var hasKey: Bool { k != nil }

    public mutating func encryptWithAd(_ ad: Data, _ plaintext: Data) throws(ProtocolError) -> Data {
        guard let k else { return plaintext }
        guard nonce < Self.maxNonce else { throw ProtocolError("nonce exhausted") }
        let out = try Primitives.aeadEncrypt(key: k, n: nonce, ad: ad, plaintext: plaintext)
        nonce += 1
        return out
    }

    /// On failure the nonce does not advance (§5.1), so a forged frame can't desync us.
    public mutating func decryptWithAd(_ ad: Data, _ ciphertext: Data) throws(ProtocolError) -> Data {
        guard let k else { return ciphertext }
        guard nonce < Self.maxNonce else { throw ProtocolError("nonce exhausted") }
        let out = try Primitives.aeadDecrypt(key: k, n: nonce, ad: ad, ciphertext: ciphertext)
        nonce += 1
        return out
    }
}

/// §5.2
public struct SymmetricState: Sendable {
    public private(set) var cipher = CipherState()
    private var ck: Data
    private var h: Data

    public init(protocolName: String) {
        let name = Data(protocolName.utf8)
        // Names up to HASHLEN are zero-padded; longer ones (ours is 32+) are hashed.
        if name.count <= Noise.hashLength {
            h = name + Data(count: Noise.hashLength - name.count)
        } else {
            h = Primitives.sha256(name)
        }
        ck = h
    }

    public var handshakeHash: Data { h }

    public mutating func mixKey(_ ikm: Data) {
        let (newCk, tempK) = Noise.hkdf2(chainingKey: ck, ikm: ikm)
        ck = newCk
        cipher.initializeKey(tempK)
    }

    public mutating func mixHash(_ data: Data) {
        h = Primitives.sha256(h + data)
    }

    public mutating func encryptAndHash(_ plaintext: Data) throws(ProtocolError) -> Data {
        let ciphertext = try cipher.encryptWithAd(h, plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    public mutating func decryptAndHash(_ ciphertext: Data) throws(ProtocolError) -> Data {
        let plaintext = try cipher.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    public func split() -> (CipherState, CipherState) {
        let (k1, k2) = Noise.hkdf2(chainingKey: ck, ikm: Data())
        return (CipherState(key: k1), CipherState(key: k2))
    }
}

/// The two directions of an established session. The phone (initiator) sends
/// with `k1` and the desktop with `k2` (SPEC.md §4.2); `HandshakeState.split()`
/// sorts that out.
public struct NoiseTransport: Sendable {
    public let handshakeHash: Data
    public let remoteStatic: Data
    private var sendState: CipherState
    private var recvState: CipherState

    init(send: CipherState, recv: CipherState, handshakeHash: Data, remoteStatic: Data) {
        sendState = send
        recvState = recv
        self.handshakeHash = handshakeHash
        self.remoteStatic = remoteStatic
    }

    public mutating func encrypt(_ plaintext: Data) throws(ProtocolError) -> Data {
        guard plaintext.count + Primitives.tagLength <= Noise.maxMessageLength else {
            throw ProtocolError("message too large for Noise")
        }
        return try sendState.encryptWithAd(Data(), plaintext)
    }

    public mutating func decrypt(_ ciphertext: Data) throws(ProtocolError) -> Data {
        guard ciphertext.count <= Noise.maxMessageLength else { throw ProtocolError("message too large for Noise") }
        return try recvState.decryptWithAd(Data(), ciphertext)
    }

    /// Counter of the next message in each direction.
    public var sendNonce: UInt64 { sendState.nonce }
    public var recvNonce: UInt64 { recvState.nonce }
}

/// §5.3 specialised to IK:
///
///     <- s
///     ...
///     -> e, es, s, ss
///     <- e, ee, se
///
/// Each value is single-use: once both messages are done, call `split()`.
public struct HandshakeState: Sendable {
    public let isInitiator: Bool
    private var ss: SymmetricState
    private let s: KeyPair
    private var e: KeyPair?
    private var rs: Data?
    private var re: Data?
    /// 0 = expecting message 1, 1 = expecting message 2, 2 = done.
    private var step = 0

    /// - Parameters:
    ///   - s: our long-term X25519 keypair.
    ///   - e: injected ephemeral keypair; only for test vectors. Omit in real use.
    ///   - rs: the responder's static public key (required for the initiator).
    public init(initiator: Bool, prologue: Data, s: KeyPair, e: KeyPair? = nil, rs: Data? = nil) throws(ProtocolError) {
        isInitiator = initiator
        self.s = s
        self.e = e
        self.rs = rs
        if initiator {
            guard let rs else { throw ProtocolError("IK initiator needs the responder static key") }
            guard rs.count == Noise.dhLength else { throw ProtocolError("responder static key must be 32 bytes") }
        }
        ss = SymmetricState(protocolName: Noise.protocolName)
        ss.mixHash(prologue)
        // Pre-message pattern `<- s`: both sides hash the responder's static key.
        ss.mixHash(initiator ? rs! : s.pub)
    }

    public static func initiator(prologue: Data = Noise.devtoolPrologue, s: KeyPair, rs: Data, e: KeyPair? = nil) throws(ProtocolError) -> HandshakeState {
        try HandshakeState(initiator: true, prologue: prologue, s: s, e: e, rs: rs)
    }

    public static func responder(prologue: Data = Noise.devtoolPrologue, s: KeyPair, e: KeyPair? = nil) throws(ProtocolError) -> HandshakeState {
        try HandshakeState(initiator: false, prologue: prologue, s: s, e: e)
    }

    public var isComplete: Bool { step == 2 }
    public var handshakeHash: Data { ss.handshakeHash }
    /// The peer's static key; for the responder it's known only after reading message 1.
    public var remoteStatic: Data? { rs }

    public mutating func writeMessage(_ payload: Data = Data()) throws(ProtocolError) -> Data {
        let writing = step == 0 ? isInitiator : !isInitiator
        guard step < 2, writing else { throw ProtocolError("not our turn to write a handshake message") }
        let ephemeral = e ?? Primitives.generateX25519()
        e = ephemeral
        var message = ephemeral.pub
        ss.mixHash(ephemeral.pub)
        if step == 0 {
            ss.mixKey(try Primitives.x25519(priv: ephemeral.priv, pub: rs!)) // es
            message += try ss.encryptAndHash(s.pub) // s
            ss.mixKey(try Primitives.x25519(priv: s.priv, pub: rs!)) // ss
        } else {
            ss.mixKey(try Primitives.x25519(priv: ephemeral.priv, pub: re!)) // ee
            ss.mixKey(try Primitives.x25519(priv: ephemeral.priv, pub: rs!)) // se (responder: e with initiator's s)
        }
        message += try ss.encryptAndHash(payload)
        guard message.count <= Noise.maxMessageLength else { throw ProtocolError("handshake message too large") }
        step += 1
        return message
    }

    public mutating func readMessage(_ message: Data) throws(ProtocolError) -> Data {
        let reading = step == 0 ? !isInitiator : isInitiator
        guard step < 2, reading else { throw ProtocolError("not our turn to read a handshake message") }
        guard message.count <= Noise.maxMessageLength else { throw ProtocolError("handshake message too large") }
        let bytes = Data(message)
        var offset = 0
        func take(_ length: Int) throws(ProtocolError) -> Data {
            guard bytes.count - offset >= length else { throw ProtocolError("handshake message truncated") }
            let out = Data(bytes[offset ..< offset + length])
            offset += length
            return out
        }
        let remoteEphemeral = try take(Noise.dhLength)
        re = remoteEphemeral
        ss.mixHash(remoteEphemeral)
        if step == 0 {
            ss.mixKey(try Primitives.x25519(priv: s.priv, pub: remoteEphemeral)) // es
            let remoteStaticKey = try ss.decryptAndHash(try take(Noise.dhLength + Primitives.tagLength)) // s
            rs = remoteStaticKey
            ss.mixKey(try Primitives.x25519(priv: s.priv, pub: remoteStaticKey)) // ss
        } else {
            ss.mixKey(try Primitives.x25519(priv: e!.priv, pub: remoteEphemeral)) // ee
            ss.mixKey(try Primitives.x25519(priv: s.priv, pub: remoteEphemeral)) // se (initiator: s with responder's e)
        }
        let payload = try ss.decryptAndHash(Data(bytes[offset...]))
        step += 1
        return payload
    }

    public func split() throws(ProtocolError) -> NoiseTransport {
        guard step == 2, let rs else { throw ProtocolError("handshake not complete") }
        let (c1, c2) = ss.split()
        let (send, recv) = isInitiator ? (c1, c2) : (c2, c1)
        return NoiseTransport(send: send, recv: recv, handshakeHash: ss.handshakeHash, remoteStatic: rs)
    }
}
