import Foundation
import Security

/// Stores raw key bytes in the Keychain as generic passwords, one item per
/// label, accessible after first unlock and never migrated to another device.
///
/// The crypto layer uses it for the phone's long-term X25519 and Ed25519
/// private keys (spec §1).
public struct KeychainStore: Sendable {
    public static let defaultService = "sk.awantech.devtool.keys"
    /// Label prefix of the phone's single M1 identity; see `DesktopRecord.keysReference`.
    public static let deviceIdentityLabel = "device"

    public let service: String
    /// `kSecAttrAccessGroup` for every query, or nil for the app's default group.
    /// An App Group ID works here on iOS, which is how the notification
    /// extension shares the push keys (`PushKeyStore`).
    public let accessGroup: String?

    public init(service: String = KeychainStore.defaultService, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Returns the bytes stored under `label`, or nil if there are none.
    public func data(for label: String) throws(KeychainError) -> Data? {
        var query = baseQuery(label)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { throw .unexpectedData }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw .unexpectedStatus(status)
        }
    }

    /// Stores `data` under `label`, replacing any existing value.
    public func set(_ data: Data, for label: String) throws(KeychainError) {
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery(label) as CFDictionary, update as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var add = baseQuery(label)
            add.merge(update) { _, new in new }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw .unexpectedStatus(addStatus) }
        default:
            throw .unexpectedStatus(status)
        }
    }

    /// Removes the item under `label`. Removing a missing item is not an error.
    public func delete(_ label: String) throws(KeychainError) {
        let status = SecItemDelete(baseQuery(label) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .unexpectedStatus(status) }
    }

    /// Every item this store's service owns, by label.
    public func allItems() throws(KeychainError) -> [String: Data] {
        var query = serviceQuery()
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let items = result as? [[String: Any]] else { throw .unexpectedData }
            var out: [String: Data] = [:]
            for item in items {
                if let label = item[kSecAttrAccount as String] as? String, let data = item[kSecValueData as String] as? Data {
                    out[label] = data
                }
            }
            return out
        case errSecItemNotFound:
            return [:]
        default:
            throw .unexpectedStatus(status)
        }
    }

    /// Removes every item this store's service owns.
    public func deleteAll() throws(KeychainError) {
        let query = serviceQuery()
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .unexpectedStatus(status) }
    }

    private func baseQuery(_ label: String) -> [String: Any] {
        var query = serviceQuery()
        query[kSecAttrAccount as String] = label
        return query
    }

    private func serviceQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        #if os(macOS)
        // The file-based macOS keychain ignores kSecAttrAccessible*; use the
        // iOS-style data protection keychain there too.
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }
}

public enum KeychainError: Error, Equatable, Sendable, LocalizedError {
    case unexpectedStatus(OSStatus)
    case unexpectedData

    /// The process isn't entitled to the access group (-34018), e.g. an
    /// unsigned build, or on macOS where the data protection keychain needs
    /// signing.
    public var isMissingEntitlement: Bool { self == .unexpectedStatus(errSecMissingEntitlement) }

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "Keychain error: \(message)"
        case .unexpectedData:
            return "Keychain returned unexpected data."
        }
    }
}
