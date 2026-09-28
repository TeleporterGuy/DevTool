import Foundation

/// Where `DeviceIdentity` keeps raw private keys. `KeychainStore` in the app,
/// `InMemorySecretStore` in tests.
public protocol SecretStore: Sendable {
    func data(for label: String) throws -> Data?
    func set(_ data: Data, for label: String) throws
    func delete(_ label: String) throws
}

extension KeychainStore: SecretStore {}

/// A process-local `SecretStore`, for tests and throwaway identities.
public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    public init() {}

    public func data(for label: String) -> Data? { lock.withLock { items[label] } }
    public func set(_ data: Data, for label: String) { lock.withLock { items[label] = data } }
    public func delete(_ label: String) { lock.withLock { _ = items.removeValue(forKey: label) } }
}

/// This phone's long-term keys (SPEC.md §1): X25519 for Noise, Ed25519 for relay
/// auth. Generated on first launch and stored as raw 32-byte private keys under
/// `<label>.x25519` and `<label>.ed25519`.
public struct DeviceIdentity: Sendable, Equatable {
    public let x25519: KeyPair
    public let ed25519: KeyPair

    /// Device ID (SPEC.md §1): the first 16 bytes of SHA-256(ed25519 pub), hex.
    public var deviceId: String { DeviceId(ed25519PublicKey: ed25519.pub).rawValue }

    public init(x25519: KeyPair, ed25519: KeyPair) {
        self.x25519 = x25519
        self.ed25519 = ed25519
    }

    /// A fresh identity that is not stored anywhere.
    public static func generate() -> DeviceIdentity {
        DeviceIdentity(x25519: Primitives.generateX25519(), ed25519: Primitives.generateEd25519())
    }

    /// Rebuilds an identity from raw private keys.
    public init(x25519Private: Data, ed25519Seed: Data) throws(ProtocolError) {
        self.init(
            x25519: try Primitives.x25519(fromPrivate: x25519Private),
            ed25519: try Primitives.ed25519(fromSeed: ed25519Seed)
        )
    }

    /// Loads the identity stored under `label`, or creates and stores one.
    /// A half-written identity (one key missing or damaged) is replaced.
    public static func loadOrCreate(
        store: any SecretStore = KeychainStore(),
        label: String = KeychainStore.deviceIdentityLabel
    ) throws -> DeviceIdentity {
        let xLabel = "\(label).x25519", edLabel = "\(label).ed25519"
        if let x = try store.data(for: xLabel), let ed = try store.data(for: edLabel),
           let identity = try? DeviceIdentity(x25519Private: x, ed25519Seed: ed) {
            return identity
        }
        let identity = generate()
        try store.set(identity.x25519.priv, for: xLabel)
        try store.set(identity.ed25519.priv, for: edLabel)
        return identity
    }
}
