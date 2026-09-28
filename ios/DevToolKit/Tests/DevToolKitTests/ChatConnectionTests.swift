import Foundation
import Testing
@testable import DevToolKit

/// Collects `chatEvents()` so tests can wait for one.
actor ChatRecorder {
    private(set) var events: [ChatStreamEvent] = []

    init(_ stream: AsyncStream<ChatStreamEvent>) {
        Task { await self.consume(stream) }
    }

    private func consume(_ stream: AsyncStream<ChatStreamEvent>) async {
        for await event in stream { events.append(event) }
    }

    var chats: [ChatEvent] {
        events.compactMap { if case .chat(let e) = $0 { e } else { nil } }
    }

    @discardableResult
    func waitFor(after index: Int = 0, timeout: Duration = .seconds(5), _ predicate: @Sendable (ChatStreamEvent) -> Bool) async throws -> Int {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let found = events.indices.first(where: { $0 >= index && predicate(events[$0]) }) { return found + 1 }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw EventRecorder.TimeoutError(events: [])
    }
}

/// Chat over `RelayDesktopConnection` against the in-process fake relay and
/// the fake desktop's canned chat: req/res correlation, timeouts, error codes,
/// events and fragmentation both ways.
@Suite(.serialized) struct ChatConnectionTests {
    struct Online {
        let rig: RelayConnectionTests.Rig
        let desktop: FakeRelay.Desktop
        let connection: any DesktopConnection
        let events: EventRecorder
    }

    static func online() async throws -> Online {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor(RelayConnectionTests.isInbox)
        return Online(rig: rig, desktop: desktop, connection: connection, events: events)
    }

    static func isChat(seq: Int64) -> @Sendable (ChatStreamEvent) -> Bool {
        { if case .chat(let e) = $0 { e.seq == seq } else { false } }
    }

    @Test func openSendAnswerFlow() async throws {
        let o = try await Self.online()
        let chat = ChatRecorder(await o.connection.chatEvents())

        let opened = try await o.connection.openChat(tabId: "tab-chat")
        #expect(opened.seq == 10)
        #expect(opened.view.items.count == 60)
        #expect(opened.view.hasEarlier)
        #expect(opened.view.items.first?.id == "old11")
        var state = ChatState(open: opened)

        // Load earlier.
        let page = try await o.connection.earlierChatItems(tabId: "tab-chat", before: "old11", limit: 5)
        #expect(page.items.map(\.id) == ["old6", "old7", "old8", "old9", "old10"])
        #expect(page.hasEarlier)
        #expect(o.desktop.requests.last?.params == .object(["tabId": "tab-chat", "before": "old11", "limit": 5]))
        state.prepend(page)

        // Send: the res comes first, then three events.
        try await o.connection.sendChat(tabId: "tab-chat", text: "hello")
        try await chat.waitFor(Self.isChat(seq: 13))
        for event in await chat.chats { #expect(state.apply(event) == .applied) }
        #expect(state.seq == 13)
        #expect(state.view.busy)
        #expect(state.view.items.suffix(3).map(\.kind) == ["user", "text", "tool"])
        #expect(state.view.items.last(where: { $0.kind == "text" })?.content == .text(markdown: "Sure.", streaming: false))
        let prompt = try #require(state.view.prompts.first)
        #expect(prompt.id == "req-1")

        // Tool detail.
        let toolId = try #require(state.view.items.last?.id)
        let detail = try await o.connection.chatDetail(tabId: "tab-chat", itemId: toolId)
        #expect(detail == .tool(input: "{\n  \"command\": \"ls\"\n}", result: "a\nb"))

        // Answer, then answering again is `gone`.
        try await o.connection.answerChat(tabId: "tab-chat", promptId: "req-1", answer: .allow(always: true))
        try await chat.waitFor(Self.isChat(seq: 14))
        #expect(o.desktop.chat.answers.first?.answer == .allow(always: true))
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.gone, message: "Already answered")) {
            try await o.connection.answerChat(tabId: "tab-chat", promptId: "req-1", answer: .deny(message: nil))
        }
        for event in await chat.chats.filter({ $0.seq > state.seq }) { state.apply(event) }
        #expect(state.view.prompts.isEmpty)

        // Interrupt and close.
        try await o.connection.interruptChat(tabId: "tab-chat")
        try await chat.waitFor(Self.isChat(seq: 15))
        try await o.connection.closeChat(tabId: "tab-chat")
        #expect(!o.desktop.chat.subscribed)
        await o.connection.stop()
    }

    @Test func errorCodesAndTimeouts() async throws {
        let o = try await Self.online()
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such tab")) {
            _ = try await o.connection.openChat(tabId: "nope")
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "Unknown op chat.fly")) {
            _ = try await o.connection.request("chat.fly", params: nil)
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.badRequest, message: "text is empty")) {
            try await o.connection.sendChat(tabId: "tab-chat", text: "   ")
        }
        // No answer: the request times out, and a later one still works.
        o.desktop.silentOps = [ChatOp.detail]
        await #expect(throws: DesktopConnectionError.timeout) {
            _ = try await o.connection.request(ChatOp.detail, params: .object(["tabId": "tab-chat", "itemId": "old1"]), timeout: .milliseconds(200))
        }
        o.desktop.silentOps = []
        let detail = try await o.connection.chatDetail(tabId: "tab-chat", itemId: "old1")
        #expect(detail == .text(markdown: "old1"))

        // Concurrent requests are matched to their own responses.
        async let a = o.connection.chatDetail(tabId: "tab-chat", itemId: "old2")
        async let b = o.connection.chatDetail(tabId: "tab-chat", itemId: "old3")
        async let c = o.connection.chatDetail(tabId: "tab-chat", itemId: "old4")
        #expect(try await [a, b, c] == [.text(markdown: "old2"), .text(markdown: "old3"), .text(markdown: "old4")])
        await o.connection.stop()
    }

    @Test func pendingRequestsFailWhenTheSessionDrops() async throws {
        let o = try await Self.online()
        let chat = ChatRecorder(await o.connection.chatEvents())
        o.desktop.silentOps = [ChatOp.open]
        let pending = Task { try await o.connection.openChat(tabId: "tab-chat") }
        try await Task.sleep(for: .milliseconds(50))
        await o.rig.relay.setOnline(o.desktop, false)
        await #expect(throws: DesktopConnectionError.connectionLost) { _ = try await pending.value }
        try await chat.waitFor { $0 == .sessionLost }
        await #expect(throws: DesktopConnectionError.desktopOffline) { _ = try await o.connection.openChat(tabId: "tab-chat") }

        // Back online: subscribers hear that the session is new, so they re-open.
        o.desktop.silentOps = []
        await o.rig.relay.setOnline(o.desktop, true)
        try await chat.waitFor { $0 == .sessionStarted }
        let reopened = try await o.connection.openChat(tabId: "tab-chat")
        #expect(reopened.seq == 10)
        await o.connection.stop()
    }

    @Test func largeMessagesAreFragmentedBothWays() async throws {
        let o = try await Self.online()
        let chat = ChatRecorder(await o.connection.chatEvents())
        _ = try await o.connection.openChat(tabId: "tab-chat")

        // Phone → desktop: 32000 two-byte characters is 64 KB of JSON, over the 60000-byte chunk.
        let text = String(repeating: "é", count: ChatOp.maxSendLength)
        try await o.connection.sendChat(tabId: "tab-chat", text: text)
        #expect(o.desktop.chat.sent.last == text)

        // Desktop → phone: a ~90 KB event.
        try await o.connection.sendChat(tabId: "tab-chat", text: "long")
        let i = try await chat.waitFor { event in
            guard case .chat(let e) = event else { return false }
            return e.upserts.contains { if case .text(let m, false) = $0.content { m.count > 80_000 } else { false } }
        }
        #expect(i > 0)
        // Over the limit locally.
        await #expect(throws: DesktopConnectionError.self) {
            try await o.connection.sendChat(tabId: "tab-chat", text: String(repeating: "x", count: ChatOp.maxSendLength + 1))
        }
        await o.connection.stop()
    }

    @Test func unsolicitedEventsReachEverySubscriber() async throws {
        let o = try await Self.online()
        let first = ChatRecorder(await o.connection.chatEvents())
        let second = ChatRecorder(await o.connection.chatEvents())
        let opened = try await o.connection.openChat(tabId: "tab-chat")
        await o.rig.relay.pushChat(o.desktop) { chat in
            chat.status.busy = true
            return [chat.event(upserts: [ChatItem(id: "s1", .text(markdown: "stream", streaming: true))])]
        }
        try await first.waitFor(Self.isChat(seq: opened.seq + 1))
        try await second.waitFor(Self.isChat(seq: opened.seq + 1))
        await o.connection.stop()
        // `stop()` ends the streams.
        let after = await first.events.count
        await o.rig.relay.pushChat(o.desktop) { chat in [chat.event()] }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await first.events.count == after)
    }

    @Test func requestsNeedASession() async throws {
        let rig = RelayConnectionTests.Rig()
        let desktop = await rig.desktop()
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        await #expect(throws: DesktopConnectionError.notConnected) { _ = try await connection.openChat(tabId: "tab-chat") }
        await connection.stop()
    }
}

/// The mock connection's chat, which `-mockDesktop` screenshots rely on.
@Suite struct MockChatTests {
    @Test func mockChatStreamsAndPrompts() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { $0 == .state(.online) }
        let chat = ChatRecorder(await mock.chatEvents())
        let opened = try await mock.openChat(tabId: "tab-1")
        var state = ChatState(open: opened)
        #expect(opened.view.hasEarlier)
        #expect(opened.view.items.count == 60)
        #expect(opened.view.prompts.first?.kind == "permission")

        try await mock.answerChat(tabId: "tab-1", promptId: "p-bash", answer: .allow(always: false))
        try await chat.waitFor(timeout: .seconds(10)) { event in
            guard case .chat(let e) = event else { return false }
            return e.prompts.contains { $0.kind == "question" }
        }
        for event in await chat.chats { #expect(state.apply(event) == .applied) }
        #expect(state.view.prompts.map(\.kind) == ["question"])
        await #expect(throws: DesktopConnectionError.self) {
            try await mock.answerChat(tabId: "tab-1", promptId: "p-bash", answer: .allow(always: false))
        }
        let detail = try await mock.chatDetail(tabId: "tab-1", itemId: "t2")
        guard case .tool(let input, let result) = detail else { Issue.record("not a tool detail"); return }
        #expect(input.contains("refresh.ts"))
        #expect(result?.contains("JsonWebTokenError") == true)

        let earlier = try await mock.earlierChatItems(tabId: "tab-1", before: opened.view.items[0].id, limit: 100)
        state.prepend(earlier)
        #expect(!state.view.hasEarlier)
        await mock.stop()
    }
}
