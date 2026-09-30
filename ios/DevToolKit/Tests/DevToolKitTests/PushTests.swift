import Foundation
import Testing
@testable import DevToolKit

/// `protocol/vectors/push.json` (§7).
@Suite struct PushVectorTests {
    @Test func registrationBody() throws {
        let file = try Vectors.load("push.json")
        let register = try #require(file["register"])
        let phone = try #require(register["phone"])
        let identity = DeviceIdentity(
            x25519: Primitives.generateX25519(),
            ed25519: try Primitives.ed25519(fromSeed: phone["seed"].hex)
        )
        #expect(identity.ed25519.pub == phone["pub"].hex)
        #expect(identity.deviceId == phone["deviceId"].str)

        let token = register["token"].str
        let env = try #require(PushEnv(rawValue: register["env"].str))
        guard case .number(let rawTs)? = register["ts"] else { Issue.record("no ts"); return }
        let ts = Int64(rawTs)

        // `message` is JSON-encoded in the vector so its newlines show.
        let message = try #require(try JSONValue.parse(register["message"].str).stringValue)
        #expect(PushRegistration.message(token: token, env: env, ts: ts) == Data(message.utf8))

        let body = try #require(register["body"])
        let vectorSig = try #require(Data(base64URLEncoded: body["sig"].str))

        // CryptoKit's Ed25519 is randomized (hedged), not RFC 8032
        // deterministic like Node's, so our `sig` can't equal the vector's byte
        // for byte. Instead: the vector's sig verifies with the vector pub, ours
        // does too, and every other field (and the serialization with the
        // vector's sig swapped in) matches exactly.
        #expect(Primitives.ed25519Verify(pub: identity.ed25519.pub, message: Data(message.utf8), signature: vectorSig))
        let signed = try PushRegistration.sign(identity: identity, token: token, env: env, ts: ts)
        #expect(signed.isValid)
        #expect(Primitives.ed25519Verify(pub: phone["pub"].hex, message: Data(message.utf8), signature: Data(base64URLEncoded: signed.sig)!))
        var withVectorSig = signed
        withVectorSig.sig = body["sig"].str
        #expect(withVectorSig.isValid)
        #expect(withVectorSig.json == body)
        #expect(withVectorSig.json.jsonString == #"{"pub":"\#(body["pub"].str)","token":"\#(token)","env":"sandbox","ts":\#(ts),"sig":"\#(body["sig"].str)"}"#)

        var tampered = withVectorSig
        tampered.ts += 1
        #expect(!tampered.isValid)
    }

    @Test func payloadsOpen() throws {
        let file = try Vectors.load("push.json")
        let payload = try #require(file["payload"])
        let key = payload["key"].hex, keyId = payload["keyId"].hex
        let cases = payload["cases"].array
        #expect(cases.count >= 4)
        for sample in cases {
            let name = sample["name"].str
            let data = sample["data"].str
            #expect(PushCrypto.keyId(of: data) == keyId, "\(name)")
            let opened = try #require(PushCrypto.open(key: key, data: data), "\(name)")
            #expect(opened.json == sample["opened"], "\(name)")
            #expect(data.count <= Push.dataMaxLength)
            // A wrong key doesn't open it.
            #expect(PushCrypto.open(key: Data(repeating: 9, count: 32), data: data) == nil)
        }
    }

    /// Sealing with the fixed nonce gives the vector's bytes (for the cases the
    /// desktop didn't have to cut).
    @Test func sealMatchesUncutCases() throws {
        let file = try Vectors.load("push.json")
        let payload = try #require(file["payload"])
        let key = payload["key"].hex, keyId = payload["keyId"].hex, nonce = payload["nonce"].hex
        var matched = 0
        for sample in payload["cases"].array where sample["input"] == sample["opened"] {
            let input = try PushPayload.parse(try #require(sample["input"]))
            #expect(try PushCrypto.seal(key: key, keyId: keyId, plaintext: input.json.jsonData, nonce: nonce) == sample["data"].str)
            matched += 1
        }
        #expect(matched >= 2)
    }

    @Test func params() throws {
        let file = try Vectors.load("push.json")
        for sample in file["params"].array {
            let op = sample["op"].str
            if op == PushOp.register {
                let parsed = try PushRegisterParams.parse(sample["params"])
                #expect(parsed.json == sample["parsed"])
            } else {
                #expect(op == PushOp.unregister)
                #expect(sample["parsed"] == .object([:]))
            }
        }
    }
}

@Suite struct PushPayloadTests {
    static let key = Data(repeating: 7, count: 32)
    static let keyId = Data([1, 2, 3, 4, 5, 6, 7, 8])

    static func seal(_ json: String) throws -> String {
        try PushCrypto.seal(key: key, keyId: keyId, plaintext: Data(json.utf8))
    }

    @Test func unknownKindIsKept() throws {
        let data = try Self.seal(#"{"v":1,"kind":"future","desktop":"d","tab":"t","title":"T","body":"B","at":1,"extra":true}"#)
        let payload = try #require(PushCrypto.open(key: Self.key, data: data))
        #expect(payload.kind == "future")
        #expect(payload.prompt == nil)
    }

    @Test func nullPromptIsAbsent() throws {
        let data = try Self.seal(#"{"v":1,"kind":"done","desktop":"d","tab":"t","prompt":null,"title":"T","body":"B","at":1}"#)
        #expect(try #require(PushCrypto.open(key: Self.key, data: data)).prompt == nil)
    }

    @Test func rejects() throws {
        for json in [
            #"{"v":2,"kind":"done","desktop":"d","tab":"t","title":"T","body":"B","at":1}"#,
            #"{"kind":"done","desktop":"d","tab":"t","title":"T","body":"B","at":1}"#,
            #"{"v":1,"kind":"done","desktop":"d","tab":"t","title":"T","at":1}"#,
            #"{"v":1,"kind":"done","desktop":"d","tab":"t","title":"T","body":"B","at":-1}"#,
            #"{"v":1,"kind":"permission","desktop":"d","tab":"t","prompt":5,"title":"T","body":"B","at":1}"#,
            "not json",
        ] {
            #expect(PushCrypto.open(key: Self.key, data: try Self.seal(json)) == nil, "\(json)")
        }
        #expect(PushCrypto.keyId(of: "short") == nil)
        #expect(PushCrypto.keyId(of: "not+base64") == nil)
        #expect(PushCrypto.open(key: Self.key, data: "AAAA") == nil)
        // Tampering with the key ID (the AAD) breaks authentication.
        var bytes = Data(base64URLEncoded: try Self.seal(#"{"v":1,"kind":"done","desktop":"d","tab":"t","title":"T","body":"B","at":1}"#))!
        bytes[0] ^= 1
        #expect(PushCrypto.open(key: Self.key, data: bytes.base64URLEncodedString) == nil)
    }

    @Test func tokens() {
        #expect(PushRegistration.isToken(String(repeating: "ab", count: 32)))
        #expect(PushRegistration.isToken(String(repeating: "ab", count: 100)))
        #expect(!PushRegistration.isToken(String(repeating: "ab", count: 31)))
        #expect(!PushRegistration.isToken(String(repeating: "ab", count: 101)))
        #expect(!PushRegistration.isToken(String(repeating: "AB", count: 32)))
        #expect(!PushRegistration.isToken(String(repeating: "a", count: 65)))
    }
}

@Suite struct PushKeyStoreTests {
    @Test func createLookupDelete() throws {
        let store = PushKeyStore(store: InMemorySecretStore())
        #expect(try store.key(for: "desk-a") == nil)
        let a = try store.keyOrCreate(for: "desk-a", desktopName: "mbp")
        #expect(a.key.count == 32 && a.keyId.count == 8)
        #expect(try store.keyOrCreate(for: "desk-a", desktopName: "mbp") == a)
        let b = try store.keyOrCreate(for: "desk-b", desktopName: "mini")
        #expect(a.key != b.key && a.keyId != b.keyId)

        // Renaming keeps the key.
        let renamed = try store.keyOrCreate(for: "desk-a", desktopName: "mbp-2")
        #expect(renamed.key == a.key && renamed.desktopName == "mbp-2")

        #expect(try store.key(keyId: b.keyId)?.desktopId == "desk-b")
        #expect(try store.key(keyId: Data(count: 8)) == nil)
        #expect(try store.all().count == 2)

        try store.delete(desktopId: "desk-a")
        #expect(try store.key(for: "desk-a") == nil)
        #expect(try store.key(keyId: a.keyId) == nil)
        #expect(try store.key(keyId: b.keyId) != nil)
    }
}

// MARK: - Gateway

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private let respond: @Sendable (URLRequest) throws -> (Int, String)

    init(_ respond: @escaping @Sendable (URLRequest) throws -> (Int, String)) {
        self.respond = respond
    }

    var sent: [URLRequest] { lock.withLock { requests } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { requests.append(request) }
        let (status, body) = try respond(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}

@Suite struct PushGatewayClientTests {
    static let token = String(repeating: "5a", count: 32)
    static let now = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func registersAndReturnsTheCap() async throws {
        let transport = FakeTransport { _ in (200, #"{"cap":"AWePXQ"}"#) }
        let identity = DeviceIdentity.generate()
        let client = PushGatewayClient(gateway: URL(string: "http://127.0.0.1:8791/")!, transport: transport, now: { Self.now })
        let cap = try await client.register(token: Self.token, env: .sandbox, identity: identity)
        #expect(cap == "AWePXQ")

        let request = try #require(transport.sent.first)
        #expect(request.url?.absoluteString == "http://127.0.0.1:8791/v1/push/register")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let raw = try #require(request.httpBody)
        let o = try #require(try JSONValue.parse(raw).objectValue)
        // Serialized in the TS key order (the parser here doesn't keep order).
        let text = String(decoding: raw, as: UTF8.self)
        #expect(text.hasPrefix(#"{"pub":""#) && text.contains(#"","token":"\#(Self.token)","env":"sandbox","ts":1790000000,"sig":""#))
        #expect(o["pub"] == .string(identity.ed25519.pub.base64URLEncodedString))
        #expect(o["token"] == .string(Self.token))
        #expect(o["env"] == "sandbox")
        #expect(o["ts"] == .int(1_790_000_000))
        let registration = PushRegistration(pub: o["pub"]!.stringValue!, token: Self.token, env: .sandbox, ts: 1_790_000_000, sig: o["sig"]!.stringValue!)
        #expect(registration.isValid)
    }

    @Test func mapsErrors() async throws {
        let cases: [(Int, String, PushGatewayError)] = [
            (400, #"{"error":"bad-request"}"#, .badRequest),
            (401, #"{"error":"auth"}"#, .auth),
            (429, #"{"error":"rate"}"#, .rate),
            (503, #"{"error":"unavailable"}"#, .unavailable),
            (500, "oops", .http(500)),
            (200, #"{"nope":1}"#, .badResponse),
            (200, #"{"cap":""}"#, .badResponse),
        ]
        for (status, body, expected) in cases {
            let client = PushGatewayClient(transport: FakeTransport { _ in (status, body) })
            await #expect(throws: expected) {
                _ = try await client.register(token: Self.token, env: .production, identity: DeviceIdentity.generate())
            }
        }
        let failing = PushGatewayClient(transport: FakeTransport { _ in throw URLError(.timedOut) })
        await #expect {
            _ = try await failing.register(token: Self.token, env: .production, identity: DeviceIdentity.generate())
        } throws: { error in
            if case .transport = error as? PushGatewayError { true } else { false }
        }
        // A bad token never leaves the phone.
        let transport = FakeTransport { _ in (200, #"{"cap":"x"}"#) }
        await #expect(throws: PushGatewayError.badRequest) {
            _ = try await PushGatewayClient(transport: transport).register(token: "abc", env: .sandbox, identity: DeviceIdentity.generate())
        }
        #expect(transport.sent.isEmpty)
    }

    @Test func defaultGateway() {
        #expect(PushGatewayClient().registerURL.absoluteString == "https://relay.devtool.awantech.sk/v1/push/register")
    }
}

// MARK: - Ops

@Suite(.serialized) struct PushOpTests {
    @Test func encoding() throws {
        let params = PushRegisterParams(cap: "cap", key: Data(repeating: 1, count: 32), keyId: Data(repeating: 2, count: 8), kinds: [.permission, .done])
        #expect(params.json.jsonString == #"{"cap":"cap","key":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","keyId":"AgICAgICAgI","kinds":["permission","done"]}"#)
        #expect(try PushRegisterParams.parse(params.json) == params)
        #expect(throws: ProtocolError.self) { try PushRegisterParams.parse(.object(["cap": "", "key": "AQ", "keyId": "Ag", "kinds": .array([])])) }
    }

    @Test func overTheRelay() async throws {
        let o = try await ChatConnectionTests.online()
        let params = PushRegisterParams(cap: "cap-1", key: Data(repeating: 3, count: 32), keyId: Data(repeating: 4, count: 8), kinds: [.question])
        try await o.connection.registerPush(params)
        #expect(o.desktop.requests.last?.op == PushOp.register)
        #expect(o.desktop.requests.last?.params == params.json)
        #expect(o.desktop.pushRegistration == params)

        try await o.connection.unregisterPush()
        #expect(o.desktop.requests.last?.op == PushOp.unregister)
        #expect(o.desktop.requests.last?.params == .object([:]))
        #expect(o.desktop.pushRegistration == nil)
        await o.connection.stop()
    }

    @Test func mock() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "mock")
        await mock.start()
        for await event in mock.events { if event == .state(.online) { break } }
        try await mock.registerPush(PushRegisterParams(cap: "c", key: Data(count: 32), keyId: Data(count: 8), kinds: PushKind.allCases))
        try await mock.unregisterPush()
        await mock.stop()
    }
}
