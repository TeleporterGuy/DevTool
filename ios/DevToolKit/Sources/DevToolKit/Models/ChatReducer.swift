import Foundation

/// The phone's copy of one open chat: the `chat.open` view plus every
/// `evt chat` applied since (SPEC.md §6.4). Pure value type, no I/O.
public struct ChatState: Sendable, Equatable {
    public enum ApplyResult: Sendable, Equatable {
        case applied
        /// Another tab's event, or one at or before the current `seq`.
        case ignored
        /// A `seq` gap: events were lost, so the phone must `chat.open` again.
        case gap
    }

    public private(set) var view: ChatView
    /// `seq` of the last applied event (or of `chat.open`).
    public private(set) var seq: Int64

    public init(open: ChatOpenResult) {
        view = open.view
        seq = open.seq
    }

    public init(view: ChatView, seq: Int64) {
        self.view = view
        self.seq = seq
    }

    public var tabId: String { view.tabId }

    /// Applies `event` when it is the next one. Upserts replace an item by id
    /// or append new ones after the last item, in the order given; removes
    /// drop by id; prompts and status replace wholesale.
    @discardableResult
    public mutating func apply(_ event: ChatEvent) -> ApplyResult {
        guard event.tabId == view.tabId, event.seq > seq else { return .ignored }
        guard event.seq == seq + 1 else { return .gap }
        seq = event.seq

        if !event.removes.isEmpty {
            let removed = Set(event.removes)
            view.items.removeAll { removed.contains($0.id) }
        }
        if !event.upserts.isEmpty {
            var index = Dictionary(view.items.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
            for item in event.upserts {
                if let at = index[item.id] {
                    view.items[at] = item
                } else {
                    index[item.id] = view.items.count
                    view.items.append(item)
                }
            }
        }
        view.prompts = event.prompts
        view.status = event.status
        return .applied
    }

    /// Prepends a `chat.earlier` page. Items already present are skipped.
    public mutating func prepend(_ page: ChatEarlierResult) {
        let known = Set(view.items.map(\.id))
        view.items.insert(contentsOf: page.items.filter { !known.contains($0.id) }, at: 0)
        view.hasEarlier = page.hasEarlier
    }

    /// Drops a prompt locally (after it was answered, or reported `gone`).
    public mutating func dismissPrompt(_ id: String) {
        view.prompts.removeAll { $0.id == id }
    }
}
