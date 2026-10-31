import Foundation

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

/// What the account read from a project's files, for the project's page: its prepared answers and how much Claude is given to read.
/// (The Call Durable Object builds the prompt and matches questions to the prepared answers on the server.)
struct KnowledgeBase {
    let documents: [MaterialDocument]
    let prepared: [PreparedAnswer]
    private let bytes: Int

    /// Rough token count; Claude's tokenizer averages ~3.9 UTF-8 bytes per token on mixed text.
    var estimatedTokens: Int { bytes * 10 / 39 }

    init(documents: [MaterialDocument]) {
        self.documents = documents
        prepared = documents.flatMap(\.prepared)
        bytes = documents.reduce(0) { $0 + $1.text.utf8.count }
    }
}
