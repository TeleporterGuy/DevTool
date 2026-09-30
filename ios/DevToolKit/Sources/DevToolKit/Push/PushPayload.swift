import CryptoKit
import Foundation

/// Push (SPEC.md §7), a port of the phone's half of `protocol/ts/push.ts`.
public enum Push {
    public static let registerContext = "devtool-push-register-v1"
    public static let registerPath = "/v1/push/register"
    public static let defaultGateway = URL(string: "https://relay.devtool.awantech.sk")!

    /// §7.1 / §7.5 limits.
    public static let keyIdLength = 8
    public static let keyLength = 32
    public static let nonceLength = 12
    public static let tagLength = 16
    public static let capMaxLength = 1024
    public static let tokenMinBytes = 32
    public static let tokenMaxBytes = 100
    public static let titleMax = 120
    public static let bodyMax = 400
    public static let dataMaxLength = 3072

    /// `userInfo` keys the notification carries once the extension has opened it
    /// (and the keys a hand-made `simctl push` payload can set directly).
    public enum UserInfoKey {
        public static let data = "d"
        public static let desktop = "desktop"
        public static let tab = "tab"
        public static let prompt = "prompt"
    }
}

/// APNs environment of a registration (§7.1).
public enum PushEnv: String, Sendable, CaseIterable {
    case production
    case sandbox
}

/// What a phone can ask for in `push.register` (§7.4). Plans ride on `question`.
public enum PushKind: String, Sendable, CaseIterable, Codable {
    case permission
    case question
    case done
}

/// What a payload can be about (§7.5). Also the notification category IDs.
public enum PushPayloadKind {
    public static let permission = "permission"
    public static let question = "question"
    public static let plan = "plan"
    public static let done = "done"
    public static let all = [permission, question, plan, done]
}

/// The decrypted `data` of a push (§7.5).
public struct PushPayload: Sendable, Equatable {
    public static let version = 1

    /// An open string: an unknown kind is kept, and shown without actions.
    public var kind: String
    public var desktop: String
    public var tab: String
    /// Present for `permission`, `question` and `plan`.
    public var prompt: String?
    public var title: String
    public var body: String
    /// Unix milliseconds.
    public var at: Int64

    public init(kind: String, desktop: String, tab: String, prompt: String? = nil, title: String, body: String, at: Int64) {
        self.kind = kind
        self.desktop = desktop
        self.tab = tab
        self.prompt = prompt
        self.title = title
        self.body = body
        self.at = at
    }

    /// Throws on an unknown `v` or a missing/wrong-typed field; unknown fields are dropped.
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> PushPayload {
        let f = try Fields(value, "payload")
        guard case .number(let v)? = f["v"], v == Double(version) else { throw ProtocolError("v must be 1") }
        return PushPayload(
            kind: try f.str("kind"),
            desktop: try f.str("desktop"),
            tab: try f.str("tab"),
            prompt: f.isUnset("prompt") ? nil : try f.str("prompt"),
            title: try f.str("title"),
            body: try f.str("body"),
            at: try f.int("at")
        )
    }

    /// The same key order as the TS sender, so sealing it matches the vectors.
    public var json: JSONValue {
        var o: JSONObject = ["v": .int(Int64(Self.version)), "kind": .string(kind), "desktop": .string(desktop), "tab": .string(tab)]
        if let prompt { o["prompt"] = .string(prompt) }
        o["title"] = .string(title)
        o["body"] = .string(body)
        o["at"] = .int(at)
        return .object(o)
    }
}

/// §7.5 `data` = b64u( keyId (8) ‖ nonce (12) ‖ AES-256-GCM(key, JSON, aad = keyId) ).
public enum PushCrypto {
    private static var minimumLength: Int { Push.keyIdLength + Push.nonceLength + Push.tagLength }

    /// The key ID `data` was sealed under (raw 8 bytes), or nil when it is malformed.
    public static func keyId(of data: String) -> Data? {
        guard let bytes = Base64URL.decode(data), bytes.count >= minimumLength else { return nil }
        return Data(bytes.prefix(Push.keyIdLength))
    }

    /// Decrypts `data`; nil when it doesn't decrypt.
    public static func openBytes(key: Data, data: String) -> Data? {
        guard key.count == Push.keyLength,
              let bytes = Base64URL.decode(data), bytes.count >= minimumLength else { return nil }
        let bytesArray = [UInt8](bytes)
        let keyId = Data(bytesArray[0..<Push.keyIdLength])
        let nonce = Data(bytesArray[Push.keyIdLength..<(Push.keyIdLength + Push.nonceLength)])
        let sealed = bytesArray[(Push.keyIdLength + Push.nonceLength)...]
        let ciphertext = Data(sealed.dropLast(Push.tagLength))
        let tag = Data(sealed.suffix(Push.tagLength))
        do {
            let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: keyId)
        } catch {
            return nil
        }
    }

    /// Decrypts and parses `data`; nil when it doesn't decrypt, isn't JSON, has
    /// an unknown `v` or lacks a field. The caller then leaves the fallback alert alone.
    public static func open(key: Data, data: String) -> PushPayload? {
        guard let plaintext = openBytes(key: key, data: data),
              let value = try? JSONValue.parse(plaintext) else { return nil }
        return try? PushPayload.parse(value)
    }

    /// The desktop's side, for tests and tooling. A random nonce unless one is given.
    /// Doesn't cut `title`/`body` the way a desktop must (§7.5).
    public static func seal(key: Data, keyId: Data, plaintext: Data, nonce: Data? = nil) throws(ProtocolError) -> String {
        guard key.count == Push.keyLength else { throw ProtocolError("key must be 32 bytes") }
        guard keyId.count == Push.keyIdLength else { throw ProtocolError("keyId must be 8 bytes") }
        let n = nonce ?? Data((0..<Push.nonceLength).map { _ in UInt8.random(in: 0...255) })
        guard n.count == Push.nonceLength else { throw ProtocolError("nonce must be 12 bytes") }
        do {
            let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: n), authenticating: keyId)
            return Base64URL.encode(Data.concat(keyId, n, box.ciphertext, box.tag))
        } catch {
            throw ProtocolError("encryption failed")
        }
    }
}

/// §7.1: the signed body of `POST /v1/push/register`.
public struct PushRegistration: Sendable, Equatable {
    /// b64u phone Ed25519 public key.
    public var pub: String
    /// APNs device token, lowercase hex.
    public var token: String
    public var env: PushEnv
    /// Unix seconds.
    public var ts: Int64
    /// b64u Ed25519 signature over `message(token:env:ts:)`.
    public var sig: String

    public init(pub: String, token: String, env: PushEnv, ts: Int64, sig: String) {
        self.pub = pub
        self.token = token
        self.env = env
        self.ts = ts
        self.sig = sig
    }

    /// `utf8("devtool-push-register-v1\n" + token + "\n" + env + "\n" + ts)`.
    public static func message(token: String, env: PushEnv, ts: Int64) -> Data {
        Data("\(Push.registerContext)\n\(token)\n\(env.rawValue)\n\(ts)".utf8)
    }

    /// Signs a registration with the phone's relay (Ed25519) key. CryptoKit's
    /// signatures are randomized, so `sig` differs on every call; any of them verifies.
    public static func sign(identity: DeviceIdentity, token: String, env: PushEnv, ts: Int64) throws(ProtocolError) -> PushRegistration {
        guard isToken(token) else { throw ProtocolError("token must be 32 to 100 bytes of lowercase hex") }
        let sig = try Primitives.ed25519Sign(seed: identity.ed25519.priv, message: message(token: token, env: env, ts: ts))
        return PushRegistration(pub: identity.ed25519.pub.base64URLEncodedString, token: token, env: env, ts: ts, sig: sig.base64URLEncodedString)
    }

    /// Whether the signature verifies for `pub`.
    public var isValid: Bool {
        guard let pub = Data(base64URLEncoded: pub), let sig = Data(base64URLEncoded: sig) else { return false }
        return Primitives.ed25519Verify(pub: pub, message: Self.message(token: token, env: env, ts: ts), signature: sig)
    }

    /// Key order as the TS encoder: `pub, token, env, ts, sig`.
    public var json: JSONValue {
        .object(["pub": .string(pub), "token": .string(token), "env": .string(env.rawValue), "ts": .int(ts), "sig": .string(sig)])
    }

    /// Lowercase hex of 32 to 100 bytes (`isPushToken` in TS).
    public static func isToken(_ token: String) -> Bool {
        guard token == token.lowercased(), let bytes = Data(hex: token) else { return false }
        return (Push.tokenMinBytes...Push.tokenMaxBytes).contains(bytes.count)
    }
}
