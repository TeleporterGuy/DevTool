import DevToolKit
import SwiftUI

/// A tool row's full input and result (`chat.detail`), or a truncated text's full Markdown.
struct ItemDetailSheet: View {
    let item: ChatItem
    let load: () async throws -> ChatDetail
    @Environment(\.dismiss) private var dismiss
    @State private var detail: ChatDetail?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let detail {
                    content(detail)
                } else if let error {
                    ContentUnavailableView {
                        Label("Couldn't load details", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await fetch() } }
                            .buttonStyle(.bordered)
                    }
                } else {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if let copyText {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = copyText }
                    }
                }
            }
        }
        .task { await fetch() }
    }

    private var tool: ChatTool? {
        if case .tool(let tool) = item.content { return tool }
        return nil
    }

    private var title: String {
        tool?.name ?? "Message"
    }

    private var copyText: String? {
        switch detail {
        case .tool(let input, let result)?: [input, result].compactMap(\.self).joined(separator: "\n\n")
        case .text(let markdown)?: markdown
        case nil: nil
        }
    }

    private func fetch() async {
        error = nil
        do {
            detail = try await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    @ViewBuilder
    private func content(_ detail: ChatDetail) -> some View {
        switch detail {
        case .tool(let input, let result):
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let tool {
                        HStack(spacing: 8) {
                            Image(systemName: tool.symbol)
                            Text(tool.summary)
                                .font(.subheadline.monospaced())
                                .lineLimit(3)
                            Spacer(minLength: 0)
                            ToolStatusIcon(status: tool.status)
                        }
                        .foregroundStyle(.secondary)
                    }
                    DetailSection(title: "Input", text: input)
                    if let result {
                        DetailSection(title: "Result", text: result.isEmpty ? "(empty)" : result)
                    } else if tool?.status.isActive == true {
                        Label("No result yet", systemImage: "hourglass")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        case .text(let markdown):
            ScrollView {
                MarkdownText(markdown: markdown)
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: 780, alignment: .leading)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct DetailSection: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(minWidth: 0, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}
