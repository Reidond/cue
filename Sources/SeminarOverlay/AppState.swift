import AppKit
import Foundation

enum Channel: String {
    case me = "Andrii"
    case others = "Participant"
}

struct Utterance: Identifiable {
    let id = UUID()
    let channel: Channel
    let text: String
    let time: Date
}

struct Answer: Identifiable {
    let id: UUID
    let question: String
    let askedAt = Date()
    /// Shown the instant the question lands, before Claude says anything.
    let opener: String
    let prepared: PreparedAnswer?
    let preparedScore: Double
    var text = ""
    var firstTokenAt: Date?
    var done = false
    var error: String?

    var isNotAQuestion: Bool { done && text.trimmingCharacters(in: .whitespacesAndNewlines) == "—" }

    /// Claude's first line once it is complete; the instant opener until then.
    var sayNow: String {
        if let newline = text.firstIndex(of: "\n") { return String(text[..<newline]).trimmingCharacters(in: .whitespaces) }
        return done ? text.trimmingCharacters(in: .whitespacesAndNewlines) : opener
    }

    /// Claude's first line while it is still being typed.
    var sayNowDraft: String? {
        text.contains("\n") || done || text.isEmpty ? nil : text
    }

    var points: String {
        guard let newline = text.firstIndex(of: "\n") else { return "" }
        return text[text.index(after: newline)...].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct ServiceStatus {
    var ok = false
    var detail = "Starting…"
}

@MainActor
final class AppState: ObservableObject {
    @Published var utterances: [Utterance] = []
    @Published var partial: [Channel: String] = [:]
    @Published var answers: [Answer] = []
    @Published var selected = 0
    @Published var micLevel: Float = 0
    @Published var systemLevel: Float = 0
    @Published var mic = ServiceStatus()
    @Published var meet = ServiceStatus()
    @Published var whisper = ServiceStatus()
    @Published var claude = ServiceStatus()
    @Published var fatalError: String?

    @Published var autoAnswer = UserDefaults.standard.object(forKey: "autoAnswer") as? Bool ?? true {
        didSet { UserDefaults.standard.set(autoAnswer, forKey: "autoAnswer") }
    }
    /// Also treat questions picked up by the microphone (people in the room) as questions.
    @Published var micQuestions = UserDefaults.standard.bool(forKey: "micQuestions") {
        didSet { UserDefaults.standard.set(micQuestions, forKey: "micQuestions") }
    }
    @Published var fontSize = UserDefaults.standard.object(forKey: "fontSize") as? Double ?? 17 {
        didSet { UserDefaults.standard.set(fontSize, forKey: "fontSize") }
    }
    @Published var opacity = UserDefaults.standard.object(forKey: "opacity") as? Double ?? 0.85 {
        didSet { UserDefaults.standard.set(opacity, forKey: "opacity") }
    }
    @Published var model = ClaudeService.Model(rawValue: UserDefaults.standard.string(forKey: "model") ?? "") ?? .haiku {
        didSet {
            UserDefaults.standard.set(model.rawValue, forKey: "model")
            if oldValue != model { restartClaude() }
        }
    }

    private var knowledge: KnowledgeBase?
    private var whisperService: WhisperService?
    private var claudeService: ClaudeService?
    private let micCapture = MicCapture()
    private let systemCapture = SystemAudioCapture()
    private let micSegmenter = SpeechSegmenter()
    private let systemSegmenter = SpeechSegmenter()
    private let detector = QuestionDetector()
    private let log = SessionLog()
    private var meterTimer: Timer?

    var current: Answer? { answers.indices.contains(selected) ? answers[selected] : nil }

    func start() {
        guard let resources = Bundle.main.resourceURL else { return }
        do {
            knowledge = try KnowledgeBase(resources: resources)
        } catch {
            fatalError = error.localizedDescription
            return
        }
        guard let knowledge else { return }

        claudeService = ClaudeService(systemPromptFile: knowledge.systemPromptFile, model: model, handlers: .init(
            onDelta: { id, text in Task { @MainActor in self.appendDelta(id, text) } },
            onDone: { id, error in Task { @MainActor in self.finish(id, error: error) } },
            onReady: { ready, detail in Task { @MainActor in self.claude = ServiceStatus(ok: ready, detail: detail) } }
        ))
        claudeService?.start()

        let whisperService = WhisperService(vocabularyPrompt: knowledge.vocabularyPrompt)
        self.whisperService = whisperService
        Task {
            do {
                try await whisperService.start()
                whisper = ServiceStatus(ok: true, detail: "Whisper ready")
            } catch {
                whisper = ServiceStatus(ok: false, detail: error.localizedDescription)
            }
        }

        detector.onQuestion = { [weak self] question in
            guard let self, self.autoAnswer else { return }
            self.ask(question)
        }
        wire(micSegmenter, channel: .me)
        wire(systemSegmenter, channel: .others)
        micCapture.onSamples = { [micSegmenter] in micSegmenter.push($0) }
        systemCapture.onSamples = { [systemSegmenter] in systemSegmenter.push($0) }
        systemCapture.onStop = { error in
            Task { @MainActor in self.meet = ServiceStatus(ok: false, detail: "Meet audio stopped: \(error.localizedDescription)") }
        }

        let environment = ProcessInfo.processInfo.environment
        if let path = environment["SEMINAR_REHEARSE_PARTICIPANT"] {
            Task {
                while !(whisper.ok && claude.ok) { try? await Task.sleep(for: .milliseconds(300)) }
                do { try Rehearsal.play(fileAt: path, into: { [systemSegmenter] in systemSegmenter.push($0) }) } catch {
                    meet = ServiceStatus(ok: false, detail: "Rehearsal file: \(error.localizedDescription)")
                }
            }
        }
        if environment["SEMINAR_NO_LIVE_AUDIO"] == "1" {
            mic = ServiceStatus(ok: false, detail: "Live audio disabled (SEMINAR_NO_LIVE_AUDIO)")
            meet = ServiceStatus(ok: environment["SEMINAR_REHEARSE_PARTICIPANT"] != nil, detail: "Rehearsal")
        } else {
            startLiveAudio()
        }

        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor in
                self.micLevel = self.micSegmenter.level
                self.systemLevel = self.systemSegmenter.level
            }
        }
    }

    private func startLiveAudio() {
        Task {
            do {
                try await micCapture.start()
                mic = ServiceStatus(ok: true, detail: "Microphone")
            } catch {
                mic = ServiceStatus(ok: false, detail: error.localizedDescription)
            }
        }
        Task {
            do {
                try await systemCapture.start()
                meet = ServiceStatus(ok: true, detail: "System audio (Google Meet)")
            } catch {
                meet = ServiceStatus(ok: false, detail: "No system audio access: System Settings → Privacy & Security → Screen & System Audio Recording → enable SeminarOverlay, then relaunch")
            }
        }
    }

    func shutdown() {
        micCapture.stop()
        systemCapture.stop()
        claudeService?.stop()
        whisperService?.stop()
    }

    private func wire(_ segmenter: SpeechSegmenter, channel: Channel) {
        segmenter.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .onset:
                Task { @MainActor in self.speechStarted(channel) }
            case .partial(let audio):
                Task {
                    guard let text = await self.whisperService?.transcribePartial(audio, channel: channel), !text.isEmpty else { return }
                    await MainActor.run { if self.partial[channel] != nil { self.partial[channel] = text } }
                }
            case .final(let audio, let speechEnded):
                Task {
                    let text = audio.isEmpty ? "" : (await self.whisperService?.transcribeFinal(audio) ?? "")
                    await MainActor.run { self.utteranceFinished(channel, text: text, speechEnded: speechEnded) }
                }
            }
        }
    }

    private func speechStarted(_ channel: Channel) {
        partial[channel] = ""
        switch channel {
        case .others:
            detector.participantsSpeaking()
        case .me:
            // With speakers instead of headphones the mic also hears Meet; don't mistake that for the presenter.
            if !systemSegmenter.isSpeaking { detector.presenterSpeaking() }
        }
    }

    private func utteranceFinished(_ channel: Channel, text: String, speechEnded: Date) {
        partial[channel] = nil
        guard !text.isEmpty, !isEcho(channel, text) else {
            if channel == .others { detector.participantsStopped(speechEnded: speechEnded) }
            return
        }
        utterances.append(Utterance(channel: channel, text: text, time: speechEnded))
        log.write("**[\(channel.rawValue)]** \(text)", at: speechEnded)
        if utterances.count > 300 { utterances.removeFirst(utterances.count - 300) }
        if channel == .others || micQuestions {
            detector.add(text, speechEnded: speechEnded)
        }
    }

    /// The mic picking up Meet through the speakers produces a near-copy of a participant line.
    private func isEcho(_ channel: Channel, _ text: String) -> Bool {
        guard channel == .me else { return false }
        let words = Set(KnowledgeBase.stems(text))
        guard words.count >= 3 else { return false }
        return utterances.suffix(4).contains { other in
            guard other.channel == .others, Date().timeIntervalSince(other.time) < 15 else { return false }
            let otherWords = Set(KnowledgeBase.stems(other.text))
            return Double(words.intersection(otherWords).count) / Double(words.count) > 0.6
        }
    }

    // MARK: - Answers

    /// Manual trigger: whatever the participants are saying right now, else their last line.
    func answerNow() {
        var question = detector.takeBuffer() ?? ""
        if let live = partial[.others], !live.isEmpty { question += (question.isEmpty ? "" : " ") + live }
        if question.isEmpty {
            question = utterances.last(where: { $0.channel == .others })?.text ?? utterances.last?.text ?? ""
        }
        guard !question.isEmpty else { return }
        ask(question, force: true)
    }

    func ask(_ question: String, force: Bool = false) {
        guard let knowledge, let claudeService else { return }
        let match = knowledge.match(question)
        let opener = match.flatMap { Self.firstSentence($0.answer.a) } ?? Lexicon.shared.defaultOpener

        let context = utterances
            .filter { Date().timeIntervalSince($0.time) < 180 && !question.contains($0.text) }
            .suffix(12)
            .map { "[\($0.channel.rawValue)] \($0.text)" }
            .joined(separator: "\n")
        var message = context.isEmpty ? "" : "Recent transcript (context):\n\(context.suffix(2500))\n\n"
        message += "Question: [\(Channel.others.rawValue)] \(question)"
        if force { message += "\n\n(Andrii asked for an answer himself — even if this is not a question, suggest what to say.)" }

        let id = claudeService.ask(message)
        log.write("❓ **Question:** \(question)\(match.map { " _(prepared match \(Int($0.score * 100))%)_" } ?? "")")
        answers.append(Answer(id: id, question: question, opener: opener, prepared: match?.answer, preparedScore: match?.score ?? 0))
        selected = answers.count - 1
    }

    private static func firstSentence(_ text: String) -> String? {
        let cleaned = text.replacingOccurrences(of: Lexicon.shared.thanksPrefix, with: "")
        guard let end = cleaned.firstIndex(where: { ".!?".contains($0) }) else { return cleaned.isEmpty ? nil : cleaned }
        return String(cleaned[...end])
    }

    private func appendDelta(_ id: UUID, _ text: String) {
        guard let index = answers.firstIndex(where: { $0.id == id }) else { return }
        if answers[index].firstTokenAt == nil { answers[index].firstTokenAt = Date() }
        answers[index].text += text
    }

    private func finish(_ id: UUID, error: String?) {
        guard let index = answers.firstIndex(where: { $0.id == id }) else { return }
        answers[index].done = true
        answers[index].error = error
        let answer = answers[index]
        let firstWord = answer.firstTokenAt.map { String(format: "first word %.1f s, ", $0.timeIntervalSince(answer.askedAt)) } ?? ""
        let total = String(format: "%.1f", Date().timeIntervalSince(answer.askedAt))
        log.write("💬 **Answer** (\(firstWord)done \(total) s):\n\n\(error.map { "⚠︎ \($0)" } ?? answer.text)\n")
        // Organisational remarks come back as "—"; drop them so the previous real answer stays on screen.
        if answers[index].isNotAQuestion && answers.count > 1 && index == selected && index == answers.count - 1 {
            answers.remove(at: index)
            selected = answers.count - 1
        }
    }

    func step(_ delta: Int) {
        guard !answers.isEmpty else { return }
        selected = min(max(selected + delta, 0), answers.count - 1)
    }

    func restartClaude() {
        claude = ServiceStatus(ok: false, detail: "Restarting…")
        claudeService?.start(model: model)
    }
}
