import AppKit
import AVFoundation
import SwiftUI

/// A project's notes: the list on the left, the rendered notes on the right.
struct ProjectNotesView: View {
    @ObservedObject var store: RecordingStore
    @ObservedObject var state: AppState
    let project: Project
    @Binding var selection: String?
    @State private var search = ""

    private var files: [RecordingFile] { store.files(in: project) }

    private var filtered: [RecordingFile] {
        guard !search.isEmpty else { return files }
        return files.filter { $0.title.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        HSplitView {
            List(selection: $selection) {
                ForEach(filtered) { file in
                    RecordingRow(file: file, processing: store.isProcessing(file.id))
                        .tag(file.id)
                        .contextMenu {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                            Button("Summarize Again") { store.summarize(file.id) }
                                .disabled(store.isProcessing(file.id))
                            Divider()
                            Button("Move to Trash", role: .destructive) { store.moveToTrash(file.id) }
                        }
                }
            }
            .searchable(text: $search, prompt: "Search notes")
            .frame(minWidth: 220, idealWidth: 270, maxWidth: 380)
            .overlay {
                if files.isEmpty {
                    ContentUnavailableView("No Notes", systemImage: "waveform",
                                           description: Text("Press ⌃⌥R or the record button in Cue to record a call into this project."))
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }

            Group {
                if let id = selection, let file = store.file(id), file.projectID == project.id {
                    RecordingDetail(store: store, player: state.player, file: file)
                } else {
                    ContentUnavailableView("Select a Note", systemImage: "doc.text",
                                           description: Text("Summaries and transcripts are saved as Markdown in the project’s Notes folder."))
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                RecordToolbarButton(state: state)
            }
        }
        .onAppear {
            store.reload()
            if selection.flatMap(store.file)?.projectID != project.id { selection = files.first?.id }
        }
    }
}

private struct RecordingRow: View {
    let file: RecordingFile
    let processing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(file.title).lineLimit(2)
            HStack(spacing: 6) {
                Text(file.date.formatted(date: .abbreviated, time: .shortened))
                if !file.duration.isEmpty { Text("·"); Text(file.duration) }
                if processing { ProgressView().controlSize(.mini) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

private struct RecordingDetail: View {
    @ObservedObject var store: RecordingStore
    /// Not observed here: only the bar redraws as it plays.
    let player: NotePlayer
    let file: RecordingFile
    @State private var confirmTrash = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let steps = store.progress[file.id] {
                    NoteSteps(steps: steps) { store.summarize(file.id) }
                } else if store.summarizing.contains(file.id), (store.liveSummary[file.id] ?? "").isEmpty {
                    Label {
                        Text("Writing the summary…")
                    } icon: {
                        ProgressView().controlSize(.small)
                    }
                    .foregroundStyle(.secondary)
                } else if let failure = store.failures[file.id] {
                    FailureBanner(message: failure) { store.summarize(file.id) }
                }
                MarkdownView(markdown: store.contents(file.id),
                             onTimestamp: file.audio == nil ? nil : { [player] in player.play(from: $0) })
            }
            // A comfortable reading measure, centred in wide windows.
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .safeAreaInset(edge: .top) {
            if file.audio != nil {
                PlayerBar(player: player)
                    .frame(maxWidth: 720)
                    .padding(.horizontal, 32)
                    .padding(.top, 14)
            }
        }
        .task(id: file.audio) { player.load(file.audio, note: file.id) }
        .onDisappear { player.load(nil, note: nil) }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button("Summarize Again", systemImage: "arrow.clockwise") { store.summarize(file.id) }
                    .disabled(store.isProcessing(file.id))
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

/// Plays the audio of the note open in the dashboard; the transcript's timestamps jump in it.
@MainActor
final class NotePlayer: ObservableObject {
    static let rates: [Float] = [1, 1.5, 2]

    @Published private(set) var isPlaying = false
    @Published private(set) var time: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    @Published var rate: Float = 1 {
        didSet {
            player.defaultRate = rate
            if isPlaying { player.rate = rate }
        }
    }
    /// While the scrubber is dragged, it sets the time rather than following it.
    var scrubbing = false

    private let player = AVPlayer()
    private let log: SessionLog
    private var url: URL?
    private var note: String?
    private var timeObserver: Any?
    private var status: NSKeyValueObservation?

    init(log: SessionLog) {
        self.log = log
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, !self.scrubbing else { return }
                self.time = time.seconds
            }
        }
        status = player.observe(\.timeControlStatus) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying = self.player.timeControlStatus != .paused
            }
        }
    }

    /// Opens a note's audio (nil stops). A new file for the same note, renamed after its summary,
    /// carries on from the same moment.
    func load(_ url: URL?, note: String?) {
        guard url != self.url else { return }
        let resume = note != nil && note == self.note ? (time: time, playing: isPlaying) : nil
        player.pause()
        self.url = url
        self.note = note
        guard let url else {
            player.replaceCurrentItem(with: nil)
            time = 0
            duration = 0
            return
        }
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        if let resume {
            player.seek(to: CMTime(seconds: resume.time, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            if resume.playing { player.playImmediately(atRate: rate) }
        } else {
            time = 0
            duration = 0
        }
        Task {
            let length = (try? await item.asset.load(.duration))?.seconds ?? 0
            if player.currentItem === item, length.isFinite { duration = length }
        }
    }

    func togglePlay() {
        if isPlaying {
            player.pause()
        } else {
            if duration > 0, time >= duration - 0.1 { seek(to: 0) }
            player.playImmediately(atRate: rate)
        }
    }

    func seek(to seconds: TimeInterval) {
        time = seconds
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    /// A timestamp clicked in the transcript: plays from there.
    func play(from seconds: TimeInterval) {
        guard let item = player.currentItem, let url else {
            log.write("⚠︎ No audio to play")
            return
        }
        time = seconds
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, finished, self.player.currentItem === item else { return }
                self.player.playImmediately(atRate: self.rate)
                let position = String(format: "%.1f", self.player.currentTime().seconds)
                self.log.write("▶︎ Playing \(url.lastPathComponent) from \(RecordingStore.clock(seconds)) (player at \(position) s)")
            }
        }
    }
}

/// Play/pause, the scrubber and the speed, floating above a note.
private struct PlayerBar: View {
    @ObservedObject var player: NotePlayer

    var body: some View {
        HStack(spacing: 12) {
            Button(player.isPlaying ? "Pause" : "Play", systemImage: player.isPlaying ? "pause.fill" : "play.fill",
                   action: player.togglePlay)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .font(.title3)
                .frame(width: 22)
                .help(player.isPlaying ? "Pause" : "Play")
            Text(RecordingStore.clock(player.time))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Slider(value: Binding(get: { player.time }, set: { player.seek(to: $0) }),
                   in: 0...max(player.duration, 1)) { player.scrubbing = $0 }
                .controlSize(.small)
                .accessibilityLabel("Position")
            Text(RecordingStore.clock(player.duration))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Picker("Speed", selection: $player.rate) {
                ForEach(NotePlayer.rates, id: \.self) { rate in
                    Text(rate.formatted(.number.precision(.fractionLength(0...1))) + "×").tag(rate)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("Playback speed")
        }
        .font(.callout)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
    }
}

/// What happens to a new note after Stop, step by step; it stays on the page if a step failed.
private struct NoteSteps: View {
    let steps: [NoteProgress]
    let retrySummary: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    icon(step.state)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.step.title)
                            .foregroundStyle(step.state == .pending ? .secondary : .primary)
                        if let detail = detail(step.state) {
                            Text(detail)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    if step.step == .writingSummary, step.failed {
                        Button("Try Again", action: retrySummary)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Processing steps")
    }

    @ViewBuilder
    private func icon(_ state: NoteProgress.State) -> some View {
        switch state {
        case .pending:
            Image(systemName: "circle.dashed").foregroundStyle(.tertiary)
        case .running:
            ProgressView().controlSize(.small)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        }
    }

    private func detail(_ state: NoteProgress.State) -> String? {
        switch state {
        case .pending: nil
        case .running(let detail), .done(let detail): detail
        case .failed(let reason): reason
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

/// Start/stop recording from the dashboard too.
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
            Text(RecordingStore.clock(context.date.timeIntervalSince(since).rounded(.down)))
                .monospacedDigit()
        }
    }
}
