import Foundation
import PDFKit

struct PreparedAnswer: Hashable {
    let q: String
    let a: String
    let who: String?
    let source: String
}

/// One file the user added, turned into prompt text plus any prepared Q&A found in it.
struct MaterialDocument {
    let url: URL
    var text = ""
    var prepared: [PreparedAnswer] = []
    var summary = ""
    var error: String?

    var name: String { url.lastPathComponent }
}

/// Reads PDF, PowerPoint, Word, Markdown and plain-text files without third-party
/// tools: PDFKit for PDF, the system `unzip` plus XMLParser for Office files.
enum Materials {
    static let supportedExtensions: Set<String> = ["pdf", "pptx", "docx", "md", "markdown", "txt"]

    static func read(_ url: URL, lexicon: Lexicon) -> MaterialDocument {
        var document = MaterialDocument(url: url)
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            document.error = "File not found"
            return document
        }
        do {
            switch url.pathExtension.lowercased() {
            case "pdf": try readPDF(&document)
            case "pptx": try readSlides(&document, lexicon: lexicon)
            case "docx": try readWord(&document, lexicon: lexicon)
            default: try readText(&document, lexicon: lexicon)
            }
        } catch {
            document.error = error.localizedDescription
        }
        return document
    }

    // MARK: PDF

    private static func readPDF(_ document: inout MaterialDocument) throws {
        guard let pdf = PDFDocument(url: document.url) else { throw ServiceError("Could not open the PDF") }
        var pages: [String] = []
        for index in 0..<pdf.pageCount {
            guard let page = pdf.page(at: index) else { continue }
            let lines = (page.string ?? "").components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !$0.allSatisfy(\.isNumber) }  // running page numbers
            pages.append("[p. \(page.label ?? String(index + 1))]\n" + unwrap(lines.joined(separator: "\n")))
        }
        guard pages.contains(where: { $0.count > 20 }) else { throw ServiceError("No text in this PDF (scanned?)") }
        document.text = "## \(document.name) (PDF; [p. N] marks page N)\n" + pages.joined(separator: "\n")
        document.summary = "\(pdf.pageCount) pages"
    }

    /// Re-joins hard line wraps into paragraphs so the text is denser for the model.
    private static let lineWrap = try! NSRegularExpression(pattern: #"(?<![.:;!?»”\]])\n(?!\[p\. )"#)

    private static func unwrap(_ text: String) -> String {
        lineWrap.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
    }

    // MARK: PowerPoint

    private static func readSlides(_ document: inout MaterialDocument, lexicon: Lexicon) throws {
        let file = document.url
        let order = try slideOrder(file)
        var parts: [String] = []
        for (number, path) in order.enumerated().map({ ($0.offset + 1, $0.element) }) {
            let slide = OfficeXML.paragraphs(try zipEntry(file, path), mode: .slide)
            var section = "### Slide \(number)\n" + slide.joined(separator: "\n")
            let rels = relationships(try? zipEntry(file, path.replacingOccurrences(of: "slides/", with: "slides/_rels/") + ".rels"))
            if let notesTarget = rels.values.first(where: { $0.contains("notesSlide") }) {
                let notesPath = "ppt/notesSlides/" + (notesTarget as NSString).lastPathComponent
                let notes = OfficeXML.paragraphs((try? zipEntry(file, notesPath)) ?? Data(), mode: .notes)
                if !notes.isEmpty {
                    section += "\nSpeaker notes:\n" + notes.joined(separator: "\n")
                    document.prepared += extractQA(notes, lexicon: lexicon, source: "\(document.name), slide \(number) notes")
                }
            }
            parts.append(section)
        }
        document.text = "## \(document.name) (slides with speaker notes)\n" + parts.joined(separator: "\n\n")
        document.summary = "\(order.count) slides" + qaSuffix(document.prepared)
    }

    /// Slide part paths in presentation order (file names don't reflect reordering).
    private static func slideOrder(_ file: URL) throws -> [String] {
        let presentation = try zipEntry(file, "ppt/presentation.xml")
        let rels = relationships(try zipEntry(file, "ppt/_rels/presentation.xml.rels"))
        let ids = OfficeXML.attributeValues(presentation, element: "p:sldId", attribute: "r:id")
        return ids.compactMap { rels[$0] }.map { "ppt/" + $0.replacingOccurrences(of: "../", with: "") }
    }

    private static func relationships(_ data: Data?) -> [String: String] {
        guard let data else { return [:] }
        let ids = OfficeXML.attributeValues(data, element: "Relationship", attribute: "Id")
        let targets = OfficeXML.attributeValues(data, element: "Relationship", attribute: "Target")
        return Dictionary(zip(ids, targets), uniquingKeysWith: { first, _ in first })
    }

    // MARK: Word, Markdown, text

    private static func readWord(_ document: inout MaterialDocument, lexicon: Lexicon) throws {
        let paragraphs = OfficeXML.paragraphs(try zipEntry(document.url, "word/document.xml"), mode: .word)
        finishText(&document, lines: paragraphs, lexicon: lexicon)
    }

    private static func readText(_ document: inout MaterialDocument, lexicon: Lexicon) throws {
        let text = try String(contentsOf: document.url, encoding: .utf8)
        finishText(&document, lines: text.components(separatedBy: .newlines), lexicon: lexicon)
    }

    private static func finishText(_ document: inout MaterialDocument, lines: [String], lexicon: Lexicon) {
        let body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        document.text = "## \(document.name)\n" + body
        document.prepared = extractQA(lines, lexicon: lexicon, source: document.name)
        let words = body.split(whereSeparator: \.isWhitespace).count
        document.summary = "\(words.formatted()) words" + qaSuffix(document.prepared)
    }

    private static func qaSuffix(_ prepared: [PreparedAnswer]) -> String {
        prepared.isEmpty ? "" : " · \(prepared.count) prepared answers"
    }

    // MARK: Prepared Q&A

    /// Finds question/answer pairs: a line with a question (or a question label)
    /// followed by a line that starts with an answer label, e.g.
    /// `12. How were the weights chosen? (Smith)` / `Answer: …` or
    /// `Q: …` / `A: …`. The answer runs until a blank line or a symbol-led line.
    static func extractQA(_ rawLines: [String], lexicon: Lexicon, source: String) -> [PreparedAnswer] {
        let lines = rawLines.flatMap { $0.components(separatedBy: .newlines) }.map { $0.trimmingCharacters(in: .whitespaces) }
        func nextNonBlank(after index: Int) -> Int? {
            var next = index + 1
            while next < lines.count, lines[next].isEmpty { next += 1 }
            return next < lines.count ? next : nil
        }
        func opensPair(_ index: Int) -> Int? {
            let line = lines[index]
            guard line.contains("?") || labelLength(line, lexicon.questionLabels) != nil,
                  labelLength(line, lexicon.answerLabels) == nil,
                  let next = nextNonBlank(after: index),
                  labelLength(lines[next], lexicon.answerLabels) != nil
            else { return nil }
            return next
        }

        var pairs: [PreparedAnswer] = []
        var index = 0
        while index < lines.count {
            guard let answerIndex = opensPair(index) else { index += 1; continue }
            var answer = [strip(lines[answerIndex], labels: lexicon.answerLabels)]
            var cursor = answerIndex + 1
            while cursor < lines.count, !lines[cursor].isEmpty, !startsWithSymbol(lines[cursor]), opensPair(cursor) == nil {
                answer.append(lines[cursor])
                cursor += 1
            }
            let (question, who) = cleanQuestion(lines[index], lexicon: lexicon)
            let text = answer.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !question.isEmpty, !text.isEmpty {
                pairs.append(PreparedAnswer(q: question, a: text, who: who, source: source))
            }
            index = cursor
        }
        return pairs
    }

    /// Length of a leading label such as "Answer:", "A.", "❓ Q:" (symbols and numbering skipped).
    private static func labelLength(_ line: String, _ labels: [String]) -> Int? {
        let lead = leadingNoise(line)
        let rest = line.dropFirst(lead).lowercased()
        for label in labels.sorted(by: { $0.count > $1.count }) where rest.hasPrefix(label) {
            let after = rest.dropFirst(label.count).drop(while: { $0 == " " })
            if let mark = after.first, ":.)–—-".contains(mark) {
                return lead + rest.count - after.count + 1
            }
        }
        return nil
    }

    private static func strip(_ line: String, labels: [String]) -> String {
        guard let length = labelLength(line, labels) else { return line }
        return String(line.dropFirst(length)).trimmingCharacters(in: .whitespaces)
    }

    /// Symbols, bullets and list numbering before the first word.
    private static func leadingNoise(_ line: String) -> Int {
        var count = 0
        var sawDigit = false
        for character in line {
            if character.isLetter || character == "«" || character == "\"" || character == "“" { break }
            if character.isNumber { sawDigit = true }
            count += 1
        }
        return sawDigit || count > 0 ? count : 0
    }

    private static func startsWithSymbol(_ line: String) -> Bool {
        guard let first = line.first else { return false }
        return !(first.isLetter || first.isNumber || "«\"“(".contains(first))
    }

    private static func cleanQuestion(_ line: String, lexicon: Lexicon) -> (String, String?) {
        // A quoted question inside a note line: …: «How do you …?»
        if let quoted = line.firstMatch(of: #/[«“"](.+?\?)[»”"]/#) {
            return (String(quoted.1), nil)
        }
        var text = strip(line, labels: lexicon.questionLabels)
        text = String(text.dropFirst(leadingNoise(text)))
        var who: String?
        if let asker = text.firstMatch(of: #/\?\s*\(([^()?]{2,40})\)\s*$/#) {
            who = String(asker.1)
            text = String(text[..<asker.range.lowerBound]) + "?"
        }
        return (text.trimmingCharacters(in: .whitespaces), who)
    }

    // MARK: Zip

    static func zipEntry(_ file: URL, _ path: String) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-p", file.path, path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, !data.isEmpty else {
            throw ServiceError("Not a valid Office file (missing \(path))")
        }
        return data
    }
}

/// Minimal Office Open XML text extraction.
private final class OfficeXML: NSObject, XMLParserDelegate {
    enum Mode { case word, slide, notes }

    private let mode: Mode
    private var paragraphs: [String] = []
    private var current = ""
    private var inText = false
    private var inParagraph = false
    // PowerPoint shapes: placeholders decide what counts as content.
    private var shapeDepth = 0
    private var shapePlaceholder: String?
    private var shapeParagraphs: [String] = []

    private init(mode: Mode) { self.mode = mode }

    static func paragraphs(_ data: Data, mode: Mode) -> [String] {
        let handler = OfficeXML(mode: mode)
        let parser = XMLParser(data: data)
        parser.delegate = handler
        parser.parse()
        // Collapse runs of blank paragraphs but keep single blanks: they separate Q&A blocks.
        var result: [String] = []
        for paragraph in handler.paragraphs where !(paragraph.isEmpty && (result.last?.isEmpty ?? true)) {
            result.append(paragraph)
        }
        return result
    }

    static func attributeValues(_ data: Data, element: String, attribute: String) -> [String] {
        final class Collector: NSObject, XMLParserDelegate {
            let element: String, attribute: String
            var values: [String] = []
            init(_ element: String, _ attribute: String) { self.element = element; self.attribute = attribute }
            func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
                if name == element, let value = attributes[attribute] { values.append(value) }
            }
        }
        let collector = Collector(element, attribute)
        let parser = XMLParser(data: data)
        parser.delegate = collector
        parser.parse()
        return collector.values
    }

    private var paragraphTag: String { mode == .word ? "w:p" : "a:p" }
    private var textTag: String { mode == .word ? "w:t" : "a:t" }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
        switch name {
        case paragraphTag:
            inParagraph = true
            current = ""
        case textTag:
            inText = true
        case "w:tab":
            if inParagraph { current += "\t" }
        case "w:br", "w:cr", "a:br":
            if inParagraph { current += "\n" }
        case "p:sp":
            shapeDepth += 1
            if shapeDepth == 1 { shapePlaceholder = nil; shapeParagraphs = [] }
        case "p:ph":
            shapePlaceholder = attributes["type"] ?? "body"
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if inText { current += string }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        switch name {
        case textTag:
            inText = false
        case paragraphTag:
            inParagraph = false
            let text = current.trimmingCharacters(in: .whitespaces)
            if shapeDepth > 0 { shapeParagraphs.append(text) } else { paragraphs.append(text) }
        case "p:sp":
            shapeDepth -= 1
            if shapeDepth == 0, keepsShape { paragraphs += shapeParagraphs + [""] }
        default:
            break
        }
    }

    private var keepsShape: Bool {
        switch mode {
        case .word: true
        case .notes: shapePlaceholder == "body"
        case .slide: !["sldNum", "dt", "ftr", "sldImg"].contains(shapePlaceholder ?? "")
        }
    }
}
