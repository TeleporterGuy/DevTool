import DevToolKit
import SwiftUI

/// Scan (or paste) → confirm → wait for approval on the desktop → done.
struct PairingSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                switch model.pairing ?? .scanning(error: nil) {
                case .scanning(let error):
                    ScanStep(error: error)
                case .confirm(let invite):
                    ConfirmStep(invite: invite)
                case .waiting(let invite):
                    WaitingStep(invite: invite)
                case .paired(let name):
                    ResultStep(
                        symbol: "checkmark.circle.fill", tint: .green,
                        title: "Paired with \(name)",
                        message: "Its projects and tasks now show up here.",
                        primary: ("Done", model.dismissPairing)
                    )
                case .failed(let message):
                    ResultStep(
                        symbol: "xmark.octagon.fill", tint: .red,
                        title: "Pairing didn't finish",
                        message: message,
                        primary: ("Try again", model.presentPairing)
                    )
                }
            }
            .navigationTitle("Pair a desktop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isPaired {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: model.dismissPairing)
                    }
                }
            }
        }
        .interactiveDismissDisabled(isWaiting)
    }

    private var isPaired: Bool {
        if case .paired = model.pairing { return true }
        return false
    }

    private var isWaiting: Bool {
        if case .waiting = model.pairing { return true }
        return false
    }
}

private struct ScanStep: View {
    @Environment(AppModel.self) private var model
    let error: String?
    @State private var link = ""
    @FocusState private var linkFocused: Bool

    var body: some View {
        Form {
            Section {
                QRScannerPanel { code in
                    model.handlePairingLink(code)
                }
                .listRowInsets(EdgeInsets())
            } footer: {
                Text("On your computer, open DevTool → Settings → Mobile → Pair and point the camera at the QR code.")
            }

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.subheadline)
                }
            }

            Section {
                TextField("devtool://pair?d=…", text: $link, axis: .vertical)
                    .lineLimit(1...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.callout.monospaced())
                    .focused($linkFocused)
                    .submitLabel(.go)
                    .onSubmit(submit)
                HStack {
                    PasteButton(payloadType: String.self) { strings in
                        guard let first = strings.first else { return }
                        Task { @MainActor in
                            link = first
                            submit()
                        }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    Spacer()
                    Button("Continue", action: submit)
                        .buttonStyle(.borderedProminent)
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } header: {
                Text("Or paste the pairing link")
            } footer: {
                Text("Use this on the simulator, or if the camera can't read the code. Copy the link from the desktop's pairing screen.")
            }
        }
    }

    private func submit() {
        let trimmed = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        linkFocused = false
        model.handlePairingLink(trimmed)
    }
}

private struct ConfirmStep: View {
    @Environment(AppModel.self) private var model
    let invite: PairingInvite

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "desktopcomputer")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("Pair with \(invite.desktopName)?")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text("This device will see the desktop's projects, tasks and agent status. You'll accept the request on the desktop next.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 6) {
                detail("Relay", invite.relayURL.host() ?? invite.relayURL.absoluteString)
                detail("Desktop ID", String(invite.desktopId.prefix(12)) + "…")
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    detail("Code expires", expiryText(now: context.date))
                }
            }
            .padding()
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if invite.usesUnencryptedRemoteRelay {
                Label(PairingInvite.unencryptedRelayWarning, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("unencryptedRelayWarning")
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    model.confirmPairing(invite)
                } label: {
                    Text("Pair").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button("Scan a different code", action: model.presentPairing)
            }
        }
        .padding(24)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(.footnote)
    }

    private func expiryText(now: Date) -> String {
        let remaining = Int(invite.remainingTime(now: now))
        if remaining == 0 { return "Expired" }
        return String(format: "in %d:%02d", remaining / 60, remaining % 60)
    }
}

private struct WaitingStep: View {
    let invite: PairingInvite

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text("Waiting for approval on \(invite.desktopName)…")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("Choose Accept in DevTool on the desktop.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}

private struct ResultStep: View {
    let symbol: String
    let tint: Color
    let title: String
    let message: String
    let primary: (String, () -> Void)

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: symbol)
                .font(.system(size: 60))
                .foregroundStyle(tint)
            Text(title)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                primary.1()
            } label: {
                Text(primary.0).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}
