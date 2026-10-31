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
        // Not an HSplitView: that takes the note's unwrapped width as its least, and in a narrow window
        // the page would come out wider than it, cut off on both sides.
        HStack(spacing: 0) {
            List(selection: $selection) {
                ForEach(filtered) { file in
                    RecordingRow(file: file, processing: store.isProcessing(file.id))
                        .tag(file.id)
                        .contextMenu {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                            Divider()
                            Button("Move to Trash", role: .destructive) { store.moveToTrash(file.id) }
                        }
                }
            }
            // On the page's own background, with the rows' text on the header's 28 pt margin
            // (the list insets it 18).
            .scrollContentBackground(.hidden)
            .padding(.leading, 10)
            .searchable(text: $search, prompt: "Search notes")
            .frame(width: 280)
            .overlay {
                if files.isEmpty {
                    ContentUnavailableView("No Notes", systemImage: "waveform",
                                           description: Text("Press ⌃⌥R or the record button in Cue to record a call into this project."))
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }

            Divider()

            Group {
                if let id = selection, let file = store.file(id), file.projectID == project.id {
                    RecordingDetail(store: store, player: state.player, file: file)
                } else {
                    ContentUnavailableView("Select a Note", systemImage: "doc.text",
                                           description: Text("Summaries and transcripts are saved as Markdown in the project’s Notes folder."))
                }
            }
            .frame(minWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
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
    /// The person being renamed, and the name being typed.
    @State private var renaming = ""
    @State private var newName = ""
    @State private var showRename = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let steps = store.progress[file.id] {
                    NoteSteps(steps: steps)
                }
                if !file.suggestions.isEmpty, !store.isProcessing(file.id) {
                    NameSuggestions(suggestions: file.suggestions) { label in
                        store.applySuggestion(for: label, in: file.id)
                    } dismiss: { label in
                        store.dismissSuggestion(for: label, in: file.id)
                    }
                }
                MarkdownView(markdown: store.contents(file.id),
                             onTimestamp: file.hasAudio ? { [player] in player.play(from: $0) } : nil,
                             onSpeaker: store.isProcessing(file.id) ? nil : { name in
                                 renaming = name
                                 newName = name
                                 showRename = true
                             })
            }
            // A comfortable reading measure, centred in wide windows.
            .frame(maxWidth: 720, alignment: .leading)
            // The project header's margin.
            .padding(.horizontal, 28)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .safeAreaInset(edge: .top) {
            if file.hasAudio {
                PlayerBar(player: player)
                    .frame(maxWidth: 720)
                    .padding(.horizontal, 28)
                    .padding(.top, 14)
            }
        }
        .task(id: file.audio?.path ?? (file.streamsAudio ? file.noteID : nil)) {
            if let audio = file.audio {
                player.load(audio, note: file.id)
            } else if file.streamsAudio, let noteID = file.noteID {
                await player.stream(noteID, note: file.id)
            } else {
                player.load(nil, note: nil)
            }
        }
        .onDisappear { player.load(nil, note: nil) }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
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
        .alert("Rename “\(renaming)”", isPresented: $showRename) {
            TextField("Name", text: $newName)
            Button("Rename") { store.rename(speaker: renaming, to: newName, in: file.id) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The name changes everywhere in this note: the transcript, the summary and the participants.")
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
    /// The account the audio of a note that isn't in the library streams from.
    private let api: CueAPI
    private var url: URL?
    private var note: String?
    private var timeObserver: Any?
    private var status: NSKeyValueObservation?

    init(log: SessionLog, api: CueAPI) {
        self.log = log
        self.api = api
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
        openItem(url, note: note, headers: nil)
    }

    /// Opens a note's audio from the account (the `mixed` side, with range requests), for a note whose audio isn't in the library.
    func stream(_ noteID: String, note: String) async {
        let url = api.audioURL(note: noteID)
        guard url != self.url, let token = try? await api.bearer() else { return }
        openItem(url, note: note, headers: ["Authorization": "Bearer \(token)", "Cue-Version": LiveCall.clientVersion])
    }

    private func openItem(_ url: URL?, note: String?, headers: [String: String]?) {
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
        // The header-fields key is AVFoundation's documented-in-practice way to make an asset's requests carry the token.
        let asset = headers.map { AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": $0]) } ?? AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
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
        HStack(spacing: 10) {
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
            Scrubber(time: player.time, duration: player.duration) { player.scrubbing = $0 } seek: { player.seek(to: $0) }
            Text(RecordingStore.clock(player.duration))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Menu {
                Picker("Speed", selection: $player.rate) {
                    ForEach(NotePlayer.rates, id: \.self) { Text(Self.label($0)).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                Text(Self.label(player.rate)).monospacedDigit()
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .padding(.leading, 6)
            .help("Playback speed")
            .accessibilityLabel("Playback speed")
            .accessibilityValue(Self.label(player.rate))
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
    }

    /// 1×, 1.5× (1,5× where that's the decimal separator), 2×.
    private static func label(_ rate: Float) -> String {
        rate.formatted(.number.precision(.fractionLength(0...1))) + "×"
    }
}

/// A slim track, the played part filled, and a small knob: click or drag anywhere on it to seek.
private struct Scrubber: View {
    let time: TimeInterval
    let duration: TimeInterval
    let scrubbing: (Bool) -> Void
    let seek: (TimeInterval) -> Void
    @State private var dragging = false

    private let knob: CGFloat = 10
    private var length: TimeInterval { max(duration, 1) }
    private var fraction: CGFloat { CGFloat(min(max(time / length, 0), 1)) }

    var body: some View {
        GeometryReader { geometry in
            let travel = max(geometry.size.width - knob, 1)
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                    .frame(height: 4)
                Capsule().fill(.tint)
                    .frame(width: knob / 2 + travel * fraction, height: 4)
                Circle().fill(.white)
                    .shadow(color: .black.opacity(0.3), radius: 1, y: 0.5)
                    .frame(width: knob, height: knob)
                    .offset(x: travel * fraction)
            }
            .frame(maxHeight: .infinity)
            .contentShape(.rect)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if !dragging {
                        dragging = true
                        scrubbing(true)
                    }
                    seek(seconds(at: value.location.x, travel: travel))
                }
                .onEnded { value in
                    seek(seconds(at: value.location.x, travel: travel))
                    dragging = false
                    scrubbing(false)
                })
        }
        .frame(height: 20)
        .accessibilityRepresentation {
            Slider(value: Binding(get: { time }, set: seek), in: 0...length) { Text("Position") }
        }
    }

    private func seconds(at x: CGFloat, travel: CGFloat) -> TimeInterval {
        TimeInterval(min(max((x - knob / 2) / travel, 0), 1)) * length
    }
}

/// Who the summary thinks the people on the call are, each with Apply (renames them in the note).
private struct NameSuggestions: View {
    let suggestions: [String: String]
    let apply: (String) -> Void
    let dismiss: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(suggestions.keys.sorted(), id: \.self) { label in
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .foregroundStyle(.secondary)
                    Text("\(label) → \(suggestions[label] ?? "")?")
                    Button("Apply") { apply(label) }
                        .controlSize(.small)
                    Button("Dismiss", systemImage: "xmark") { dismiss(label) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("Dismiss the suggestion")
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.4), in: .capsule)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested names")
    }
}

/// What happens to a new note after Stop, step by step; it stays on the page if a step failed.
private struct NoteSteps: View {
    let steps: [NoteProgress]

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

/// Start/stop recording from the dashboard too.
struct RecordToolbarButton: View {
    @ObservedObject var state: AppState

    var body: some View {
        Button { state.toggleRecording(.dashboard) } label: {
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
