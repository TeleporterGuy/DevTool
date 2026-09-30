import Foundation

/// Every validation failure in the protocol layer throws this, so callers can
/// tell "the peer sent something malformed" (drop it) apart from bugs.
/// Mirrors `ProtocolError` in `protocol/ts/errors.ts`.
public struct ProtocolError: Error, Sendable, Equatable, CustomStringConvertible, LocalizedError {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { "ProtocolError: \(message)" }
    public var errorDescription: String? { message }
}
