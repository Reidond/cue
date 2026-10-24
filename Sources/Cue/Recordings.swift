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

    /// Consecutive lines from the same side with short pauses become one paragraph.
    private var turns: [(channel: Channel, started: Date, text: String)] {
        var turns: [(channel: Channel, started: Date, ended: Date, text: String)] = []
        for line in lines {
            if let last = turns.last, last.channel == line.channel, line.started.timeIntervalSince(last.ended) < 4 {
                turns[turns.count - 1].text += " " + line.text
                turns[turns.count - 1].ended = line.time
            } else {
                turns.append((line.channel, line.started, line.time, line.text))
            }
        }
        return turns.map { ($0.channel, $0.started, $0.text) }
    }

    private func offset(_ date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(startedAt)))
        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }

    func markdown(names: (Channel) -> String) -> String {
        turns.map { "**\(offset($0.started)) · \(names($0.channel))**\n\($0.text)" }.joined(separator: "\n\n")
    }

    func plainText(names: (Channel) -> String) -> String {
        turns.map { "[\(offset($0.started))] [\(names($0.channel))] \($0.text)" }.joined(separator: "\n")
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
                             audio: audio.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil })
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

/// Saves recordings as Markdown in each project's `Notes/` and keeps them listed, newest first.
@MainActor
final class RecordingStore: ObservableObject {
    @Published private(set) var files: [RecordingFile] = []
    /// Summary text streaming in, by recording id.
    @Published private(set) var liveSummary: [String: String] = [:]
    @Published private(set) var summarizing: Set<String> = []
    @Published private(set) var failures: [String: String] = [:]

    private let preferences: Preferences
    private let projects: ProjectStore
    private let log: SessionLog
    private var summarizers: [String: Process] = [:]

    init(preferences: Preferences, projects: ProjectStore, log: SessionLog) {
        self.preferences = preferences
        self.projects = projects
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
            text = replacingSummary(in: text, with: Self.withoutTitle(live))
        }
        return text
    }

    /// Writes the transcript into the project's notes right away so nothing is lost, puts the call's
    /// audio next to it (with Keep audio on), then summarizes it.
    func save(_ transcript: CallTranscript, into project: Project, audio: AudioRecorder.Recording? = nil) -> String? {
        let lexicon = project.lexicon
        let speaker = preferences.speakerName.isEmpty ? "You" : preferences.speakerName
        let names: (Channel) -> String = { $0 == .me ? speaker : lexicon.participant }
        let stamp = ISO8601DateFormatter().string(from: transcript.startedAt)
        let id = RecordingFile.id(project: project.id, stamp: stamp)
        let title = "Call " + transcript.startedAt.formatted(date: .abbreviated, time: .shortened)
        let duration = Duration.seconds(transcript.endedAt.timeIntervalSince(transcript.startedAt))
            .formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, zeroValueUnits: .hide))
        let summarize = preferences.summarizeRecordings
        let folder = project.notesFolder
        let url = folder.appendingPathComponent(Self.fileName(date: transcript.startedAt, title: "Call"))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            NSAlert(error: error).runModal()
            return nil
        }

        // The mixed audio goes next to the note, under the same name; the working copies stay for processing.
        var audioFile: URL?
        if let mixed = audio?.mixed, preferences.keepAudio {
            let target = url.deletingPathExtension().appendingPathExtension("m4a")
            do {
                if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
                try FileManager.default.moveItem(at: mixed, to: target)
                audioFile = target
            } catch {
                log.write("⚠︎ Couldn't save the audio: \(error.localizedDescription)")
            }
        } else if let mixed = audio?.mixed {
            try? FileManager.default.removeItem(at: mixed)
        }

        let document = """
        ---
        title: "\(title)"
        date: \(stamp)
        duration: \(duration.isEmpty ? "<1 min" : duration)
        participants: \(speaker), \(lexicon.participant)
        project: \(RecordingFile.quoted(project.name))\(audioFile.map { "\naudio: \(RecordingFile.quoted($0.lastPathComponent))" } ?? "")
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
        reload()
        if summarize {
            self.summarize(id, transcript: transcript.plainText(names: names))
        } else {
            notesReady(url, startedAt: transcript.startedAt)
        }
        return id
    }

    /// The last step a new note goes through: its working audio is no longer needed.
    private func notesReady(_ url: URL, startedAt: Date) {
        // Tests and the session log both wait for "Notes ready".
        log.write("📝 Notes ready: \(url.path)")
        let working = AudioRecorder.workingFolder(startedAt: startedAt)
        if FileManager.default.fileExists(atPath: working.path), (try? FileManager.default.removeItem(at: working)) != nil {
            log.write("🧹 Working audio removed: \(working.path)")
        }
    }

    /// 0:42, 12:05 or 1:02:03.
    nonisolated static func clock(_ seconds: TimeInterval) -> String {
        let seconds = max(0, Int(seconds.rounded()))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// (Re)generates the summary of a saved recording.
    func summarize(_ id: String, transcript: String? = nil) {
        guard let file = file(id), !summarizing.contains(id) else { return }
        let text = transcript ?? (try? String(contentsOf: file.url, encoding: .utf8)).map(Self.transcriptSection) ?? ""
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        summarizing.insert(id)
        failures[id] = nil
        liveSummary[id] = ""
        let project = projects.project(file.projectID)
        let prompt = Summarizer.systemPrompt(speaker: preferences.speakerName, language: (project?.lexicon ?? Lexicon.load("en")).name,
                                             occasion: project?.occasion ?? "")
        summarizers[id] = Summarizer.run(system: prompt, transcript: text, model: preferences.model, onText: { [weak self] partial in
            Task { @MainActor in if self?.summarizing.contains(id) == true { self?.liveSummary[id] = partial } }
        }, completion: { [weak self] result in
            Task { @MainActor in self?.finishSummary(id, result) }
        })
    }

    private func finishSummary(_ id: String, _ result: Result<String, Error>) {
        summarizing.remove(id)
        summarizers[id] = nil
        liveSummary[id] = nil
        guard let file = file(id), let text = try? String(contentsOf: file.url, encoding: .utf8) else { return }
        defer { notesReady(self.file(id)?.url ?? file.url, startedAt: file.date) }
        switch result {
        case .failure(let error):
            failures[id] = error.localizedDescription
            log.write("⚠︎ Summary failed: \(error.localizedDescription)")
            try? replacingSummary(in: text, with: "").write(to: file.url, atomically: true, encoding: .utf8)
        case .success(let summary):
            let title = Self.title(of: summary) ?? file.title
            var updated = replacingSummary(in: text, with: Self.withoutTitle(summary))
            updated = updated.replacingOccurrences(of: "title: \"\(file.title.replacingOccurrences(of: "\"", with: "\\\""))\"",
                                                   with: "title: \"\(title.replacingOccurrences(of: "\"", with: "\\\""))\"")
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
            do {
                try updated.write(to: file.url, atomically: true, encoding: .utf8)
                if rename { try FileManager.default.moveItem(at: file.url, to: renamed) }
            } catch {
                failures[id] = error.localizedDescription
            }
        }
        reload()
    }

    /// Moves the note and its audio to the Trash; working audio, if it is still being processed, is deleted.
    func moveToTrash(_ id: String) {
        guard let file = file(id) else { return }
        summarizers[id]?.terminate()
        try? FileManager.default.removeItem(at: file.workingAudio)
        NSWorkspace.shared.recycle([file.url] + (file.audio.map { [$0] } ?? [])) { [weak self] _, _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func cancelAll() {
        summarizers.values.forEach { $0.terminate() }
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
    static func systemPrompt(speaker: String, language: String, occasion: String) -> String {
        let name = speaker.isEmpty ? "the user" : speaker
        return """
        You turn call transcripts into concise meeting notes in Markdown.

        The transcript comes from automatic speech recognition. [\(name)] is the person who recorded the call; the other label is everyone else, possibly several people. Fix obvious recognition errors from context, but never invent facts, names, numbers or commitments, and don't comment on the transcript's quality.

        Write everything in the language of the conversation (usually \(language)). The headings below are in English only to show the structure: write them in the conversation's language too.

        Output exactly this structure and nothing before or after it:

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

        Context the user gave about their current talk (it may not apply to this call): \(occasion.isEmpty ? "none" : occasion)
        """
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
        process.arguments = [
            "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--model", model.rawValue, "--system-prompt", system,
            "--tools", "", "--strict-mcp-config", "--setting-sources", "",
            "--disable-slash-commands", "--no-session-persistence",
        ]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try FileManager.default.createDirectory(at: process.currentDirectoryURL!, withIntermediateDirectories: true)
            try process.run()
        } catch {
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
            if !finished {
                completion(.failure(ServiceError(process.terminationReason == .uncaughtSignal ? "Summary cancelled" : "Claude stopped before finishing")))
            }
        }
        return process
    }
}
