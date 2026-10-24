import Foundation

/// Decides when the participants have finished asking something.
///
/// Participant utterances collect into a buffer. Once the buffer contains
/// something question-like, it fires when the participants have been quiet for
/// `quietGap` since they stopped talking, or immediately when the presenter
/// starts talking (they are answering). New participant speech postpones it.
final class QuestionDetector {
    var onQuestion: ((String) -> Void)?

    private let quietGap: TimeInterval = 1.8
    private var buffer: [String] = []
    private var lastAdded = Date.distantPast
    private var armed = false
    private var timer: Timer?

    /// Interrogative words of the spoken language, from its lexicon.
    var cues: [String] = []

    func looksLikeQuestion(_ text: String) -> Bool {
        let words = " " + text.lowercased().components(separatedBy: CharacterSet.letters.inverted).joined(separator: " ") + " "
        return text.contains("?") || cues.contains { words.contains(" \($0) ") }
    }

    /// A finished participant utterance.
    func add(_ text: String, speechEnded: Date) {
        // Utterances separated by a long silence belong to different exchanges.
        if Date().timeIntervalSince(lastAdded) > 45 { buffer.removeAll(); armed = false }
        buffer.append(text)
        lastAdded = Date()
        if looksLikeQuestion(text) { armed = true }
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
        if let question = takeBuffer() { onQuestion?(question) }
    }
}
