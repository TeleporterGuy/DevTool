import Foundation
import Testing
@testable import DevToolKit

@Suite struct PairingInviteTests {
    static let key32 = Data(repeating: 7, count: 32)
    /// The ID must match `e` (here `key32`), or the invite is refused.
    static let desktopId = DeviceId(ed25519PublicKey: key32).rawValue

    static func uri(for json: String) -> String {
        "devtool://pair?d=" + Data(json.utf8).base64URLEncodedString
    }

    static func json(
        v: Int = 1,
        relay: String = "wss://relay.devtool.awantech.sk",
        id: String = desktopId,
        x: String = key32.base64URLEncodedString,
        exp: Int = 1_790_000_300,
        extra: String = ""
    ) -> String {
        let k = key32.base64URLEncodedString
        return """
        {"v":\(v),"relay":"\(relay)","id":"\(id)","x":"\(x)","e":"\(k)","s":"\(k)","n":"join3r-mbp","exp":\(exp)\(extra)}
        """
    }

    @Test func flagsUnencryptedRemoteRelays() {
        func flagged(_ s: String) -> Bool { PairingInvite.isUnencryptedRemoteRelay(URL(string: s)!) }
        #expect(flagged("ws://relay.example.com"))
        #expect(flagged("ws://192.168.1.5:8787"))
        #expect(!flagged("ws://localhost:8787"))
        #expect(!flagged("ws://127.0.0.1:8787"))
        #expect(!flagged("ws://[::1]:8787"))
        #expect(!flagged("wss://relay.example.com"))
    }

    @Test func parsesValidURI() throws {
        let invite = try PairingInvite.parse(Self.uri(for: Self.json()))
        #expect(invite.version == 1)
        #expect(invite.relayURL.absoluteString == "wss://relay.devtool.awantech.sk")
        #expect(invite.desktopId == Self.desktopId)
        #expect(invite.desktopX25519PublicKey == Self.key32)
        #expect(invite.desktopEd25519PublicKey == Self.key32)
        #expect(invite.secret == Self.key32)
        #expect(invite.desktopName == "join3r-mbp")
        #expect(invite.expiresAt == Date(timeIntervalSince1970: 1_790_000_300))
    }

    @Test func ignoresUnknownFieldsAndWhitespace() throws {
        let uri = "  " + Self.uri(for: Self.json(extra: #","future":{"a":1}"#)) + "\n"
        let invite = try PairingInvite.parse(uri)
        #expect(invite.desktopName == "join3r-mbp")
    }

    @Test func roundTripsThroughURI() throws {
        let invite = try PairingInvite.parse(Self.uri(for: Self.json()))
        #expect(try PairingInvite.parse(invite.uri) == invite)
    }

    @Test func rejectsOtherVersions() {
        #expect(throws: PairingInviteError.unsupportedVersion(2)) {
            try PairingInvite.parse(Self.uri(for: Self.json(v: 2)))
        }
        #expect(throws: PairingInviteError.unsupportedVersion(3)) {
            try PairingInvite.parse(Self.uri(for: #"{"v":3,"somethingElse":true}"#))
        }
    }

    @Test func rejectsWrongSchemeHostAndPayload() {
        #expect(throws: PairingInviteError.notAPairingLink) {
            try PairingInvite.parse("https://pair?d=abc")
        }
        #expect(throws: PairingInviteError.notAPairingLink) {
            try PairingInvite.parse("devtool://open?d=abc")
        }
        #expect(throws: PairingInviteError.missingPayload) {
            try PairingInvite.parse("devtool://pair")
        }
        #expect(throws: PairingInviteError.invalidEncoding) {
            try PairingInvite.parse("devtool://pair?d=a+b/")
        }
        #expect(throws: PairingInviteError.invalidJSON) {
            try PairingInvite.parse(Self.uri(for: "not json"))
        }
    }

    @Test func validatesFields() {
        #expect(throws: PairingInviteError.invalidField("relay")) {
            try PairingInvite.parse(Self.uri(for: Self.json(relay: "https://relay.example")))
        }
        #expect(throws: PairingInviteError.invalidField("id")) {
            try PairingInvite.parse(Self.uri(for: Self.json(id: "XYZ")))
        }
        #expect(throws: PairingInviteError.invalidField("id")) {
            try PairingInvite.parse(Self.uri(for: Self.json(id: "0123456789abcdef0123456789abcdef")))
        }
        #expect(throws: PairingInviteError.invalidField("x")) {
            try PairingInvite.parse(Self.uri(for: Self.json(x: Data(count: 31).base64URLEncodedString)))
        }
    }

    @Test func expiry() throws {
        let invite = try PairingInvite.parse(Self.uri(for: Self.json(exp: 1000)))
        #expect(!invite.isExpired(now: Date(timeIntervalSince1970: 999)))
        #expect(invite.isExpired(now: Date(timeIntervalSince1970: 1000)))
        #expect(invite.remainingTime(now: Date(timeIntervalSince1970: 940)) == 60)
        #expect(invite.remainingTime(now: Date(timeIntervalSince1970: 2000)) == 0)
        #expect(throws: PairingInviteError.expired) {
            try PairingInvite.parse(Self.uri(for: Self.json(exp: 1000)), now: Date(timeIntervalSince1970: 1001))
        }
    }
}

@Suite struct Base64URLTests {
    @Test func encodesWithoutPadding() {
        #expect(Base64URL.encode(Data([0xfb, 0xff])) == "-_8")
        #expect(Base64URL.encode(Data("f".utf8)) == "Zg")
        #expect(Base64URL.encode(Data()) == "")
    }

    @Test func decodesUnpadded() {
        #expect(Base64URL.decode("-_8") == Data([0xfb, 0xff]))
        #expect(Base64URL.decode("Zg") == Data("f".utf8))
        #expect(Base64URL.decode("") == Data())
    }

    /// Spec §2: strict everywhere, like `b64uDecode` in TS.
    @Test func rejectsPaddingAndNonCanonicalBits() {
        #expect(Base64URL.decode("Zg==") == nil)
        #expect(Base64URL.decode("Zh") == nil) // same bytes as "Zg", non-zero trailing bits
        #expect(Base64URL.decode("AB") == nil)
        #expect(Base64URL.decode("AA") == Data([0]))
    }

    @Test func rejectsInvalid() {
        #expect(Base64URL.decode("+/8") == nil)
        #expect(Base64URL.decode("a") == nil)
        #expect(Base64URL.decode("ab$c") == nil)
    }

    @Test func roundTripsAllLengths() {
        for n in 0..<40 {
            let data = Data((0..<n).map { UInt8(($0 * 37 + 11) & 0xff) })
            #expect(Base64URL.decode(Base64URL.encode(data)) == data)
        }
    }
}

@Suite struct DeviceIdTests {
    @Test func derivesFromEd25519Key() {
        // SHA-256 of 32 zero bytes = 66687aad f862bd77 6c8fc18b 8e9f8e20 ...
        let id = DeviceId(ed25519PublicKey: Data(count: 32))
        #expect(id.rawValue == "66687aadf862bd776c8fc18b8e9f8e20")
    }

    @Test func validatesStrings() {
        #expect(DeviceId("66687aadf862bd776c8fc18b8e9f8e20") != nil)
        #expect(DeviceId("66687AADF862BD776C8FC18B8E9F8E20") == nil)
        #expect(DeviceId("abc") == nil)
    }
}
