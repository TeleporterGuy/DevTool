import DevToolKit
import SwiftUI

@main
struct DevToolApp: App {
    /// Owns the model (and push), so notification callbacks reach it even
    /// when the app launches in the background without a scene.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    private let options = LaunchOptions.current

    var body: some Scene {
        WindowGroup {
            RootView(demoRoute: options.demoRoute)
                .environment(delegate.model)
                .environment(delegate.push)
                .onOpenURL { url in
                    if url.scheme == PairingInvite.scheme, url.host == PairingInvite.host {
                        delegate.model.handlePairingLink(url.absoluteString)
                    }
                }
                .task {
                    let model = delegate.model
                    model.connectAll()
                    if let link = options.pairLink {
                        model.handlePairingLink(link)
                        if options.autoConfirmPairing, case .confirm(let invite) = model.pairing {
                            model.confirmPairing(invite)
                        }
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await delegate.push.refreshAuthorization() }
            }
        }
    }
}
