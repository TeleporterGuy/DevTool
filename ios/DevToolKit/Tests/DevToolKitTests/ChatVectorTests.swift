import Foundation
import Testing
@testable import DevToolKit

/// `protocol/vectors/fragments.json` (§6.1).
@Suite struct FragmentVectorTests {
    @Test func messageSplitsIntoTheVectorFragments() throws {
        let file = try Vectors.load("fragments.json")
        let chunkSize = try #require(file["chunkSize"])
        #expect(chunkSize == .int(Int64(Fragmentation.maxChunk)))
        let message = try #require(file["message"])
        let bytes = message["hex"].hex
        #expect(bytes.count == 150_000)
        #expect(Primitives.sha256(bytes).hexString == message["sha256"].str)
        guard case .number(let rawId)? = message["id"] else { Issue.record("no id"); return }
        let id = UInt32(rawId)
        let fragments = try Fragmentation.encode(bytes, id: id)
        let expected = message["fragments"].array.map(\.hex)
        #expect(fragments == expected)

        var receiver = Reassembler()
        for (index, fragment) in expected.enumerated() {
            let output = receiver.receive(fragment)
            if index < expected.count - 1 {
                #expect(output == .partial)
            } else {
                #expect(output == .message(bytes))
            }
        }
        #expect(receiver.inFlight == 0)
        // The first boundary splits a UTF-8 character; the joined bytes still decode.
        #expect(String(data: bytes, encoding: .utf8) != nil)
    }

    @Test func boundaries() throws {
        let file = try Vectors.load("fragments.json")
        for boundary in file["boundaries"].array {
            guard case .number(let length)? = boundary["length"], case .number(let count)? = boundary["fragmentCount"] else {
                Issue.record("bad boundary \(boundary)")
                continue
            }
            // The vectors hash a message we can't reconstruct, so build one of that length.
            var message = Data(repeating: 0x61, count: Int(length))
            message[0] = 0x7B
            let fragments = try Fragmentation.encode(message, id: 0)
            #expect(fragments.count == Int(count), "\(boundary["note"].str)")
            if let last = boundary["lastFragment"]?.stringValue {
                // Only the header and the final byte: compare the header and length.
                let expected = Data(hex: last)!
                #expect(fragments.last?.prefix(Fragmentation.headerLength) == expected.prefix(Fragmentation.headerLength))
                #expect(fragments.last?.count == expected.count)
            }
        }
    }

    @Test func scenarios() throws {
        let file = try Vectors.load("fragments.json")
        let scenarios = file["scenarios"].array
        #expect(scenarios.count >= 10)
        for scenario in scenarios {
            var receiver = Reassembler()
            for (index, step) in scenario["steps"].array.enumerated() {
                if step["reset"] == .bool(true) {
                    receiver.reset()
                    continue
                }
                let output = receiver.receive(step["input"].hex)
                let got: Data? = if case .message(let data) = output { data } else { nil }
                let want: Data? = step["output"] == .null ? nil : step["output"].hex
                #expect(got == want, "\(scenario["name"].str) step \(index)")
            }
        }
    }

    @Test func partialMessagesTimeOut() {
        var receiver = Reassembler()
        let start = ContinuousClock.now
        let fragments = try! Fragmentation.encode(Data([0x7B] + Array(repeating: 0x20, count: 70_000) + [0x7D]), id: 3)
        #expect(receiver.receive(fragments[0], now: start) == .partial)
        #expect(receiver.inFlight == 1)
        // 30 s later the partial message is gone, so the last chunk alone doesn't complete it.
        #expect(receiver.receive(fragments[1], now: start + .seconds(30)) == .partial)
        #expect(receiver.inFlight == 1)
        receiver.expire(now: start + .seconds(61))
        #expect(receiver.inFlight == 0)
    }

    @Test func oversizedMessagesAreRefused() {
        let big = Data(repeating: 0x20, count: Fragmentation.maxMessageBytes + 1)
        #expect(throws: ProtocolError.self) { try Fragmentation.encode(big, id: 0) }

        // A receiver drops a message whose chunks add up to more than the limit.
        var receiver = Reassembler(limits: .init(maxMessageBytes: 100))
        let fragments = try! Fragmentation.encode(Data(repeating: 0x20, count: 120_000), id: 1)
        #expect(receiver.receive(fragments[0]) == .dropped(id: 1, reason: "over 100 bytes"))
        #expect(receiver.inFlight == 0)
    }
}

/// `protocol/vectors/chat-messages.json` (§6.2–§6.4).
@Suite struct ChatMessageVectorTests {
    /// What `parseChatResult` returns in TS, as JSON (`nil` for a non-chat op).
    static func parseResult(op: String, _ json: String) throws -> JSONValue? {
        let value = try JSONValue.parse(json)
        switch op {
        case ChatOp.open: return try ChatOpenResult.parse(value).json
        case ChatOp.earlier: return try ChatEarlierResult.parse(value).json
        case ChatOp.detail: return try ChatDetail.parse(value).json
        case ChatOp.close, ChatOp.send, ChatOp.answer, ChatOp.interrupt:
            _ = try Fields(value, "result")
            return .object([:])
        default: return nil
        }
    }

    @Test func requests() throws {
        let file = try Vectors.load("chat-messages.json")
        let samples = file["requests"].array
        #expect(!samples.isEmpty)
        for sample in samples {
            let parsed = try AppMessage.parse(Data(sample["json"].str.utf8))
            #expect(parsed?.json == sample["expected"], "\(sample["json"].str)")
        }
    }

    @Test func params() throws {
        let file = try Vectors.load("chat-messages.json")
        for sample in file["params"].array {
            let op = sample["op"].str
            let parsed = try ChatParams.parse(op: op, try JSONValue.parse(sample["json"].str))
            #expect((parsed?.json ?? .null) == sample["expected"], "\(op) \(sample["json"].str)")
        }
    }

    @Test func results() throws {
        let file = try Vectors.load("chat-messages.json")
        let samples = file["results"].array
        #expect(samples.count >= 5)
        for sample in samples {
            let op = sample["op"].str
            let parsed = try Self.parseResult(op: op, sample["json"].str)
            #expect((parsed ?? .null) == sample["expected"], "\(op) \(sample["json"].str)")
        }
    }

    @Test func events() throws {
        let file = try Vectors.load("chat-messages.json")
        let samples = file["events"].array
        #expect(!samples.isEmpty)
        for sample in samples {
            let parsed = try AppMessage.parse(Data(sample["json"].str.utf8))
            guard case .chat? = parsed else {
                Issue.record("not a chat event: \(sample["json"].str)")
                continue
            }
            #expect(parsed?.json == sample["expected"], "\(sample["json"].str)")
        }
    }

    @Test func unknownKindsStayInPlace() throws {
        let file = try Vectors.load("chat-messages.json")
        let open = try #require(file["results"].array.first { $0["json"].str.contains("\"diagram\"") })
        let result = try ChatOpenResult.parse(try JSONValue.parse(open["json"].str))
        #expect(result.view.items.map(\.kind) == ["user", "unknown", "tool", "notice"])
        #expect(result.view.items[1].content == .unknown(kind: "diagram"))
        #expect(result.view.prompts.first?.content == .unknown(kind: "survey"))
        guard case .tool(let tool) = result.view.items[2].content else { Issue.record("no tool"); return }
        #expect(tool.status == .pending)
        #expect(result.view.status.process == .idle)
    }

    @Test func invalid() throws {
        let file = try Vectors.load("chat-messages.json")
        let invalid = try #require(file["invalid"])
        for sample in invalid["params"].array {
            #expect(throws: (any Error).self, "\(sample["op"].str) \(sample["json"].str)") {
                _ = try ChatParams.parse(op: sample["op"].str, try JSONValue.parse(sample["json"].str))
            }
        }
        for sample in invalid["results"].array {
            #expect(throws: (any Error).self, "\(sample["op"].str) \(sample["json"].str)") {
                _ = try Self.parseResult(op: sample["op"].str, sample["json"].str)
            }
        }
        for json in invalid["events"].array {
            #expect(throws: (any Error).self, "\(json.str)") {
                _ = try AppMessage.parse(Data(json.str.utf8))
            }
        }
    }

    @Test func answersEncodeLikeTheDesktopExpects() throws {
        #expect(ChatAnswer.allow(always: false).json.jsonString == #"{"behavior":"allow"}"#)
        #expect(ChatAnswer.allow(always: true).json.jsonString == #"{"behavior":"allow","always":true}"#)
        #expect(ChatAnswer.deny(message: nil).json.jsonString == #"{"behavior":"deny"}"#)
        #expect(ChatAnswer.approvePlan.json.jsonString == #"{"behavior":"approvePlan"}"#)
        let answers = ChatAnswer.answers([(question: "Which extras?", answer: ChatAnswer.joined(["Auth", "Admin"]))])
        #expect(answers.json.jsonString == #"{"behavior":"answers","answers":{"Which extras?":"Auth, Admin"}}"#)
        #expect(try ChatAnswer.parse(answers.json) == answers)
    }
}
