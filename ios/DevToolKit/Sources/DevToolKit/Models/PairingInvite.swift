import Foundation

/// The QR payload a desktop shows in Settings → Mobile (spec §2):
/// `devtool://pair?d=<b64u(JSON)>`.
public struct PairingInvite: Sendable, Equatable {
    public static let scheme = "devtool"
    public static let host = "pair"
    public static let supportedVersion = 1

    public let version: Int
    /// Base relay URL, e.g. `wss://relay.devtool.awantech.sk`.
    public let relayURL: URL
    public let desktopId: String
    /// Raw 32-byte X25519 public key (Noise static).
    public let desktopX25519PublicKey: Data
    /// Raw 32-byte Ed25519 public key (relay auth).
    public let desktopEd25519PublicKey: Data
    /// 32-byte one-time secret. Feeds `relayToken` and `pairProof` via HKDF.
    public let secret: Data
    /// Desktop display name, e.g. its hostname.
    public let desktopName: String
    public let expiresAt: Date

    public init(
        version: Int = PairingInvite.supportedVersion,
        relayURL: URL,
        desktopId: String,
        desktopX25519PublicKey: Data,
        desktopEd25519PublicKey: Data,
        secret: Data,
        desktopName: String,
        expiresAt: Date
    ) {
        self.version = version
        self.relayURL = relayURL
        self.desktopId = desktopId
        self.desktopX25519PublicKey = desktopX25519PublicKey
        self.desktopEd25519PublicKey = desktopEd25519PublicKey
        self.secret = secret
        self.desktopName = desktopName
        self.expiresAt = expiresAt
    }

    /// A `ws://` relay that isn't on this machine: the channel is still
    /// end-to-end encrypted, but connection metadata travels in the clear.
    public var usesUnencryptedRemoteRelay: Bool {
        Self.isUnencryptedRemoteRelay(relayURL)
    }

    public static func isUnencryptedRemoteRelay(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "ws" else { return false }
        var host = (url.host(percentEncoded: false) ?? "").lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return false }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, octets[0] == "127", octets.allSatisfy({ UInt8($0) != nil }) { return false }
        return true
    }

    public static let unencryptedRelayWarning =
        "Unencrypted relay: connection metadata is visible on the network (messages stay end-to-end encrypted)."

    public func isExpired(now: Date = Date()) -> Bool {
        now >= expiresAt
    }

    /// Seconds left before the invite lapses (0 when expired).
    public func remainingTime(now: Date = Date()) -> TimeInterval {
        max(0, expiresAt.timeIntervalSince(now))
    }
}

public enum PairingInviteError: Error, Equatable, Sendable, LocalizedError {
    case notAPairingLink
    case missingPayload
    case invalidEncoding
    case invalidJSON
    case unsupportedVersion(Int)
    case invalidField(String)
    case expired

    public var errorDescription: String? {
        switch self {
        case .notAPairingLink: "This isn't a DevTool pairing link."
        case .missingPayload: "The pairing link has no payload."
        case .invalidEncoding: "The pairing link is damaged."
        case .invalidJSON: "The pairing link is damaged."
        case .unsupportedVersion(let v): "This pairing link uses version \(v). Update the app."
        case .invalidField(let name): "The pairing link has an invalid \(name)."
        case .expired: "This pairing code has expired. Show a new one on the desktop."
        }
    }
}

extension PairingInvite {
    /// Parses a pairing URI (spec §2), with the same rules as `decodePairingUri`
    /// in `protocol/ts/pairing-uri.ts`. Surrounding whitespace and unknown JSON
    /// fields are ignored. Does not check expiry unless `now` is given, so
    /// callers can show a specific message.
    public static func parse(_ string: String, now: Date? = nil) throws(PairingInviteError) -> PairingInvite {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == scheme,
              components.host == host
        else { throw .notAPairingLink }

        guard let d = components.queryItems?.first(where: { $0.name == "d" })?.value, !d.isEmpty
        else { throw .missingPayload }
        guard let json = Data(base64URLEncoded: d) else { throw .invalidEncoding }
        guard let value = try? JSONValue.parse(json) else { throw .invalidJSON }
        let invite = try PairingInvite(json: value)
        if let now, invite.isExpired(now: now) { throw .expired }
        return invite
    }

    /// Validates the decoded JSON payload (`validatePairingPayload` in TS).
    public init(json value: JSONValue) throws(PairingInviteError) {
        guard case .object(let o) = value else { throw .invalidJSON }
        guard case .number(let v)? = o["v"], v == Double(PairingInvite.supportedVersion) else {
            if case .number(let v)? = o["v"], v == v.rounded(), abs(v) < 1e15 { throw .unsupportedVersion(Int(v)) }
            throw .invalidField("v")
        }
        guard case .string(let relayString)? = o["relay"],
              let relay = URL(string: relayString),
              let relayScheme = relay.scheme?.lowercased(),
              ["ws", "wss"].contains(relayScheme),
              relay.host != nil
        else { throw .invalidField("relay") }
        guard case .string(let id)? = o["id"], DeviceId(id) != nil else { throw .invalidField("id") }
        func key32(_ name: String) throws(PairingInviteError) -> Data {
            guard case .string(let text)? = o[name], let bytes = Data(base64URLEncoded: text), bytes.count == 32
            else { throw .invalidField(name) }
            return bytes
        }
        let x = try key32("x"), e = try key32("e"), s = try key32("s")
        // A tampered QR could otherwise pair us with keys the relay routes to a different desktop.
        guard DeviceId(ed25519PublicKey: e).rawValue == id else { throw .invalidField("id") }
        guard case .string(let name)? = o["n"] else { throw .invalidField("n") }
        guard case .number(let exp)? = o["exp"], exp == exp.rounded(), exp >= 0, exp <= 9_007_199_254_740_991
        else { throw .invalidField("exp") }

        self.init(
            version: PairingInvite.supportedVersion,
            relayURL: relay,
            desktopId: id,
            desktopX25519PublicKey: x,
            desktopEd25519PublicKey: e,
            secret: s,
            desktopName: name,
            expiresAt: Date(timeIntervalSince1970: exp)
        )
    }

    /// Wire JSON, keys in the spec's order `v, relay, id, x, e, s, n, exp`.
    public var json: JSONValue {
        .object([
            "v": .int(Int64(version)),
            "relay": .string(relayURL.absoluteString),
            "id": .string(desktopId),
            "x": .string(desktopX25519PublicKey.base64URLEncodedString),
            "e": .string(desktopEd25519PublicKey.base64URLEncodedString),
            "s": .string(secret.base64URLEncodedString),
            "n": .string(desktopName),
            "exp": .int(Int64(expiresAt.timeIntervalSince1970.rounded(.down))),
        ])
    }

    /// Encodes back to a `devtool://pair?d=…` URI, byte-identical to the TS encoder.
    public var uri: String {
        "\(PairingInvite.scheme)://\(PairingInvite.host)?d=\(json.jsonData.base64URLEncodedString)"
    }

    /// The relay token the phone sends in `hello.pair` (§2).
    public var relayToken: Data { Derive.relayToken(secret: secret) }

    /// The proof the phone sends inside the Noise handshake (§2).
    public var pairProof: Data { Derive.pairProof(secret: secret) }
}
