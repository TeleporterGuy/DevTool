import DevToolKit
import Foundation
import Observation
import OSLog
import UIKit
import UserNotifications

/// Push notifications (SPEC.md §7): the Settings switches, APNs token, gateway
/// registration (§7.1) and `push.register` / `push.unregister` on every
/// desktop (§7.4).
///
/// - At launch, and whenever push gets switched on, it asks APNs for a token
///   (or takes `-fakePushToken`), registers it with the gateway and keeps the
///   returned `cap`.
/// - After every established session, and whenever the switches or `cap`
///   change, it sends `push.register` with that desktop's key, or
///   `push.unregister` when push is off.
///
/// In mock mode (`live == false`) it never talks to APNs or a gateway; the
/// switches still work and ask for notification permission, so notifications
/// sent with `xcrun simctl push` show up and their actions reach the mock desktop.
@MainActor
@Observable
final class PushManager {
    /// The master switch.
    private(set) var enabled: Bool
    private(set) var kinds: Set<PushKind>
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// The last registration failure, for Settings.
    private(set) var lastError: String?

    @ObservationIgnored weak var model: AppModel?
    /// Whether Allow / Deny must open the app to authenticate (§8.3).
    @ObservationIgnored weak var security: SecuritySettings?

    @ObservationIgnored private let live: Bool
    @ObservationIgnored private let identity: DeviceIdentity
    @ObservationIgnored private let gateway: PushGatewayClient
    @ObservationIgnored private let env: PushEnv
    @ObservationIgnored private let fakeToken: String?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let keys: PushKeyStore
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var registration: StoredCap?
    @ObservationIgnored private var registering: Task<Void, Never>?
    /// The token registered (or being registered) in this process, so the
    /// launch and scene-activation paths don't register twice.
    @ObservationIgnored private var registeredToken: String?
    /// Desktops that hold a registration of ours, so turning push off knows whom to tell.
    @ObservationIgnored private var registered: Set<String>
    @ObservationIgnored private let log = Logger(subsystem: "sk.awantech.devtool", category: "push")

    private enum Key {
        static let enabled = "push.enabled"
        static let kinds = "push.kinds"
        static let cap = "push.cap"
        static let registered = "push.registeredDesktops"
    }

    /// A `cap` and what it was issued for; a different token, env or gateway needs a new one.
    private struct StoredCap: Codable, Equatable {
        var cap: String
        var token: String
        var env: String
        var gateway: String
    }

    init(live: Bool, identity: DeviceIdentity, options: LaunchOptions, defaults: UserDefaults = .standard, keys: PushKeyStore = .shared()) {
        self.live = live
        self.identity = identity
        self.defaults = defaults
        self.keys = keys
        gateway = PushGatewayClient(gateway: options.pushGateway ?? Push.defaultGateway)
        #if DEBUG
        env = .sandbox
        fakeToken = options.fakePushToken
        #else
        env = .production
        fakeToken = nil
        #endif
        enabled = defaults.bool(forKey: Key.enabled)
        if let stored = defaults.stringArray(forKey: Key.kinds) {
            kinds = Set(stored.compactMap(PushKind.init(rawValue:)))
        } else {
            kinds = Set(PushKind.allCases)
        }
        registered = Set(defaults.stringArray(forKey: Key.registered) ?? [])
        registration = defaults.data(forKey: Key.cap).flatMap { try? JSONDecoder().decode(StoredCap.self, from: $0) }
    }

    /// Push is on and the system lets us show notifications.
    var isActive: Bool { enabled && Self.allows(authorization) }

    var isDenied: Bool { authorization == .denied }

    private static func allows(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: true
        default: false
        }
    }

    /// The `cap` for the current token, env and gateway, if we have one.
    private var cap: String? {
        guard let registration, let token, registration.token == token, registration.env == env.rawValue,
              registration.gateway == gateway.gateway.absoluteString else { return nil }
        return registration.cap
    }

    // MARK: Launch and settings

    /// Called once at launch.
    func start() {
        updateCategories()
        Task {
            await refreshAuthorization()
            if isActive { requestToken() }
        }
    }

    /// Registers the categories for the current "Require Face ID for
    /// approvals" value. Delivered notifications pick up the new actions too.
    func updateCategories() {
        let requireAuth = security?.requireAuthForApprovals ?? false
        UNUserNotificationCenter.current().setNotificationCategories(NotificationCategories.all(requireAuth: requireAuth))
    }

    /// Re-reads the system permission (the user may have changed it in Settings).
    func refreshAuthorization() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard status != authorization else { return }
        let wasActive = isActive
        authorization = status
        if isActive != wasActive {
            if isActive { requestToken() }
            syncAll()
        }
    }

    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        enabled = on
        defaults.set(on, forKey: Key.enabled)
        lastError = nil
        guard on else {
            syncAll()
            return
        }
        Task {
            if authorization == .notDetermined {
                do {
                    _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                } catch {
                    log.error("Notification authorization failed: \(error.localizedDescription, privacy: .public)")
                }
                authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            }
            if isActive { requestToken() }
            syncAll()
        }
    }

    func isOn(_ kind: PushKind) -> Bool { kinds.contains(kind) }

    func set(_ kind: PushKind, on: Bool) {
        guard kinds.contains(kind) != on else { return }
        if on { kinds.insert(kind) } else { kinds.remove(kind) }
        defaults.set(PushKind.allCases.filter(kinds.contains).map(\.rawValue), forKey: Key.kinds)
        syncAll()
    }

    // MARK: Token and gateway

    private func requestToken() {
        guard live else { return }
        if let fakeToken {
            log.notice("Using -fakePushToken instead of APNs")
            didReceiveToken(fakeToken)
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken: Data) {
        didReceiveToken(deviceToken.hexString)
    }

    func didFailToRegister(_ error: any Error) {
        log.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
        lastError = "Couldn't get a push token: \(error.localizedDescription)"
    }

    /// Registers `token` with the gateway (every launch, §7.1) and hands the
    /// new `cap` to the desktops. On failure the previous `cap` for the same
    /// token stays in use.
    private func didReceiveToken(_ token: String) {
        self.token = token
        guard token != registeredToken else {
            syncAll()
            return
        }
        registeredToken = token
        registering?.cancel()
        let gateway = gateway, env = env, identity = identity
        registering = Task {
            do {
                let cap = try await gateway.register(token: token, env: env, identity: identity)
                guard !Task.isCancelled else { return }
                let stored = StoredCap(cap: cap, token: token, env: env.rawValue, gateway: gateway.gateway.absoluteString)
                registration = stored
                defaults.set(try? JSONEncoder().encode(stored), forKey: Key.cap)
                lastError = nil
                log.notice("Registered with the push gateway")
                syncAll()
            } catch {
                log.error("Push gateway registration failed: \(error.localizedDescription, privacy: .public)")
                guard !Task.isCancelled else { return }
                lastError = error.localizedDescription
                // Try again the next time a token arrives (push switched on, next launch).
                registeredToken = nil
                // An older cap for this token may still work.
                syncAll()
            }
        }
    }

    // MARK: Desktops

    /// A session with `desktopId` just finished its handshake with `ok`.
    func sessionEstablished(_ desktopId: String) {
        sync(desktopId)
    }

    /// The pairing was removed: its push key goes with it.
    func forget(_ desktopId: String) {
        do {
            try keys.delete(desktopId: desktopId)
        } catch {
            log.error("Couldn't delete the push key: \(error.localizedDescription, privacy: .public)")
        }
        markRegistered(desktopId, false)
    }

    private func syncAll() {
        for desktop in model?.desktops ?? [] { sync(desktop.id) }
    }

    /// Sends `push.register` or `push.unregister` to one desktop, if it is online.
    private func sync(_ desktopId: String) {
        guard let model, model.state(of: desktopId) == .online,
              let connection = model.connection(for: desktopId),
              let desktop = model.desktop(desktopId) else { return }
        if isActive {
            // Without a cap there is nothing to register yet; the gateway
            // answer calls back here.
            guard let cap else { return }
            let key: PushKey
            do {
                key = try keys.keyOrCreate(for: desktopId, desktopName: desktop.name)
            } catch {
                log.error("Couldn't store a push key: \(error.localizedDescription, privacy: .public)")
                return
            }
            let params = PushRegisterParams(cap: cap, key: key.key, keyId: key.keyId, kinds: PushKind.allCases.filter(kinds.contains))
            Task {
                do {
                    try await connection.registerPush(params)
                    markRegistered(desktopId, true)
                } catch {
                    log.notice("push.register on \(desktopId, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        } else if registered.contains(desktopId) {
            Task {
                do {
                    try await connection.unregisterPush()
                    markRegistered(desktopId, false)
                } catch {
                    log.notice("push.unregister on \(desktopId, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    private func markRegistered(_ desktopId: String, _ on: Bool) {
        let changed = on ? registered.insert(desktopId).inserted : registered.remove(desktopId) != nil
        if changed { defaults.set(Array(registered).sorted(), forKey: Key.registered) }
    }
}

/// Notification categories (§7.7). The Service Extension sets the category to
/// the payload's `kind`; an unknown kind has no category, so no actions.
///
/// With "Require Face ID for approvals" on (§8.3), Allow and Deny also carry
/// `.foreground`: they open the app, which authenticates and then answers.
enum NotificationCategories {
    static let allowAction = "allow"
    static let denyAction = "deny"

    static func all(requireAuth: Bool) -> Set<UNNotificationCategory> {
        var options: UNNotificationActionOptions = [.authenticationRequired]
        if requireAuth { options.insert(.foreground) }
        let allow = UNNotificationAction(identifier: allowAction, title: "Allow", options: options)
        let deny = UNNotificationAction(identifier: denyAction, title: "Deny", options: options.union(.destructive))
        return [
            UNNotificationCategory(identifier: PushPayloadKind.permission, actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushPayloadKind.question, actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushPayloadKind.plan, actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushPayloadKind.done, actions: [], intentIdentifiers: []),
        ]
    }
}
