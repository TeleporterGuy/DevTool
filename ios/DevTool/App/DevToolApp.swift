import DevToolKit
import OSLog
import SwiftUI
import UIKit

@main
struct DevToolApp: App {
    @State private var model: AppModel
    private let options = LaunchOptions.current

    init() {
        let options = LaunchOptions.current
        if options.mockDesktop {
            _model = State(initialValue: AppModel.mock())
        } else {
            _model = State(initialValue: AppModel(factory: Self.relayFactory(), store: FileAppStore()))
        }
    }

    /// Real connections through the relay, with this phone's Keychain identity.
    private static func relayFactory() -> RelayDesktopConnectionFactory {
        let identity: DeviceIdentity
        do {
            identity = try DeviceIdentity.loadOrCreate()
        } catch {
            // Without the Keychain nothing can stay paired; run with a
            // throwaway identity rather than not at all.
            Logger(subsystem: "sk.awantech.devtool", category: "identity")
                .error("Keychain unavailable, using a temporary identity: \(error.localizedDescription, privacy: .public)")
            identity = DeviceIdentity.generate()
        }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return RelayDesktopConnectionFactory(
            identity: identity,
            deviceName: UIDevice.current.name,
            appVersion: "ios/\(version)"
        )
    }

    var body: some Scene {
        WindowGroup {
            RootView(demoRoute: options.demoRoute)
                .environment(model)
                .onOpenURL { url in
                    if url.scheme == PairingInvite.scheme, url.host == PairingInvite.host {
                        model.handlePairingLink(url.absoluteString)
                    }
                }
                .task {
                    model.connectAll()
                    if let link = options.pairLink {
                        model.handlePairingLink(link)
                        if options.autoConfirmPairing, case .confirm(let invite) = model.pairing {
                            model.confirmPairing(invite)
                        }
                    }
                }
        }
    }
}
