import SwiftUI

struct EmptyStateView: View {
    let onPair: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No desktops yet", systemImage: "desktopcomputer")
        } description: {
            Text("Pair this device with DevTool on your computer to follow your tasks and agents from here.\n\nOn the computer, open **Settings → Mobile** and choose **Pair**.")
        } actions: {
            Button(action: onPair) {
                Label("Pair a desktop", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .navigationTitle("DevTool")
    }
}
