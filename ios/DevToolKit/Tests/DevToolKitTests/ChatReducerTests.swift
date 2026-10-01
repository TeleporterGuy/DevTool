import Foundation
import Testing
@testable import DevToolKit

@Suite struct ChatReducerTests {
    static func text(_ id: String, _ markdown: String, streaming: Bool = false) -> ChatItem {
        ChatItem(id: id, .text(markdown: markdown, streaming: streaming))
    }

    static func user(_ id: String, _ text: String) -> ChatItem {
        ChatItem(id: id, .user(text: text, images: nil, queued: false, failed: false))
    }

    static let permission = ChatPrompt(id: "p1", .permission(ChatPermission(toolName: "Bash", title: "Run", summary: "ls", canAlwaysAllow: true)))

    static func state() -> ChatState {
        ChatState(open: ChatOpenResult(seq: 5, view: ChatView(
            tabId: "tab", title: "Claude", status: ChatStatus(busy: false, process: .running),
            items: [user("u1", "hi"), text("a1", "Hello")], hasEarlier: true, prompts: [])))
    }

    @Test func upsertsReplaceInPlaceAndAppendNewOnesInOrder() {
        var state = Self.state()
        let event = ChatEvent(tabId: "tab", seq: 6, upserts: [
            Self.text("a2", "second"), Self.text("a1", "Hello there", streaming: true), Self.text("a3", "third"),
        ], prompts: [Self.permission], status: ChatStatus(busy: true, turnStartedAt: 42, process: .running, model: "opus"))
        #expect(state.apply(event) == .applied)
        #expect(state.seq == 6)
        #expect(state.view.items.map(\.id) == ["u1", "a1", "a2", "a3"])
        #expect(state.view.items[1] == Self.text("a1", "Hello there", streaming: true))
        #expect(state.view.prompts == [Self.permission])
        #expect(state.view.status == ChatStatus(busy: true, turnStartedAt: 42, process: .running, model: "opus"))
        #expect(state.view.hasEarlier)
    }

    @Test func removesApplyBeforeUpserts() {
        var state = Self.state()
        // A /clear: every item removed, then the new window upserted (an id may come back).
        let event = ChatEvent(tabId: "tab", seq: 6, upserts: [Self.text("a1", "fresh"), Self.user("u9", "new")],
                              removes: ["u1", "a1"], status: ChatStatus(process: .idle))
        #expect(state.apply(event) == .applied)
        #expect(state.view.items == [Self.text("a1", "fresh"), Self.user("u9", "new")])
    }

    @Test func promptsAndStatusAreFullReplacements() {
        var state = Self.state()
        state.apply(ChatEvent(tabId: "tab", seq: 6, prompts: [Self.permission], status: ChatStatus(busy: true, turnStartedAt: 1, process: .running)))
        state.apply(ChatEvent(tabId: "tab", seq: 7, prompts: [], status: ChatStatus(busy: false, process: .exited, processError: "boom")))
        #expect(state.view.prompts.isEmpty)
        #expect(state.view.status.turnStartedAt == nil)
        #expect(state.view.status.processError == "boom")
        #expect(state.view.items.count == 2)
    }

    @Test func staleOtherTabAndGapEvents() {
        var state = Self.state()
        #expect(state.apply(ChatEvent(tabId: "tab", seq: 5, upserts: [Self.text("x", "old")])) == .ignored)
        #expect(state.apply(ChatEvent(tabId: "tab", seq: 3)) == .ignored)
        #expect(state.apply(ChatEvent(tabId: "other", seq: 6, upserts: [Self.text("x", "other")])) == .ignored)
        #expect(state.apply(ChatEvent(tabId: "tab", seq: 8, upserts: [Self.text("x", "gap")])) == .gap)
        // Nothing changed.
        #expect(state == Self.state())
        #expect(state.apply(ChatEvent(tabId: "tab", seq: 6, upserts: [Self.text("x", "next")])) == .applied)
    }

    @Test func prependSkipsKnownItems() {
        var state = Self.state()
        state.prepend(ChatEarlierResult(items: [Self.user("u0", "first"), Self.text("a0", "reply"), Self.user("u1", "dupe")], hasEarlier: false))
        #expect(state.view.items.map(\.id) == ["u0", "a0", "u1", "a1"])
        #expect(state.view.items[2] == Self.user("u1", "hi"))
        #expect(!state.view.hasEarlier)
    }

    @Test func dismissPrompt() {
        var state = Self.state()
        state.apply(ChatEvent(tabId: "tab", seq: 6, prompts: [Self.permission], status: ChatStatus(busy: true, process: .running)))
        state.dismissPrompt("p1")
        #expect(state.view.prompts.isEmpty)
        #expect(state.seq == 6)
    }
}
