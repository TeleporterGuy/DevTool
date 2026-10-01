import DevToolKit
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let ref: TaskRef

    @State private var creatingChat = false
    @State private var newChatError: String?

    var body: some View {
        if let found = model.task(ref) {
            let project = found.project
            let task = found.task
            let offline = model.isOffline(ref.desktopId)
            let desktop = model.desktop(ref.desktopId)
            List {
                if offline {
                    Section {
                        OfflineBanner(title: "Desktop", lastSeen: lastSeen(desktop))
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                Section {
                    LabeledContent("Project") {
                        ProjectHeader(project: project, desktopName: nil)
                    }
                    LabeledContent("Desktop", value: desktop?.name ?? "")
                    LabeledContent("Status") {
                        StatusBadge(status: task.summaryStatus)
                    }
                    if let last = task.lastInteractedAt {
                        LabeledContent("Last used") {
                            RelativeTime(date: Date(unixMilliseconds: last))
                        }
                    }
                }

                Section {
                    ForEach(task.tabs) { tab in
                        if tab.type == .claudeChat {
                            // Only Claude chat tabs open on the phone; the rest are status only.
                            NavigationLink(value: ChatRoute(desktopId: ref.desktopId, tabId: tab.id)) {
                                TabRow(tab: tab)
                            }
                        } else {
                            TabRow(tab: tab)
                        }
                    }
                    if task.tabs.isEmpty {
                        Text("No agent or terminal tabs").foregroundStyle(.secondary)
                    }
                    if model.supports(DesktopFeature.chatNew, on: ref.desktopId) {
                        newChatRow(offline: offline)
                    }
                } header: {
                    Text("Tabs")
                } footer: {
                    if task.tabs.contains(where: { $0.type == .claudeChat }) {
                        Text("Open a Claude chat to read it, reply and answer its requests.")
                    }
                }
                .opacity(offline ? 0.55 : 1)
            }
            .listStyle(.insetGrouped)
            .navigationTitle(task.name)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.refresh([ref.desktopId]) }
            .alert("Couldn't start a chat", isPresented: Binding(get: { newChatError != nil }, set: { if !$0 { newChatError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(newChatError ?? "")
            }
        } else {
            ContentUnavailableView("Task not found", systemImage: "questionmark.folder", description: Text("It may have been closed on the desktop."))
        }
    }

    /// "New chat" (§8.2, §8.3): adds a Claude chat to the task on the desktop
    /// and opens it once it shows up in the inbox.
    private func newChatRow(offline: Bool) -> some View {
        Button {
            Task { await createChat() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus.bubble")
                    .frame(width: 28)
                Text("New chat")
                Spacer()
                if creatingChat { ProgressView() }
            }
        }
        .disabled(offline || creatingChat)
    }

    private func createChat() async {
        guard !creatingChat else { return }
        creatingChat = true
        defer { creatingChat = false }
        do {
            // RootView waits for the tab to appear in the inbox, then pushes the chat.
            model.requestedChat = try await model.newChat(in: ref)
        } catch {
            newChatError = error.localizedDescription
        }
    }

    private func lastSeen(_ desktop: DesktopRecord?) -> Date? {
        if case .offline(let seen?) = model.state(of: ref.desktopId) { return seen }
        return desktop?.lastSeen
    }
}

struct TabRow: View {
    let tab: InboxTab

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            TabTypeIcon(type: tab.type, status: tab.status)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(tab.title.isEmpty ? tab.type.displayName : tab.title)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let since = tab.since {
                        RelativeTime(date: Date(unixMilliseconds: since))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    StatusBadge(status: tab.status)
                    if let activity = tab.activity, !activity.isEmpty {
                        Text(activity)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
