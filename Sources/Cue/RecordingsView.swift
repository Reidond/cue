import AppKit
import SwiftUI

/// Library of recorded calls: list on the left, the rendered notes on the right.
struct RecordingsView: View {
    @ObservedObject var store: RecordingStore
    @ObservedObject var state: AppState
    @Binding var selection: String?
    @State private var search = ""

    private var filtered: [RecordingFile] {
        guard !search.isEmpty else { return store.files }
        return store.files.filter { $0.title.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(filtered) { file in
                    RecordingRow(file: file, summarizing: store.summarizing.contains(file.id))
                        .tag(file.id)
                        .contextMenu {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                            Button("Summarize Again") { store.summarize(file.id) }
                                .disabled(store.summarizing.contains(file.id))
                            Divider()
                            Button("Move to Trash", role: .destructive) { store.moveToTrash(file.id) }
                        }
                }
            }
            .searchable(text: $search, placement: .sidebar, prompt: "Search")
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
            .overlay {
                if store.files.isEmpty {
                    ContentUnavailableView("No Recordings", systemImage: "waveform",
                                           description: Text("Press ⌃⌥R or the record button in Cue to record a call."))
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
        } detail: {
            if let id = selection, let file = store.file(id) {
                RecordingDetail(store: store, file: file)
            } else {
                ContentUnavailableView("Select a Recording", systemImage: "doc.text",
                                       description: Text("Summaries and transcripts are saved as Markdown in \(store.folder.lastPathComponent)."))
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                RecordToolbarButton(state: state)
            }
        }
        .onAppear { store.reload() }
        .frame(minWidth: 760, minHeight: 480)
    }
}

private struct RecordingRow: View {
    let file: RecordingFile
    let summarizing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(file.title).lineLimit(2)
            HStack(spacing: 6) {
                Text(file.date.formatted(date: .abbreviated, time: .shortened))
                if !file.duration.isEmpty { Text("·"); Text(file.duration) }
                if summarizing { ProgressView().controlSize(.mini) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

private struct RecordingDetail: View {
    @ObservedObject var store: RecordingStore
    let file: RecordingFile
    @State private var confirmTrash = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if store.summarizing.contains(file.id), (store.liveSummary[file.id] ?? "").isEmpty {
                    Label {
                        Text("Writing the summary…")
                    } icon: {
                        ProgressView().controlSize(.small)
                    }
                    .foregroundStyle(.secondary)
                }
                if let failure = store.failures[file.id] {
                    FailureBanner(message: failure) { store.summarize(file.id) }
                }
                MarkdownView(markdown: store.contents(file.id))
            }
            // A comfortable reading measure, centred in wide windows.
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle(file.title)
        .navigationSubtitle(file.date.formatted(date: .long, time: .shortened))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button("Summarize Again", systemImage: "arrow.clockwise") { store.summarize(file.id) }
                    .disabled(store.summarizing.contains(file.id))
                    .help("Summarize again")
                Button("Copy Markdown", systemImage: "doc.on.doc") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(store.contents(file.id), forType: .string)
                }
                .help("Copy as Markdown")
                Button("Show in Finder", systemImage: "folder") {
                    NSWorkspace.shared.activateFileViewerSelecting([file.url])
                }
                .help("Show in Finder")
                Button("Move to Trash", systemImage: "trash") { confirmTrash = true }
                    .help("Move to Trash")
            }
        }
        .confirmationDialog("Move “\(file.title)” to the Trash?", isPresented: $confirmTrash) {
            Button("Move to Trash", role: .destructive) { store.moveToTrash(file.id) }
        } message: {
            Text("You can restore it from the Trash in Finder.")
        }
    }
}

private struct FailureBanner: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
            VStack(alignment: .leading, spacing: 2) {
                Text("Couldn't write the summary").fontWeight(.semibold)
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Try Again", action: retry)
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }
}

/// Start/stop recording from the library window too.
struct RecordToolbarButton: View {
    @ObservedObject var state: AppState

    var body: some View {
        Button(action: state.toggleRecording) {
            if let started = state.recorder.startedAt, !state.recorder.stopping {
                Label {
                    ElapsedTime(since: started)
                } icon: {
                    Image(systemName: "stop.circle.fill").foregroundStyle(.red)
                }
            } else if state.recorder.stopping {
                Label("Saving…", systemImage: "hourglass")
            } else {
                Label("Record", systemImage: "record.circle")
            }
        }
        .labelStyle(.titleAndIcon)
        .disabled(state.recorder.stopping)
        .help(state.recorder.isRecording ? "Stop recording (⌃⌥R)" : "Record a call (⌃⌥R)")
    }
}

/// mm:ss (or h:mm:ss), ticking every second.
struct ElapsedTime: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: since, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince(since)))
            Text(seconds >= 3600
                 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
                 : String(format: "%d:%02d", seconds / 60, seconds % 60))
                .monospacedDigit()
        }
    }
}
