import DevToolKit
import OSLog
import UIKit
import UserNotifications

/// Owns the app model and push, and handles APNs and notification callbacks.
/// Created before any scene, so a notification action that launches the app
/// in the background finds the model ready.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: AppModel
    let push: PushManager
    private let log = Logger(subsystem: "sk.awantech.devtool", category: "notifications")

    override init() {
        let options = LaunchOptions.current
        if options.mockDesktop {
            model = AppModel.mock()
            // Mock mode keeps its switches apart from the real ones.
            let defaults = UserDefaults(suiteName: "sk.awantech.devtool.mock") ?? .standard
            push = PushManager(live: false, identity: DeviceIdentity.generate(), options: options, defaults: defaults,
                               keys: PushKeyStore(store: InMemorySecretStore()))
        } else {
            let identity = Self.loadIdentity()
            model = AppModel(factory: Self.relayFactory(identity: identity), store: FileAppStore())
            push = PushManager(live: true, identity: identity, options: options)
        }
        super.init()
        model.push = push
        push.model = model
    }

    private static func loadIdentity() -> DeviceIdentity {
        do {
            return try DeviceIdentity.loadOrCreate()
        } catch {
            // Without the Keychain nothing can stay paired; run with a
            // throwaway identity rather than not at all.
            Logger(subsystem: "sk.awantech.devtool", category: "identity")
                .error("Keychain unavailable, using a temporary identity: \(error.localizedDescription, privacy: .public)")
            return DeviceIdentity.generate()
        }
    }

    /// Real connections through the relay, with this phone's Keychain identity.
    private static func relayFactory(identity: DeviceIdentity) -> RelayDesktopConnectionFactory {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return RelayDesktopConnectionFactory(
            identity: identity,
            deviceName: UIDevice.current.name,
            appVersion: "ios/\(version)"
        )
    }

    // MARK: UIApplicationDelegate

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        push.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        push.didFailToRegister(error)
    }

    // MARK: UNUserNotificationCenterDelegate

    /// What a notification points at, read from its `userInfo`.
    private struct Target: Sendable {
        var desktop: String
        var tab: String
        var prompt: String?

        init?(_ userInfo: [AnyHashable: Any]) {
            guard let desktop = userInfo[Push.UserInfoKey.desktop] as? String,
                  let tab = userInfo[Push.UserInfoKey.tab] as? String else { return nil }
            self.desktop = desktop
            self.tab = tab
            prompt = userInfo[Push.UserInfoKey.prompt] as? String
        }

        var route: ChatRoute { ChatRoute(desktopId: desktop, tabId: tab) }
    }

    /// Foreground: a banner and sound, unless that exact chat is on screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        let target = Target(notification.request.content.userInfo)
        Task { @MainActor in
            if let target, self.model.visibleChat == target.route, UIApplication.shared.applicationState == .active {
                completionHandler([])
            } else {
                completionHandler([.banner, .list, .sound])
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let action = response.actionIdentifier
        let target = Target(response.notification.request.content.userInfo)
        Task { @MainActor in
            await self.handle(action: action, target: target)
            completionHandler()
        }
    }

    private func handle(action: String, target: Target?) async {
        guard let target else { return }
        switch action {
        case NotificationCategories.allowAction, NotificationCategories.denyAction:
            guard let prompt = target.prompt else { return }
            await answer(target: target, prompt: prompt, allow: action == NotificationCategories.allowAction)
        case UNNotificationDefaultActionIdentifier:
            model.requestedChat = target.route
        default:
            break // dismissed
        }
    }

    /// Allow / Deny from the notification (§7.7): the app runs in the
    /// background, so it holds a background task while it connects and answers.
    private func answer(target: Target, prompt: String, allow: Bool) async {
        let log = log
        var taskId = UIBackgroundTaskIdentifier.invalid
        taskId = UIApplication.shared.beginBackgroundTask(withName: "answer-prompt") {
            log.notice("Background time ran out while answering a prompt")
        }
        defer { if taskId != .invalid { UIApplication.shared.endBackgroundTask(taskId) } }
        let ok = await model.answerFromNotification(
            desktopId: target.desktop, tabId: target.tab, promptId: prompt, allow: allow,
            deadline: .now + .seconds(25)
        )
        if ok {
            log.notice("Answered \(prompt, privacy: .public) from a notification (\(allow ? "allow" : "deny", privacy: .public))")
        } else {
            log.error("Couldn't answer \(prompt, privacy: .public) from a notification")
            await notifyAnswerFailed(target: target)
        }
    }

    /// Tells the user the answer didn't go through; tapping it opens the chat.
    private func notifyAnswerFailed(target: Target) async {
        let content = UNMutableNotificationContent()
        content.title = model.desktop(target.desktop)?.name ?? "DevTool"
        content.body = "Couldn't send your answer. Open the chat to try again."
        content.userInfo = [Push.UserInfoKey.desktop: target.desktop, Push.UserInfoKey.tab: target.tab]
        content.threadIdentifier = target.tab
        let request = UNNotificationRequest(identifier: "answer-failed-\(target.tab)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
