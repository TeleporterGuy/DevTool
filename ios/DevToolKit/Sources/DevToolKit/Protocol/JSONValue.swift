import Foundation

/// A JSON value, the working type of every protocol parser. Parsing mirrors
/// `JSON.parse` and the TS parsers' checks; serialization mirrors
/// `JSON.stringify` (compact, keys in insertion order), so encoded messages
/// match the TS output byte for byte.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    /// JSON numbers, as in JavaScript. Integers up to 2^53 are exact.
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)

    // MARK: Parsing

    /// Parses JSON text. Any top-level value is allowed (callers check the shape).
    public static func parse(_ text: String) throws(ProtocolError) -> JSONValue {
        try parse(Data(text.utf8))
    }

    /// Parses UTF-8 JSON bytes. Invalid UTF-8 is an error, not something to paper over.
    public static func parse(_ data: Data) throws(ProtocolError) -> JSONValue {
        guard String(data: data, encoding: .utf8) != nil else { throw ProtocolError("invalid UTF-8") }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw ProtocolError("payload is not JSON")
        }
        return try JSONValue(foundation: object)
    }

    init(foundation value: Any) throws(ProtocolError) {
        switch value {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            var out: [JSONValue] = []
            out.reserveCapacity(array.count)
            for element in array { out.append(try JSONValue(foundation: element)) }
            self = .array(out)
        case let dictionary as [String: Any]:
            var object = JSONObject()
            for (key, element) in dictionary { object[key] = try JSONValue(foundation: element) }
            self = .object(object)
        default:
            throw ProtocolError("unexpected JSON value")
        }
    }

    // MARK: Accessors

    public var objectValue: JSONObject? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var isNull: Bool { self == .null }

    // MARK: Serialization

    /// Compact JSON text, like `JSON.stringify`.
    public var jsonString: String {
        var out = ""
        write(to: &out)
        return out
    }

    /// Compact UTF-8 JSON bytes.
    public var jsonData: Data { Data(jsonString.utf8) }

    private func write(to out: inout String) {
        switch self {
        case .null:
            out += "null"
        case .bool(let b):
            out += b ? "true" : "false"
        case .number(let d):
            out += Self.formatNumber(d)
        case .string(let s):
            Self.writeString(s, to: &out)
        case .array(let array):
            out += "["
            for (index, element) in array.enumerated() {
                if index > 0 { out += "," }
                element.write(to: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            for (index, (key, element)) in object.entries.enumerated() {
                if index > 0 { out += "," }
                Self.writeString(key, to: &out)
                out += ":"
                element.write(to: &out)
            }
            out += "}"
        }
    }

    private static func formatNumber(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 9_007_199_254_740_992 {
            return String(Int64(d))
        }
        return "\(d)"
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue {
    public static func int(_ value: Int64) -> JSONValue { .number(Double(value)) }
}

/// A JSON object that keeps insertion order (for byte-exact serialization) and
/// compares without regard to order. Setting an existing key replaces its
/// value in place; setting `nil` removes it.
public struct JSONObject: Sendable, Equatable, ExpressibleByDictionaryLiteral {
    public private(set) var entries: [(String, JSONValue)] = []

    public init() {}

    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        for (key, value) in elements { self[key] = value }
    }

    public subscript(key: String) -> JSONValue? {
        get { entries.first { $0.0 == key }?.1 }
        set {
            if let index = entries.firstIndex(where: { $0.0 == key }) {
                if let newValue { entries[index].1 = newValue } else { entries.remove(at: index) }
            } else if let newValue {
                entries.append((key, newValue))
            }
        }
    }

    public var keys: [String] { entries.map(\.0) }
    public var count: Int { entries.count }

    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        guard lhs.entries.count == rhs.entries.count else { return false }
        for (key, value) in lhs.entries where rhs[key] != value { return false }
        return true
    }
}
