import Foundation

/// A note as Markdown: the copy Cue keeps in the project's `Notes` folder (YAML front matter, the title, the summary, and the transcript after
/// an HTML comment marker), written from the account's note and, for the notes a Mac had before it had an account, read back into one.
enum NoteMarkdown {
    /// 0:42 → "1 min"; under a minute "<1 min". The locale's abbreviations ("1 hr, 5 min").
    static func duration(_ seconds: TimeInterval) -> String {
        let text = Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, zeroValueUnits: .hide))
        return text.isEmpty ? "<1 min" : text
    }

    /// 00:12:05, the way a transcript turn starts.
    static func offset(_ seconds: TimeInterval) -> String {
        let seconds = max(0, Int(seconds))
        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }

    static func stamp(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    /// The file's text for `note`. `stamp` is the note's `date:` (kept as it was written), `audio` the file name of the local audio next to
    /// it, `audioOnline` that the account still has the audio and the player may stream it. `keepingTranscriptOf` is the file's text when the
    /// note has no transcript of its own (the live transcript this Mac saved is the better one then).
    static func render(_ note: RemoteNote, project: String, stamp: String, audio: String?, audioOnline: Bool,
                       keepingTranscriptOf existing: String? = nil) -> String {
        var front = [
            "title: \(RecordingFile.quoted(note.title))",
            "date: \(stamp)",
            "duration: \(duration(note.durationSeconds))",
            "participants: \(note.participants.joined(separator: ", "))",
            "project: \(RecordingFile.quoted(project))",
        ]
        if let meeting = note.meeting {
            front.append("event: \(RecordingFile.quoted(meeting.title))")
            front.append("attendees: \(RecordingFile.list(meeting.attendees))")
        }
        if let audio {
            front.append("audio: \(RecordingFile.quoted(audio))")
        } else if audioOnline {
            front.append("audio-online: yes")
        }
        if !note.suggestions.isEmpty { front.append("suggestions: \(RecordingFile.names(note.suggestions))") }
        front.append("note: \(note.id)")

        let summary = note.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        var transcript = "\(RecordingFile.transcriptMarker)\n## \(note.transcriptHeading)\n\n"
            + note.transcript.map { "**\(offset($0.start)) · \($0.label)**\n\($0.text)" }.joined(separator: "\n\n") + "\n"
        if note.transcript.isEmpty, let existing, let marker = existing.range(of: RecordingFile.transcriptMarker) {
            transcript = String(existing[marker.lowerBound...])
        }
        return "---\n" + front.joined(separator: "\n") + "\n---\n\n# \(note.title)\n\n" + (summary.isEmpty ? "" : summary + "\n\n") + transcript
    }

    /// The account's note for a file of the library that was written before there was one: its front matter, summary and transcript taken
    /// apart. Nil when the file isn't a note Cue wrote.
    static func importBody(from text: String, project: Project, stamp: String) -> NoteImportBody? {
        let front = RecordingFile.frontMatter(text)
        guard let title = front["title"], let date = ISO8601DateFormatter().date(from: stamp), let serverID = project.serverID,
              text.hasPrefix("---\n"), let end = text.range(of: "\n---\n", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return nil }
        let body = String(text[end.upperBound...])
        let marker = body.range(of: RecordingFile.transcriptMarker)
        let head = marker.map { String(body[..<$0.lowerBound]) } ?? body
        let tail = marker.map { String(body[$0.upperBound...]) } ?? ""

        // The summary is everything between the H1 title and the transcript.
        var summaryLines = head.components(separatedBy: "\n")
        if let heading = summaryLines.firstIndex(where: { $0.hasPrefix("# ") }) { summaryLines.removeSubrange(...heading) }
        var summary = summaryLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if summary == "_…_" { summary = "" }

        let participants = RecordingFile.participants(front["participants"])
        let speaker = participants.first ?? "You"
        var heading = project.lexicon.transcript
        var turns: [RemoteTurn] = []
        var current: (start: Double, label: String, lines: [String])?
        func flush() {
            guard let turn = current else { return }
            current = nil
            let label = turn.label
            let isMe = label == speaker
            let number = label.firstMatch(of: #/ (\d+)$/#).flatMap { Int($0.1) }
            turns.append(RemoteTurn(channel: isMe ? "me" : "others", speaker: isMe ? nil : number, label: label, start: turn.start,
                                    text: turn.lines.joined(separator: " ")))
        }
        for line in tail.components(separatedBy: "\n") {
            if let match = line.firstMatch(of: #/^\*\*(\d+):(\d{2}):(\d{2}) · (.+)\*\*$/#) {
                flush()
                let hours: Double = Double(match.1) ?? 0
                let minutes: Double = Double(match.2) ?? 0
                let secs: Double = Double(match.3) ?? 0
                let seconds: Double = hours * 3600 + minutes * 60 + secs
                current = (seconds, String(match.4), [])
            } else if current != nil {
                if line.trimmingCharacters(in: .whitespaces).isEmpty { flush() } else { current?.lines.append(line) }
            } else if line.hasPrefix("## ") {
                heading = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }
        }
        flush()

        let meeting = front["event"].map { RemoteMeeting(title: $0, attendees: RecordingFile.list(front["attendees"])) }
        return NoteImportBody(stamp: stamp, projectId: serverID, title: title, startedAt: Int64(date.timeIntervalSince1970 * 1000),
                              durationSeconds: seconds(of: front["duration"]) ?? turns.last?.start ?? 0, language: project.language,
                              speaker: speaker, meeting: meeting, participants: participants.isEmpty ? [speaker] : participants,
                              summary: summary, transcriptHeading: heading, transcript: turns,
                              suggestions: RecordingFile.names(front["suggestions"]))
    }

    /// "1 hr, 5 min", "12 min", "<1 min" read back (the units begin with h or г for hours, m or х for minutes); nil when there is nothing to read.
    private static func seconds(of duration: String?) -> TimeInterval? {
        guard let duration, !duration.isEmpty else { return nil }
        if duration.hasPrefix("<") { return 30 }
        var total: TimeInterval = 0
        var found = false
        for match in duration.matches(of: #/(\d+)\s*(\p{L})/#) {
            guard let number = Double(match.1) else { continue }
            switch match.2.lowercased() {
            case "h", "г": total += number * 3600
            case "m", "х": total += number * 60
            default: continue
            }
            found = true
        }
        return found ? total : nil
    }
}
