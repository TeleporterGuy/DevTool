import Foundation

/// SPEC.md §6.1: transport plaintext is either a complete JSON message (first
/// byte `{`) or one fragment of a larger one:
///
///     0x01 id:u32be i:u16be n:u16be chunk…
///
/// A sender splits any encoded message over `maxChunk` bytes into chunks of at
/// most `maxChunk` bytes; the receiver reassembles them within the limits of
/// `Reassembler`.
public enum Fragmentation {
    /// Largest chunk, and the largest message sent unfragmented.
    public static let maxChunk = 60_000
    /// First byte of a fragment.
    public static let fragmentMarker: UInt8 = 0x01
    /// First byte of a complete JSON message.
    public static let jsonMarker: UInt8 = 0x7B
    /// `0x01` + id (4) + i (2) + n (2).
    public static let headerLength = 9
    /// Largest reassembled message.
    public static let maxMessageBytes = 4 * 1024 * 1024
    /// Most chunks a message within `maxMessageBytes` can need.
    public static let maxFragments = (maxMessageBytes + maxChunk - 1) / maxChunk

    /// The transport plaintexts for one encoded message: the message itself when
    /// it fits, fragments otherwise. `id` is the sender's per-session counter.
    /// Throws for a message over `maxMessageBytes`, which no receiver accepts.
    public static func encode(_ message: Data, id: UInt32) throws(ProtocolError) -> [Data] {
        guard message.count > maxChunk else { return [message] }
        guard message.count <= maxMessageBytes else { throw ProtocolError("message too large (\(message.count) bytes)") }
        let bytes = [UInt8](message)
        let count = (bytes.count + maxChunk - 1) / maxChunk
        var out: [Data] = []
        out.reserveCapacity(count)
        for index in 0..<count {
            let start = index * maxChunk
            let end = min(start + maxChunk, bytes.count)
            var fragment = Data(capacity: headerLength + end - start)
            fragment.append(fragmentMarker)
            fragment.append(contentsOf: bigEndian(id))
            fragment.append(contentsOf: bigEndian(UInt16(index)))
            fragment.append(contentsOf: bigEndian(UInt16(count)))
            fragment.append(contentsOf: bytes[start..<end])
            out.append(fragment)
        }
        return out
    }

    /// A parsed fragment header, or nil when `plaintext` isn't a fragment.
    public struct Fragment: Sendable, Equatable {
        public var id: UInt32
        public var index: Int
        public var count: Int
        public var chunk: Data
    }

    public static func parseFragment(_ plaintext: Data) -> Fragment? {
        let bytes = [UInt8](plaintext)
        guard bytes.count >= headerLength, bytes[0] == fragmentMarker else { return nil }
        let id = bytes[1..<5].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let index = Int(bytes[5]) << 8 | Int(bytes[6])
        let count = Int(bytes[7]) << 8 | Int(bytes[8])
        return Fragment(id: id, index: index, count: count, chunk: Data(bytes[headerLength...]))
    }

    private static func bigEndian<T: FixedWidthInteger>(_ value: T) -> [UInt8] {
        withUnsafeBytes(of: value.bigEndian, Array.init)
    }
}

/// Receiver side of §6.1. Feed it every decrypted transport plaintext.
///
/// Limits: a reassembled message is at most `maxMessageBytes`, at most
/// `maxInFlight` messages can be partial at once, and a partial message is
/// dropped `timeout` after its first fragment. A violation drops that partial
/// message; the session carries on. `reset()` (on `0x04` or a new session)
/// clears everything.
public struct Reassembler: Sendable {
    public struct Limits: Sendable, Equatable {
        public var maxMessageBytes: Int
        public var maxInFlight: Int
        public var timeout: Duration

        public init(maxMessageBytes: Int = 4 * 1024 * 1024, maxInFlight: Int = 4, timeout: Duration = .seconds(30)) {
            self.maxMessageBytes = maxMessageBytes
            self.maxInFlight = maxInFlight
            self.timeout = timeout
        }

        public static let standard = Limits()
    }

    public enum Output: Sendable, Equatable {
        /// A complete JSON message (unfragmented, or the last fragment arrived).
        case message(Data)
        /// A fragment was stored; the message isn't complete yet.
        case partial
        /// Unknown first byte: ignore the plaintext.
        case ignored
        /// A limit or consistency violation dropped a partial message.
        case dropped(id: UInt32, reason: String)
    }

    private struct Partial: Sendable {
        var count: Int
        var chunks: [Int: Data]
        var bytes: Int
        var started: ContinuousClock.Instant
    }

    public let limits: Limits
    private var partials: [UInt32: Partial] = [:]
    /// Insertion order of `partials`, oldest first.
    private var order: [UInt32] = []

    public init(limits: Limits = .standard) {
        self.limits = limits
    }

    /// How many messages are partially received.
    public var inFlight: Int { partials.count }

    public mutating func reset() {
        partials = [:]
        order = []
    }

    /// Mirrors `Reassembler.push` in `protocol/ts/fragments.ts`, check for check.
    public mutating func receive(_ plaintext: Data, now: ContinuousClock.Instant = .now) -> Output {
        expire(now: now)
        guard let first = plaintext.first else { return .ignored }
        if first == Fragmentation.jsonMarker { return .message(plaintext) }
        guard first == Fragmentation.fragmentMarker else { return .ignored }
        // A header with no chunk carries nothing.
        guard plaintext.count > Fragmentation.headerLength, let fragment = Fragmentation.parseFragment(plaintext) else {
            return .ignored
        }
        let id = fragment.id
        guard fragment.count >= 2, fragment.count <= Fragmentation.maxFragments else {
            return drop(id, "n=\(fragment.count) out of range")
        }
        guard fragment.index < fragment.count else { return drop(id, "i=\(fragment.index) not below n=\(fragment.count)") }
        guard fragment.chunk.count <= Fragmentation.maxChunk else { return drop(id, "chunk of \(fragment.chunk.count) bytes") }

        var partial: Partial
        if let existing = partials[id] {
            partial = existing
        } else {
            guard partials.count < limits.maxInFlight else { return drop(id, "more than \(limits.maxInFlight) partial messages") }
            partial = Partial(count: fragment.count, chunks: [:], bytes: 0, started: now)
            partials[id] = partial
            order.append(id)
        }
        guard partial.count == fragment.count else { return drop(id, "n changed from \(partial.count) to \(fragment.count)") }
        guard partial.chunks[fragment.index] == nil else { return drop(id, "chunk \(fragment.index) repeated") }
        guard partial.bytes + fragment.chunk.count <= limits.maxMessageBytes else { return drop(id, "over \(limits.maxMessageBytes) bytes") }
        partial.chunks[fragment.index] = fragment.chunk
        partial.bytes += fragment.chunk.count

        guard partial.chunks.count == partial.count else {
            partials[id] = partial
            return .partial
        }
        remove(id)
        var message = Data(capacity: partial.bytes)
        for index in 0..<partial.count { message.append(partial.chunks[index]!) }
        return .message(message)
    }

    /// Drops partial messages older than the timeout.
    public mutating func expire(now: ContinuousClock.Instant = .now) {
        for id in order where partials[id].map({ now - $0.started >= limits.timeout }) ?? true {
            remove(id)
        }
    }

    private mutating func drop(_ id: UInt32, _ reason: String) -> Output {
        remove(id)
        return .dropped(id: id, reason: reason)
    }

    private mutating func remove(_ id: UInt32) {
        partials[id] = nil
        order.removeAll { $0 == id }
    }
}
