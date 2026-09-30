import Foundation
import OSLog

/// The last transcript of a chat the phone opened (SPEC.md §8.3), shown
/// read-only while its desktop is offline.
public struct CachedChat: Sendable, Equatable {
    /// At most the §6.4 window.
    public static let window = 60

    public var desktopId: String
    public private(set) var view: ChatView
    public var savedAt: Date

    /// Keeps the newest `window` items of `view`; `hasEarlier` is set when
    /// that drops any.
    public init(desktopId: String, view: ChatView, savedAt: Date = Date()) {
        self.desktopId = desktopId
        var view = view
        if view.items.count > Self.window {
            view.items = Array(view.items.suffix(Self.window))
            view.hasEarlier = true
        }
        self.view = view
        self.savedAt = savedAt
    }

    public var tabId: String { view.tabId }

    /// `view` is stored in its wire form, so it reads back with the same
    /// tolerant parsing as a `chat.open` result.
    public var json: JSONValue {
        .object(["v": 1, "desktopId": .string(desktopId), "savedAt": .int(savedAt.unixMilliseconds), "view": view.json])
    }

    public static func parse(_ value: JSONValue) throws(ProtocolError) -> CachedChat {
        let f = try Fields(value, "cached chat")
        return CachedChat(
            desktopId: try f.str("desktopId"),
            view: try ChatView.parse(f["view"]),
            savedAt: Date(unixMilliseconds: try f.int("savedAt"))
        )
    }
}

/// Where the app keeps `CachedChat`s.
public protocol ChatCacheStore: Sendable {
    func load(desktopId: String, tabId: String) -> CachedChat?
    func save(_ chat: CachedChat)
    /// The desktop was forgotten.
    func deleteAll(desktopId: String)
    /// Drops the desktop's cached chats whose tab isn't in `tabIds` (the
    /// latest inbox's tabs).
    func prune(desktopId: String, keeping tabIds: Set<String>)
}

/// JSON files at `<directory>/<desktopId>/<tabId>.json`, written atomically
/// with file protection until first unlock (like the inbox cache).
public struct FileChatCacheStore: ChatCacheStore {
    public let directory: URL
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "store")

    public init(directory: URL) {
        self.directory = directory
    }

    /// IDs come from the desktop: keep them to safe path characters.
    static func component(_ id: String) -> String {
        let safe = String(id.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }.map(Character.init))
        return safe.isEmpty ? "_" : safe
    }

    private func desktopDirectory(_ desktopId: String) -> URL {
        directory.appending(path: Self.component(desktopId), directoryHint: .isDirectory)
    }

    private func url(desktopId: String, tabId: String) -> URL {
        desktopDirectory(desktopId).appending(path: "\(Self.component(tabId)).json")
    }

    public func load(desktopId: String, tabId: String) -> CachedChat? {
        let url = url(desktopId: desktopId, tabId: tabId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            let chat = try CachedChat.parse(try JSONValue.parse(data))
            return chat.desktopId == desktopId && chat.tabId == tabId ? chat : nil
        } catch {
            log.error("Could not decode \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func save(_ chat: CachedChat) {
        let url = url(desktopId: chat.desktopId, tabId: chat.tabId)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try chat.json.jsonData.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            log.error("Could not write \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    public func deleteAll(desktopId: String) {
        try? FileManager.default.removeItem(at: desktopDirectory(desktopId))
    }

    public func prune(desktopId: String, keeping tabIds: Set<String>) {
        let folder = desktopDirectory(desktopId)
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        let keep = Set(tabIds.map { "\(Self.component($0)).json" })
        for file in files where !keep.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }
}

/// Keeps cached chats in memory (mock mode, tests).
public final class InMemoryChatCacheStore: ChatCacheStore, @unchecked Sendable {
    private let lock = NSLock()
    private var chats: [String: [String: CachedChat]] = [:]

    public init(_ chats: [CachedChat] = []) {
        for chat in chats { self.chats[chat.desktopId, default: [:]][chat.tabId] = chat }
    }

    public func load(desktopId: String, tabId: String) -> CachedChat? {
        lock.withLock { chats[desktopId]?[tabId] }
    }

    public func save(_ chat: CachedChat) {
        lock.withLock { chats[chat.desktopId, default: [:]][chat.tabId] = chat }
    }

    public func deleteAll(desktopId: String) {
        lock.withLock { _ = chats.removeValue(forKey: desktopId) }
    }

    public func prune(desktopId: String, keeping tabIds: Set<String>) {
        lock.withLock { chats[desktopId] = chats[desktopId]?.filter { tabIds.contains($0.key) } }
    }
}
