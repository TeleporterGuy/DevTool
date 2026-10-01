import Foundation

/// Small byte helpers shared by the crypto and protocol layers.
public enum Hex {
    /// Lowercase hex, as used by the test vectors and device IDs.
    public static func encode(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for byte in data {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Decodes hex (either case). Returns nil on odd length or a non-hex character.
    public static func decode(_ string: String) -> Data? {
        let chars = Array(string.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var index = 0
        while index < chars.count {
            guard let hi = nibble(chars[index]), let lo = nibble(chars[index + 1]) else { return nil }
            out.append(hi << 4 | lo)
            index += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): c - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): c - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): c - UInt8(ascii: "A") + 10
        default: nil
        }
    }
}

extension Data {
    /// Lowercase hex of these bytes.
    public var hexString: String { Hex.encode(self) }

    /// Decodes hex; nil on invalid input.
    public init?(hex: String) {
        guard let data = Hex.decode(hex) else { return nil }
        self = data
    }

    static func concat(_ parts: Data...) -> Data {
        var out = Data(capacity: parts.reduce(0) { $0 + $1.count })
        for part in parts { out.append(part) }
        return out
    }
}
