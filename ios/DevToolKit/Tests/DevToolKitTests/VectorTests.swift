import Foundation
import Testing
@testable import DevToolKit

/// Loads `protocol/vectors/…` straight from the repo (SPEC.md §5).
enum Vectors {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // DevToolKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // DevToolKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repo root
        .appending(path: "protocol/vectors")

    static func load(_ name: String) throws -> JSONObject {
        let data = try Data(contentsOf: directory.appending(path: name))
        return try #require(try JSONValue.parse(data).objectValue)
    }
}

extension JSONValue {
    subscript(key: String) -> JSONValue? { objectValue?[key] }

    var array: [JSONValue] {
        if case .array(let a) = self { return a }
        return []
    }

    /// Hex bytes; records an issue (and returns empty) when the field isn't hex.
    var hex: Data {
        guard let s = stringValue, let data = Data(hex: s) else {
            Issue.record("expected a hex string, got \(self)")
            return Data()
        }
        return data
    }

    var str: String {
        guard let s = stringValue else {
            Issue.record("expected a string, got \(self)")
            return ""
        }
        return s
    }
}

extension Optional where Wrapped == JSONValue {
    subscript(key: String) -> JSONValue? { self?[key] }
    var hex: Data { (self ?? .null).hex }
    var str: String { (self ?? .null).str }
    var array: [JSONValue] { self?.array ?? [] }
}

// MARK: - Noise

@Suite struct NoiseVectorTests {
    /// Runs a full IK exchange and checks every byte against the vector.
    /// `messages[0...1]` are the handshake, the rest transport; `fromInitiator`
    /// says who sends each transport message.
    static func run(
        prologue: Data,
        initStatic: Data, initEphemeral: Data, respStatic: Data, respEphemeral: Data,
        remoteStatic: Data,
        handshake: [(payload: Data, ciphertext: Data)],
        handshakeHash: Data?,
        transport: [(fromInitiator: Bool, payload: Data, ciphertext: Data)]
    ) throws {
        let initS = try Primitives.x25519(fromPrivate: initStatic)
        let respS = try Primitives.x25519(fromPrivate: respStatic)
        #expect(respS.pub == remoteStatic)
        var initiator = try HandshakeState.initiator(
            prologue: prologue, s: initS, rs: remoteStatic, e: try Primitives.x25519(fromPrivate: initEphemeral))
        var responder = try HandshakeState.responder(
            prologue: prologue, s: respS, e: try Primitives.x25519(fromPrivate: respEphemeral))

        let msg1 = try initiator.writeMessage(handshake[0].payload)
        #expect(msg1.hexString == handshake[0].ciphertext.hexString)
        #expect(try responder.readMessage(handshake[0].ciphertext) == handshake[0].payload)
        #expect(responder.remoteStatic == initS.pub)

        let msg2 = try responder.writeMessage(handshake[1].payload)
        #expect(msg2.hexString == handshake[1].ciphertext.hexString)
        #expect(try initiator.readMessage(handshake[1].ciphertext) == handshake[1].payload)

        #expect(initiator.isComplete && responder.isComplete)
        #expect(initiator.handshakeHash == responder.handshakeHash)
        if let handshakeHash { #expect(initiator.handshakeHash.hexString == handshakeHash.hexString) }

        var initT = try initiator.split()
        var respT = try responder.split()
        for message in transport {
            if message.fromInitiator {
                #expect(try initT.encrypt(message.payload).hexString == message.ciphertext.hexString)
                #expect(try respT.decrypt(message.ciphertext) == message.payload)
            } else {
                #expect(try respT.encrypt(message.payload).hexString == message.ciphertext.hexString)
                #expect(try initT.decrypt(message.ciphertext) == message.payload)
            }
        }
    }

    @Test func officialVectors() throws {
        // The official file for our suite, e.g. `official/noise-ik-25519-aesgcm-sha256.json`.
        let official = try FileManager.default.contentsOfDirectory(atPath: Vectors.directory.appending(path: "official").path())
        let name = try #require(official.first { $0.lowercased() == Noise.protocolName.lowercased().replacingOccurrences(of: "noise_", with: "noise-").replacingOccurrences(of: "_", with: "-") + ".json" },
                                "no official vectors for \(Noise.protocolName) in \(official)")
        let file = try Vectors.load("official/\(name)")
        let vectors = file["vectors"].array
        #expect(!vectors.isEmpty)
        for v in vectors {
            #expect(v["protocol_name"].str == Noise.protocolName)
            #expect(v["init_prologue"].hex == v["resp_prologue"].hex)
            let messages = v["messages"].array.map { (payload: $0["payload"].hex, ciphertext: $0["ciphertext"].hex) }
            try Self.run(
                prologue: v["init_prologue"].hex,
                initStatic: v["init_static"].hex, initEphemeral: v["init_ephemeral"].hex,
                respStatic: v["resp_static"].hex, respEphemeral: v["resp_ephemeral"].hex,
                remoteStatic: v["init_remote_static"].hex,
                handshake: Array(messages.prefix(2)),
                handshakeHash: v["handshake_hash"] == nil ? nil : v["handshake_hash"].hex,
                // The alternation continues after the handshake: index 2 is the initiator's.
                transport: messages.enumerated().dropFirst(2).map { (fromInitiator: $0.offset % 2 == 0, payload: $0.element.payload, ciphertext: $0.element.ciphertext) }
            )
        }
    }

    @Test func generatedVectors() throws {
        let file = try Vectors.load("noise-ik.json")
        let vectors = file["vectors"].array
        #expect(vectors.map { $0["name"]?.stringValue } == ["pair", "resume", "empty-payloads"])
        for v in vectors {
            #expect(v["protocol"].str == Noise.protocolName)
            #expect(v["prologue"].hex == Noise.devtoolPrologue)
            let phone = try #require(v["phone"]), desktop = try #require(v["desktop"])
            for pair in [phone["static"], phone["ephemeral"], desktop["static"], desktop["ephemeral"]] {
                #expect(try Primitives.x25519(fromPrivate: pair?["priv"].hex ?? Data()).pub == (pair?["pub"].hex))
            }
            try Self.run(
                prologue: v["prologue"].hex,
                initStatic: phone["static"]?["priv"].hex ?? Data(),
                initEphemeral: phone["ephemeral"]?["priv"].hex ?? Data(),
                respStatic: desktop["static"]?["priv"].hex ?? Data(),
                respEphemeral: desktop["ephemeral"]?["priv"].hex ?? Data(),
                remoteStatic: desktop["static"]?["pub"].hex ?? Data(),
                handshake: [
                    (v["msg1"]?["payload"].hex ?? Data(), v["msg1"]?["ciphertext"].hex ?? Data()),
                    (v["msg2"]?["payload"].hex ?? Data(), v["msg2"]?["ciphertext"].hex ?? Data()),
                ],
                handshakeHash: v["handshakeHash"].hex,
                transport: v["transport"].array.map {
                    (fromInitiator: $0["from"].str == "phone", payload: $0["payload"].hex, ciphertext: $0["ciphertext"].hex)
                }
            )
            // Handshake payloads are the §4.3 JSON and parse as such.
            if case let payload = v["msg1"]["payload"].hex, !payload.isEmpty {
                let hello = try PhoneHello.parse(payload)
                #expect(hello.json.jsonData == payload, "PhoneHello re-encodes byte for byte")
            }
            if case let payload = v["msg2"]["payload"].hex, !payload.isEmpty {
                let hello = try DesktopHello.parse(payload)
                #expect(hello.json.jsonData == payload, "DesktopHello re-encodes byte for byte")
            }
        }
    }

    @Test func tamperedMessagesFailWithoutAdvancingNonce() throws {
        let phone = Primitives.generateX25519(), desktop = Primitives.generateX25519()
        var i = try HandshakeState.initiator(s: phone, rs: desktop.pub)
        var r = try HandshakeState.responder(s: desktop)
        var m1 = try i.writeMessage(Data("hi".utf8))
        m1[m1.count - 1] ^= 1
        var r2 = r
        #expect(throws: ProtocolError.self) { try r2.readMessage(m1) }
        m1[m1.count - 1] ^= 1
        _ = try r.readMessage(m1)
        _ = try i.readMessage(try r.writeMessage())
        var it = try i.split(), rt = try r.split()
        var c = try it.encrypt(Data("x".utf8))
        c[0] ^= 1
        #expect(throws: ProtocolError.self) { try rt.decrypt(c) }
        #expect(rt.recvNonce == 0)
        c[0] ^= 1
        #expect(try rt.decrypt(c) == Data("x".utf8))
        #expect(throws: ProtocolError.self) { try it.encrypt(Data(count: Noise.maxMessageLength)) }
        _ = try it.encrypt(Data(count: Noise.maxMessageLength - 16))
    }

    @Test func truncatedMessage1Throws() throws {
        var r = try HandshakeState.responder(s: Primitives.generateX25519())
        #expect(throws: ProtocolError.self) { try r.readMessage(Data(count: 40)) }
    }
}

// MARK: - Derivations and keys

@Suite struct DeriveVectorTests {
    @Test func secrets() throws {
        let file = try Vectors.load("derive.json")
        let secrets = file["secrets"].array
        #expect(!secrets.isEmpty)
        for v in secrets {
            let secret = v["secret"].hex
            let token = Derive.relayToken(secret: secret)
            #expect(token.hexString == (v["relayToken"].str))
            #expect(Derive.pairProof(secret: secret).hexString == (v["pairProof"].str))
            let hash = Derive.tokenHash(relayToken: token)
            #expect(hash.hexString == (v["tokenHash"].str))
            #expect(hash.base64URLEncodedString == (v["tokenHashB64u"].str))
        }
    }

    @Test func deviceIds() throws {
        let file = try Vectors.load("derive.json")
        for v in file["deviceIds"].array {
            let pair = try Primitives.ed25519(fromSeed: v["seed"].hex)
            #expect(pair.pub.hexString == (v["pub"].str))
            #expect(try Derive.deviceId(ed25519Pub: pair.pub) == (v["deviceId"].str))
        }
    }

    @Test func x25519() throws {
        let file = try Vectors.load("derive.json")
        for v in file["x25519"].array {
            #expect(try Primitives.x25519(fromPrivate: v["priv"].hex).pub.hexString == (v["pub"].str))
        }
        for v in file["x25519Dh"].array {
            #expect(try Primitives.x25519(priv: v["priv"].hex, pub: v["pub"].hex).hexString == (v["shared"].str))
        }
    }

    @Test func lowOrderPointIsRefused() {
        #expect(throws: ProtocolError.self) {
            try Primitives.x25519(priv: Primitives.generateX25519().priv, pub: Data(count: 32))
        }
    }

    @Test func identityPersistsInStore() throws {
        let store = InMemorySecretStore()
        let a = try DeviceIdentity.loadOrCreate(store: store, label: "t")
        let b = try DeviceIdentity.loadOrCreate(store: store, label: "t")
        #expect(a == b)
        #expect(a.deviceId == DeviceId(ed25519PublicKey: a.ed25519.pub).rawValue)
        store.delete("t.ed25519")
        #expect(try DeviceIdentity.loadOrCreate(store: store, label: "t") != a)
    }
}

// MARK: - Relay auth

@Suite struct RelayAuthVectorTests {
    /// CryptoKit's Ed25519 signatures are randomized, so they can't be compared
    /// with the vector's deterministic RFC 8032 ones byte for byte. Instead:
    /// the payload must match exactly, the vector's signature must verify with
    /// CryptoKit, our own signature must verify with the vector's public key,
    /// and the `hello` text built with the vector's signature must match exactly.
    @Test func vectors() throws {
        let file = try Vectors.load("relay-auth.json")
        let vectors = file["vectors"].array
        #expect(vectors.count == 3)
        for v in vectors {
            let ed = try #require(v["ed25519"])
            let pair = try Primitives.ed25519(fromSeed: ed["seed"].hex)
            #expect(pair.pub.hexString == (ed["pub"].str))
            #expect(try Derive.deviceId(ed25519Pub: pair.pub) == (ed["deviceId"].str))

            let role = try #require(RelayRole(rawValue: v["role"].str))
            let nonce = v["nonce"].str
            let payload = RelayProtocol.authPayload(role: role, nonce: nonce)
            #expect(payload.hexString == (v["payload"].str))

            let vectorSig = v["sig"].hex
            #expect(Primitives.ed25519Verify(pub: pair.pub, message: payload, signature: vectorSig))
            var tampered = vectorSig
            tampered[0] ^= 1
            #expect(!Primitives.ed25519Verify(pub: pair.pub, message: payload, signature: tampered))

            let expectedHello = v["hello"].str
            let parsed = try RelayClientMessage.parse(expectedHello)
            guard case .hello(let pRole, let pPub, let pSig, let pPair) = parsed else {
                Issue.record("vector hello did not parse as hello")
                continue
            }
            #expect(pRole == role && pPub == pair.pub.base64URLEncodedString && pSig == vectorSig.base64URLEncodedString)
            #expect(RelayProtocol.verifyHello(pub: pPub, sig: pSig, role: role, nonce: nonce) == (ed["deviceId"].str))

            let token = try pPair.map { try #require(Base64URL.decode($0.token)) }
            let ours = try RelayProtocol.hello(role: role, nonce: nonce, ed25519: pair, pair: pPair.map { ($0.to, token!) })
            guard case .hello(_, let oPub, let oSig, let oPair) = ours else {
                Issue.record("hello builder produced something else")
                continue
            }
            #expect(oPub == pPub && oPair == pPair)
            #expect(RelayProtocol.verifyHello(pub: oPub, sig: oSig, role: role, nonce: nonce) == (ed["deviceId"].str))
            // Same message with the vector's signature: byte-identical JSON.
            #expect(RelayClientMessage.hello(role: role, pub: oPub, sig: pSig, pair: oPair).text == expectedHello)
        }
    }
}

// MARK: - Pairing URI

@Suite struct PairingURIVectorTests {
    @Test func valid() throws {
        let file = try Vectors.load("pairing-uri.json")
        let valid = file["valid"].array
        #expect(valid.count >= 3)
        for v in valid {
            let payload = try #require(v["payload"])
            let uri = v["uri"].str
            let invite = try PairingInvite.parse(uri)
            #expect(invite.json == payload)
            #expect(invite.relayToken == Derive.relayToken(secret: invite.secret))
            if v["note"] == nil {
                #expect(invite.uri == uri)
                #expect(try PairingInvite(json: payload).uri == uri)
            }
        }
    }

    @Test func invalid() throws {
        let file = try Vectors.load("pairing-uri.json")
        let invalid = file["invalid"].array
        #expect(invalid.count >= 9)
        for v in invalid {
            let uri = v["uri"].str
            #expect(throws: PairingInviteError.self, "\(v["reason"]?.stringValue ?? "?")") {
                try PairingInvite.parse(uri)
            }
        }
    }

    @Test func expiryIsSeparate() throws {
        let uri = try Vectors.load("pairing-uri.json")["valid"].array.first?["uri"].str ?? ""
        let invite = try PairingInvite.parse(uri)
        #expect(invite.isExpired(now: invite.expiresAt))
        #expect(!invite.isExpired(now: invite.expiresAt.addingTimeInterval(-1)))
    }
}

// MARK: - App messages

@Suite struct AppMessageVectorTests {
    static func payload(_ sample: JSONValue) throws -> Data {
        Data(sample["json"].str.utf8)
    }

    @Test func phoneHello() throws {
        let file = try Vectors.load("app-messages.json")
        for sample in file["phoneHello"].array {
            #expect(try PhoneHello.parse(try Self.payload(sample)).json == sample["expected"])
        }
    }

    @Test func desktopHello() throws {
        let file = try Vectors.load("app-messages.json")
        for sample in file["desktopHello"].array {
            #expect(try DesktopHello.parse(try Self.payload(sample)).json == sample["expected"])
        }
    }

    @Test func appMessages() throws {
        let file = try Vectors.load("app-messages.json")
        let samples = file["appMessages"].array
        #expect(samples.count >= 6)
        for sample in samples {
            let parsed = try AppMessage.parse(try Self.payload(sample))
            if sample["expected"] == .null {
                #expect(parsed == nil, "\(sample["json"].str)")
            } else {
                #expect(parsed?.json == sample["expected"], "\(sample["json"].str)")
                // `res.result` for inbox.get validates as an Inbox.
                if case .resOk(_, let result)? = parsed, result.objectValue?["desktop"] != nil {
                    #expect(try Inbox.parse(result).json == result)
                }
            }
        }
    }

    @Test func inboxWithUnknownFields() throws {
        let file = try Vectors.load("app-messages.json")
        let sample = try #require(file["inboxWithUnknownFields"])
        let inbox = try Inbox.parse(try JSONValue.parse(sample["json"].str))
        #expect(inbox.json == sample["expected"])
        #expect(inbox.projects[0].tasks[0].tabs[0].type == .unknown("gemini"))
        #expect(inbox.projects[0].tasks[0].tabs[0].status == .idle)
    }

    @Test func invalidSamplesFail() throws {
        let file = try Vectors.load("app-messages.json")
        let invalid = try #require(file["invalid"])
        for json in invalid["phoneHello"].array {
            #expect(throws: ProtocolError.self) { try PhoneHello.parse(Data(json.str.utf8)) }
        }
        for json in invalid["desktopHello"].array {
            #expect(throws: ProtocolError.self) { try DesktopHello.parse(Data(json.str.utf8)) }
        }
        for json in invalid["appMessages"].array {
            #expect(throws: ProtocolError.self, "\(json.str)") { try AppMessage.parse(Data(json.str.utf8)) }
        }
    }

    @Test func versionNegotiation() throws {
        let file = try Vectors.load("app-messages.json")
        let samples = file["versionNegotiation"].array
        #expect(samples.count >= 5)
        func info(_ value: JSONValue?) throws -> VersionInfo {
            guard case .number(let v)? = value?["v"], case .number(let min)? = value?["min"] else { throw ProtocolError("bad sample") }
            return VersionInfo(v: Int(v), min: Int(min))
        }
        for sample in samples {
            let result = VersionNegotiation.negotiate(local: try info(sample["local"]), remote: try info(sample["remote"]))
            let expected = try #require(sample["result"])
            switch result {
            case .ok(let version):
                #expect(expected["ok"] == .bool(true) && expected["version"] == .int(Int64(version)))
            case .incompatible(let update):
                #expect(expected["ok"] == .bool(false) && expected["update"] == .string(update.rawValue))
            }
        }
    }

    @Test func versionOnlyParsesFutureShapes() throws {
        let info = try VersionInfo.parse(Data(#"{"v":3,"min":2,"whatever":{}}"#.utf8))
        #expect(info == VersionInfo(v: 3, min: 2))
        #expect(throws: ProtocolError.self) { try VersionInfo.parse(Data(#"{"v":1,"min":2}"#.utf8)) }
    }
}

// MARK: - Relay messages and envelope

@Suite struct RelayMessageTests {
    @Test func parsesServerMessagesAndDropsUnknownFields() throws {
        let id = "20671253fbf6054273bb719d3a34999b"
        #expect(try RelayServerMessage.parse(#"{"t":"ready","id":"\#(id)","extra":1}"#) == .ready(id: id))
        #expect(try RelayServerMessage.parse(#"{"t":"peer","id":"\#(id)","state":"offline","lastSeen":1790000000000}"#)
            == .peer(id: id, state: .offline, lastSeen: 1_790_000_000_000))
        #expect(try RelayServerMessage.parse(#"{"t":"error","code":"offline","to":"\#(id)"}"#)
            == .error(code: .offline, message: nil, to: id))
        #expect(try RelayServerMessage.parse(#"{"t":"frame","from":"\#(id)","data":"AQ"}"#) == .frame(from: id, data: "AQ"))
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"frame","to":"\#(id)","data":"AQ"}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"frame","from":"\#(id)","data":""}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"challenge","nonce":"AA"}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"nope"}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse("[]") }
    }

    @Test func toleratesValuesANewerRelayMayAdd() throws {
        let id = "20671253fbf6054273bb719d3a34999b"
        // Unknown error code: kept, and handled as a generic error.
        #expect(try RelayServerMessage.parse(#"{"t":"error","code":"maintenance","to":"\#(id)"}"#)
            == .error(code: .other("maintenance"), message: nil, to: id))
        #expect(RelayErrorCode(rawValue: "bad-request") == .badRequest)
        #expect(RelayErrorCode.other("maintenance").rawValue == "maintenance")
        // Unknown peer state: the message is ignored.
        #expect(try RelayServerMessage.parse(#"{"t":"peer","id":"\#(id)","state":"asleep"}"#) == nil)
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"peer","id":"x","state":"asleep"}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"error","code":""}"#) }
        #expect(throws: ProtocolError.self) { try RelayServerMessage.parse(#"{"t":"error"}"#) }
        #expect(RelayProtocol.CloseCode.pairingExpired == 4403)
        #expect(RelayProtocol.CloseCode.goingAway == 1001)
    }

    @Test func encodesClientMessages() {
        #expect(RelayClientMessage.watch(desktops: ["a"]).text == #"{"t":"watch","desktops":["a"]}"#)
        #expect(RelayClientMessage.frame(to: "b", data: "AQ").text == #"{"t":"frame","to":"b","data":"AQ"}"#)
        #expect(RelayClientMessage.ping.text == #"{"t":"ping"}"#)
    }

    @Test func envelope() throws {
        #expect(try Envelope(kind: .transport, body: Data([9])).encode() == Data([3, 9]))
        #expect(try Envelope.decode(Data([4, 1, 2])) == Envelope(kind: .reset))
        #expect(throws: ProtocolError.self) { try Envelope.decode(Data()) }
        #expect(throws: ProtocolError.self) { try Envelope.decode(Data([9])) }
        #expect(throws: ProtocolError.self) { try Envelope(kind: .reset, body: Data([1])).encode() }
    }

    @Test func jsonSerializationMatchesJavaScript() throws {
        let value: JSONValue = .object(["s": "a\"b\\c\n\u{01}é🐴/", "n": .int(1_790_000_000_000), "b": false, "z": .null])
        #expect(value.jsonString == #"{"s":"a\"b\\c\n\u0001é🐴/","n":1790000000000,"b":false,"z":null}"#)
        #expect(try JSONValue.parse(value.jsonString) == value)
    }
}
