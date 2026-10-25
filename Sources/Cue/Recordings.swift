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
                             suggestions: names(front["suggestions"]))
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

/// Saves recordings as Markdown in each project's `Notes/` and keeps them listed, newest first.
@MainActor
final class RecordingStore: ObservableObject {
    @Published private(set) var files: [RecordingFile] = []
    /// Summary text streaming in, by recording id.
    @Published private(set) var liveSummary: [String: String] = [:]
    @Published private(set) var summarizing: Set<String> = []
    @Published private(set) var failures: [String: String] = [:]
    /// The steps of each note being processed, by recording id; kept after processing only if one failed.
    @Published private(set) var progress: [String: [NoteProgress]] = [:]
    /// Called with a recording's id once its notes are ready: every step done (or failed).
    var onNotesReady: (String) -> Void = { _ in }

    private let preferences: Preferences
    private let projects: ProjectStore
    private let speakerModels: SpeakerModels
    private let log: SessionLog
    private var summarizers: [String: Process] = [:]
    private var secondPasses: [String: SecondPassProcess] = [:]
    /// Second passes run one at a time: each loads the 1.6 GB speech model.
    private var secondPassRunning = false
    private var secondPassQueue: [CheckedContinuation<Void, Never>] = []

    init(preferences: Preferences, projects: ProjectStore, speakerModels: SpeakerModels, log: SessionLog) {
        self.preferences = preferences
        self.projects = projects
        self.speakerModels = speakerModels
        self.log = log
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
        guard let file = file(id), var text = try? String(contentsOf: file.url, encoding: .utf8) else { return "" }
        if let live = liveSummary[id] {
            let remarks = (projects.project(file.projectID)?.lexicon ?? Lexicon.load("en")).transcriptRemarks
            let summary = Summarizer.nameSuggestions(in: Summarizer.droppingTranscriptRemarks(live, words: remarks).text, for: []).text
            text = replacingSummary(in: text, with: Self.withoutTitle(summary))
        }
        return text
    }

    /// Still going through its steps after Stop, or being summarized again.
    func isProcessing(_ id: String) -> Bool {
        summarizing.contains(id) || progress[id]?.contains { !$0.isFinished } == true
    }

    /// Writes the transcript into the project's notes right away so nothing is lost, puts the call's
    /// audio next to it (with Keep audio on), then improves the transcript and summarizes it (see
    /// `process`). A call recorded for a calendar event is named after the event and lists its attendees.
    /// `language` is what the call was recognized in live, when it isn't the project's language.
    func save(_ transcript: CallTranscript, into project: Project, meeting: MeetingDetails? = nil,
              audio: AudioRecorder.Recording? = nil, spokenIn language: String? = nil) -> String? {
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
            NSAlert(error: error).runModal()
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
            NSAlert(error: error).runModal()
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
        Task { await process(id, transcript: transcript, in: project, language: language ?? project.language, names: names) }
        return id
    }

    /// The steps after the live transcript is saved, one after another: each works on what the
    /// one before left, and a step that fails leaves the note as it was for the next.
    private func process(_ id: String, transcript live: CallTranscript, in project: Project, language: String,
                         names: @escaping (Channel, Int?) -> String) async {
        var transcript = live
        if has(.improvingTranscript, id),
           let improved = await improve(id, transcript: live, in: project, language: language, names: names) {
            transcript = improved
        }
        if has(.findingSpeakers, id), let labelled = await findSpeakers(id, transcript: transcript, names: names) {
            transcript = labelled
        }
        if has(.writingSummary, id) {
            await withCheckedContinuation { done in summarize(id, transcript: transcript.plainText(names: names)) { done.resume() } }
        }
        guard let file = file(id) else { return }  // moved to the Trash meanwhile
        notesReady(id, file.url, startedAt: file.date)
    }

    /// Whisper's second pass over each side's whole recording replaces the live transcript; on failure
    /// the live one stays. Returns the improved transcript.
    private func improve(_ id: String, transcript live: CallTranscript, in project: Project, language: String,
                         names: @escaping (Channel, Int?) -> String) async -> CallTranscript? {
        await waitForSecondPass()
        defer { secondPassFinished() }
        guard let file = file(id) else { return nil }
        set(.improvingTranscript, of: id, to: .running(nil))
        log.write("🔁 Improving transcript…")
        let child = SecondPassProcess()
        secondPasses[id] = child
        defer { secondPasses[id] = nil }
        let started = Date()
        let job = SecondPass.Job(folder: file.workingAudio, startedAt: live.startedAt, endedAt: live.endedAt,
                                 language: language, prompt: project.whisperPrompt, lexicon: project.lexicon)
        do {
            let result = try await SecondPass.run(job, child: child) { [weak self] done in
                Task { @MainActor in
                    guard self?.progress[id]?.first(where: { $0.step == .improvingTranscript })?.isFinished == false else { return }
                    self?.set(.improvingTranscript, of: id, to: .running(done.formatted(.percent.precision(.fractionLength(0)))))
                }
            }
            if let side = Self.sideLost(live: live, improved: result.transcript) {
                throw ServiceError("it heard much less than live recognition on \(side)")
            }
            try writeTranscript(result.transcript, names: names, of: id)
            let took = String(format: "%.1f", Date().timeIntervalSince(started))
            log.write("✅ Transcript improved: \(result.transcript.lines.count) segments (\(took) s for \(Self.clock(result.duration)) of audio)")
            set(.improvingTranscript, of: id, to: .done(nil))
            return result.transcript
        } catch {
            log.write("⚠︎ Couldn't improve the transcript: \(error.localizedDescription) — the live transcript is kept")
            set(.improvingTranscript, of: id, to: .failed("\(error.localizedDescription). The live transcript is kept."))
            return nil
        }
    }

    /// The side on which the second pass lost more than a quarter of the words live recognition heard
    /// (a wrong language, a cut-off run, nothing but hallucinations), if any: the live transcript is the
    /// better one then. A good pass stays within a few percent of the live word count.
    private static func sideLost(live: CallTranscript, improved: CallTranscript) -> String? {
        func words(_ transcript: CallTranscript, _ channel: Channel) -> Int {
            transcript.lines.filter { $0.channel == channel }
                .reduce(0) { $0 + $1.text.split(whereSeparator: \.isWhitespace).count }
        }
        for channel in [Channel.me, .others] {
            let before = words(live, channel), after = words(improved, channel)
            if before >= 8 && after * 4 < before * 3 { return channel == .me ? "your side" : "the call side" }
        }
        return nil
    }

    /// Tells the voices on the call side apart in `call.wav` and gives each call-side line its voice.
    /// With several, the transcript and the participants name them «Учасник 1», «Учасник 2»…; with
    /// one, the note stays as it was, and so it does on failure. Returns the labelled transcript.
    private func findSpeakers(_ id: String, transcript: CallTranscript,
                              names: @escaping (Channel, Int?) -> String) async -> CallTranscript? {
        guard let file = file(id) else { return nil }
        set(.findingSpeakers, of: id, to: .running(nil))
        log.write("👥 Finding speakers…")
        do {
            guard transcript.lines.contains(where: { $0.channel == .others }) else {
                log.write("✅ Speakers: 0 (no one spoke on the call side)")
                set(.findingSpeakers, of: id, to: .done("No one else spoke"))
                return nil
            }
            if !SpeakerModels.installed {
                set(.findingSpeakers, of: id, to: .running("Downloading the speaker models"))
                try await speakerModels.prepare()
                set(.findingSpeakers, of: id, to: .running(nil))
            }
            let started = Date()
            let voices = try await Speakers.voices(in: file.workingAudio.appendingPathComponent(AudioRecorder.callFile)) { [weak self] done in
                Task { @MainActor in
                    guard self?.progress[id]?.first(where: { $0.step == .findingSpeakers })?.isFinished == false else { return }
                    self?.set(.findingSpeakers, of: id, to: .running(done.formatted(.percent.precision(.fractionLength(0)))))
                }
            }
            let (labelled, count) = Speakers.label(transcript, voices: voices)
            if count > 1 {
                let people = [names(.me, nil)] + (1...count).map { names(.others, $0) }
                try writeTranscript(labelled, names: names, participants: people, of: id)
            }
            let took = String(format: "%.1f", Date().timeIntervalSince(started))
            log.write("✅ Speakers: \(count) (\(took) s, \(voices.count) stretches of speech)")
            set(.findingSpeakers, of: id, to: .done(count > 1 ? "\(count) people on the call" : "One person on the call"))
            return labelled
        } catch {
            // System errors end with a full stop of their own.
            let reason = error.localizedDescription.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
            log.write("⚠︎ Couldn't tell speakers apart: \(reason) — the transcript is kept as it was")
            set(.findingSpeakers, of: id, to: .failed("\(reason). The transcript is kept as it was."))
            return nil
        }
    }

    private func waitForSecondPass() async {
        guard secondPassRunning else { secondPassRunning = true; return }
        await withCheckedContinuation { secondPassQueue.append($0) }
    }

    private func secondPassFinished() {
        if secondPassQueue.isEmpty { secondPassRunning = false } else { secondPassQueue.removeFirst().resume() }
    }

    /// Replaces the note's transcript section, and its participants when given.
    private func writeTranscript(_ transcript: CallTranscript, names: (Channel, Int?) -> String,
                                 participants: [String]? = nil, of id: String) throws {
        guard let file = file(id), var text = try? String(contentsOf: file.url, encoding: .utf8),
              let marker = text.range(of: RecordingFile.transcriptMarker)
        else { throw ServiceError("The note was moved or changed") }
        let heading = projects.project(file.projectID)?.lexicon.transcript ?? Lexicon.load("en").transcript
        let section = "\(RecordingFile.transcriptMarker)\n## \(heading)\n\n\(transcript.markdown(names: names))\n"
        text = String(text[..<marker.lowerBound]) + section
        if let participants { text = RecordingFile.setting("participants", to: participants.joined(separator: ", "), in: text) }
        try text.write(to: file.url, atomically: true, encoding: .utf8)
        objectWillChange.send()  // the open note shows the new transcript
    }

    private func has(_ step: NoteStep, _ id: String) -> Bool { progress[id]?.contains { $0.step == step } == true }

    private func set(_ step: NoteStep, of id: String, to state: NoteProgress.State) {
        guard let index = progress[id]?.firstIndex(where: { $0.step == step }) else { return }
        progress[id]?[index].state = state
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

    /// 0:42, 12:05 or 1:02:03.
    nonisolated static func clock(_ seconds: TimeInterval) -> String {
        let seconds = max(0, Int(seconds.rounded()))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// (Re)generates the summary of a saved recording. Without `completion` (Summarize Again) the notes
    /// are ready when it is done; with one, the caller has more to do and calls it.
    func summarize(_ id: String, transcript: String? = nil, completion: (() -> Void)? = nil) {
        guard let file = file(id), !summarizing.contains(id) else { completion?(); return }
        let saved = (try? String(contentsOf: file.url, encoding: .utf8)) ?? ""
        let text = transcript ?? Self.transcriptSection(saved)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { completion?(); return }
        summarizing.insert(id)
        failures[id] = nil
        liveSummary[id] = ""
        set(.writingSummary, of: id, to: .running(nil))
        log.write("✍️ Writing summary…")
        let project = projects.project(file.projectID)
        let lexicon = project?.lexicon ?? Lexicon.load("en")
        let front = RecordingFile.frontMatter(saved)
        let meeting = front["event"].map { MeetingDetails(title: $0, attendees: RecordingFile.list(front["attendees"])) }
        // The labels as the transcript has them: the user first, then the people on the call.
        let people = RecordingFile.participants(front["participants"])
        let prompt = Summarizer.systemPrompt(speaker: people.first ?? preferences.speakerName, others: Array(people.dropFirst()),
                                             unnamed: people.dropFirst().filter(lexicon.isParticipantLabel),
                                             language: lexicon.name, occasion: project?.occasion ?? "",
                                             namesAndTerms: project?.vocabulary ?? "", meeting: meeting)
        summarizers[id] = Summarizer.run(system: prompt, transcript: text, model: preferences.model, onText: { [weak self] partial in
            Task { @MainActor in if self?.summarizing.contains(id) == true { self?.liveSummary[id] = partial } }
        }, completion: { [weak self] result in
            Task { @MainActor in self?.finishSummary(id, result, completion: completion) }
        })
    }

    private func finishSummary(_ id: String, _ result: Result<String, Error>, completion: (() -> Void)?) {
        summarizing.remove(id)
        summarizers[id] = nil
        liveSummary[id] = nil
        guard let file = file(id), let text = try? String(contentsOf: file.url, encoding: .utf8) else { completion?(); return }
        defer {
            if let completion { completion() } else { notesReady(id, self.file(id)?.url ?? file.url, startedAt: file.date) }
        }
        switch result {
        case .failure(let error):
            failures[id] = error.localizedDescription
            set(.writingSummary, of: id, to: .failed(error.localizedDescription))
            log.write("⚠︎ Summary failed: \(error.localizedDescription)")
            try? replacingSummary(in: text, with: "").write(to: file.url, atomically: true, encoding: .utf8)
        case .success(let written):
            set(.writingSummary, of: id, to: .done(nil))
            // Remarks about the transcript break the rule in the prompt; the lexicon says how they read.
            let lexicon = projects.project(file.projectID)?.lexicon ?? Lexicon.load("en")
            let (cleaned, dropped) = Summarizer.droppingTranscriptRemarks(written, words: lexicon.transcriptRemarks)
            for remark in dropped { log.write("🧽 Dropped a remark about the transcript from the summary: \(remark)") }
            // Names the summary found for the people on the call become suggestions on the note's page.
            let front = RecordingFile.frontMatter(text)
            let labels = RecordingFile.participants(front["participants"]).dropFirst().filter(lexicon.isParticipantLabel)
            let (summary, suggested) = Summarizer.nameSuggestions(in: cleaned, for: labels)
            for (label, name) in suggested.sorted(by: { $0.key < $1.key }) { log.write("💡 Suggested name: \(label) → \(name)") }
            // A calendar call keeps the event's title; other calls take the summary's.
            let title = front["event"] == nil ? Self.title(of: summary) ?? file.title : file.title
            var updated = replacingSummary(in: text, with: Self.withoutTitle(summary))
            updated = RecordingFile.setting("suggestions", to: suggested.isEmpty ? nil : RecordingFile.names(suggested), in: updated)
            do {
                try write(updated, to: file, title: title)
            } catch {
                failures[id] = error.localizedDescription
                set(.writingSummary, of: id, to: .failed(error.localizedDescription))
            }
        }
        reload()
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

    /// Renames a person throughout a note — its transcript, summary, title and participants — and
    /// drops the name suggested for them. Calendar facts (the event, who was invited) stay as they were.
    func rename(speaker old: String, to name: String, in id: String) {
        // Commas would split the participants, asterisks the transcript's speaker lines.
        let new = name.components(separatedBy: CharacterSet(charactersIn: ",*\n")).joined().trimmingCharacters(in: .whitespaces)
        guard let file = file(id), !new.isEmpty, new != old, !isProcessing(id),
              let text = try? String(contentsOf: file.url, encoding: .utf8),
              text.hasPrefix("---\n"), let end = text.range(of: "\n---\n", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return }
        let front = RecordingFile.frontMatter(text)
        var updated = String(text[..<end.upperBound]) + Self.replacingName(old, with: new, in: String(text[end.upperBound...]))
        // Two labels that turn out to be one person become one participant.
        var people: [String] = []
        for person in RecordingFile.participants(front["participants"]).map({ $0 == old ? new : $0 }) where !people.contains(person) {
            people.append(person)
        }
        updated = RecordingFile.setting("participants", to: people.joined(separator: ", "), in: updated)
        var suggestions = RecordingFile.names(front["suggestions"])
        suggestions[old] = nil
        updated = RecordingFile.setting("suggestions", to: suggestions.isEmpty ? nil : RecordingFile.names(suggestions), in: updated)
        do {
            try write(updated, to: file, title: Self.replacingName(old, with: new, in: file.title))
            log.write("✏️ Renamed “\(old)” to “\(new)” in \(file.title)")
        } catch {
            NSAlert(error: error).runModal()
        }
        reload()
    }

    /// Leaves a name suggestion unused.
    func dismissSuggestion(for label: String, in id: String) {
        guard let file = file(id), var text = try? String(contentsOf: file.url, encoding: .utf8) else { return }
        var suggestions = file.suggestions
        suggestions[label] = nil
        text = RecordingFile.setting("suggestions", to: suggestions.isEmpty ? nil : RecordingFile.names(suggestions), in: text)
        try? text.write(to: file.url, atomically: true, encoding: .utf8)
        reload()
    }

    /// Every whole-word `old` in `text` (not part of a longer word or number: «Учасник 1» isn't «Учасник 12»).
    private static func replacingName(_ old: String, with new: String, in text: String) -> String {
        var result = "", rest = text[...]
        while let found = rest.range(of: old) {
            let before = found.lowerBound > text.startIndex ? text[text.index(before: found.lowerBound)] : " "
            let after = found.upperBound < text.endIndex ? text[found.upperBound] : " "
            let whole = !(before.isLetter || before.isNumber) && !(after.isLetter || after.isNumber)
            result += rest[..<found.lowerBound] + (whole ? new : old)
            rest = rest[found.upperBound...]
        }
        return result + rest
    }

    /// Moves the note and its audio to the Trash; working audio, if it is still being processed, is deleted.
    func moveToTrash(_ id: String) {
        guard let file = file(id) else { return }
        summarizers[id]?.terminate()
        secondPasses[id]?.terminate()
        progress[id] = nil
        try? FileManager.default.removeItem(at: file.workingAudio)
        NSWorkspace.shared.recycle([file.url] + (file.audio.map { [$0] } ?? [])) { [weak self] _, _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func cancelAll() {
        summarizers.values.forEach { $0.terminate() }
        secondPasses.values.forEach { $0.terminate() }
    }

    // MARK: Markdown surgery

    /// Everything between the H1 title and the transcript marker is the summary.
    private func replacingSummary(in text: String, with summary: String) -> String {
        guard let titleRange = text.range(of: "\n# "),
              let titleEnd = text[titleRange.upperBound...].firstIndex(of: "\n"),
              let marker = text.range(of: RecordingFile.transcriptMarker)
        else { return text }
        let body = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text[..<titleEnd]) + "\n\n" + (body.isEmpty ? "" : body + "\n\n") + String(text[marker.lowerBound...])
    }

    private static func transcriptSection(_ text: String) -> String {
        guard let marker = text.range(of: RecordingFile.transcriptMarker) else { return text }
        return String(text[marker.upperBound...])
    }

    private static func title(of summary: String) -> String? {
        summary.split(separator: "\n").first { $0.hasPrefix("# ") }
            .map { $0.dropFirst(2).trimmingCharacters(in: .whitespaces) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func withoutTitle(_ summary: String) -> String {
        summary.split(separator: "\n", omittingEmptySubsequences: false)
            .drop { $0.trimmingCharacters(in: .whitespaces).isEmpty || $0.hasPrefix("# ") }
            .joined(separator: "\n")
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

/// One-shot `claude -p` run that turns a transcript into meeting notes.
enum Summarizer {
    /// `others` are the transcript's labels for the people on the call (one label for all of them
    /// unless their voices were told apart), and `unnamed` those of them that are labels rather than
    /// names: the summary may suggest who they are. `namesAndTerms` and `occasion` come from the
    /// note's project, `meeting` from the calendar event it was recorded for.
    static func systemPrompt(speaker: String, others: [String] = [], unnamed: [String] = [], language: String,
                             occasion: String, namesAndTerms: String = "", meeting: MeetingDetails? = nil) -> String {
        let name = speaker.isEmpty ? "the user" : speaker
        let terms = namesAndTerms.trimmingCharacters(in: .whitespacesAndNewlines)
        let event = meeting.map { meeting in
            let invited = meeting.attendees.isEmpty ? "" : " Invited: \(meeting.attendees.joined(separator: ", "))."
            return "\n\nThe call was the calendar event “\(meeting.title)”.\(invited) The transcript doesn't say which of them is speaking: use a name only where the conversation makes it clear (for example, someone is addressed by name)."
        } ?? ""
        let labels = { (names: [String]) in
            let listed = names.map { "[\($0)]" }
            return listed.count > 1 ? listed.dropLast().joined(separator: ", ") + " and " + listed.last! : listed.joined()
        }
        let people = others.count > 1
            ? "\(labels(others)) are the other people on the call, told apart by their voices (now and then a line may go to the wrong one)"
            : "the other label is everyone else, possibly several people"
        let example = unnamed.first ?? "Participant 1"
        let naming = unnamed.isEmpty ? "" : """


        Where the conversation shows who \(labels(unnamed)) \(unnamed.count > 1 ? "are" : "is") — someone is addressed by name («Дякую, Олено»), introduces themselves, or can only be one of the people invited — add one line per person at the very end, after everything else: <!-- speaker: \(example) = Olena Mulesa --> (the label exactly as in the transcript, then their full name as best you know it, for example from the invited list). Leave the line out when unsure. In the notes, write such a label as it is in the transcript, without brackets and without inflecting it, so it can be replaced with the name later.
        """
        return """
        You turn call transcripts into concise meeting notes in Markdown.

        The transcript comes from automatic speech recognition. [\(name)] is the person who recorded the call; \(people). Fix obvious recognition errors from context, but never invent facts, names, numbers or commitments.

        Write about the conversation only, never about the transcript: no notes, anywhere, about the transcript, the recording or speech recognition — not in parentheses, not as caveats or footnotes. Where a word was misheard, write the right word as if it had been heard correctly; where something can't be made out, leave it out. For example, never write «Надіслати звіт до п'ятниці (у транскрипті — „дотатниці“, ймовірно, мається на увазі „до п'ятниці“)» — write «Надіслати звіт до п'ятниці».

        Write everything in the language of the conversation (usually \(language)). The headings below are in English only to show the structure: write them in the conversation's language too.

        Output exactly this structure and nothing before or after it\(unnamed.isEmpty ? "" : " (except the lines naming people, described at the end)"):

        # A title of at most 8 words

        ## Summary
        Three to five sentences: what the call was about and how it ended.

        ## Key points
        - One line each.

        ## Decisions
        - Only if decisions were made; otherwise leave the section out.

        ## Action items
        - [ ] Owner: task (deadline if one was mentioned). Leave the section out if there are none.

        ## Questions and answers
        - **Question:** … — **Answer:** the gist of how it was answered. Only if questions were asked.

        ## Open questions
        - Only if something was left unresolved.

        Context the user gave about their current talk (it may not apply to this call): \(occasion.isEmpty ? "none" : occasion)\(terms.isEmpty ? "" : "\n\nNames and terms that may come up, spelled the way the user writes them: \(terms)")\(event)\(naming)
        """
    }

    /// The names the summary suggests for the people on the call, as `<!-- speaker: LABEL = NAME -->`
    /// lines (see the prompt), for those of `labels`; returns the summary without them, or any other
    /// comment line (half a line, while it streams in).
    static func nameSuggestions(in summary: String, for labels: [String]) -> (text: String, names: [String: String]) {
        var names: [String: String] = [:]
        let lines = summary.components(separatedBy: "\n").filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("<!--") else { return true }
            if let match = trimmed.firstMatch(of: #/^<!--\s*speaker:\s*(.+?)\s*=\s*(.+?)\s*-->$/#),
               labels.contains(String(match.1)), String(match.2) != String(match.1) {
                names[String(match.1)] = String(match.2).replacingOccurrences(of: ",", with: "")
            }
            return false
        }
        return (lines.joined(separator: "\n"), names)
    }

    /// The safety net for the rule above: drops parenthetical remarks that mention the transcript or
    /// recognition (`words`, from the lexicon), as in «до п'ятниці (у транскрипті — „дотатниці“)».
    /// Returns the summary and the remarks dropped.
    static func droppingTranscriptRemarks(_ summary: String, words: [String]) -> (text: String, dropped: [String]) {
        guard !words.isEmpty else { return (summary, []) }
        var dropped: [String] = []
        var lines: [String] = []
        for line in summary.components(separatedBy: "\n") {
            var characters = Array(line)
            var index = 0, changed = false
            while index < characters.count {
                // A parenthesis right after `]` is a link's address.
                guard characters[index] == "(", index == 0 || characters[index - 1] != "]",
                      let close = closingParenthesis(in: characters, from: index),
                      mentions(String(characters[index + 1..<close]), words)
                else { index += 1; continue }
                dropped.append(String(characters[index...close]))
                var start = index, end = close + 1
                // An italic remark, `_(…)_`, goes with its markers.
                if start > 0, end < characters.count, "_*".contains(characters[start - 1]), characters[end] == characters[start - 1] {
                    start -= 1
                    end += 1
                }
                while start > 0, characters[start - 1] == " " { start -= 1 }
                if start == 0 { while end < characters.count, characters[end] == " " { end += 1 } }
                characters.removeSubrange(start..<end)
                changed = true
                index = start
            }
            let cleaned = String(characters)
            // A list item or quote that was nothing but the remark goes altogether.
            if changed, ["", "-", "*", "+", ">", "- [ ]", "- [x]"].contains(cleaned.trimmingCharacters(in: .whitespaces)) { continue }
            lines.append(cleaned)
        }
        return (lines.joined(separator: "\n"), dropped)
    }

    private static func closingParenthesis(in characters: [Character], from open: Int) -> Int? {
        var depth = 0
        for index in open..<characters.count {
            if characters[index] == "(" { depth += 1 }
            if characters[index] == ")" { depth -= 1 }
            if depth == 0 { return index }
        }
        return nil
    }

    /// Whether the text has one of the words, at the start of a word ("транскрипт" in «транскрипті»).
    private static func mentions(_ text: String, _ words: [String]) -> Bool {
        words.contains { word in
            var range = text.startIndex..<text.endIndex
            while let found = text.range(of: word, options: [.caseInsensitive], range: range) {
                if found.lowerBound == text.startIndex || !text[text.index(before: found.lowerBound)].isLetter { return true }
                range = found.upperBound..<text.endIndex
            }
            return false
        }
    }

    /// Streams the growing summary through `onText`; returns the process so it can be cancelled.
    @discardableResult
    static func run(system: String, transcript: String, model: ClaudeService.Model,
                    onText: @escaping (String) -> Void,
                    completion: @escaping (Result<String, Error>) -> Void) -> Process? {
        guard let binary = ClaudeService.findBinary() else {
            completion(.failure(ServiceError("Claude Code not found")))
            return nil
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.currentDirectoryURL = appSupport.appendingPathComponent("run")
        // From a file: arguments would reach Claude with «й» and «ї» decomposed (see `SecondPass.spawn`).
        let systemFile = process.currentDirectoryURL!.appendingPathComponent("summary-\(UUID().uuidString).md")
        process.arguments = [
            "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--model", model.rawValue, "--system-prompt-file", systemFile.path,
            "--tools", "", "--strict-mcp-config", "--setting-sources", "",
            "--disable-slash-commands", "--no-session-persistence",
        ]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try FileManager.default.createDirectory(at: process.currentDirectoryURL!, withIntermediateDirectories: true)
            try system.write(to: systemFile, atomically: true, encoding: .utf8)
            try process.run()
        } catch {
            try? FileManager.default.removeItem(at: systemFile)
            completion(.failure(error))
            return nil
        }
        DispatchQueue.global().async {
            try? input.fileHandleForWriting.write(contentsOf: Data(("Transcript:\n\n" + transcript).utf8))
            try? input.fileHandleForWriting.close()
        }
        DispatchQueue.global().async {
            var text = "", buffer = Data(), finished = false
            let handle = output.fileHandleForReading
            while case let chunk = handle.availableData, !chunk.isEmpty {
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    if event["type"] as? String == "stream_event",
                       let inner = event["event"] as? [String: Any],
                       let delta = inner["delta"] as? [String: Any],
                       delta["type"] as? String == "text_delta",
                       let piece = delta["text"] as? String {
                        text += piece
                        onText(text)
                    } else if event["type"] as? String == "result" {
                        finished = true
                        if event["is_error"] as? Bool == true {
                            completion(.failure(ServiceError(event["result"] as? String ?? "Claude couldn't summarize the call")))
                        } else {
                            completion(.success((event["result"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? text))
                        }
                    }
                }
            }
            process.waitUntilExit()
            try? FileManager.default.removeItem(at: systemFile)
            if !finished {
                completion(.failure(ServiceError(process.terminationReason == .uncaughtSignal ? "Summary cancelled" : "Claude stopped before finishing")))
            }
        }
        return process
    }
}
