import Foundation

/// §7.4: push registration on a desktop.
public enum PushOp {
    public static let register = "push.register"
    public static let unregister = "push.unregister"
    public static let all = [register, unregister]
}

/// `push.register` params. `key` and `keyId` are raw bytes here, b64u on the wire.
public struct PushRegisterParams: Sendable, Equatable {
    public var cap: String
    public var key: Data
    public var keyId: Data
    public var kinds: [PushKind]

    public init(cap: String, key: Data, keyId: Data, kinds: [PushKind]) {
        self.cap = cap
        self.key = key
        self.keyId = keyId
        self.kinds = kinds
    }

    /// Key order as the TS encoder: `cap, key, keyId, kinds`.
    public var json: JSONValue {
        .object([
            "cap": .string(cap),
            "key": .string(key.base64URLEncodedString),
            "keyId": .string(keyId.base64URLEncodedString),
            "kinds": .array(kinds.map { .string($0.rawValue) }),
        ])
    }

    /// The desktop's parser (`parsePushParams`), for tests and fakes. Unknown
    /// kinds are dropped and the known ones come back in `PushKind` order.
    public static func parse(_ params: JSONValue?) throws(ProtocolError) -> PushRegisterParams {
        let f = try Fields(params, "params")
        let cap = try f.str("cap")
        guard !cap.isEmpty, cap.count <= Push.capMaxLength else { throw ProtocolError("cap has the wrong length") }
        let key = try f.b64u("key", length: Push.keyLength)
        let keyId = try f.b64u("keyId", length: Push.keyIdLength)
        let listed = try f.array("kinds").compactMap(\.stringValue)
        return PushRegisterParams(
            cap: cap,
            key: Base64URL.decode(key)!,
            keyId: Base64URL.decode(keyId)!,
            kinds: PushKind.allCases.filter { listed.contains($0.rawValue) }
        )
    }
}

extension DesktopConnection {
    /// `push.register`: replaces this phone's registration on the desktop.
    public func registerPush(_ params: PushRegisterParams) async throws {
        _ = try await request(PushOp.register, params: params.json)
    }

    /// `push.unregister`: the desktop forgets this phone's registration.
    public func unregisterPush() async throws {
        _ = try await request(PushOp.unregister, params: .object([:]))
    }
}
