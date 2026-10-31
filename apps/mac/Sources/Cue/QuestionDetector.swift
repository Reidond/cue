import Foundation

/// Decides when the participants have finished asking something, and what they asked.
///
/// Participant utterances collect into a buffer, and each time one is added the judge (Claude
/// Haiku, see `QuestionJudge`) reads the buffer and says which questions in it are for the
/// speaker. Once it has found some, the detector fires when the participants have been quiet for
/// `quietGap` since they stopped talking, or as soon as the presenter starts talking (they are
/// answering). New participant speech postpones it and is judged again with the rest. Talk the
/// judge finds no question in never fires. Without a judge, sentences ending in "?" count.
final class QuestionDetector {
    /// The questions asked in one go, in order.
    var onQuestions: (([String]) -> Void)?
    /// Reads what was just said (an utterance per line, "[Label] text") and calls back with its
    /// questions for the speaker (none: []), or nil when it couldn't tell.
    var judge: ((_ speech: String, _ verdict: @escaping ([String]?) -> Void) -> Void)?

    struct Line {
        let label: String
        let text: String
        let started: Date
    }

    private let quietGap: TimeInterval = 1.8
    /// What was said since the last question, judged as a whole each time it grows.
    private(set) var buffer: [Line] = []
    /// Counts the buffer's changes, so a verdict on an older buffer is dropped.
    private var version = 0
    /// The judge's verdict on the buffer as it is; nil while it's still judging.
    private var questions: [String]?
    /// When the participants last stopped talking, while they're quiet.
    private var quietSince: Date?
    /// When the participants last started talking.
    private var lastOnset = Date.distantPast
    /// The presenter started answering before the verdict came.
    private var fireWhenJudged = false
    private var lastAdded = Date.distantPast
    private var timer: Timer?

    /// A finished utterance (`label` is who said it, as the transcript shows them).
    func add(_ text: String, from label: String, speechStarted: Date, speechEnded: Date) {
        // Utterances separated by a long silence belong to different exchanges.
        if Date().timeIntervalSince(lastAdded) > 45 { buffer.removeAll() }
        buffer.append(Line(label: label, text: text, started: speechStarted))
        // Only the end of a long talk can hold its question.
        if buffer.count > 8 { buffer.removeFirst(buffer.count - 8) }
        lastAdded = Date()
        version += 1
        questions = nil
        let asked = version
        let speech = buffer.map { "[\($0.label)] \($0.text)" }.joined(separator: "\n")
        let marked = Self.marked(in: buffer.map(\.text).joined(separator: " "))
        if let judge {
            judge(speech) { [weak self] found in
                guard let self, asked == self.version else { return }
                self.judged(found ?? marked)
            }
        } else {
            judged(marked)
        }
        participantsStopped(speechEnded: speechEnded)
    }

    /// Participants went quiet (also after a noise blip that produced no text).
    func participantsStopped(speechEnded: Date) {
        // They may have started again while this was being transcribed.
        guard lastOnset < speechEnded else { return }
        quietSince = speechEnded
        schedule()
    }

    /// Participants started talking again: the question may go on.
    func participantsSpeaking() {
        lastOnset = Date()
        timer?.invalidate()
        quietSince = nil
        // They go on, so the presenter's word over what they said before wasn't an answer.
        fireWhenJudged = false
    }

    /// The presenter started talking, so the question is over.
    func presenterSpeaking() {
        if questions == nil, !buffer.isEmpty { fireWhenJudged = true } else { fire() }
    }

    /// Everything collected so far and its questions (the judge's, if it has spoken), used by the
    /// manual "answer now" hot key.
    func take() -> (speech: String, questions: [String])? {
        defer { clear() }
        guard !buffer.isEmpty else { return nil }
        let speech = buffer.map(\.text).joined(separator: " ")
        return (speech, questions ?? Self.marked(in: speech))
    }

    private func judged(_ found: [String]) {
        questions = found
        let answering = fireWhenJudged
        fireWhenJudged = false
        if answering, !found.isEmpty { fire() } else { schedule() }
    }

    private func schedule() {
        timer?.invalidate()
        guard let questions, !questions.isEmpty, let quietSince else { return }
        let delay = max(0.05, quietGap - Date().timeIntervalSince(quietSince))
        timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.fire() }
    }

    private func fire() {
        guard let found = questions, !found.isEmpty else { return }
        clear()
        onQuestions?(found)
    }

    private func clear() {
        timer?.invalidate()
        buffer.removeAll()
        questions = nil
        fireWhenJudged = false
        version += 1
    }

    /// Without the judge: sentences ending in "?" that are more than a tag ("Right?").
    static func marked(in text: String) -> [String] {
        sentences(text).filter { $0.contains("?") && words($0).count >= 2 }
    }

    /// Sentences, each with its own end mark (and closing quote); a full stop inside a number doesn't end one.
    static func sentences(_ text: String) -> [String] {
        var sentences: [String] = [], current = ""
        let characters = Array(text)
        var index = 0
        while index < characters.count {
            current.append(characters[index])
            if ".?!…".contains(characters[index]) {
                while index + 1 < characters.count, ".?!…»”\")".contains(characters[index + 1]) {
                    index += 1
                    current.append(characters[index])
                }
                if index + 1 == characters.count || characters[index + 1].isWhitespace {
                    sentences.append(current.trimmingCharacters(in: .whitespaces))
                    current = ""
                }
            }
            index += 1
        }
        let rest = current.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty { sentences.append(rest) }
        return sentences
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }
    }
}
