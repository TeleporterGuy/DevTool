import DevToolKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPair: () -> Void

    @State private var pendingForget: DesktopRecord?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.desktops) { desktop in
                        PairedDesktopRow(desktop: desktop)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Forget", role: .destructive) { pendingForget = desktop }
                            }
                            .contextMenu {
                                Button("Forget", systemImage: "trash", role: .destructive) { pendingForget = desktop }
                            }
                    }
                    Button("Pair a desktop", systemImage: "plus.circle", action: onPair)
                } header: {
                    Text("Paired desktops")
                } footer: {
                    Text("Forgetting removes the desktop from this device. To cut off access completely, also revoke this device in DevTool → Settings → Mobile.")
                }

                Section("About") {
                    LabeledContent("Version", value: Self.version)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                pendingForget.map { "Forget \($0.name)?" } ?? "",
                isPresented: Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } }),
                titleVisibility: .visible,
                presenting: pendingForget
            ) { desktop in
                Button("Forget", role: .destructive) { model.forget(desktop.id) }
            } message: { _ in
                Text("You'll need to scan a new pairing code to see it again.")
            }
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}

private struct PairedDesktopRow: View {
    @Environment(AppModel.self) private var model
    let desktop: DesktopRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.state(of: desktop.id).dotColor)
                    .frame(width: 8, height: 8)
                Text(desktop.name)
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let relay = desktop.relayURL.host() ?? desktop.relayURL.absoluteString
        let paired = desktop.pairedAt.formatted(date: .abbreviated, time: .omitted)
        return "\(relay) · paired \(paired)"
    }
}
