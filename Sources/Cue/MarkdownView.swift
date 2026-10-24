import SwiftUI

/// Renders the Markdown Cue writes (and what people usually add by hand):
/// front matter, headings, paragraphs, bullet / numbered / task lists, quotes,
/// rules, code blocks and transcript speaker lines. Inline styles come from
/// Foundation's Markdown parser.
struct MarkdownView: View {
    let markdown: String
    /// Makes the speaker lines' timestamps clickable; called with the offset in seconds.
    var onTimestamp: ((TimeInterval) -> Void)?

    var body: some View {
        let document = MarkdownDocument(markdown)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                BlockView(block: block, onTimestamp: onTimestamp)
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

/// Selectable text, except in snapshot test runs: offscreen rendering can't draw it.
private struct Selectable: ViewModifier {
    func body(content: Content) -> some View {
        if ProcessInfo.processInfo.environment["CUE_SNAPSHOT"] == nil {
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

    static func == (lhs: MarkdownBlock, rhs: MarkdownBlock) -> Bool { String(describing: lhs) == String(describing: rhs) }

    var spacingAbove: CGFloat {
        switch self {
        case .heading(let level, _): level == 1 ? 6 : 28
        case .bullet, .task, .numbered: 6
        case .speaker: 20
        default: 12
        }
    }
}

struct MarkdownDocument {
    var blocks: [MarkdownBlock] = []

    init(_ text: String) {
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")[...]

        // YAML front matter shown as a compact metadata row; the title (and the event it is named
        // after) repeats as the H1 and the audio has its own player.
        if lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") {
            let pairs = lines[lines.startIndex + 1..<end].compactMap { line -> (key: String, value: String)? in
                guard let colon = line.firstIndex(of: ":") else { return nil }
                let key = line[..<colon].trimmingCharacters(in: .whitespaces)
                let value = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet.whitespaces.union(["\""]))
                return ["title", "event", "audio"].contains(key) || value.isEmpty || value == "[]" ? nil : (key, value)
            }
            if !pairs.isEmpty { blocks.append(.metadata(pairs)) }
            lines = lines[(end + 1)...]
        }

        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }

        var iterator = lines.makeIterator()
        while let raw = iterator.next() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let depth = raw.prefix { $0 == " " }.count / 2

            if line.hasPrefix("```") {
                flush()
                var code: [String] = []
                while let next = iterator.next(), !next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(next) }
                blocks.append(.code(code.joined(separator: "\n")))
            } else if line.isEmpty || line.hasPrefix("<!--") {
                flush()
            } else if let match = line.firstMatch(of: #/^(#{1,6})\s+(.+)$/#) {
                flush()
                blocks.append(.heading(level: match.1.count, text: String(match.2)))
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

private struct BlockView: View {
    let block: MarkdownBlock
    let onTimestamp: ((TimeInterval) -> Void)?

    var body: some View {
        switch block {
        case .metadata(let pairs):
            HStack(spacing: 14) {
                ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                    Label(display(pair.key, pair.value), systemImage: symbol(pair.key))
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
        case .heading(let level, let text):
            Inline(text)
                .font(level == 1 ? .largeTitle.weight(.bold) : level == 2 ? .title2.weight(.semibold) : .title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        case .paragraph(let text):
            Inline(text).font(.body).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
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
                Text(name).font(.body.weight(.semibold))
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

    private func display(_ key: String, _ value: String) -> String {
        if key == "attendees" {
            let names = RecordingFile.list(value)
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
