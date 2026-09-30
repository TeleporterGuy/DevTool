import CryptoKit
import Foundation

/// A device identifier (spec §1): lowercase hex of the first 16 bytes of
/// `SHA-256(ed25519Pub)`, 32 hex characters. Desktops and phones use the
/// same formula.
public struct DeviceId: Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String

    /// Wraps an existing ID string. Returns nil unless it is 32 lowercase hex chars.
    public init?(_ rawValue: String) {
        guard rawValue.count == 32,
              rawValue.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) })
        else { return nil }
        self.rawValue = rawValue
    }

    /// Derives the ID from a raw 32-byte Ed25519 public key.
    public init(ed25519PublicKey: Data) {
        let digest = SHA256.hash(data: ed25519PublicKey)
        rawValue = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    public var description: String { rawValue }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let string = try container.decode(String.self)
        guard let id = DeviceId(string) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid device id: \(string)")
        }
        self = id
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
