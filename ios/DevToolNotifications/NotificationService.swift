import DevToolKit
import OSLog
import UserNotifications

/// Decrypts a push (SPEC.md §7.5, §7.7): reads `d`, finds the desktop's key
/// by the key ID in front of it, and replaces the gateway's fallback alert
/// ("An agent needs you") with the payload's title and body. Anything that
/// goes wrong leaves the original notification as it came.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "notification-service")

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        original = request.content
        let content = decrypted(request.content) ?? request.content
        self.contentHandler = nil
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        guard let contentHandler, let original else { return }
        self.contentHandler = nil
        contentHandler(original)
    }

    private func decrypted(_ content: UNNotificationContent) -> UNNotificationContent? {
        guard let data = content.userInfo[Push.UserInfoKey.data] as? String else { return nil }
        guard let keyId = PushCrypto.keyId(of: data) else {
            log.error("Push data is malformed")
            return nil
        }
        let store = PushKeyStore.shared()
        let key: PushKey
        do {
            guard let found = try store.key(keyId: keyId) else {
                log.error("No push key for this key ID")
                return nil
            }
            key = found
        } catch {
            log.error("Keychain lookup failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        guard let payload = PushCrypto.open(key: key.key, data: data) else {
            log.error("Push payload didn't decrypt or parse")
            return nil
        }
        guard let out = content.mutableCopy() as? UNMutableNotificationContent else { return nil }
        out.title = payload.title
        out.body = payload.body
        // More than one desktop: say which one.
        if let count = try? store.all().count, count > 1, !key.desktopName.isEmpty {
            out.subtitle = key.desktopName
        }
        // An unknown kind has no registered category, so it shows without actions.
        out.categoryIdentifier = payload.kind
        out.threadIdentifier = payload.tab
        var userInfo = content.userInfo
        // The key says which desktop sealed it; don't take the payload's word for it.
        if payload.desktop != key.desktopId { log.notice("Push payload names another desktop; using the key's") }
        userInfo[Push.UserInfoKey.desktop] = key.desktopId
        userInfo[Push.UserInfoKey.tab] = payload.tab
        if let prompt = payload.prompt { userInfo[Push.UserInfoKey.prompt] = prompt }
        out.userInfo = userInfo
        return out
    }
}
