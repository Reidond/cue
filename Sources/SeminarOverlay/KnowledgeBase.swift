import Foundation

struct PreparedAnswer: Decodable {
    let q: String
    let a: String
    let who: String?
    let source: String
}

/// Ukrainian language data (question cues, stop words, Whisper artefacts, spoken
/// openers) kept in Resources/lexicon.json so the code itself stays language-neutral.
struct Lexicon: Decodable {
    let questionCues: [String]
    let stopWords: Set<String>
    let hallucinations: [String]
    let thanksPrefix: String
    let defaultOpener: String

    static let shared: Lexicon = {
        guard let url = Bundle.main.url(forResource: "lexicon", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let lexicon = try? JSONDecoder().decode(Lexicon.self, from: data)
        else { return Lexicon(questionCues: [], stopWords: [], hallucinations: [], thanksPrefix: "", defaultOpener: "") }
        return lexicon
    }()
}

/// The seminar materials bundled into the app by scripts/build.sh.
final class KnowledgeBase {
    let prepared: [PreparedAnswer]
    let systemPromptFile: URL
    let vocabularyPrompt: String
    private let idf: [String: Double]
    private let questionStems: [Set<String>]

    init(resources: URL) throws {
        let knowledge = resources.appendingPathComponent("knowledge")
        func read(_ url: URL) throws -> String {
            do { return try String(contentsOf: url, encoding: .utf8) } catch {
                throw ServiceError("Missing knowledge file \(url.lastPathComponent). Run scripts/prepare_knowledge.py and rebuild.")
            }
        }
        prepared = try JSONDecoder().decode([PreparedAnswer].self, from: Data(read(knowledge.appendingPathComponent("qa.json")).utf8))
        vocabularyPrompt = try read(resources.appendingPathComponent("whisper_prompt.txt"))
            .trimmingCharacters(in: .whitespacesAndNewlines)

        var prompt = try read(resources.appendingPathComponent("prompt.md"))
        prompt += "\n\n# PREPARED ANSWERS\n"
        for item in prepared {
            prompt += "\nQuestion\(item.who.map { " (\($0))" } ?? ""): \(item.q)\nAnswer: \(item.a)\n"
        }
        prompt += "\n\n# PRESENTATION (slides and speaker notes)\n"
        prompt += try read(knowledge.appendingPathComponent("slides.md"))
        prompt += "\n\n# DISSERTATION TEXT ([p. N] marks page N)\n"
        prompt += try read(knowledge.appendingPathComponent("thesis.md"))

        // Same bytes on every launch, so the prompt cache keeps hitting.
        systemPromptFile = appSupport.appendingPathComponent("run/system.md")
        try FileManager.default.createDirectory(at: systemPromptFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try prompt.write(to: systemPromptFile, atomically: true, encoding: .utf8)

        questionStems = prepared.map { Set(Self.stems($0.q)) }
        var documentFrequency: [String: Int] = [:]
        for stems in questionStems { for stem in stems { documentFrequency[stem, default: 0] += 1 } }
        let total = Double(prepared.count)
        idf = documentFrequency.mapValues { log((total + 1) / Double($0)) + 0.5 }
    }

    /// Best prepared answer for a question, by IDF-weighted stem overlap. Instant, offline.
    func match(_ question: String) -> (answer: PreparedAnswer, score: Double)? {
        let query = Set(Self.stems(question))
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

    /// Crude stemming that works well enough for Ukrainian: lowercase, keep words of
    /// 4+ letters that are not stop words, cut to 6 letters.
    static func stems(_ text: String) -> [String] {
        text.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'-")).inverted)
            .filter { $0.count >= 4 && !Lexicon.shared.stopWords.contains($0) }
            .map { String($0.prefix(6)) }
    }
}
