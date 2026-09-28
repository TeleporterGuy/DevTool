import Foundation

/// Plan §4.1: the bytes inside a relay `frame.data` are `[kind:u8] || body`.
public enum FrameKind: UInt8, Sendable, CaseIterable {
    /// Noise handshake message 1, phone → desktop.
    case handshake1 = 0x01
    /// Noise handshake message 2, desktop → phone.
    case handshake2 = 0x02
    /// Noise transport message, either direction.
    case transport = 0x03
    /// "I have no session, handshake again"; empty body.
    case reset = 0x04
}

public struct Envelope: Sendable, Equatable {
    public var kind: FrameKind
    public var body: Data

    public init(kind: FrameKind, body: Data = Data()) {
        self.kind = kind
        self.body = body
    }

    public func encode() throws(ProtocolError) -> Data {
        if kind == .reset, !body.isEmpty { throw ProtocolError("reset frames have no body") }
        return Data([kind.rawValue]) + body
    }

    /// Unknown kinds throw so the caller can answer with a reset. A reset that
    /// somehow carries a body is still a reset; the body is dropped.
    public static func decode(_ bytes: Data) throws(ProtocolError) -> Envelope {
        guard let first = bytes.first else { throw ProtocolError("empty frame") }
        guard let kind = FrameKind(rawValue: first) else { throw ProtocolError("unknown frame kind") }
        return Envelope(kind: kind, body: kind == .reset ? Data() : Data(bytes.dropFirst()))
    }
}
