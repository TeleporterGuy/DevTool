import Foundation
import OSLog
import Security

/// A `SecretStore` that can also list what it holds.
public protocol ListableSecretStore: SecretStore {
    func allItems() throws -> [String: Data]
}

extension KeychainStore: ListableSecretStore {}
extension InMemorySecretStore: ListableSecretStore {}

/// A phone's push key for one desktop pairing (§7.4): the desktop seals pushes
/// with `key`, and `keyId` in front of each payload says which key to use.
public struct PushKey: Codable, Sendable, Equatable {
    public var desktopId: String
    /// 32 random bytes (AES-256-GCM).
    public var key: Data
    /// 8 random bytes.
    public var keyId: Data
    /// Shown as the notification's subtitle when more than one desktop is paired.
    public var desktopName: String

    public init(desktopId: String, key: Data, keyId: Data, desktopName: String) {
        self.desktopId = desktopId
        self.key = key
        self.keyId = keyId
        self.desktopName = desktopName
    }

    static func random(desktopId: String, desktopName: String) -> PushKey {
        func bytes(_ count: Int) -> Data {
            var data = Data(count: count)
            let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
            precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
            return data
        }
        return PushKey(desktopId: desktopId, key: bytes(Push.keyLength), keyId: bytes(Push.keyIdLength), desktopName: desktopName)
    }
}

/// Per-desktop push keys, one Keychain item per desktop ID (JSON of `PushKey`).
///
/// The app creates a key on first use and deletes it when the pairing is
/// removed; the Notification Service Extension only reads, by key ID. Both
/// processes reach the same items through a shared access group (the App
/// Group `group.sk.awantech.devtool`, which iOS also accepts as a keychain
/// access group). Where that group isn't available (an unsigned simulator
/// build, `swift test` on macOS), the store falls back to the default group;
/// then only the app sees the keys and the extension shows the fallback alert.
public struct PushKeyStore: Sendable {
    public static let service = "sk.awantech.devtool.push"
    public static let appGroup = "group.sk.awantech.devtool"

    private let store: any ListableSecretStore

    public init(store: any ListableSecretStore) {
        self.store = store
    }

    /// The shared Keychain store the app and the extension both use.
    public static func shared() -> PushKeyStore {
        PushKeyStore(store: FallbackKeychainStore(
            primary: KeychainStore(service: service, accessGroup: appGroup),
            fallback: KeychainStore(service: service)
        ))
    }

    /// This desktop's key, or nil if it has none yet.
    public func key(for desktopId: String) throws -> PushKey? {
        guard let data = try store.data(for: desktopId) else { return nil }
        return try? JSONDecoder().decode(PushKey.self, from: data)
    }

    /// This desktop's key, creating (and storing) one on first use. Keeps
    /// `desktopName` current.
    public func keyOrCreate(for desktopId: String, desktopName: String) throws -> PushKey {
        if var existing = try key(for: desktopId) {
            if existing.desktopName != desktopName, !desktopName.isEmpty {
                existing.desktopName = desktopName
                try save(existing)
            }
            return existing
        }
        let key = PushKey.random(desktopId: desktopId, desktopName: desktopName)
        try save(key)
        return key
    }

    /// The key a payload names (`PushCrypto.keyId(of:)`), for the extension.
    public func key(keyId: Data) throws -> PushKey? {
        for data in try store.allItems().values {
            if let key = try? JSONDecoder().decode(PushKey.self, from: data), key.keyId == keyId { return key }
        }
        return nil
    }

    /// Forgets a desktop's key (its pairing was removed).
    public func delete(desktopId: String) throws {
        try store.delete(desktopId)
    }

    /// Every stored key.
    public func all() throws -> [PushKey] {
        try store.allItems().values.compactMap { try? JSONDecoder().decode(PushKey.self, from: $0) }
    }

    private func save(_ key: PushKey) throws {
        try store.set(JSONEncoder().encode(key), for: key.desktopId)
    }
}

/// Uses `primary` (a shared access group) and switches to `fallback` for good
/// once the Keychain says the process isn't entitled to that group.
public final class FallbackKeychainStore: ListableSecretStore, @unchecked Sendable {
    private let primary: KeychainStore
    private let fallback: KeychainStore
    private let lock = NSLock()
    private var useFallback = false
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "keychain")

    public init(primary: KeychainStore, fallback: KeychainStore) {
        self.primary = primary
        self.fallback = fallback
    }

    private func run<T>(_ body: (KeychainStore) throws(KeychainError) -> T) throws -> T {
        if !lock.withLock({ useFallback }) {
            do {
                return try body(primary)
            } catch where error.isMissingEntitlement {
                log.notice("Keychain access group \(self.primary.accessGroup ?? "", privacy: .public) unavailable; using the default group")
                lock.withLock { useFallback = true }
            }
        }
        return try body(fallback)
    }

    public func data(for label: String) throws -> Data? { try run { store throws(KeychainError) in try store.data(for: label) } }
    public func set(_ data: Data, for label: String) throws { try run { store throws(KeychainError) in try store.set(data, for: label) } }
    public func delete(_ label: String) throws { try run { store throws(KeychainError) in try store.delete(label) } }
    public func allItems() throws -> [String: Data] { try run { store throws(KeychainError) in try store.allItems() } }
}
