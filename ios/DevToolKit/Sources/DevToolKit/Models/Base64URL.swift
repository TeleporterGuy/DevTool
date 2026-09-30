import Foundation

/// Base64url without padding ("b64u"), the binary encoding used everywhere in
/// the protocol (spec §1).
public enum Base64URL {
    /// Encodes bytes as base64url with no `=` padding.
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes base64url strictly, as the spec requires everywhere (§2): no
    /// `=` padding, nothing outside the url-safe alphabet, and no
    /// non-canonical trailing bits (so two strings can't name the same key).
    /// Mirrors `b64uDecode` in `protocol/ts/encoding.ts`.
    public static func decode(_ string: String) -> Data? {
        guard string.utf8.allSatisfy(isAlphabet) else { return nil }
        let remainder = string.utf8.count % 4
        if remainder == 1 { return nil }
        var s = string.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: s), encode(data) == string else { return nil }
        return data
    }

    private static func isAlphabet(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"), UInt8(ascii: "_"):
            return true
        default:
            return false
        }
    }
}

extension Data {
    /// This data as base64url without padding.
    public var base64URLEncodedString: String { Base64URL.encode(self) }

    /// Decodes strict base64url (no padding). Returns nil on invalid input.
    public init?(base64URLEncoded string: String) {
        guard let data = Base64URL.decode(string) else { return nil }
        self = data
    }
}
