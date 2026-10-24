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

    func start() {
        lines = []
        endedAt = nil
        stopping = false
        startedAt = Date()
    }

    func add(_ utterance: Utterance) {
        guard let startedAt, utterance.time >= startedAt, utterance.started < (endedAt ?? .distantFuture) else { return }
        lines.append(utterance)
    }

    func beginStop() {
        endedAt = Date()
        stopping = true
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
    let id: String          // start time; stays the same when the title (and file name) changes
    let title: String
    let date: Date
    let duration: String

    static let transcriptMarker = "<!-- transcript -->"

    static func load(_ url: URL) -> RecordingFile? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let front = frontMatter(text)
        guard let id = front["date"], let date = ISO8601DateFormatter().date(from: id) else { return nil }
        return RecordingFile(url: url, id: id, title: front["title"] ?? url.deletingPathExtension().lastPathComponent,
                             date: date, duration: front["duration"] ?? "")
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

/// Saves recordings as Markdown in the user's folder and keeps them listed.
@MainActor
final class RecordingStore: ObservableObject {
    @Published private(set) var files: [RecordingFile] = []
    /// Summary text streaming in, by recording id.
    @Published private(set) var liveSummary: [String: String] = [:]
    @Published private(set) var summarizing: Set<String> = []
    @Published private(set) var failures: [String: String] = [:]

    private let profile: Profile
    private var summarizers: [String: Process] = [:]

    init(profile: Profile) {
        self.profile = profile
    }

    var folder: URL { profile.recordingsFolder }

    func reload() {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        files = urls.filter { $0.pathExtension == "md" }
            .compactMap(RecordingFile.load)
            .sorted { $0.date > $1.date }
    }

    func file(_ id: String) -> RecordingFile? { files.first { $0.id == id } }

    func contents(_ id: String) -> String {
        guard let file = file(id), var text = try? String(contentsOf: file.url, encoding: .utf8) else { return "" }
        if let live = liveSummary[id] {
            text = replacingSummary(in: text, with: Self.withoutTitle(live))
        }
        return text
    }

    /// Writes the transcript right away so nothing is lost, then summarizes it.
    func save(_ transcript: CallTranscript) -> String? {
        let lexicon = profile.lexicon
        let speaker = profile.speakerName.isEmpty ? "You" : profile.speakerName
        let names: (Channel) -> String = { $0 == .me ? speaker : lexicon.participant }
        let id = ISO8601DateFormatter().string(from: transcript.startedAt)
        let title = "Call " + transcript.startedAt.formatted(date: .abbreviated, time: .shortened)
        let duration = Duration.seconds(transcript.endedAt.timeIntervalSince(transcript.startedAt))
            .formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, zeroValueUnits: .hide))
        let summarize = profile.summarizeRecordings
        let document = """
        ---
        title: "\(title)"
        date: \(id)
        duration: \(duration.isEmpty ? "<1 min" : duration)
        participants: \(speaker), \(lexicon.participant)
        ---

        # \(title)

        \(summarize ? "_…_" : "")

        \(RecordingFile.transcriptMarker)
        ## \(lexicon.transcript)

        \(transcript.markdown(names: names))

        """
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(fileName(date: transcript.startedAt, title: "Call"))
            try document.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            NSAlert(error: error).runModal()
            return nil
        }
        reload()
        if summarize { self.summarize(id, transcript: transcript.plainText(names: names)) }
        return id
    }

    /// (Re)generates the summary of a saved recording.
    func summarize(_ id: String, transcript: String? = nil) {
        guard let file = file(id), !summarizing.contains(id) else { return }
        let text = transcript ?? (try? String(contentsOf: file.url, encoding: .utf8)).map(Self.transcriptSection) ?? ""
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        summarizing.insert(id)
        failures[id] = nil
        liveSummary[id] = ""
        let prompt = Summarizer.systemPrompt(speaker: profile.speakerName, language: profile.lexicon.name, occasion: profile.occasion)
        summarizers[id] = Summarizer.run(system: prompt, transcript: text, model: profile.model, onText: { [weak self] partial in
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
        switch result {
        case .failure(let error):
            failures[id] = error.localizedDescription
            try? replacingSummary(in: text, with: "").write(to: file.url, atomically: true, encoding: .utf8)
        case .success(let summary):
            let title = Self.title(of: summary) ?? file.title
            var updated = replacingSummary(in: text, with: Self.withoutTitle(summary))
            updated = updated.replacingOccurrences(of: "title: \"\(file.title.replacingOccurrences(of: "\"", with: "\\\""))\"",
                                                   with: "title: \"\(title.replacingOccurrences(of: "\"", with: "\\\""))\"")
            updated = updated.replacingOccurrences(of: "\n# \(file.title)\n", with: "\n# \(title)\n")
            let renamed = folder.appendingPathComponent(fileName(date: file.date, title: title))
            do {
                try updated.write(to: file.url, atomically: true, encoding: .utf8)
                if renamed != file.url, !FileManager.default.fileExists(atPath: renamed.path) {
                    try FileManager.default.moveItem(at: file.url, to: renamed)
                }
            } catch {
                failures[id] = error.localizedDescription
            }
        }
        reload()
    }

    func moveToTrash(_ id: String) {
        guard let file = file(id) else { return }
        summarizers[id]?.terminate()
        NSWorkspace.shared.recycle([file.url]) { [weak self] _, _ in
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
    private func fileName(date: Date, title: String) -> String {
        let safe = title.components(separatedBy: CharacterSet(charactersIn: "/:\\\n")).joined(separator: "-").prefix(80)
        return "\(Self.stampFormat.string(from: date)) – \(safe).md"
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
