import DevToolKit
import Foundation
import OSLog

/// Where `AppModel` keeps paired desktops and the last inbox of each.
protocol AppPersistence: Sendable {
    func loadDesktops() -> [DesktopRecord]
    func saveDesktops(_ desktops: [DesktopRecord])
    func loadInbox(for desktopId: String) -> Inbox?
    func saveInbox(_ inbox: Inbox, for desktopId: String)
    func deleteInbox(for desktopId: String)
}

/// JSON files under Application Support/DevTool:
/// `desktops.json` and `inbox/<desktopId>.json`.
struct FileAppStore: AppPersistence {
    let directory: URL
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "store")

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory.appending(path: "DevTool", directoryHint: .isDirectory)
    }

    private var desktopsURL: URL { directory.appending(path: "desktops.json") }
    private var inboxDirectory: URL { directory.appending(path: "inbox", directoryHint: .isDirectory) }

    private func inboxURL(_ id: String) -> URL {
        // Desktop IDs are hex, but don't trust them as path components.
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return inboxDirectory.appending(path: "\(safe).json")
    }

    func loadDesktops() -> [DesktopRecord] {
        read([DesktopRecord].self, from: desktopsURL) ?? []
    }

    func saveDesktops(_ desktops: [DesktopRecord]) {
        write(desktops, to: desktopsURL)
    }

    func loadInbox(for desktopId: String) -> Inbox? {
        read(Inbox.self, from: inboxURL(desktopId))
    }

    func saveInbox(_ inbox: Inbox, for desktopId: String) {
        write(inbox, to: inboxURL(desktopId))
    }

    func deleteInbox(for desktopId: String) {
        try? FileManager.default.removeItem(at: inboxURL(desktopId))
    }

    private func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            log.error("Could not decode \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(value)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            log.error("Could not write \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// Keeps everything in memory. Used by `-mockDesktop` so mock data never
/// touches the real pairings.
final class InMemoryAppStore: AppPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var desktops: [DesktopRecord]
    private var inboxes: [String: Inbox]

    init(desktops: [DesktopRecord] = [], inboxes: [String: Inbox] = [:]) {
        self.desktops = desktops
        self.inboxes = inboxes
    }

    func loadDesktops() -> [DesktopRecord] { lock.withLock { desktops } }
    func saveDesktops(_ desktops: [DesktopRecord]) { lock.withLock { self.desktops = desktops } }
    func loadInbox(for desktopId: String) -> Inbox? { lock.withLock { inboxes[desktopId] } }
    func saveInbox(_ inbox: Inbox, for desktopId: String) { lock.withLock { inboxes[desktopId] = inbox } }
    func deleteInbox(for desktopId: String) { lock.withLock { _ = inboxes.removeValue(forKey: desktopId) } }
}
