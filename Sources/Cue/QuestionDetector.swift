import Foundation

/// Decides when the participants have finished asking something, and what they asked.
///
/// Participant utterances collect into a buffer. Once the buffer holds a question (see
/// `questions(in:)`), it fires when the participants have been quiet for `quietGap` since they
/// stopped talking, or immediately when the presenter starts talking (they are answering). New
/// participant speech postpones it. Talk without a question never fires.
final class QuestionDetector {
    /// The questions asked in one go, in order.
    var onQuestions: (([String]) -> Void)?

    private let quietGap: TimeInterval = 1.8
    /// Statements this long after a question mean the speaker answered it themselves (a talk's
    /// rhetorical "Who is this for? …").
    private let rhetoricalAfter = 30
    private var buffer: [String] = []
    private var lastAdded = Date.distantPast
    private var armed = false
    private var timer: Timer?

    /// Interrogative words of the spoken language, from its lexicon; they make a short "…?" a question.
    var cues: [String] = [] { didSet { cueWords = cues.map(Self.words) } }
    /// Requests that are questions without a question mark ("explain …"), from its lexicon.
    var requestCues: [String] = [] { didSet { requestWords = requestCues.map(Self.words) } }
    private var cueWords: [[String]] = []
    private var requestWords: [[String]] = []

    /// The questions in a stretch of speech: sentences ending in "?" that are more than a tag
    /// ("Right?") and sentences that open with a request ("Could you explain …"), leaving out
    /// those the speaker went on to answer at length themselves.
    func questions(in text: String) -> [String] {
        let sentences = Self.sentences(text)
        let asking = sentences.map(isQuestion)
        var questions: [String] = []
        for (index, sentence) in sentences.enumerated() where asking[index] {
            let rest = sentences[(index + 1)...].prefix { !isQuestion($0) }
            if rest.reduce(0, { $0 + Self.words($1).count }) <= rhetoricalAfter { questions.append(sentence) }
        }
        return questions
    }

    private func isQuestion(_ sentence: String) -> Bool {
        let words = Self.words(sentence)
        if sentence.contains("?") { return words.count >= 3 || cueWords.contains { words.contains(sequence: $0) } }
        return requestWords.contains { cue in (0...1).contains { words.dropFirst($0).starts(with: cue) } }
    }

    /// A finished participant utterance.
    func add(_ text: String, speechEnded: Date) {
        // Utterances separated by a long silence belong to different exchanges.
        if Date().timeIntervalSince(lastAdded) > 45 { buffer.removeAll(); armed = false }
        buffer.append(text)
        // Only the end of a long talk can hold its question.
        if buffer.count > 8 { buffer.removeFirst(buffer.count - 8) }
        lastAdded = Date()
        armed = !questions(in: buffer.joined(separator: " ")).isEmpty
        participantsStopped(speechEnded: speechEnded)
    }

    /// Participants went quiet (also after a noise blip that produced no text).
    func participantsStopped(speechEnded: Date) {
        guard armed else { return }
        timer?.invalidate()
        let delay = max(0.05, quietGap - Date().timeIntervalSince(speechEnded))
        timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.fire() }
    }

    /// Participants started talking again: the question may go on.
    func participantsSpeaking() {
        timer?.invalidate()
    }

    /// The presenter started talking, so the question is over.
    func presenterSpeaking() {
        if armed { fire() }
    }

    /// Everything collected so far, used by the manual "answer now" hot key.
    func takeBuffer() -> String? {
        timer?.invalidate()
        defer { buffer.removeAll(); armed = false }
        return buffer.isEmpty ? nil : buffer.joined(separator: " ")
    }

    private func fire() {
        guard let speech = takeBuffer() else { return }
        let questions = questions(in: speech)
        if !questions.isEmpty { onQuestions?(questions) }
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

    /// Lowercased words, as the cues are matched.
    static func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }
    }
}

private extension Array where Element == String {
    func contains(sequence: [String]) -> Bool {
        guard !sequence.isEmpty, sequence.count <= count else { return false }
        return (0...(count - sequence.count)).contains { self[$0..<($0 + sequence.count)].elementsEqual(sequence) }
    }
}
