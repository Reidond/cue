import Foundation

/// Who is speaking and about what; fills the placeholders in Resources/prompt.md.
struct PromptContext: Equatable {
    var speaker: String
    var occasion: String
    var languageCode: String

    var lexicon: Lexicon { Lexicon.load(languageCode) }
}

/// A prepared question and its answer, found in a material by the Cue API.
struct PreparedAnswer: Hashable {
    let q: String
    let a: String
    let who: String?
    let source: String
}

/// One file of a project: the text the Cue API read from it, plus any prepared Q&A it found there.
struct MaterialDocument {
    let name: String
    var text = ""
    var prepared: [PreparedAnswer] = []
    var summary = ""
    var error: String?

    init(name: String, summary: String, error: String?) {
        self.name = name
        self.summary = summary
        self.error = error
    }
}

/// The user's materials compiled into Claude's system prompt, plus the prepared
/// answers for the instant offline match.
struct KnowledgeBase {
    let documents: [MaterialDocument]
    let prepared: [PreparedAnswer]
    let systemPrompt: String
    private let idf: [String: Double]
    private let questionStems: [Set<String>]
    private let stopWords: Set<String>

    static let systemPromptFile = appSupport.appendingPathComponent("run/system.md")

    /// Rough token count; Claude's tokenizer averages ~3.9 UTF-8 bytes per token on mixed text.
    var estimatedTokens: Int { systemPrompt.utf8.count * 10 / 39 }

    static func build(documents: [MaterialDocument], context: PromptContext) -> KnowledgeBase {
        let lexicon = context.lexicon
        let prepared = documents.flatMap(\.prepared)

        let template = (Bundle.main.url(forResource: "prompt", withExtension: "md"))
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let speaker = context.speaker.trimmingCharacters(in: .whitespaces).isEmpty ? "the speaker" : context.speaker
        let occasion = context.occasion.trimmingCharacters(in: .whitespacesAndNewlines)
        var prompt = template
            .replacingOccurrences(of: "{{speaker}}", with: speaker)
            .replacingOccurrences(of: "{{occasion}}", with: occasion.isEmpty ? "a talk followed by questions." : occasion)
            .replacingOccurrences(of: "{{language}}", with: lexicon.name)
            .replacingOccurrences(of: "{{numbersLabel}}", with: lexicon.numbersLabel)
            .replacingOccurrences(of: "{{sourceLabel}}", with: lexicon.sourceLabel)

        if !prepared.isEmpty {
            prompt += "\n\n# PREPARED ANSWERS\n"
            for item in prepared {
                prompt += "\nQuestion\(item.who.map { " (\($0))" } ?? ""): \(item.q)\nAnswer: \(item.a)\n"
            }
        }
        let texts = documents.filter { !$0.text.isEmpty }
        prompt += texts.isEmpty
            ? "\n\n# MATERIALS\n\nNo materials were provided. Answer from general knowledge and say when you are unsure.\n"
            : "\n\n# MATERIALS\n\n" + texts.map(\.text).joined(separator: "\n\n")

        return KnowledgeBase(documents: documents, prepared: prepared, systemPrompt: prompt, stopWords: lexicon.stopWords)
    }

    private init(documents: [MaterialDocument], prepared: [PreparedAnswer], systemPrompt: String, stopWords: Set<String>) {
        self.documents = documents
        self.prepared = prepared
        self.systemPrompt = systemPrompt
        self.stopWords = stopWords
        questionStems = prepared.map { Set(Self.stems($0.q, stopWords: stopWords)) }
        var documentFrequency: [String: Int] = [:]
        for stems in questionStems { for stem in stems { documentFrequency[stem, default: 0] += 1 } }
        let total = Double(prepared.count)
        idf = documentFrequency.mapValues { log((total + 1) / Double($0)) + 0.5 }
    }

    /// Writes the prompt for `claude --system-prompt-file`. Returns false when the
    /// file already had these exact bytes, so the running session (and its prompt
    /// cache) can be kept.
    func writeSystemPrompt() throws -> Bool {
        let url = Self.systemPromptFile
        if let existing = try? String(contentsOf: url, encoding: .utf8), existing == systemPrompt { return false }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try systemPrompt.write(to: url, atomically: true, encoding: .utf8)
        return true
    }

    /// Best prepared answer for a question, by IDF-weighted stem overlap. Instant, offline.
    func match(_ question: String) -> (answer: PreparedAnswer, score: Double)? {
        let query = Set(Self.stems(question, stopWords: stopWords))
        let queryWeight = query.reduce(0) { $0 + (idf[$1] ?? 1.5) }
        guard queryWeight > 0 else { return nil }
        var best: (Int, Double)?
        for (index, stems) in questionStems.enumerated() {
            let shared = query.intersection(stems).reduce(0) { $0 + (idf[$1] ?? 0) }
            let candidateWeight = stems.reduce(0) { $0 + (idf[$1] ?? 0) }
            // Harmonic mean of coverage in both directions, so neither a short nor a long question wins by size.
            let a = shared / queryWeight, b = shared / max(candidateWeight, 0.001)
            let score = a + b > 0 ? 2 * a * b / (a + b) : 0
            if score > (best?.1 ?? 0) { best = (index, score) }
        }
        guard let (index, score) = best, score >= 0.3 else { return nil }
        return (prepared[index], score)
    }

    /// Crude stemming that works well enough across European languages: lowercase,
    /// keep words of 4+ letters that are not stop words, cut to 6 letters.
    static func stems(_ text: String, stopWords: Set<String>) -> [String] {
        text.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'-")).inverted)
            .filter { $0.count >= 4 && !stopWords.contains($0) }
            .map { String($0.prefix(6)) }
    }
}
