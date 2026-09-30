import Foundation
import LocalAuthentication
import Observation
import OSLog

/// What device-owner authentication would use on this device.
enum AuthMethod: Sendable, Equatable {
    case faceID
    case touchID
    case opticID
    case passcode

    var name: String {
        switch self {
        case .faceID: "Face ID"
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        case .passcode: "passcode"
        }
    }

    var symbol: String {
        switch self {
        case .faceID: "faceid"
        case .touchID: "touchid"
        case .opticID: "opticid"
        case .passcode: "lock"
        }
    }
}

enum AuthOutcome: Sendable, Equatable {
    case success
    /// The user (or the system) dismissed the prompt: nothing to report.
    case cancelled
    case failed(String)
}

/// Device-owner authentication (biometry with the passcode as fallback),
/// behind a protocol so mock mode and tests don't need a real prompt.
protocol DeviceOwnerAuthenticator: Sendable {
    /// nil when the device can't authenticate its owner (no passcode set).
    func availableMethod() -> AuthMethod?
    func authenticate(reason: String) async -> AuthOutcome
}

/// `LAContext` with `.deviceOwnerAuthentication`.
struct LocalAuthenticator: DeviceOwnerAuthenticator {
    func availableMethod() -> AuthMethod? {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return nil }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .passcode
        }
    }

    func authenticate(reason: String) async -> AuthOutcome {
        let context = LAContext()
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .success : .cancelled
        } catch let error as LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback: return .cancelled
            default: return .failed(error.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// Mock mode: always "Face ID", answers after a short pause without a prompt,
/// so the flow can be driven on a simulator. `-mockAuth cancel|fail` makes it
/// refuse (see `LaunchOptions`).
struct MockAuthenticator: DeviceOwnerAuthenticator {
    var outcome: AuthOutcome = .success

    func availableMethod() -> AuthMethod? { .faceID }

    func authenticate(reason: String) async -> AuthOutcome {
        try? await Task.sleep(for: .milliseconds(400))
        return outcome
    }
}

/// App security settings (SPEC.md §8.3): "Require Face ID for approvals".
/// When it is on, every in-app answer to a permission, question or plan
/// authenticates first, and the notification's Allow / Deny open the app
/// (see `NotificationCategories`).
@MainActor
@Observable
final class SecuritySettings {
    private(set) var requireAuthForApprovals: Bool
    /// Re-read with `refreshAvailability()` (a passcode can be removed in Settings).
    private(set) var method: AuthMethod?

    /// Told when `requireAuthForApprovals` changes (push re-registers its categories).
    @ObservationIgnored var onChange: (@MainActor () -> Void)?

    @ObservationIgnored private let authenticator: any DeviceOwnerAuthenticator
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let log = Logger(subsystem: "sk.awantech.devtool", category: "security")

    static let requireAuthKey = "security.requireAuthForApprovals"

    init(authenticator: any DeviceOwnerAuthenticator, defaults: UserDefaults = .standard) {
        self.authenticator = authenticator
        self.defaults = defaults
        requireAuthForApprovals = defaults.bool(forKey: Self.requireAuthKey)
        method = authenticator.availableMethod()
    }

    func refreshAvailability() {
        let now = authenticator.availableMethod()
        if now != method { method = now }
    }

    /// The toggle shows when the device can authenticate, or when it is on
    /// (so it can still be turned off after the passcode went away).
    var canOffer: Bool { method != nil || requireAuthForApprovals }

    /// Turning it off asks for authentication too, so an unlocked phone left
    /// on a desk can't just switch it off. Returns the new value.
    @discardableResult
    func setRequireAuth(_ on: Bool) async -> Bool {
        guard on != requireAuthForApprovals else { return on }
        if !on, method != nil {
            guard await authenticator.authenticate(reason: "Stop requiring authentication for approvals") == .success else {
                return requireAuthForApprovals
            }
        }
        requireAuthForApprovals = on
        defaults.set(on, forKey: Self.requireAuthKey)
        log.notice("Require authentication for approvals: \(on, privacy: .public)")
        onChange?()
        return on
    }

    /// Whether an answer may go out: `.success` straight away when the
    /// setting is off, otherwise the outcome of authenticating.
    func authorizeAnswer() async -> AuthOutcome {
        guard requireAuthForApprovals else { return .success }
        return await authenticator.authenticate(reason: "Answer Claude's request")
    }
}
