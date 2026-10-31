import AppKit
import Foundation

/// Collects the transcript while a call is being recorded. Lines keep arriving
/// for a moment after Stop, because the last phrase is still being transcribed.
@MainActor
final class CallRecorder: ObservableObject {
    @Published private(set) var startedAt: Date?
    @Published private(set) var stopping = false
    private var endedAt: Date?
    private var lines: [Utterance] = []

    var isRecording: Bool { startedAt != nil && !stopping }

    /// Returns the start, which is also where the call's audio begins.
    @discardableResult
    func start() -> Date {
        let now = Date()
        lines = []
        endedAt = nil
        stopping = false
        startedAt = now
        return now
    }

    func add(_ utterance: Utterance) {
        guard let startedAt, utterance.time >= startedAt, utterance.started < (endedAt ?? .distantFuture) else { return }
        lines.append(utterance)
    }

    /// Returns the end of the recording.
    @discardableResult
    func beginStop() -> Date {
        let now = Date()
        endedAt = now
        stopping = true
        return now
    }

    func finish() -> CallTranscript? {
        defer { startedAt = nil; endedAt = nil; stopping = false; lines = [] }
        guard let startedAt else { return nil }
        return CallTranscript(startedAt: startedAt, endedAt: endedAt ?? Date(),
                              lines: lines.sorted { $0.started < $1.started })
    }
}

struct CallTranscript {
    let startedAt: Date
    let endedAt: Date
    let lines: [Utterance]

    /// Consecutive lines from the same speaker with short pauses become one paragraph.
    private var turns: [(channel: Channel, speaker: Int?, started: Date, text: String)] {
        var turns: [(channel: Channel, speaker: Int?, started: Date, ended: Date, text: String)] = []
        for line in lines {
            if let last = turns.last, last.channel == line.channel, last.speaker == line.speaker,
               line.started.timeIntervalSince(last.ended) < 4 {
                turns[turns.count - 1].text += " " + line.text
                turns[turns.count - 1].ended = line.time
            } else {
                turns.append((line.channel, line.speaker, line.started, line.time, line.text))
            }
        }
        return turns.map { ($0.channel, $0.speaker, $0.started, $0.text) }
    }

    private func offset(_ date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(startedAt)))
        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }

    /// `names` labels a side, and on the call side one of its voices when they were told apart.
    func markdown(names: (Channel, Int?) -> String) -> String {
        turns.map { "**\(offset($0.started)) · \(names($0.channel, $0.speaker))**\n\($0.text)" }.joined(separator: "\n\n")
    }

    func plainText(names: (Channel, Int?) -> String) -> String {
        turns.map { "[\(offset($0.started))] [\(names($0.channel, $0.speaker))] \($0.text)" }.joined(separator: "\n")
    }
}

/// A saved recording: Markdown with YAML front matter, the summary, and the
/// transcript after an HTML comment marker so the summary can be replaced later.
struct RecordingFile: Identifiable, Hashable {
    let url: URL
    let id: String          // project folder and start time; stays the same when the title (and file name) changes
    let title: String
    let date: Date
    let duration: String
    /// The call's audio next to the note (front matter `audio:`), if it was kept and is still there.
    let audio: URL?
    /// Names the summary suggested for the people on the call, by label (front matter `suggestions:`).
    let suggestions: [String: String]
    /// The note in the account (front matter `note:`); nil for one the account doesn't know yet.
    let noteID: String?
    /// The library has no audio of its own, but the account does and the player can stream it (front matter `audio-online:`).
    let streamsAudio: Bool
    var hasAudio: Bool { audio != nil || streamsAudio }

    static let transcriptMarker = "<!-- transcript -->"

    /// Folder name of the project the note belongs to (`<project>/Notes/<note>.md`).
    var projectID: String { url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent }

    /// Each side of the call on its own (`mic.wav`, `call.wav`), there while the note is being processed.
    var workingAudio: URL { AudioRecorder.workingFolder(startedAt: date) }

    static func load(_ url: URL) -> RecordingFile? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let front = frontMatter(text)
        guard let stamp = front["date"], let date = ISO8601DateFormatter().date(from: stamp) else { return nil }
        let project = url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
        let audio = front["audio"].map { url.deletingLastPathComponent().appendingPathComponent($0) }
        return RecordingFile(url: url, id: id(project: project, stamp: stamp), title: front["title"] ?? url.deletingPathExtension().lastPathComponent,
                             date: date, duration: front["duration"] ?? "",
                             audio: audio.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil },
                             suggestions: names(front["suggestions"]), noteID: front["note"], streamsAudio: front["audio-online"] == "yes")
    }

    static func id(project: String, stamp: String) -> String { "\(project)/\(stamp)" }

    /// Records the project in a note's front matter (notes moved in from before projects).
    static func setProject(_ name: String, in url: URL) {
        guard var text = try? String(contentsOf: url, encoding: .utf8), frontMatter(text)["project"] == nil,
              text.hasPrefix("---\n"), let end = text.range(of: "\n---\n", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return }
        text.insert(contentsOf: "\nproject: \(quoted(name))", at: end.lowerBound)
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    static func quoted(_ value: String) -> String { "\"\(value.replacingOccurrences(of: "\"", with: "\\\""))\"" }

    /// A list of names as YAML (and JSON): `["Olena Mulesa", "Petro Ivanenko"]`.
    static func list(_ values: [String]) -> String { "[" + values.map(quoted).joined(separator: ", ") + "]" }

    static func list(_ value: String?) -> [String] {
        value.flatMap { try? JSONDecoder().decode([String].self, from: Data($0.utf8)) } ?? []
    }

    /// Names by label as YAML (and JSON): `{"Participant 1": "Olena Mulesa"}`.
    static func names(_ values: [String: String]) -> String {
        "{" + values.sorted { $0.key < $1.key }.map { "\(quoted($0.key)): \(quoted($0.value))" }.joined(separator: ", ") + "}"
    }

    static func names(_ value: String?) -> [String: String] {
        value.flatMap { try? JSONDecoder().decode([String: String].self, from: Data($0.utf8)) } ?? [:]
    }

    /// The people in the note's `participants:`, the user first.
    static func participants(_ value: String?) -> [String] {
        (value ?? "").components(separatedBy: ", ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Sets (or, with nil, removes) one key of a note's front matter.
    static func setting(_ key: String, to value: String?, in text: String) -> String {
        guard text.hasPrefix("---\n"),
              let end = text.range(of: "\n---\n", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return text }
        var lines = text[text.index(text.startIndex, offsetBy: 4)..<end.lowerBound].components(separatedBy: "\n")
        let index = lines.firstIndex { $0.hasPrefix(key + ":") }
        switch (index, value) {
        case (let index?, let value?): lines[index] = "\(key): \(value)"
        case (let index?, nil): lines.remove(at: index)
        case (nil, let value?): lines.append("\(key): \(value)")
        case (nil, nil): return text
        }
        return "---\n" + lines.joined(separator: "\n") + String(text[end.lowerBound...])
    }

    static func frontMatter(_ text: String) -> [String: String] {
        let lines = text.components(separatedBy: "\n")
        guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return [:] }
        var values: [String: String] = [:]
        for line in lines[1..<end] {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 { value = String(value.dropFirst().dropLast()) }
            values[key] = value.replacingOccurrences(of: "\\\"", with: "\"")
        }
        return values
    }
}

/// The calendar event a call was recorded for: the note is named after it, and its attendees
/// go into the front matter and the summary prompt.
struct MeetingDetails {
    let title: String
    let attendees: [String]
}

/// What a new note goes through after Stop, in order; its page lists them as they happen.
/// The live transcript is saved before any of them, so a step that fails loses nothing.
enum NoteStep: String {
    case savingAudio = "Saving audio"
    case uploadingRecording = "Uploading recording"
    case improvingTranscript = "Improving transcript"
    case findingSpeakers = "Finding speakers"
    case writingSummary = "Writing summary"

    var title: String { rawValue }
}

struct NoteProgress: Identifiable, Equatable {
    enum State: Equatable {
        case pending
        /// With how far it has got, when the step knows.
        case running(String?)
        case done(String?)
        case failed(String)
    }

    let step: NoteStep
    var state: State
    var id: NoteStep { step }

    var isFinished: Bool {
        switch state {
        case .done, .failed: true
        case .pending, .running: false
        }
    }

    var failed: Bool { if case .failed = state { true } else { false } }
}

/// Saves recordings as Markdown in each project's `Notes/` and keeps them listed, newest first. The notes themselves are the account's:
/// the server makes them after each call (see `process`) and keeps them, and the Markdown here is the copy Cue shows and the user owns.
@MainActor
final class RecordingStore: ObservableObject {
    @Published private(set) var files: [RecordingFile] = []
    /// The steps of each note being processed, by recording id; kept after processing only if one failed.
    @Published private(set) var progress: [String: [NoteProgress]] = [:]
    /// Called with a recording's id once its notes are ready: every step done (or failed).
    var onNotesReady: (String) -> Void = { _ in }

    private let preferences: Preferences
    private let projects: ProjectStore
    private let api: CueAPI
    private let log: SessionLog
    private let uploader: RecordingUploader
    /// What uploads and follows each recording being processed, by recording id.
    private var tasks: [String: Task<Void, Never>] = [:]
    private var syncing = false

    init(preferences: Preferences, projects: ProjectStore, api: CueAPI, log: SessionLog) {
        self.preferences = preferences
        self.projects = projects
        self.api = api
        self.log = log
        uploader = RecordingUploader(api: api, log: log)
    }

    func reload() {
        let urls = projects.projects.flatMap { project in
            (try? FileManager.default.contentsOfDirectory(at: project.notesFolder, includingPropertiesForKeys: nil)) ?? []
        }
        files = urls.filter { $0.pathExtension == "md" }
            .compactMap(RecordingFile.load)
            .sorted { $0.date > $1.date }
    }

    func file(_ id: String) -> RecordingFile? { files.first { $0.id == id } }

    func files(in project: Project) -> [RecordingFile] { files.filter { $0.projectID == project.id } }

    func contents(_ id: String) -> String {
        guard let file = file(id) else { return "" }
        return (try? String(contentsOf: file.url, encoding: .utf8)) ?? ""
    }

    /// Still going through its steps after Stop.
    func isProcessing(_ id: String) -> Bool {
        progress[id]?.contains { !$0.isFinished } == true
    }

    /// Writes the transcript into the project's notes right away so nothing is lost, puts the call's
    /// audio next to it (with Keep audio on), then has the account make the notes (see `process`).
    /// A call recorded for a calendar event is named after the event and lists its attendees.
    /// `language` is what the call was recognized in live, when it isn't the project's language;
    /// `callID` the live call that heard it, if there is one.
    func save(_ transcript: CallTranscript, into project: Project, meeting: MeetingDetails? = nil,
              audio: AudioRecorder.Recording? = nil, spokenIn language: String? = nil, callID: String? = nil) -> String? {
        let lexicon = project.lexicon
        let speaker = preferences.speakerName.isEmpty ? "You" : preferences.speakerName
        let names: (Channel, Int?) -> String = { channel, voice in
            channel == .me ? speaker : voice.map(lexicon.numberedParticipant) ?? lexicon.participant
        }
        let stamp = ISO8601DateFormatter().string(from: transcript.startedAt)
        let id = RecordingFile.id(project: project.id, stamp: stamp)
        let title = meeting?.title ?? "Call " + transcript.startedAt.formatted(date: .abbreviated, time: .shortened)
        let duration = Duration.seconds(transcript.endedAt.timeIntervalSince(transcript.startedAt))
            .formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, zeroValueUnits: .hide))
        let summarize = preferences.summarizeRecordings
        let folder = project.notesFolder
        let event = meeting.map { "\nevent: \(RecordingFile.quoted($0.title))\nattendees: \(RecordingFile.list($0.attendees))" } ?? ""
        let url = folder.appendingPathComponent(Self.fileName(date: transcript.startedAt, title: meeting?.title ?? "Call"))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            NSAlert(error: error).show(logging: log)
            return nil
        }

        // The mixed audio goes next to the note, under the same name; the working copies stay for processing.
        var audioFile: URL?
        var steps: [NoteProgress] = []
        if let audio, preferences.keepAudio {
            do {
                guard let mixed = audio.mixed else { throw audio.error ?? ServiceError("Couldn't write the call's audio") }
                let target = url.deletingPathExtension().appendingPathExtension("m4a")
                if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
                try FileManager.default.moveItem(at: mixed, to: target)
                audioFile = target
                steps.append(NoteProgress(step: .savingAudio, state: .done(Self.clock(audio.duration))))
            } catch {
                log.write("⚠︎ Couldn't save the audio: \(error.localizedDescription)")
                steps.append(NoteProgress(step: .savingAudio, state: .failed(error.localizedDescription)))
            }
        } else if let mixed = audio?.mixed {
            try? FileManager.default.removeItem(at: mixed)
        }
        if audio != nil {
            steps.append(NoteProgress(step: .uploadingRecording, state: .pending))
            steps.append(NoteProgress(step: .improvingTranscript, state: .pending))
            steps.append(NoteProgress(step: .findingSpeakers, state: .pending))
        }
        if summarize { steps.append(NoteProgress(step: .writingSummary, state: .pending)) }

        let document = """
        ---
        title: \(RecordingFile.quoted(title))
        date: \(stamp)
        duration: \(duration.isEmpty ? "<1 min" : duration)
        participants: \(speaker), \(lexicon.participant)
        project: \(RecordingFile.quoted(project.name))\(event)\(audioFile.map { "\naudio: \(RecordingFile.quoted($0.lastPathComponent))" } ?? "")
        ---

        # \(title)

        \(summarize ? "_…_" : "")

        \(RecordingFile.transcriptMarker)
        ## \(lexicon.transcript)

        \(transcript.markdown(names: names))

        """
        do {
            try document.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            NSAlert(error: error).show(logging: log)
            return nil
        }
        log.write("🎙 Transcript saved: \(url.path)")
        if let audio {
            let length = Self.clock(audio.duration)
            if let error = audio.error { log.write("⚠︎ Audio incomplete: \(error.localizedDescription)") }
            if let audioFile {
                log.write("🔊 Audio saved: \(audioFile.path) (\(length))")
            } else if !preferences.keepAudio {
                log.write("🔊 Audio not kept (Keep audio is off): \(length)")
            }
            log.write("🎚 Working audio: \(audio.folder.path) (\(AudioRecorder.micFile), \(AudioRecorder.callFile))")
        }
        progress[id] = steps
        reload()
        let mixedAudio = audioFile
        tasks[id] = Task {
            await process(id, transcript: transcript, in: project, title: title, meeting: meeting, audio: audio, mixed: mixedAudio,
                          language: language ?? project.language, speaker: speaker, callID: callID)
            tasks[id] = nil
        }
        return id
    }

    // MARK: The notes

    /// What happens after the live transcript is saved: the recording goes up to the account (each side of the call, and the mixed audio
    /// for playing), the account's notes Workflow reads it again, tells the voices apart, suggests names and writes the summary, and this
    /// follows its progress. A step that fails leaves the note as it was (the live transcript stays) and the Workflow goes on to the next.
    private func process(_ id: String, transcript live: CallTranscript, in project: Project, title: String, meeting: MeetingDetails?,
                         audio: AudioRecorder.Recording?, mixed: URL?, language: String, speaker: String, callID: String?) async {
        guard let serverID = project.serverID else {
            abandon(id, "this project isn't in your account yet")
            return
        }
        // A recording belongs to the call that heard it. Without one (the live call never started), a call is made just for the notes.
        var made: String?
        if callID == nil {
            do {
                made = try await api.createCall(projectID: serverID, speaker: speaker, auto: false, micQuestions: false, questions: false).callId
            } catch {
                abandon(id, error.localizedDescription)
                return
            }
        }
        let temporary = made != nil
        guard let call = callID ?? made else { return }
        let take = Int64((live.startedAt.timeIntervalSince1970 * 1000).rounded(.down))

        var sides: [String] = []
        if let audio {
            set(.uploadingRecording, of: id, to: .running(nil))
            log.write("⬆️ Uploading the recording…")
            var total = 0
            var failure: Error?
            for (side, name) in [("me", AudioRecorder.micFile), ("others", AudioRecorder.callFile)] {
                do {
                    total += try await uploader.upload(audio.folder.appendingPathComponent(name), side: side, call: call, take: take)
                    sides.append(side)
                } catch {
                    failure = error
                    break
                }
            }
            if failure == nil, let mixed {
                do {
                    total += try await uploader.upload(mixed, side: "mixed", call: call, take: take)
                    sides.append("mixed")
                } catch {
                    log.write("⚠︎ Couldn't upload the audio for playing: \(error.localizedDescription)")
                }
            }
            if let failure {
                sides = []
                log.write("⚠︎ Couldn't upload the recording: \(failure.localizedDescription) — the live transcript is kept")
                set(.uploadingRecording, of: id, to: .failed(Self.sentence(failure.localizedDescription) + " The live transcript is kept."))
                // The server has no recording to read again.
                progress[id]?.removeAll { $0.step == .improvingTranscript || $0.step == .findingSpeakers }
            } else {
                let megabytes = String(format: "%.1f", Double(total) / 1_000_000)
                log.write("⬆️ Recording uploaded: \(megabytes) MB")
                set(.uploadingRecording, of: id, to: .done("\(megabytes) MB"))
            }
        }
        guard !Task.isCancelled, file(id) != nil else {
            if temporary { await api.endCall(call) }
            return
        }

        let started: RemoteNote
        do {
            started = try await api.startNotes(call: call, NewNotesBody(
                title: title, take: take, endedAt: Int64((live.endedAt.timeIntervalSince1970 * 1000).rounded(.down)), sides: sides,
                speaker: speaker, meeting: meeting.map { RemoteMeeting(title: $0.title, attendees: $0.attendees) },
                keepAudio: preferences.keepAudio, summarize: has(.writingSummary, id),
                language: language == project.language ? nil : language, projectId: serverID))
        } catch {
            if temporary { await api.endCall(call) }
            abandon(id, error.localizedDescription)
            return
        }
        if temporary { await api.endCall(call) }
        guard !Task.isCancelled, file(id) != nil else {
            try? await api.deleteNote(started.id)  // moved to the Trash meanwhile
            return
        }
        setNoteID(started.id, of: id)

        let followed = await follow(id, note: started.id)
        guard file(id) != nil else { return }
        guard let followed else {
            abandon(id, "the account stopped answering")
            return
        }
        adopt(followed.note, as: id, died: followed.died)
        finish(id)
    }

    /// Follows the Workflow's progress events (a dropped stream is picked up again where it left off) until the note is ready; returns the
    /// note as the account has it then (`died`: the Workflow ended without finishing), or nil when the account stopped answering.
    private func follow(_ id: String, note noteID: String) async -> (note: RemoteNote, died: Bool)? {
        var after = 0
        var ready = false
        var died = false
        var progressed = false
        /// Reads the events after the last one seen, to the end of the stream.
        func pull() async throws {
            try await api.followNoteEvents(noteID, after: after) { event in
                after = max(after, event.seq)
                progressed = true
                handle(event, of: id)
                if event.kind == "note", event.state == "ready" || event.state == "failed" {
                    ready = true
                    died = event.state == "failed"
                }
            }
        }
        var quiet = 0
        while !ready, quiet < 40, !Task.isCancelled, file(id) != nil {
            progressed = false
            do {
                try await pull()
            } catch CueAPIError.ended {
                break
            } catch {
                // The stream dropped, or the account is out of reach for a moment: look again below.
            }
            if ready { break }
            if let note = try? await api.note(noteID), note.status == "ready" {
                // Done while the stream was down: what it missed is replayed so the session log has every line.
                try? await pull()
                return (note, died)
            }
            quiet = progressed ? 0 : quiet + 1
            try? await Task.sleep(for: .seconds(progressed ? 0.5 : 2))
        }
        guard ready, let note = try? await api.note(noteID) else { return nil }
        return (note, died)
    }

    /// One progress event: the line it stands for goes to the session log, the step it is about to the note's page.
    private func handle(_ event: NoteProgressEvent, of id: String) {
        if let line = event.line { log.write(line) }
        guard event.kind == "step", let step = event.step else { return }
        apply(step: step, state: event.state, detail: event.detail, to: id)
    }

    /// The Workflow's steps are the page's: the names are suggested as part of writing the summary.
    private func apply(step: String, state: String, detail: String?, to id: String) {
        switch (step, state) {
        case ("transcript", "running"): set(.improvingTranscript, of: id, to: .running(nil))
        case ("transcript", "done"): set(.improvingTranscript, of: id, to: .done(nil))
        case ("transcript", "failed"):
            set(.improvingTranscript, of: id, to: .failed(Self.sentence(detail) + " The live transcript is kept."))
        case ("speakers", "running"): set(.findingSpeakers, of: id, to: .running(nil))
        case ("speakers", "done"): set(.findingSpeakers, of: id, to: .done(detail))
        case ("speakers", "failed"):
            set(.findingSpeakers, of: id, to: .failed(Self.sentence(detail) + " The transcript is kept as it was."))
        case ("names", "running"), ("summary", "running"): set(.writingSummary, of: id, to: .running(nil))
        case ("summary", "done"): set(.writingSummary, of: id, to: .done(nil))
        case ("summary", "failed"): set(.writingSummary, of: id, to: .failed(Self.sentence(detail)))
        default: break
        }
    }

    /// The note is ready: its steps are settled as the account has them, and its Markdown copy is written from it.
    private func adopt(_ note: RemoteNote, as id: String, died: Bool) {
        for step in note.steps where step.state == "done" || step.state == "failed" {
            apply(step: step.id, state: step.state, detail: step.detail, to: id)
        }
        // A step the Workflow didn't run (nothing to read again, say) doesn't keep the page waiting; with a Workflow that died, they failed.
        progress[id] = progress[id]?.map { step in
            var step = step
            if !step.isFinished { step.state = died ? .failed("The notes stopped early. The live transcript is kept.") : .done(nil) }
            return step
        }
        store(note, in: id)
    }

    /// Nothing more will come of the notes: the steps that hadn't happened failed, and the live transcript is what the note has.
    private func abandon(_ id: String, _ why: String) {
        log.write("⚠︎ Couldn't make the notes: \(why) — the live transcript is kept")
        progress[id] = progress[id]?.map { step in
            var step = step
            if !step.isFinished { step.state = .failed(Self.sentence(why) + " The live transcript is kept.") }
            return step
        }
        finish(id)
    }

    private func finish(_ id: String) {
        guard let file = file(id) else { return }  // moved to the Trash meanwhile
        notesReady(id, file.url, startedAt: file.date)
    }

    /// Records the account's id of a note in its Markdown, so the library and the account know it is one.
    private func setNoteID(_ noteID: String, of id: String) {
        guard let file = file(id), let text = try? String(contentsOf: file.url, encoding: .utf8) else { return }
        try? RecordingFile.setting("note", to: noteID, in: text).write(to: file.url, atomically: true, encoding: .utf8)
        reload()
    }

    /// Writes the Markdown copy of a note as the account has it. A new title renames the file and its audio.
    @discardableResult
    private func store(_ note: RemoteNote, in id: String) -> Bool {
        guard let file = file(id), let text = try? String(contentsOf: file.url, encoding: .utf8) else { return false }
        let stamp = RecordingFile.frontMatter(text)["date"] ?? NoteMarkdown.stamp(note.started)
        let rendered = NoteMarkdown.render(note, project: projects.project(file.projectID)?.name ?? file.projectID, stamp: stamp,
                                           audio: file.audio?.lastPathComponent, audioOnline: note.audio.contains("mixed"),
                                           keepingTranscriptOf: text)
        do {
            try write(rendered, to: file, title: note.title)
            reload()
            return true
        } catch {
            log.write("⚠︎ Couldn't save the note: \(error.localizedDescription)")
            return false
        }
    }

    /// The last step a new note goes through: its working audio is no longer needed, and its steps
    /// leave the page unless one of them failed.
    private func notesReady(_ id: String, _ url: URL, startedAt: Date) {
        // Tests and the session log both wait for "Notes ready".
        log.write("📝 Notes ready: \(url.path)")
        let working = AudioRecorder.workingFolder(startedAt: startedAt)
        if FileManager.default.fileExists(atPath: working.path), (try? FileManager.default.removeItem(at: working)) != nil {
            log.write("🧹 Working audio removed: \(working.path)")
        }
        if progress[id]?.contains(where: \.failed) != true { progress[id] = nil }
        onNotesReady(id)
    }

    private func has(_ step: NoteStep, _ id: String) -> Bool { progress[id]?.contains { $0.step == step } == true }

    private func set(_ step: NoteStep, of id: String, to state: NoteProgress.State) {
        guard let index = progress[id]?.firstIndex(where: { $0.step == step }) else { return }
        progress[id]?[index].state = state
    }

    /// "The upload broke" → "The upload broke."; system errors end with a full stop of their own.
    private static func sentence(_ text: String?) -> String {
        let trimmed = (text ?? "").trimmingCharacters(in: CharacterSet(charactersIn: ". \n"))
        return trimmed.isEmpty ? "It failed." : trimmed + "."
    }

    /// 0:42, 12:05 or 1:02:03.
    nonisolated static func clock(_ seconds: TimeInterval) -> String {
        let seconds = max(0, Int(seconds.rounded()))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// Writes a note under its title, which may be new: the front matter and the H1 take it, and the
    /// note and its audio are renamed after it (unless a file by that name is already there).
    private func write(_ text: String, to file: RecordingFile, title: String) throws {
        var updated = text.replacingOccurrences(of: "title: \(RecordingFile.quoted(file.title))", with: "title: \(RecordingFile.quoted(title))")
        updated = updated.replacingOccurrences(of: "\n# \(file.title)\n", with: "\n# \(title)\n")
        let renamed = file.url.deletingLastPathComponent().appendingPathComponent(Self.fileName(date: file.date, title: title))
        let rename = renamed != file.url && !FileManager.default.fileExists(atPath: renamed.path)
        // The audio takes the note's new name too.
        if rename, let audio = file.audio {
            let renamedAudio = renamed.deletingPathExtension().appendingPathExtension(audio.pathExtension)
            if !FileManager.default.fileExists(atPath: renamedAudio.path),
               (try? FileManager.default.moveItem(at: audio, to: renamedAudio)) != nil {
                updated = updated.replacingOccurrences(of: "\naudio: \(RecordingFile.quoted(audio.lastPathComponent))\n",
                                                       with: "\naudio: \(RecordingFile.quoted(renamedAudio.lastPathComponent))\n")
            }
        }
        try updated.write(to: file.url, atomically: true, encoding: .utf8)
        if rename { try FileManager.default.moveItem(at: file.url, to: renamed) }
    }

    // MARK: Editing a note

    /// Renames a person throughout a note — its transcript, summary, title and participants — and
    /// drops the name suggested for them. Calendar facts (the event, who was invited) stay as they were.
    /// The account does it; the Markdown copy follows.
    func rename(speaker old: String, to name: String, in id: String) {
        // Commas would split the participants, asterisks the transcript's speaker lines.
        let new = name.components(separatedBy: CharacterSet(charactersIn: ",*\n")).joined().trimmingCharacters(in: .whitespaces)
        guard let file = file(id), !new.isEmpty, new != old, !isProcessing(id) else { return }
        edit(file, .rename(from: old, to: new), renamed: (old, new))
    }

    /// Uses the name suggested for a label.
    func applySuggestion(for label: String, in id: String) {
        guard let file = file(id), let name = file.suggestions[label], !isProcessing(id) else { return }
        edit(file, .apply(label), renamed: (label, name))
    }

    /// Leaves a name suggestion unused.
    func dismissSuggestion(for label: String, in id: String) {
        guard let file = file(id) else { return }
        edit(file, .dismiss(label), renamed: nil)
    }

    private func edit(_ file: RecordingFile, _ patch: NotePatchBody, renamed: (old: String, new: String)?) {
        guard let noteID = file.noteID else {
            log.write("⚠︎ “\(file.title)” isn't in your account yet: try again in a moment")
            return
        }
        Task {
            do {
                let note = try await api.patchNote(noteID, patch)
                guard store(note, in: file.id) else { return }
                if let renamed { log.write("✏️ Renamed “\(renamed.old)” to “\(renamed.new)” in \(file.title)") }
            } catch {
                NSAlert(error: error).show(logging: log)
            }
        }
    }

    /// Moves the note and its audio to the Trash (and the note out of the account); working audio, if it is still being processed, is deleted.
    func moveToTrash(_ id: String) {
        guard let file = file(id) else { return }
        tasks[id]?.cancel()
        tasks[id] = nil
        progress[id] = nil
        try? FileManager.default.removeItem(at: file.workingAudio)
        Task {
            if let noteID = file.noteID {
                do {
                    try await api.deleteNote(noteID)
                } catch {
                    log.write("⚠︎ Couldn't delete “\(file.title)” from your account: \(error.localizedDescription)")
                }
            }
            NSWorkspace.shared.recycle([file.url] + (file.audio.map { [$0] } ?? [])) { [weak self] _, _ in
                Task { @MainActor in self?.reload() }
            }
        }
    }

    func cancelAll() {
        tasks.values.forEach { $0.cancel() }
    }

    // MARK: The account's notes

    /// After signing in: the notes this Mac had before it had an account go up to it once (`📦 Imported …`), and the account's notes
    /// the library doesn't have (from another Mac, say) are written to it (`☁️ Restored …`).
    func syncWithAccount() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        reload()
        let remote: [RemoteNote]
        do {
            remote = try await api.listNotes()
        } catch {
            log.write("⚠︎ Couldn't read your notes from your account: \(error.localizedDescription)")
            return
        }

        var imported = 0
        for file in files where file.noteID == nil && progress[file.id] == nil {
            guard let project = projects.project(file.projectID), project.serverID != nil,
                  let text = try? String(contentsOf: file.url, encoding: .utf8),
                  let stamp = RecordingFile.frontMatter(text)["date"],
                  let body = NoteMarkdown.importBody(from: text, project: project, stamp: stamp)
            else { continue }
            do {
                let note = try await api.importNote(body)
                if let audio = file.audio, !note.audio.contains("mixed") {
                    do {
                        try await api.putImportAudio(note.id, file: audio)
                    } catch {
                        log.write("⚠︎ Couldn't upload the audio of “\(file.title)”: \(error.localizedDescription)")
                    }
                }
                try? RecordingFile.setting("note", to: note.id, in: text).write(to: file.url, atomically: true, encoding: .utf8)
                imported += 1
            } catch {
                log.write("⚠︎ Couldn't import “\(file.title)”: \(error.localizedDescription)")
            }
        }
        if imported > 0 { log.write("📦 Imported \(imported) note\(imported == 1 ? "" : "s") from this Mac") }

        reload()
        let known = Set(files.compactMap(\.noteID))
        let identities = Set(files.map(\.id))
        var restored = 0
        for note in remote where note.status == "ready" && !known.contains(note.id) {
            guard let projectID = note.projectId, let project = projects.projects.first(where: { $0.serverID == projectID }),
                  !identities.contains(RecordingFile.id(project: project.id, stamp: NoteMarkdown.stamp(note.started)))
            else { continue }
            let url = project.notesFolder.appendingPathComponent(Self.fileName(date: note.started, title: note.title))
            guard !FileManager.default.fileExists(atPath: url.path) else { continue }
            let text = NoteMarkdown.render(note, project: project.name, stamp: NoteMarkdown.stamp(note.started), audio: nil,
                                           audioOnline: note.audio.contains("mixed"))
            do {
                try FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
                try text.write(to: url, atomically: true, encoding: .utf8)
                restored += 1
            } catch {
                log.write("⚠︎ Couldn't restore “\(note.title)”: \(error.localizedDescription)")
            }
        }
        if restored > 0 { log.write("☁️ Restored \(restored) note\(restored == 1 ? "" : "s") from your account") }
        reload()
    }

    private static let stampFormat: DateFormatter = {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd HH.mm"
        return format
    }()

    /// "2026-10-24 14.05 – Title.md": sorts by date in Finder.
    private static func fileName(date: Date, title: String) -> String {
        let safe = title.components(separatedBy: CharacterSet(charactersIn: "/:\\\n")).joined(separator: "-").prefix(80)
        return "\(stampFormat.string(from: date)) – \(safe).md"
    }
}
