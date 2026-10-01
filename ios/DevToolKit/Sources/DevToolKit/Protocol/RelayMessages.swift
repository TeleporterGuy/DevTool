import Foundation

/// Relay protocol v1 (SPEC.md §3): one JSON object per WebSocket text frame,
/// discriminated by `t`. A port of `protocol/ts/relay-messages.ts`: parsers
/// keep only the fields the spec defines, so unknown fields are dropped.
public enum RelayProtocol {
    public static let path = "/v1"
    public static let maxFrameBytes = 256 * 1024
    public static let pingInterval: Duration = .seconds(25)
    public static let idleTimeout: Duration = .seconds(60)

    /// WebSocket close codes the relay uses (§3.1, §3.5, §3.7).
    public enum CloseCode {
        /// Idle timeout, or the server is shutting down.
        public static let goingAway = 1001
        public static let tooBig = 1009
        public static let auth = 4401
        /// A pending phone's pairing window lapsed and it has no other desktop.
        public static let pairingExpired = 4403
        public static let helloTimeout = 4408
        public static let replaced = 4409
        public static let rate = 4429
    }

    static let authContext = "devtool-relay-v1"

    /// §3.1: the exact bytes signed in `hello`. `nonce` is the b64u string as
    /// received, not its decoded bytes.
    public static func authPayload(role: RelayRole, nonce: String) -> Data {
        Data("\(authContext)\n\(role.rawValue)\n\(nonce)".utf8)
    }

    /// Builds a signed `hello` for the challenge `nonce`.
    public static func hello(
        role: RelayRole,
        nonce: String,
        ed25519: KeyPair,
        pair: (to: String, token: Data)? = nil
    ) throws(ProtocolError) -> RelayClientMessage {
        let sig = try Primitives.ed25519Sign(seed: ed25519.priv, message: authPayload(role: role, nonce: nonce))
        return .hello(
            role: role,
            pub: ed25519.pub.base64URLEncodedString,
            sig: sig.base64URLEncodedString,
            pair: pair.map { RelayPair(to: $0.to, token: $0.token.base64URLEncodedString) }
        )
    }

    /// Relay side of §3.1: the device ID to answer `ready` with, or nil if the
    /// hello is not authentic.
    public static func verifyHello(pub: String, sig: String, role: RelayRole, nonce: String) -> String? {
        guard let pubBytes = Base64URL.decode(pub), let sigBytes = Base64URL.decode(sig),
              Primitives.ed25519Verify(pub: pubBytes, message: authPayload(role: role, nonce: nonce), signature: sigBytes)
        else { return nil }
        return try? Derive.deviceId(ed25519Pub: pubBytes)
    }
}

public enum RelayRole: String, Sendable {
    case desktop
    case phone
}

public enum PeerState: String, Sendable {
    case online
    case offline
    case revoked
}

/// A relay `error` code. Codes a newer relay may add are kept as `other`, and
/// clients treat them as a generic error.
public enum RelayErrorCode: Sendable, Hashable {
    case auth
    case offline
    case forbidden
    case rate
    case badRequest
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "auth": self = .auth
        case "offline": self = .offline
        case "forbidden": self = .forbidden
        case "rate": self = .rate
        case "bad-request": self = .badRequest
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .auth: "auth"
        case .offline: "offline"
        case .forbidden: "forbidden"
        case .rate: "rate"
        case .badRequest: "bad-request"
        case .other(let code): code
        }
    }
}

public struct RelayPair: Sendable, Equatable {
    public var to: String
    /// b64u relayToken.
    public var token: String

    public init(to: String, token: String) {
        self.to = to
        self.token = token
    }
}

/// Everything a client may send to the relay.
public enum RelayClientMessage: Sendable, Equatable {
    case hello(role: RelayRole, pub: String, sig: String, pair: RelayPair?)
    case offer(tokenHash: String, exp: Int64)
    case authorize(phone: String, pub: String)
    case revoke(phone: String)
    case watch(desktops: [String])
    /// Route `data` (b64u) to `to`.
    case frame(to: String, data: String)
    case ping
    case pong

    public var json: JSONValue {
        var o = JSONObject()
        switch self {
        case .hello(let role, let pub, let sig, let pair):
            o["t"] = "hello"
            o["role"] = .string(role.rawValue)
            o["pub"] = .string(pub)
            o["sig"] = .string(sig)
            if let pair { o["pair"] = .object(["to": .string(pair.to), "token": .string(pair.token)]) }
        case .offer(let tokenHash, let exp):
            o["t"] = "offer"
            o["tokenHash"] = .string(tokenHash)
            o["exp"] = .int(exp)
        case .authorize(let phone, let pub):
            o["t"] = "authorize"
            o["phone"] = .string(phone)
            o["pub"] = .string(pub)
        case .revoke(let phone):
            o["t"] = "revoke"
            o["phone"] = .string(phone)
        case .watch(let desktops):
            o["t"] = "watch"
            o["desktops"] = .array(desktops.map(JSONValue.string))
        case .frame(let to, let data):
            o["t"] = "frame"
            o["to"] = .string(to)
            o["data"] = .string(data)
        case .ping:
            o["t"] = "ping"
        case .pong:
            o["t"] = "pong"
        }
        return .object(o)
    }

    /// The JSON text sent on the socket.
    public var text: String { json.jsonString }

    /// What the relay does with every incoming text frame.
    public static func parse(_ text: String) throws(ProtocolError) -> RelayClientMessage {
        try parse(object: Fields(JSONValue.parse(text), "message"))
    }

    static func parse(object f: Fields) throws(ProtocolError) -> RelayClientMessage {
        switch f["t"]?.stringValue ?? "" {
        case "hello":
            let role = RelayRole(rawValue: try f.oneOf("role", ["desktop", "phone"]))!
            let pub = try f.b64u("pub", length: 32)
            let sig = try f.b64u("sig", length: 64)
            var pair: RelayPair?
            if f.has("pair") {
                let p = try Fields(f["pair"], "message")
                pair = RelayPair(to: try p.deviceId("to"), token: try p.b64u("token", length: 32))
            }
            return .hello(role: role, pub: pub, sig: sig, pair: pair)
        case "offer":
            return .offer(tokenHash: try f.b64u("tokenHash", length: 32), exp: try f.int("exp"))
        case "authorize":
            return .authorize(phone: try f.deviceId("phone"), pub: try f.b64u("pub", length: 32))
        case "revoke":
            return .revoke(phone: try f.deviceId("phone"))
        case "watch":
            let desktops = try f.array("desktops").map { (value) throws(ProtocolError) -> String in
                guard case .string(let id) = value, DeviceId(id) != nil else {
                    throw ProtocolError("desktops must hold device IDs")
                }
                return id
            }
            return .watch(desktops: desktops)
        case "frame":
            if f.has("from") { throw ProtocolError("client frames carry `to`, not `from`") }
            return .frame(to: try f.deviceId("to"), data: try f.b64u("data", length: nil))
        case "ping":
            return .ping
        case "pong":
            return .pong
        default:
            throw ProtocolError("unknown client message type")
        }
    }
}

/// Everything the relay may send to a client.
public enum RelayServerMessage: Sendable, Equatable {
    case challenge(nonce: String)
    case ready(id: String)
    /// `data` (b64u) arrived from `from`.
    case frame(from: String, data: String)
    case peer(id: String, state: PeerState, lastSeen: Int64?)
    case error(code: RelayErrorCode, message: String?, to: String?)
    case ping
    case pong

    /// What phones and desktops use on every frame from the relay. Returns nil
    /// for a message to ignore: a `peer` with a state this version doesn't know
    /// (forward compatibility). An unknown error `code` becomes `.other`.
    public static func parse(_ text: String) throws(ProtocolError) -> RelayServerMessage? {
        let f = try Fields(JSONValue.parse(text), "message")
        switch f["t"]?.stringValue ?? "" {
        case "challenge":
            return .challenge(nonce: try f.b64u("nonce", length: 32))
        case "ready":
            return .ready(id: try f.deviceId("id"))
        case "frame":
            if f.has("to") { throw ProtocolError("server frames carry `from`, not `to`") }
            return .frame(from: try f.deviceId("from"), data: try f.b64u("data", length: nil))
        case "peer":
            let id = try f.deviceId("id")
            guard let state = PeerState(rawValue: try f.str("state")) else { return nil }
            return .peer(id: id, state: state, lastSeen: f.has("lastSeen") ? try f.int("lastSeen") : nil)
        case "error":
            let rawCode = try f.str("code")
            if rawCode.isEmpty { throw ProtocolError("code must not be empty") }
            let code = RelayErrorCode(rawValue: rawCode)
            let message: String? = f.has("message") ? try f.str("message") : nil
            let to: String? = f.has("to") ? try f.deviceId("to") : nil
            return .error(code: code, message: message, to: to)
        case "ping":
            return .ping
        case "pong":
            return .pong
        default:
            throw ProtocolError("unknown server message type")
        }
    }

    public var json: JSONValue {
        var o = JSONObject()
        switch self {
        case .challenge(let nonce):
            o["t"] = "challenge"
            o["nonce"] = .string(nonce)
        case .ready(let id):
            o["t"] = "ready"
            o["id"] = .string(id)
        case .frame(let from, let data):
            o["t"] = "frame"
            o["from"] = .string(from)
            o["data"] = .string(data)
        case .peer(let id, let state, let lastSeen):
            o["t"] = "peer"
            o["id"] = .string(id)
            o["state"] = .string(state.rawValue)
            if let lastSeen { o["lastSeen"] = .int(lastSeen) }
        case .error(let code, let message, let to):
            o["t"] = "error"
            o["code"] = .string(code.rawValue)
            if let message { o["message"] = .string(message) }
            if let to { o["to"] = .string(to) }
        case .ping:
            o["t"] = "ping"
        case .pong:
            o["t"] = "pong"
        }
        return .object(o)
    }

    public var text: String { json.jsonString }
}
