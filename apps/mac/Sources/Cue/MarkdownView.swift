import SwiftUI

/// Renders the Markdown Cue writes (and what people usually add by hand):
/// front matter, headings, paragraphs, bullet / numbered / task lists, quotes,
/// rules, code blocks and transcript speaker lines. Inline styles come from
/// Foundation's Markdown parser. A translated note's lines' translations sit
/// under them, smaller (`MarkdownDocument` has the other ways to show one).
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    /// Makes the speaker lines' timestamps clickable; called with the offset in seconds.
    var onTimestamp: ((TimeInterval) -> Void)?
    /// Makes the speaker lines' names clickable; called with the name.
    var onSpeaker: ((String) -> Void)?
    /// Shown at the end of the transcript's heading (a translated note's Translations switch).
    var transcriptAccessory: AnyView?

    init(markdown: String, onTimestamp: ((TimeInterval) -> Void)? = nil, onSpeaker: ((String) -> Void)? = nil) {
        self.init(blocks: MarkdownDocument(markdown).blocks, onTimestamp: onTimestamp, onSpeaker: onSpeaker)
    }

    init(blocks: [MarkdownBlock], onTimestamp: ((TimeInterval) -> Void)? = nil, onSpeaker: ((String) -> Void)? = nil,
         transcriptAccessory: AnyView? = nil) {
        self.blocks = blocks
        self.onTimestamp = onTimestamp
        self.onSpeaker = onSpeaker
        self.transcriptAccessory = transcriptAccessory
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                BlockView(block: block, onTimestamp: onTimestamp, onSpeaker: onSpeaker, transcriptAccessory: transcriptAccessory)
                    .padding(.top, index == 0 ? 0 : block.spacingAbove)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(Selectable())
    }

    /// A transcript timestamp in seconds: "00:01:05" or "1:05" → 65.
    static func seconds(_ time: String) -> TimeInterval? {
        let parts = time.split(separator: ":", omittingEmptySubsequences: false).map { Double($0) }
        guard (2...3).contains(parts.count), !parts.contains(nil) else { return nil }
        return parts.reduce(0) { $0 * 60 + $1! }
    }
}

/// Selectable text, except when snapshots are drawn offscreen, which can't draw it.
private struct Selectable: ViewModifier {
    func body(content: Content) -> some View {
        if !Snapshots.drawn {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}

enum MarkdownBlock: Equatable {
    case metadata([(key: String, value: String)])
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet(String, depth: Int)
    case task(String, done: Bool, depth: Int)
    case numbered(Int, String, depth: Int)
    case quote(String)
    case code(String)
    case speaker(time: String, name: String)
    case rule
    /// The `> ` line right under a transcript turn: its translation (or, in the other language, the line as it was said).
    case translated(String)
    /// The transcript's own heading, the first after Cue's `<!-- transcript -->` marker.
    case transcriptHeading(String)
    /// One after another: where the note in the other language begins, under the language's name.
    case languageHeading(language: String, title: String)

    static func == (lhs: MarkdownBlock, rhs: MarkdownBlock) -> Bool { String(describing: lhs) == String(describing: rhs) }

    var spacingAbove: CGFloat {
        switch self {
        case .heading(let level, _): level == 1 ? 6 : 28
        case .transcriptHeading: 28
        case .languageHeading: 36
        case .bullet, .task, .numbered: 6
        case .speaker: 20
        case .translated: 4
        default: 12
        }
    }

    var isTranslation: Bool { if case .translated = self { true } else { false } }
}

struct MarkdownDocument {
    var blocks: [MarkdownBlock] = []
    /// Where the transcript begins in `blocks` (Cue's `<!-- transcript -->` marker); the end when there is none.
    var transcriptStart: Int?
    /// A translated note's title and summary in the other language (`<!-- cue:translation CODE -->` … `<!-- /cue:translation -->`), by its
    /// code. They are not among `blocks`, which are the note in its own language.
    var translation: (language: String, blocks: [MarkdownBlock])?

    init(_ text: String) {
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")[...]

        // YAML front matter shown as a compact metadata row; the title (and the event it is named
        // after) repeats as the H1, the audio has its own player, name suggestions their chips and
        // the translation its switch.
        if lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") {
            let pairs = lines[lines.startIndex + 1..<end].compactMap { line -> (key: String, value: String)? in
                guard let colon = line.firstIndex(of: ":") else { return nil }
                let key = line[..<colon].trimmingCharacters(in: .whitespaces)
                let value = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet.whitespaces.union(["\""]))
                return ["title", "event", "audio", "suggestions", "translation"].contains(key) || value.isEmpty || value == "[]"
                    ? nil : (key, value)
            }
            if !pairs.isEmpty { blocks.append(.metadata(pairs)) }
            lines = lines[(end + 1)...]
        }

        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }

        // In the transcript (after Cue's marker), a `> ` line right under a turn's words is their translation.
        var inTranscript = false
        var transcriptHeaded = false
        var iterator = lines.makeIterator()
        while let raw = iterator.next() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let depth = raw.prefix { $0 == " " }.count / 2

            if line.hasPrefix("```") {
                flush()
                var code: [String] = []
                while let next = iterator.next(), !next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(next) }
                blocks.append(.code(code.joined(separator: "\n")))
            } else if line == RecordingFile.transcriptMarker {
                flush()
                inTranscript = true
                transcriptStart = blocks.count
            } else if let match = line.firstMatch(of: #/^<!-- cue:translation (\S+) -->$/#) {
                flush()
                var inside: [String] = []
                while let next = iterator.next(), next.trimmingCharacters(in: .whitespaces) != RecordingFile.translationEnd { inside.append(next) }
                translation = (language: String(match.1), blocks: MarkdownDocument(inside.joined(separator: "\n")).blocks)
            } else if line.isEmpty || line.hasPrefix("<!--") {
                flush()
            } else if let match = line.firstMatch(of: #/^(#{1,6})\s+(.+)$/#) {
                flush()
                if inTranscript, !transcriptHeaded {
                    transcriptHeaded = true
                    blocks.append(.transcriptHeading(String(match.2)))
                } else {
                    blocks.append(.heading(level: match.1.count, text: String(match.2)))
                }
            } else if inTranscript, !paragraph.isEmpty, case .speaker? = blocks.last, let match = line.firstMatch(of: #/^>\s?(.*)$/#) {
                flush()
                blocks.append(.translated(String(match.1)))
            } else if line == "---" || line == "***" || line == "___" {
                flush()
                blocks.append(.rule)
            } else if let match = line.firstMatch(of: #/^[-*+]\s+\[([ xX])\]\s+(.*)$/#) {
                flush()
                blocks.append(.task(String(match.2), done: match.1 != " ", depth: depth))
            } else if let match = line.firstMatch(of: #/^[-*+]\s+(.*)$/#) {
                flush()
                blocks.append(.bullet(String(match.1), depth: depth))
            } else if let match = line.firstMatch(of: #/^(\d+)[.)]\s+(.*)$/#) {
                flush()
                blocks.append(.numbered(Int(match.1) ?? 1, String(match.2), depth: depth))
            } else if let match = line.firstMatch(of: #/^>\s?(.*)$/#) {
                flush()
                if case .quote(let previous) = blocks.last {
                    blocks[blocks.count - 1] = .quote(previous + " " + match.1)
                } else {
                    blocks.append(.quote(String(match.1)))
                }
            } else if let match = line.firstMatch(of: #/^\*\*(\d{1,2}:\d{2}(?::\d{2})?)\s+·\s+(.+)\*\*$/#) {
                flush()
                blocks.append(.speaker(time: String(match.1), name: String(match.2)))
            } else {
                paragraph.append(line)
            }
        }
        flush()
    }
}

/// The ways a translated note shows its two languages (Settings › General › Languages › Notes).
extension MarkdownDocument {
    private var head: ArraySlice<MarkdownBlock> { blocks[..<(transcriptStart ?? blocks.count)] }
    private var transcript: ArraySlice<MarkdownBlock> { blocks[(transcriptStart ?? blocks.count)...] }

    /// The note in its own language: its title and summary, and the transcript with each line's translation under it (or without them).
    func original(translations: Bool) -> [MarkdownBlock] {
        translations ? blocks : blocks.filter { !$0.isTranslation }
    }

    /// The note in the other language: its translated title and summary, and in the transcript each line's translation first with the line as
    /// it was said under it (or alone). `heading` is the transcript's heading in that language, when Cue knows it.
    func translated(translations: Bool, heading: String?) -> [MarkdownBlock] {
        guard let translation else { return original(translations: translations) }
        let transcript = self.transcript
        var result: [MarkdownBlock] = []
        if case .metadata? = blocks.first { result.append(blocks[0]) }
        result += translation.blocks
        var index = transcript.startIndex
        while index < transcript.endIndex {
            let block = transcript[index]
            let next = transcript.index(after: index)
            if case .paragraph(let said) = block, next < transcript.endIndex, case .translated(let other) = transcript[next] {
                result.append(.paragraph(other))
                if translations { result.append(.translated(said)) }
                index = transcript.index(after: next)
                continue
            }
            if case .transcriptHeading = block, let heading {
                result.append(.transcriptHeading(heading))
            } else {
                result.append(block)
            }
            index = next
        }
        return result
    }

    /// One after another: the note, then its translated title and summary under the other language's name, then the transcript with each
    /// line's translation under it (or without them).
    func oneAfterAnother(language: String, translations: Bool) -> [MarkdownBlock] {
        guard let translation else { return original(translations: translations) }
        var result = Array(head)
        var summary = translation.blocks
        var title = ""
        if case .heading(1, let text)? = summary.first {
            title = text
            summary.removeFirst()
        }
        result.append(.languageHeading(language: language, title: title))
        result += summary
        result += translations ? Array(transcript) : transcript.filter { !$0.isTranslation }
        return result
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    let onTimestamp: ((TimeInterval) -> Void)?
    let onSpeaker: ((String) -> Void)?
    let transcriptAccessory: AnyView?

    var body: some View {
        switch block {
        case .metadata(let pairs):
            // In a row while it fits; one under another in a narrow note, so no name breaks mid-word.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { labels(pairs) }
                VStack(alignment: .leading, spacing: 6) { labels(pairs) }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
        case .heading(let level, let text):
            Inline(text)
                .font(level == 1 ? .largeTitle.weight(.bold) : level == 2 ? .title2.weight(.semibold) : .title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        case .transcriptHeading(let text):
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Inline(text)
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let transcriptAccessory { transcriptAccessory }
            }
        case .languageHeading(let language, let title):
            VStack(alignment: .leading, spacing: 6) {
                Divider().padding(.bottom, 22)
                Label(language, systemImage: "translate")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !title.isEmpty {
                    Inline(title)
                        .font(.title.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .paragraph(let text):
            Inline(text).font(.body).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        case .translated(let text):
            // Under the line it belongs to: smaller and quieter, so the eye reads one language down the page.
            Inline(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        case .bullet(let text, let depth):
            ListRow(marker: Text("•").foregroundStyle(.secondary), text: text, depth: depth)
        case .task(let text, let done, let depth):
            ListRow(marker: Image(systemName: done ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(done ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary)),
                    text: text, depth: depth)
        case .numbered(let number, let text, let depth):
            ListRow(marker: Text("\(number).").monospacedDigit().foregroundStyle(.secondary), text: text, depth: depth)
        case .quote(let text):
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3)
                Inline(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        case .code(let code):
            Text(code)
                .font(.callout.monospaced())
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
        case .speaker(let time, let name):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let onSpeaker {
                    Button(name) { onSpeaker(name) }
                        .buttonStyle(.plain)
                        .font(.body.weight(.semibold))
                        .help("Rename \(name)")
                } else {
                    Text(name).font(.body.weight(.semibold))
                }
                if let onTimestamp, let seconds = MarkdownView.seconds(time) {
                    Button(time) { onTimestamp(seconds) }
                        .buttonStyle(.plain)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tint)
                        .pointerStyle(.link)
                        .help("Play from \(time)")
                } else {
                    Text(time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        case .rule:
            Divider()
        }
    }

    @ViewBuilder private func labels(_ pairs: [(key: String, value: String)]) -> some View {
        ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
            Label(display(pair.key, pair.value), systemImage: symbol(pair.key))
        }
    }

    private func display(_ key: String, _ value: String) -> String {
        if key == "attendees" || key == "participants" {
            let names = key == "attendees" ? RecordingFile.list(value) : RecordingFile.participants(value)
            return names.count > 3 ? "\(names.prefix(2).joined(separator: ", ")) and \(names.count - 2) more" : names.joined(separator: ", ")
        }
        guard key == "date", let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func symbol(_ key: String) -> String {
        switch key {
        case "date": "calendar"
        case "duration": "clock"
        case "participants": "person.2"
        case "attendees": "person.crop.circle.badge.checkmark"
        case "project": "folder"
        default: "info.circle"
        }
    }
}

/// Bullets, tasks and numbers hang in a fixed column so wrapped lines align.
private struct ListRow<Marker: View>: View {
    let marker: Marker
    let text: String
    let depth: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            marker.frame(minWidth: 16, alignment: .trailing)
            Inline(text).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, CGFloat(depth) * 20)
    }
}

/// Inline Markdown (bold, italics, code, links) through Foundation's parser.
private struct Inline: View {
    let source: String
    init(_ source: String) { self.source = source }

    var body: some View {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        Text((try? AttributedString(markdown: source, options: options)) ?? AttributedString(source))
    }
}
