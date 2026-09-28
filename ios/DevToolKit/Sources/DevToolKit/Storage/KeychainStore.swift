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

    public init(service: String = KeychainStore.defaultService) {
        self.service = service
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

    /// Removes every item this store's service owns.
    public func deleteAll() throws(KeychainError) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .unexpectedStatus(status) }
    }

    private func baseQuery(_ label: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: label,
        ]
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
