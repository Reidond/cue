import AppKit
import Combine
import Foundation

enum Channel: String {
    case me, others

    var label: String { self == .me ? "You" : "Call" }
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
    let opener: String?
    let prepared: PreparedAnswer?
    let preparedScore: Double
    var text = ""
    var firstTokenAt: Date?
    var done = false
    var error: String?

    var isNotAQuestion: Bool { done && text.trimmingCharacters(in: .whitespacesAndNewlines) == "—" }

    /// Claude's first line, once it is complete.
    var firstLine: String? {
        if let newline = text.firstIndex(of: "\n") { return String(text[..<newline]).trimmingCharacters(in: .whitespaces) }
        return done && !text.isEmpty ? text.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    /// What to say right now: Claude's first line when ready, the instant opener until then.
    var sayNow: String? { firstLine ?? opener }

    var rest: [String] {
        guard let newline = text.firstIndex(of: "\n") else { return [] }
        return text[text.index(after: newline)...]
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

struct ServiceStatus: Equatable {
    var ok = false
    var detail = "Starting…"
}

/// Orchestrates audio → speech recognition → question detection → answers.
@MainActor
final class AppState: ObservableObject {
    let profile: Profile
    let downloader = ModelDownloader()

    @Published var utterances: [Utterance] = []
    @Published var partial: [Channel: String] = [:]
    @Published var answers: [Answer] = []
    @Published var selected = 0
    @Published var micLevel: Float = 0
    @Published var callLevel: Float = 0
    @Published var mic = ServiceStatus()
    @Published var call = ServiceStatus()
    @Published var whisper = ServiceStatus()
    @Published var claude = ServiceStatus()
    @Published private(set) var knowledge: KnowledgeBase?
    @Published private(set) var readingMaterials = false

    var openSettings: () -> Void = {}

    private var whisperService = WhisperService()
    private var claudeService: ClaudeService?
    private let micCapture = MicCapture()
    private let systemCapture = SystemAudioCapture()
    private let micSegmenter = SpeechSegmenter()
    private let systemSegmenter = SpeechSegmenter()
    private let detector = QuestionDetector()
    private let log = SessionLog()
    private var meterTimer: Timer?
    private var subscriptions: Set<AnyCancellable> = []
    private var knowledgeGeneration = 0

    init(profile: Profile) {
        self.profile = profile
    }

    var current: Answer? { answers.indices.contains(selected) ? answers[selected] : nil }

    /// One line for the control bar: what Cue is doing, or the first thing that needs attention.
    var status: (text: String, kind: StatusKind) {
        if readingMaterials { return ("Reading materials…", .working) }
        if let progress = downloader.progress { return ("Downloading speech model \(Int(progress * 100))%", .working) }
        if !whisper.ok { return (whisper.detail, whisper.detail.hasPrefix("Starting") ? .working : .problem) }
        if !claude.ok { return (claude.detail, claude.detail.contains("…") ? .working : .problem) }
        if !call.ok && !mic.ok { return ("No audio", .problem) }
        if profile.materials.isEmpty { return ("No materials", .problem) }
        return ("Listening", .ready)
    }

    enum StatusKind { case ready, working, problem }

    // MARK: - Lifecycle

    func start() {
        detector.onQuestion = { [weak self] question in
            guard let self, self.profile.autoAnswer else { return }
            self.ask(question)
        }
        wire(micSegmenter, channel: .me)
        wire(systemSegmenter, channel: .others)
        micCapture.onSamples = { [micSegmenter] in micSegmenter.push($0) }
        systemCapture.onSamples = { [systemSegmenter] in systemSegmenter.push($0) }
        systemCapture.onStop = { error in
            Task { @MainActor in self.call = ServiceStatus(ok: false, detail: "Call audio stopped: \(error.localizedDescription)") }
        }
        downloader.onFinished = { [weak self] in self?.startWhisper() }

        applyLanguage()
        rebuildKnowledge()
        startWhisper()
        startAudio()
        observeProfile()

        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor in
                self.micLevel = self.micSegmenter.level
                self.callLevel = self.systemSegmenter.level
            }
        }
    }

    func shutdown() {
        micCapture.stop()
        systemCapture.stop()
        claudeService?.stop()
        whisperService.stop()
    }

    private func observeProfile() {
        // Anything that changes the system prompt rebuilds it; Claude restarts only if the bytes changed.
        Publishers.Merge4(
            profile.$materials.map { _ in () },
            profile.$speakerName.map { _ in () },
            profile.$occasion.map { _ in () },
            profile.$languageCode.map { _ in () }
        )
        .dropFirst(4)
        .debounce(for: .seconds(1.2), scheduler: RunLoop.main)
        .sink { [weak self] in
            self?.applyLanguage()
            self?.rebuildKnowledge()
        }
        .store(in: &subscriptions)

        profile.$vocabulary.dropFirst()
            .debounce(for: .seconds(0.5), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.applyLanguage() }
            .store(in: &subscriptions)

        profile.$model.dropFirst().removeDuplicates()
            .sink { [weak self] model in self?.restartClaude(model: model) }
            .store(in: &subscriptions)

        // Re-publish so the overlay's status line follows the download.
        downloader.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)
    }

    private func applyLanguage() {
        let lexicon = profile.lexicon
        detector.cues = lexicon.questionCues
        let whisperService = whisperService
        let language = profile.languageCode, prompt = profile.whisperPrompt, hallucinations = lexicon.hallucinations
        Task { await whisperService.configure(language: language, vocabularyPrompt: prompt, hallucinations: hallucinations) }
    }

    func rebuildKnowledge() {
        knowledgeGeneration += 1
        let generation = knowledgeGeneration
        let materials = profile.materials
        let context = PromptContext(speaker: profile.speakerName, occasion: profile.occasion, languageCode: profile.languageCode)
        readingMaterials = true
        Task.detached(priority: .userInitiated) {
            let knowledge = KnowledgeBase.build(materials: materials, context: context)
            let changed = (try? knowledge.writeSystemPrompt()) ?? true
            await MainActor.run {
                guard generation == self.knowledgeGeneration else { return }
                self.knowledge = knowledge
                self.readingMaterials = false
                let files = knowledge.documents.map { "\($0.name) — \($0.error ?? $0.summary)" }.joined(separator: "; ")
                self.log.write("📚 Materials (~\(knowledge.estimatedTokens / 1000)k tokens): \(files.isEmpty ? "none" : files)")
                if changed || self.claudeService == nil { self.restartClaude(model: self.profile.model) }
            }
        }
    }

    func restartClaude(model: ClaudeService.Model? = nil) {
        guard knowledge != nil else { return }
        claude = ServiceStatus(ok: false, detail: "Warming up…")
        if claudeService == nil {
            claudeService = ClaudeService(systemPromptFile: KnowledgeBase.systemPromptFile, model: profile.model, handlers: .init(
                onDelta: { id, text in Task { @MainActor in self.appendDelta(id, text) } },
                onDone: { id, error in Task { @MainActor in self.finish(id, error: error) } },
                onReady: { ready, detail in Task { @MainActor in self.claude = ServiceStatus(ok: ready, detail: detail) } }
            ))
        }
        claudeService?.start(model: model ?? profile.model)
    }

    func startWhisper() {
        whisper = ServiceStatus(ok: false, detail: "Starting speech recognition…")
        let whisperService = whisperService
        Task {
            do {
                try await whisperService.start()
                whisper = ServiceStatus(ok: true, detail: "Speech recognition ready")
                startRehearsalIfRequested()
            } catch {
                whisper = ServiceStatus(ok: false, detail: error.localizedDescription)
            }
        }
    }

    private func startAudio() {
        let environment = ProcessInfo.processInfo.environment
        if environment["CUE_NO_LIVE_AUDIO"] == "1" {
            mic = ServiceStatus(ok: false, detail: "Live audio off (CUE_NO_LIVE_AUDIO)")
            call = ServiceStatus(ok: environment["CUE_REHEARSE_PARTICIPANT"] != nil, detail: "Rehearsal")
            return
        }
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
                call = ServiceStatus(ok: true, detail: "Call audio")
            } catch {
                call = ServiceStatus(ok: false, detail: "No access to call audio — allow Cue in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen it")
            }
        }
    }

    /// Rehearsal mode: CUE_REHEARSE_PARTICIPANT=/path/to/audio plays a recording as the call.
    private func startRehearsalIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["CUE_REHEARSE_PARTICIPANT"] else { return }
        Task {
            while !claude.ok { try? await Task.sleep(for: .milliseconds(300)) }
            do {
                try Rehearsal.play(fileAt: path, into: { [systemSegmenter] in systemSegmenter.push($0) })
            } catch {
                call = ServiceStatus(ok: false, detail: "Rehearsal file: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Speech

    private func wire(_ segmenter: SpeechSegmenter, channel: Channel) {
        segmenter.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .onset:
                Task { @MainActor in self.speechStarted(channel) }
            case .partial(let audio):
                Task {
                    guard let text = await self.whisperService.transcribePartial(audio, channel: channel), !text.isEmpty else { return }
                    await MainActor.run { if self.partial[channel] != nil { self.partial[channel] = text } }
                }
            case .final(let audio, let speechEnded):
                Task {
                    let text = audio.isEmpty ? "" : await self.whisperService.transcribeFinal(audio)
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
            // With speakers instead of headphones the mic also hears the call; don't mistake that for the user.
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
        if utterances.count > 300 { utterances.removeFirst(utterances.count - 300) }
        log.write("**[\(promptLabel(channel))]** \(text)", at: speechEnded)
        if channel == .others || profile.micQuestions {
            detector.add(text, speechEnded: speechEnded)
        }
    }

    /// The mic picking up the call through speakers produces a near-copy of a participant line.
    private func isEcho(_ channel: Channel, _ text: String) -> Bool {
        guard channel == .me else { return false }
        let stopWords = profile.lexicon.stopWords
        let words = Set(KnowledgeBase.stems(text, stopWords: stopWords))
        guard words.count >= 3 else { return false }
        return utterances.suffix(4).contains { other in
            guard other.channel == .others, Date().timeIntervalSince(other.time) < 15 else { return false }
            let otherWords = Set(KnowledgeBase.stems(other.text, stopWords: stopWords))
            return Double(words.intersection(otherWords).count) / Double(words.count) > 0.6
        }
    }

    private func promptLabel(_ channel: Channel) -> String {
        channel == .me ? (profile.speakerName.isEmpty ? "Speaker" : profile.speakerName) : "Participant"
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
        guard let claudeService else { return }
        let lexicon = profile.lexicon
        let match = knowledge?.match(question)
        let opener = match.flatMap { Self.firstSentence($0.answer.a, dropping: lexicon.thanksPrefix) }
            ?? (lexicon.defaultOpener.isEmpty ? nil : lexicon.defaultOpener)

        let context = utterances
            .filter { Date().timeIntervalSince($0.time) < 180 && !question.contains($0.text) }
            .suffix(12)
            .map { "[\(promptLabel($0.channel))] \($0.text)" }
            .joined(separator: "\n")
        var message = context.isEmpty ? "" : "Recent transcript (context):\n\(context.suffix(2500))\n\n"
        message += "Question: [\(promptLabel(.others))] \(question)"
        if force { message += "\n\n(The speaker asked for an answer themselves — even if this is not a question, suggest what to say.)" }

        let id = claudeService.ask(message)
        log.write("❓ **Question:** \(question)\(match.map { " _(prepared match \(Int($0.score * 100))%)_" } ?? "")")
        answers.append(Answer(id: id, question: question, opener: opener, prepared: match?.answer, preparedScore: match?.score ?? 0))
        selected = answers.count - 1
    }

    private static func firstSentence(_ text: String, dropping prefix: String) -> String? {
        let cleaned = prefix.isEmpty ? text : text.replacingOccurrences(of: prefix, with: "")
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
        if answer.isNotAQuestion && answers.count > 1 && index == selected && index == answers.count - 1 {
            answers.remove(at: index)
            selected = answers.count - 1
        }
    }

    func step(_ delta: Int) {
        guard !answers.isEmpty else { return }
        selected = min(max(selected + delta, 0), answers.count - 1)
    }
}
