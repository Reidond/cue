import Foundation

/// A second, small Claude session (Haiku, without the materials) that reads what the participants
/// just said and tells which questions in it are for the speaker, so only those get an answer.
/// Uses the same Claude Code login as the answers; Resources/judge.md is its prompt.
@MainActor
final class QuestionJudge {
    enum State: Equatable { case starting, ready, unavailable(String) }

    /// Unavailable means the detector goes by question marks until the judge is back.
    private(set) var state = State.starting
    var onState: (State) -> Void = { _ in }

    static let systemPromptFile = appSupport.appendingPathComponent("run/judge.md")

    private var service: ClaudeService?
    private var replies: [UUID: String] = [:]
    private var waiting: [UUID: ([String]?) -> Void] = [:]
    /// A verdict slower than this is no use: the question would have been answered already.
    private let patience: TimeInterval = 6

    /// Writes the prompt for the talk; (re)starts the session when it changed.
    func configure(_ context: PromptContext) {
        let template = Bundle.main.url(forResource: "judge", withExtension: "md")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let speaker = context.speaker.trimmingCharacters(in: .whitespaces).isEmpty ? "the speaker" : context.speaker
        let occasion = context.occasion.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = template
            .replacingOccurrences(of: "{{speaker}}", with: speaker)
            .replacingOccurrences(of: "{{occasion}}", with: occasion.isEmpty ? "a talk followed by questions." : occasion)
            .replacingOccurrences(of: "{{language}}", with: context.lexicon.name)
        let url = Self.systemPromptFile
        let unchanged = (try? String(contentsOf: url, encoding: .utf8)) == prompt
        if !unchanged {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? prompt.write(to: url, atomically: true, encoding: .utf8)
        }
        guard !unchanged || service == nil else { return }
        if service == nil {
            service = ClaudeService(systemPromptFile: url, model: .haiku, handlers: .init(
                onDelta: { id, text in Task { @MainActor in self.replies[id, default: ""] += text } },
                onDone: { id, error in Task { @MainActor in self.finish(id, error: error) } },
                onReady: { ready, detail in Task { @MainActor in self.ready(ready, detail: detail) } }
            ))
        }
        set(.starting)
        service?.start(model: .haiku)
    }

    func stop() {
        service?.stop()
    }

    /// The questions in `message` for the speaker (none: []), or nil when the judge couldn't tell.
    func judge(_ message: String, verdict: @escaping ([String]?) -> Void) {
        guard state == .ready, let service else { return verdict(nil) }
        let id = service.ask(message)
        waiting[id] = verdict
        DispatchQueue.main.asyncAfter(deadline: .now() + patience) { [weak self] in
            MainActor.assumeIsolated { self?.answer(id, with: nil) }
        }
    }

    private func finish(_ id: UUID, error: String?) {
        answer(id, with: error == nil ? Self.questions(in: replies[id] ?? "") : nil)
    }

    private func answer(_ id: UUID, with questions: [String]?) {
        replies[id] = nil
        waiting.removeValue(forKey: id)?(questions)
    }

    private func ready(_ ready: Bool, detail: String) {
        if ready {
            set(.ready)
        } else if detail.hasPrefix("Warming up") {
            set(.starting)
        } else {
            set(.unavailable(detail))
        }
    }

    private func set(_ new: State) {
        guard new != state else { return }
        state = new
        onState(new)
    }

    /// The "Q: …" lines of a reply; anything else (an explanation instead of "—") is no question.
    static func questions(in reply: String) -> [String] {
        reply.split(separator: "\n").compactMap { line in
            let line = line.trimmingCharacters(in: .whitespaces)
            guard line.uppercased().hasPrefix("Q:") else { return nil }
            let question = line.dropFirst(2).trimmingCharacters(in: .whitespaces)
            return question.isEmpty ? nil : question
        }
    }
}
