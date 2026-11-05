import Foundation

/// A prepared question and its answer: written in a material, or one of the likely questions Cue answered from the materials.
struct PreparedAnswer: Hashable {
    let q: String
    let a: String
    let who: String?
    let source: String
    /// Prepared by Cue from the materials, not written in them.
    var byCue = false
}

/// One file of a project, as the Cue API read it.
struct MaterialDocument {
    let name: String
    var summary = ""
    var error: String?
}

/// What the account read from a project's files, for the project's page: its prepared answers and how much Claude reads for each question.
/// (The Call Durable Object builds the prompt and matches questions to the prepared answers on the server.)
struct KnowledgeBase {
    let documents: [MaterialDocument]
    let prepared: [PreparedAnswer]
    /// Nil from a backend from before it said.
    var reading: ProjectReading?

    /// "~2k tokens", or for materials too long to read whole "~263k tokens, ~6k read per question"; nil when the backend didn't say.
    var tokens: String? {
        guard let reading else { return nil }
        let size = { (tokens: Int) in tokens >= 1000 ? "\(tokens / 1000)k" : "\(tokens)" }
        return reading.passages
            ? "~\(size(reading.totalTokens)) tokens, ~\(size(reading.tokens)) read per question"
            : "~\(size(reading.tokens)) tokens"
    }
}
