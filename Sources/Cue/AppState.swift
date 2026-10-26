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
    let started: Date
    /// When the speaker stopped.
    let time: Date
    /// Which of the call's voices said it (1, 2, …), once they have been told apart.
    var speaker: Int?

    /// The microphone picking up the call through speakers produces a near-copy of a participant line.
    static func isEcho(_ text: String, of other: String, stopWords: Set<String>) -> Bool {
        let words = Set(KnowledgeBase.stems(text, stopWords: stopWords))
        guard words.count >= 3 else { return false }
        let otherWords = Set(KnowledgeBase.stems(other, stopWords: stopWords))
        return Double(words.intersection(otherWords).count) / Double(words.count) > 0.6
    }
}

/// What was asked in one go: one question or several, each answered on its own and shown together.
struct Exchange: Identifiable {
    let id = UUID()
    var answers: [Answer]

    /// Noticed with Auto off: the questions wait for Prepare Answer.
    var waiting: Bool { answers.contains { !$0.requested } }
    var isNotAQuestion: Bool { answers.allSatisfy(\.isNotAQuestion) }
}

struct Answer: Identifiable {
    /// Also the id of its request to Claude.
    let id = UUID()
    let question: String
    var askedAt = Date()
    /// Shown the instant the question lands, before Claude says anything.
    let opener: String?
    let prepared: PreparedAnswer?
    let preparedScore: Double
    /// Sent to Claude (a question noticed with Auto off isn't, until Prepare Answer).
    var requested = true
    var text = ""
    var firstTokenAt: Date?
    var done = false
    var error: String?

    /// Claude's "—": nothing to answer (even when it explains why after the dash).
    var isNotAQuestion: Bool { done && text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("—") }
    /// The first words of a real answer have come (not "—").
    var isUnderWay: Bool {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !said.hasPrefix("—") && said.contains { !"—- \n".contains($0) }
    }

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
    let preferences: Preferences
    let projects: ProjectStore
    let downloader = ModelDownloader()
    /// The models that tell the voices on a call apart.
    let speakerModels: SpeakerModels
    let recorder = CallRecorder()
    let recordings: RecordingStore
    /// Plays the audio of the note open in the dashboard.
    let player: NotePlayer
    let calendar: MeetingCalendar
    private(set) lazy var meetings = MeetingMonitor(state: self)

    /// The project Cue answers from and records into.
    @Published private(set) var activeProject: Project?

    @Published var utterances: [Utterance] = []
    @Published var partial: [Channel: String] = [:]
    /// Everything asked so far, oldest first.
    @Published private(set) var exchanges: [Exchange] = []
    /// The exchange shown in full in the overlay's list (also its index, `selected`). One Cue
    /// noticed by itself takes it only once Claude starts a real answer, so an organisational remark
    /// ("—") never pushes the answer being read out of view, and not while the user reads another.
    @Published private(set) var expandedID: UUID?
    @Published private(set) var selected = 0
    /// The user opened an older exchange to read it: new ones wait under a "new questions" button.
    @Published private(set) var holding = false
    /// The overlay's list is scrolled away from its newest end, which holds the view in place too.
    var listScrolled = false { didSet { if !listScrolled && !holding { unseen = [] } } }
    /// Exchanges that came in while the view was held: kept out of the list until the "new questions"
    /// button (or the newest end of the list) shows them.
    @Published private(set) var unseen: Set<UUID> = []
    /// Whether the speaker reads the answer in view aloud: they started talking after it came into view and
    /// haven't paused for `readingPause` since. New questions meanwhile wait in the list's New group, under
    /// the answer being read, and the newest comes into view when they pause — the text being read never
    /// moves. Talking once they're done with it ("Thank you for the question") holds nothing back.
    private enum Reading { case notYet, reading, done }
    private var reading = Reading.notYet
    private var presenterSpoke = Date.distantPast
    private let readingPause: TimeInterval = 5
    /// The exchanges held back while the speaker read.
    private var heldWhileReading: Set<UUID> = []
    /// Exchanges shown in full at some point: once another takes their place, they've been answered.
    @Published private(set) var seen: Set<UUID> = []

    /// The exchange shown in full, at the top of the list.
    var current: Exchange? { exchanges.first { $0.id == expandedID } }
    /// Under it, newest first: the ones not shown in full yet — still coming, ready, or waiting for
    /// Prepare Answer.
    var newExchanges: [Exchange] {
        exchanges.reversed().filter { $0.id != expandedID && !unseen.contains($0.id) && !seen.contains($0.id) && !$0.isNotAQuestion }
    }
    /// At the bottom, newest first: the ones shown and left, and remarks that weren't questions.
    var answeredExchanges: [Exchange] {
        exchanges.reversed().filter { $0.id != expandedID && !unseen.contains($0.id) && (seen.contains($0.id) || $0.isNotAQuestion) }
    }
    @Published var micLevel: Float = 0
    @Published var callLevel: Float = 0
    @Published var mic = ServiceStatus()
    @Published var call = ServiceStatus()
    /// Speech recognition, by whichever provider: whisper-server's start, or Deepgram's key check.
    @Published var speech = ServiceStatus()
    @Published var claude = ServiceStatus()
    @Published private(set) var knowledge: KnowledgeBase?
    @Published private(set) var readingMaterials = false
    /// Between Start Cue and Stop Cue: the overlay is up and Cue listens for questions.
    @Published private(set) var cueRunning = false
    /// The microphone and call audio are open: while Cue runs, or while a call is recorded.
    private var capturing = false

    var openSettings: () -> Void = {}
    /// Settings on its Providers tab.
    var openProviders: () -> Void = {}
    var openDashboard: () -> Void = {}
    var openRecordings: (_ selecting: String?) -> Void = { _ in }
    var showOverlay: () -> Void = {}
    var hideOverlay: () -> Void = {}

    private let whisperService = WhisperService()
    private let deepgramService = DeepgramService()
    /// The service `speech` is about: the provider's.
    private lazy var recognizer: SpeechRecognizer = preferences.speechProvider == .deepgram ? deepgramService : whisperService
    private var rehearsalStarted = false
    private var claudeService: ClaudeSession?
    /// The provider `claudeService` goes through.
    private var claudeProvider: ClaudeProvider?
    private let micCapture = MicCapture()
    private let systemCapture = SystemAudioCapture()
    private let micSegmenter = SpeechSegmenter()
    private let systemSegmenter = SpeechSegmenter()
    private let audioRecorder = AudioRecorder()
    private let detector = QuestionDetector()
    private let judge = QuestionJudge()
    let log: SessionLog
    private var meterTimer: Timer?
    private var subscriptions: Set<AnyCancellable> = []
    private var knowledgeGeneration = 0
    /// What the current knowledge was built from, so unrelated project edits don't re-read the materials.
    private var knowledgeInputs: KnowledgeInputs?
    /// Where the recording in progress goes, even if the user switches project meanwhile.
    private var recordingProject: Project?
    /// The calendar event being recorded, if the recording is for one.
    private var recordingMeeting: MeetingDetails?

    private struct KnowledgeInputs: Equatable {
        var materials: [URL]
        var context: PromptContext
    }

    init(preferences: Preferences) {
        self.preferences = preferences
        let log = SessionLog()
        self.log = log
        projects = ProjectStore(preferences: preferences)
        projects.migrateLegacySettings(log: log)
        speakerModels = SpeakerModels(log: log)
        recordings = RecordingStore(preferences: preferences, projects: projects, speakerModels: speakerModels, log: log)
        recordings.reload()
        player = NotePlayer(log: log)
        AudioRecorder.removeStaleWorkingFolders()
        calendar = MeetingCalendar(preferences: preferences)
        // CUE_PROJECT=name picks the project at launch (creating it when missing); otherwise the last one used.
        if let name = ProcessInfo.processInfo.environment["CUE_PROJECT"] {
            activeProject = projects.project(named: name) ?? (try? projects.create(named: name))
        } else {
            activeProject = projects.project(preferences.activeProject) ?? projects.mostRecent
        }
        preferences.activeProject = activeProject?.id
        if let activeProject { log.write("📁 Project: \(activeProject.name)") }
    }

    /// The active project's language data.
    var lexicon: Lexicon { activeProject?.lexicon ?? Lexicon.load(Project.defaultLanguage) }

    /// One line for the control bar: what Cue is doing, or the first thing that needs attention.
    var status: (text: String, kind: StatusKind) {
        if readingMaterials { return ("Reading materials…", .working) }
        if let progress = downloader.progress { return ("Downloading speech model \(Int(progress * 100))%", .working) }
        if !speech.ok { return (speech.detail, speech.detail.hasPrefix("Starting") ? .working : .problem) }
        if !claude.ok { return (claude.detail, claude.detail.contains("…") ? .working : .problem) }
        if !call.ok && !mic.ok { return ("No audio", .problem) }
        guard let activeProject else { return ("No project", .problem) }
        if activeProject.materials.isEmpty { return ("No materials", .problem) }
        return ("Listening", .ready)
    }

    enum StatusKind { case ready, working, problem }

    // MARK: - Lifecycle

    func start() {
        // With Auto off, the questions are listed for Prepare Answer instead of answered.
        detector.onQuestions = { [weak self] questions in
            guard let self else { return }
            self.ask(questions, request: self.preferences.autoAnswer)
        }
        // The judge decides what is a question for the speaker; the detector, when it was asked.
        detector.judge = { [weak self] speech, verdict in
            guard let self else { return verdict(nil) }
            self.judge.judge(self.judgeMessage(speech), verdict: verdict)
        }
        judge.onState = { [weak self] state in
            switch state {
            case .ready: self?.log.write("🧐 Question judge ready: Claude Haiku")
            case .unavailable(let detail): self?.log.write("⚠︎ Question judge unavailable (\(detail)) — going by question marks")
            case .starting: break
            }
        }
        wire(micSegmenter, channel: .me)
        wire(systemSegmenter, channel: .others)
        micCapture.onSamples = { [micSegmenter, audioRecorder] samples, time in
            micSegmenter.push(samples)
            audioRecorder.push(samples, from: .me, at: time)
        }
        systemCapture.onSamples = { [systemSegmenter, audioRecorder] samples, time in
            systemSegmenter.push(samples)
            audioRecorder.push(samples, from: .others, at: time)
        }
        systemCapture.onStop = { error in
            Task { @MainActor in self.call = ServiceStatus(ok: false, detail: "Call audio stopped: \(error.localizedDescription)") }
        }
        downloader.onFinished = { [weak self] in if self?.preferences.speechProvider == .whisper { self?.startSpeech() } }
        preferences.onKeyChange = { [weak self] key, saved in self?.keyChanged(key, saved: saved) }
        log.write("🤖 Claude: \(preferences.claudeProvider.title)")
        log.write("🗣 Speech recognition: \(preferences.speechProvider.title)")
        let deepgramService = deepgramService
        Task {
            await deepgramService.setProblemHandler { problem in
                Task { @MainActor in self.speechProblem(problem) }
            }
        }

        applyLanguage()
        rebuildKnowledge()
        startSpeech()
        // Listening starts with Start Cue (or a recording), not at launch.
        mic = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
        call = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
        observeSettings()
        meetings.start()

        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor in
                self.micLevel = self.micSegmenter.level
                self.callLevel = self.systemSegmenter.level
                self.checkReading()
            }
        }
    }

    func shutdown() {
        recordings.cancelAll()
        audioRecorder.cancel()
        micCapture.stop()
        systemCapture.stop()
        claudeService?.stop()
        judge.stop()
        whisperService.stop()
        deepgramService.stop()
    }

    private func observeSettings() {
        // Edits to the active project on its page (and files added to it) arrive through the store.
        projects.$projects
            .sink { [weak self] projects in
                guard let self, let id = self.activeProject?.id,
                      let updated = projects.first(where: { $0.id == id }), updated != self.activeProject else { return }
                self.activeProject = updated
            }
            .store(in: &subscriptions)
        projects.$projects.map { $0.map(\.id) }.removeDuplicates().dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.recordings.reload() }
            .store(in: &subscriptions)
        preferences.$libraryFolder.dropFirst().removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.projects.reload()
                self?.projectsChanged()
            }
            .store(in: &subscriptions)

        // Anything that changes the system prompt rebuilds it; Claude restarts only if the bytes changed.
        // @Published sends the new value before storing it, so build the inputs from what was sent.
        Publishers.CombineLatest($activeProject, preferences.$speakerName)
            .map { Self.knowledgeInputs(project: $0, speaker: $1) }
            .removeDuplicates()
            .dropFirst()
            .debounce(for: .seconds(1.2), scheduler: RunLoop.main)
            .sink { [weak self] inputs in
                guard let self, inputs != self.knowledgeInputs else { return }
                self.applyLanguage()
                self.rebuildKnowledge()
            }
            .store(in: &subscriptions)

        $activeProject.map { $0?.whisperPrompt }.removeDuplicates().dropFirst()
            .debounce(for: .seconds(0.5), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.applyLanguage() }
            .store(in: &subscriptions)

        preferences.$model.dropFirst().removeDuplicates()
            .sink { [weak self] model in self?.restartClaude(model: model) }
            .store(in: &subscriptions)

        // Settings › Providers: speech recognition, live and after a recording, by the provider picked there…
        preferences.$speechProvider.removeDuplicates().dropFirst()
            .sink { [weak self] provider in
                self?.log.write("🗣 Speech recognition: \(provider.title)")
                self?.startSpeech(provider: provider)
            }
            .store(in: &subscriptions)
        // …and answers, the judge and summaries too.
        preferences.$claudeProvider.removeDuplicates().dropFirst()
            .sink { [weak self] provider in
                guard let self else { return }
                self.log.write("🤖 Claude: \(provider.title)")
                self.restartClaude(provider: provider)
                if let context = self.knowledgeInputs?.context { self.judge.configure(context, provider: provider) }
            }
            .store(in: &subscriptions)

        projects.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)

        // Re-publish so the overlay follows the download and the recorder.
        downloader.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)
        recorder.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)
    }

    private func applyLanguage() {
        let lexicon = self.lexicon
        let language = activeProject?.language ?? Project.defaultLanguage, prompt = activeProject?.whisperPrompt ?? ""
        let terms = activeProject?.terms ?? [], hallucinations = lexicon.hallucinations
        for recognizer in [whisperService, deepgramService] as [SpeechRecognizer] {
            Task { await recognizer.configure(language: language, prompt: prompt, terms: terms, hallucinations: hallucinations) }
        }
    }

    private static func knowledgeInputs(project: Project?, speaker: String) -> KnowledgeInputs {
        KnowledgeInputs(materials: project?.materials ?? [],
                        context: PromptContext(speaker: speaker, occasion: project?.occasion ?? "",
                                               languageCode: project?.language ?? Project.defaultLanguage))
    }

    func rebuildKnowledge() {
        knowledgeGeneration += 1
        let generation = knowledgeGeneration
        let inputs = Self.knowledgeInputs(project: activeProject, speaker: preferences.speakerName)
        knowledgeInputs = inputs
        let materials = inputs.materials, context = inputs.context
        let project = activeProject?.name ?? "no project"
        readingMaterials = true
        Task.detached(priority: .userInitiated) {
            let knowledge = KnowledgeBase.build(materials: materials, context: context)
            let changed = (try? knowledge.writeSystemPrompt()) ?? true
            await MainActor.run {
                guard generation == self.knowledgeGeneration else { return }
                self.knowledge = knowledge
                self.readingMaterials = false
                let files = knowledge.documents.map { "\($0.name) — \($0.error ?? $0.summary)" }.joined(separator: "; ")
                self.log.write("📚 Materials for \(project) (~\(knowledge.estimatedTokens / 1000)k tokens): \(files.isEmpty ? "none" : files)")
                if changed || self.claudeService == nil { self.restartClaude(model: self.preferences.model) }
                self.judge.configure(context, provider: self.preferences.claudeProvider)
            }
        }
    }

    /// `provider` when it just changed (the preference still has the old one).
    func restartClaude(model: ClaudeService.Model? = nil, provider: ClaudeProvider? = nil) {
        guard knowledge != nil else { return }
        claude = ServiceStatus(ok: false, detail: "Warming up…")
        let provider = provider ?? preferences.claudeProvider
        if claudeService == nil || provider != claudeProvider {
            claudeService?.stop()
            claudeProvider = provider
            claudeService = makeClaudeSession(provider, systemPromptFile: KnowledgeBase.systemPromptFile, model: preferences.model, handlers: .init(
                onDelta: { id, text in Task { @MainActor in self.appendDelta(id, text) } },
                onDone: { id, error in Task { @MainActor in self.finish(id, error: error) } },
                onReady: { ready, detail in Task { @MainActor in self.claude = ServiceStatus(ok: ready, detail: detail) } }
            ))
        }
        claudeService?.start(model: model ?? preferences.model)
    }

    /// A key saved or removed in Settings › Providers: the provider that uses it starts again with it.
    private func keyChanged(_ key: APIKey, saved: Bool) {
        log.write("🔑 \(key.title) \(saved ? "saved in the keychain" : "removed")")
        switch key {
        case .anthropic where preferences.claudeProvider == .anthropicAPI:
            restartClaude()
            judge.restart()
        case .deepgram where preferences.speechProvider == .deepgram:
            startSpeech()
        default:
            break
        }
    }

    /// Starts the provider's speech recognition (`provider` when it just changed): whisper-server, or a
    /// check of the Deepgram key. The other one stops, so whisper-server doesn't hold the GPU for nothing.
    func startSpeech(provider: SpeechProvider? = nil) {
        let provider = provider ?? preferences.speechProvider
        recognizer = provider == .deepgram ? deepgramService : whisperService
        (provider == .deepgram ? whisperService as SpeechRecognizer : deepgramService).stop()
        for segmenter in [micSegmenter, systemSegmenter] {
            segmenter.partialFrames = Int(recognizer.partialInterval * whisperSampleRate) / 320
        }
        speech = ServiceStatus(ok: false, detail: "Starting speech recognition…")
        let recognizer = recognizer
        Task {
            do {
                try await recognizer.start()
                guard recognizer === self.recognizer else { return }
                speech = ServiceStatus(ok: true, detail: "Speech recognition ready")
                startRehearsalIfRequested()
            } catch {
                guard recognizer === self.recognizer else { return }
                speech = ServiceStatus(ok: false, detail: error.localizedDescription)
                log.write("⚠︎ Speech recognition unavailable: \(error.localizedDescription)")
            }
        }
    }

    /// A Deepgram stream failed after starting fine (a key revoked, no credit left, the connection lost), or,
    /// with nil, one answered again after that.
    private func speechProblem(_ problem: String?) {
        guard preferences.speechProvider == .deepgram else { return }
        if let problem {
            guard speech.ok || speech.detail != problem else { return }
            speech = ServiceStatus(ok: false, detail: problem)
            log.write("⚠︎ Speech recognition unavailable: \(problem)")
        } else if !speech.ok {
            speech = ServiceStatus(ok: true, detail: "Speech recognition ready")
            log.write("🗣 Speech recognition ready again: Deepgram")
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
                // Stop Cue may have come while the microphone was starting.
                guard capturing else { return micCapture.stop() }
                mic = ServiceStatus(ok: true, detail: "Microphone")
            } catch {
                mic = ServiceStatus(ok: false, detail: error.localizedDescription)
            }
        }
        Task {
            do {
                try await systemCapture.start()
                guard capturing else { return systemCapture.stop() }
                call = ServiceStatus(ok: true, detail: "Call audio")
            } catch {
                call = ServiceStatus(ok: false, detail: "No access to call audio — allow Cue in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen it")
            }
        }
    }

    /// Opens the microphone and call audio while Cue runs or a call is recorded, and closes them after.
    private func updateCapture() {
        let needed = cueRunning || recorder.startedAt != nil
        guard needed != capturing else { return }
        capturing = needed
        if needed {
            startAudio()
            log.write("🎤 Listening")
        } else {
            micCapture.stop()
            systemCapture.stop()
            partial = [:]
            mic = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
            call = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
            log.write("🎤 Listening stopped")
        }
    }

    /// Rehearsal mode: CUE_REHEARSE_PARTICIPANT=/path/to/audio plays a recording as the call.
    private func startRehearsalIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["CUE_REHEARSE_PARTICIPANT"], !rehearsalStarted else { return }
        rehearsalStarted = true
        Task {
            while !claude.ok || judge.state == .starting { try? await Task.sleep(for: .milliseconds(300)) }
            do {
                // CUE_REHEARSE_RECORD=1 also records the rehearsal and writes its notes.
                let record = ProcessInfo.processInfo.environment["CUE_REHEARSE_RECORD"] == "1"
                if record { startRecording(.rehearsal) }
                var length = try Rehearsal.play(fileAt: path) { [systemSegmenter, audioRecorder] samples, time in
                    systemSegmenter.push(samples)
                    // ScreenCaptureKit delivers nothing while the Mac plays nothing; the recorder gets the same here.
                    if samples.contains(where: { $0 != 0 }) { audioRecorder.push(samples, from: .others, at: time) }
                }
                // CUE_REHEARSE_ME plays a second recording as your microphone, in parallel.
                if let mine = ProcessInfo.processInfo.environment["CUE_REHEARSE_ME"] {
                    length = max(length, try Rehearsal.play(fileAt: mine) { [micSegmenter, audioRecorder] samples, time in
                        micSegmenter.push(samples)
                        audioRecorder.push(samples, from: .me, at: time)
                    })
                }
                if record {
                    try? await Task.sleep(for: .seconds(length + 1))
                    stopRecording(.rehearsal)
                }
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
                Task { await self.recognizer.begin(channel: channel) }
                Task { @MainActor in self.speechStarted(channel) }
            case .partial(let audio):
                Task {
                    guard let text = await self.recognizer.transcribePartial(audio, channel: channel), !text.isEmpty else { return }
                    await MainActor.run { if self.partial[channel] != nil { self.partial[channel] = text } }
                }
            case .final(let audio, let speechStarted, let speechEnded):
                Task {
                    let text = await self.recognizer.transcribeFinal(audio, channel: channel)
                    await MainActor.run {
                        self.utteranceFinished(channel, text: text, speechStarted: speechStarted, speechEnded: speechEnded)
                    }
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
            guard !systemSegmenter.isSpeaking else { return }
            detector.presenterSpeaking()
            presenterSpoke = Date()
            if reading == .notYet && expandedID != nil { reading = .reading }
        }
    }

    private func utteranceFinished(_ channel: Channel, text: String, speechStarted: Date, speechEnded: Date) {
        partial[channel] = nil
        guard !text.isEmpty, !isEcho(channel, text) else {
            if channel == .others { detector.participantsStopped(speechEnded: speechEnded) }
            return
        }
        let utterance = Utterance(channel: channel, text: text, started: speechStarted, time: speechEnded)
        utterances.append(utterance)
        if utterances.count > 300 { utterances.removeFirst(utterances.count - 300) }
        recorder.add(utterance)
        log.write("**[\(promptLabel(channel))]** \(text)", at: speechEnded)
        // Questions are only looked for while Cue runs, as only then the overlay shows them.
        if cueRunning, channel == .others || preferences.micQuestions {
            detector.add(text, from: judgeLabel(channel), speechStarted: speechStarted, speechEnded: speechEnded)
        }
    }

    /// The mic picking up the call through speakers produces a near-copy of a participant line.
    private func isEcho(_ channel: Channel, _ text: String) -> Bool {
        guard channel == .me else { return false }
        let stopWords = lexicon.stopWords
        return utterances.suffix(4).contains { other in
            other.channel == .others && Date().timeIntervalSince(other.time) < 15
                && Utterance.isEcho(text, of: other.text, stopWords: stopWords)
        }
    }

    private func promptLabel(_ channel: Channel) -> String {
        channel == .me ? (preferences.speakerName.isEmpty ? "Speaker" : preferences.speakerName) : "Participant"
    }

    // MARK: - Projects

    /// Binds Cue to a project: its materials, language and names and terms.
    func activate(_ project: Project) {
        var project = projects.project(project.id) ?? project
        project.lastUsed = Date()
        projects.update(project)
        guard project.id != activeProject?.id else { return }
        activeProject = project
        preferences.activeProject = project.id
        log.write("📁 Project: \(project.name)")
        applyLanguage()
        rebuildKnowledge()
    }

    /// The project page's Start Cue: shows the overlay and listens, answering from this project.
    func startCue(_ project: Project) {
        activate(project)
        startListening()
    }

    /// Shows the overlay and listens, with the current project (a rehearsal, ⌃⌥H).
    func startListening() {
        showOverlay()
        guard !cueRunning else { return }
        cueRunning = true
        log.write("▶︎ Cue started\(activeProject.map { ": \($0.name)" } ?? "")")
        updateCapture()
    }

    /// Stop Cue: hides the overlay and stops listening. A call being recorded keeps recording.
    func stopCue() {
        guard cueRunning else { return }
        cueRunning = false
        hideOverlay()
        _ = detector.take()
        log.write("⏹ Cue stopped")
        updateCapture()
    }

    /// After a rename or delete on the dashboard.
    func projectsChanged(renamed old: Project? = nil, to new: Project? = nil) {
        if let old, let new { calendar.projectRenamed(from: old.id, to: new.id) }
        if let old, let new, old.id == activeProject?.id {
            activeProject = new
            preferences.activeProject = new.id
        } else if let active = activeProject, projects.project(active.id) == nil {
            activeProject = nil
            preferences.activeProject = nil
            if let next = projects.mostRecent {
                activate(next)
            } else {
                applyLanguage()
                rebuildKnowledge()
            }
        }
        recordings.reload()
    }

    // MARK: - Recording

    /// What started or stopped a recording. The session log names it, so notes that end early say why.
    enum RecordingTrigger: String {
        case hotKey = "⌃⌥R", overlay, dashboard, menuBar = "menu bar", upcoming = "Upcoming"
        case notification = "Record in the notification", callNoticed = "call noticed", callEnded = "call ended"
        case rehearsal
    }

    func toggleRecording(_ trigger: RecordingTrigger) {
        if recorder.isRecording { stopRecording(trigger) } else if !recorder.stopping { startRecording(trigger) }
    }

    func startRecording(_ trigger: RecordingTrigger) {
        startRecording(into: activeProject, by: trigger)
    }

    /// Records into a given project, e.g. a calendar event's, named after the event when there is one.
    func startRecording(into project: Project?, meeting: MeetingDetails? = nil, by trigger: RecordingTrigger) {
        recordingProject = project
        recordingMeeting = meeting
        audioRecorder.start(at: recorder.start())
        log.write("⏺ Recording started (\(trigger.rawValue))")
        updateCapture()
    }

    /// Waits for the last phrase to be transcribed, then saves the notes and audio and summarizes.
    func stopRecording(_ trigger: RecordingTrigger) {
        stopRecording(automatically: false, by: trigger)
    }

    /// `automatically` when Cue ends the recording itself because the call ended: the note isn't
    /// opened and an empty recording isn't an alert. `saved` gets the note's id (nil if nothing was heard).
    func stopRecording(automatically: Bool, by trigger: RecordingTrigger, saved: @escaping (String?) -> Void = { _ in }) {
        guard recorder.isRecording, let started = recorder.startedAt else { return }
        let ended = recorder.beginStop()
        audioRecorder.stop(at: ended)
        log.write("⏹ Recording stopped after \(RecordingStore.clock(ended.timeIntervalSince(started).rounded(.down))) (\(trigger.rawValue))")
        let meeting = recordingMeeting
        recordingMeeting = nil
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            let audio = await audioRecorder.finish()
            let finished = recorder.finish()
            updateCapture()  // closes the audio again unless Cue is running
            guard let transcript = finished else { return }
            guard !transcript.lines.isEmpty else {
                audio.map { try? FileManager.default.removeItem(at: $0.folder) }
                saved(nil)
                guard !automatically else { return }
                let alert = NSAlert()
                alert.messageText = "Nothing was recorded"
                alert.informativeText = "Cue didn't hear any speech while recording, so no notes were saved."
                alert.show(logging: log)
                return
            }
            // Without a project (none created yet), recordings go to "Meetings".
            let project = recordingProject.flatMap { projects.project($0.id) } ?? activeProject
                ?? projects.project(named: "Meetings") ?? (try? projects.create(named: "Meetings"))
            guard let project else { return }
            // The language live recognition used: the bound project's, which a meeting's project may not share.
            let spoken = activeProject?.language ?? Project.defaultLanguage
            let id = recordings.save(transcript, into: project, meeting: meeting, audio: audio, spokenIn: spoken)
            if let id, !automatically { openRecordings(id) }
            saved(id)
        }
    }

    // MARK: - Answers

    /// Manual trigger: whatever the participants are saying right now, else their last line. Its
    /// questions are answered each on its own, or all of it when it holds none.
    func answerNow() {
        let taken = detector.take()
        let live = partial[.others] ?? ""
        var speech = taken?.speech ?? ""
        if !live.isEmpty { speech += (speech.isEmpty ? "" : " ") + live }
        if speech.isEmpty {
            speech = utterances.last(where: { $0.channel == .others })?.text ?? utterances.last?.text ?? ""
        }
        guard !speech.isEmpty else { return }
        // The judge hasn't heard what's still being said.
        let questions = live.isEmpty ? taken?.questions ?? [] : []
        ask(questions.isEmpty ? [speech] : questions, force: true)
    }

    /// Who said a line, for the judge. Listening for questions from the room, the microphone hears
    /// the people around the speaker too, so it can't be labelled as the speaker.
    private func judgeLabel(_ channel: Channel) -> String {
        channel == .me && preferences.micQuestions ? "Room" : promptLabel(channel)
    }

    /// What the judge reads: the last two minutes for context, then what was just said.
    private func judgeMessage(_ speech: String) -> String {
        let said = Set(detector.buffer.map(\.started))
        let context = utterances
            .filter { Date().timeIntervalSince($0.time) < 120 && !said.contains($0.started) }
            .suffix(10)
            .map { "[\(judgeLabel($0.channel))] \($0.text)" }
            .joined(separator: "\n")
        return (context.isEmpty ? "" : "Said earlier (context):\n\(context.suffix(2000))\n\n") + "Just said:\n\(speech)"
    }

    func ask(_ question: String, force: Bool = false) {
        ask([question], force: force)
    }

    /// Questions asked in one go, answered each on its own and listed together. `force` when the user
    /// asked for it: shown at once. Without `request` they are only listed, for Prepare Answer.
    func ask(_ questions: [String], force: Bool = false, request: Bool = true) {
        guard claudeService != nil || !request else { return }
        let lexicon = self.lexicon
        let exchange = Exchange(answers: questions.map { question in
            let match = knowledge?.match(question)
            let opener = match.flatMap { Self.firstSentence($0.answer.a, dropping: lexicon.thanksPrefix) }
                ?? (lexicon.defaultOpener.isEmpty ? nil : lexicon.defaultOpener)
            return Answer(question: question, opener: opener, prepared: match?.answer, preparedScore: match?.score ?? 0, requested: false)
        })
        exchanges.append(exchange)
        if request {
            send(exchange.id, force: force)
        } else {
            for question in questions { log.write("❔ **Question (Auto is off):** \(question)") }
        }
        // Asked for by the user: show it now. Noticed by Cue: it waits as a row until it's a real answer,
        // or under the button while the view is held or the speaker reads the answer in view.
        if force {
            expand(exchange.id)
        } else if holding || listScrolled {
            unseen.insert(exchange.id)
        } else if reading == .reading {
            hold(exchange.id)
        }
    }

    /// Prepare Answer on questions noticed with Auto off.
    func prepare(_ id: UUID) {
        send(id, force: true)
        expand(id)
    }

    /// Sends an exchange's questions that are still waiting to Claude, each as its own request.
    private func send(_ id: UUID, force: Bool) {
        guard let claudeService, let index = exchanges.firstIndex(where: { $0.id == id }) else { return }
        let questions = exchanges[index].answers.map(\.question)
        for (part, answer) in exchanges[index].answers.enumerated() where !answer.requested {
            let others = questions.enumerated().filter { $0.offset != part }.map { "«\($0.element)»" }
            claudeService.ask(message(for: answer.question, askedWith: others, force: force), id: answer.id)
            exchanges[index].answers[part].requested = true
            exchanges[index].answers[part].askedAt = Date()
            let of = questions.count > 1 ? " _(\(part + 1) of \(questions.count))_" : ""
            let match = answer.prepared.map { _ in " _(prepared match \(Int(answer.preparedScore * 100))%)_" } ?? ""
            log.write("❓ **Question:** \(answer.question)\(of)\(match)")
        }
    }

    private func message(for question: String, askedWith others: [String], force: Bool) -> String {
        let context = utterances
            .filter { Date().timeIntervalSince($0.time) < 180 && !question.contains($0.text) }
            .suffix(12)
            .map { "[\(promptLabel($0.channel))] \($0.text)" }
            .joined(separator: "\n")
        var message = context.isEmpty ? "" : "Recent transcript (context):\n\(context.suffix(2500))\n\n"
        message += "Question: [\(promptLabel(.others))] \(question)"
        if !others.isEmpty {
            message += "\n\n(Asked in one go with \(others.joined(separator: ", ")), which are answered separately: answer only this question.)"
        }
        message += force
            ? "\n\n(The speaker asked for an answer themselves — even if this is not a question, suggest what to say.)"
            : "\n\n(Noticed automatically. If it is not a question or remark addressed to the speaker, reply with — alone.)"
        return message
    }

    /// The user opens an exchange (a click, ⌃⌥← →). An older one holds the view: new questions
    /// wait under the "new questions" button until the user goes back to the newest.
    func expand(_ id: UUID) {
        guard let index = exchanges.firstIndex(where: { $0.id == id }) else { return }
        selected = index
        expandedID = id
        seen.insert(id)
        reading = .notYet
        heldWhileReading = []
        holding = index < exchanges.count - 1
        unseen.remove(id)
        if !holding { unseen = [] }
    }

    /// The "new questions" button: the newest, and new questions come into view again.
    func showNewest() {
        if let newest = exchanges.last { expand(newest.id) }
    }

    /// Cue brings an exchange into view by itself, unless the user holds the view on another one or reads
    /// the one in view aloud.
    private func reveal(_ index: Int) {
        let id = exchanges[index].id
        guard id != expandedID else { return }
        if holding || listScrolled { unseen.insert(id); return }
        if reading == .reading { return hold(id) }
        selected = index
        expandedID = id
        seen.insert(id)
        reading = .notYet
    }

    /// Keeps a new exchange in the New group, under the answer the speaker reads aloud.
    private func hold(_ id: UUID) {
        guard heldWhileReading.insert(id).inserted, let exchange = exchanges.first(where: { $0.id == id }) else { return }
        log.write("📖 Waits while you read the answer in view: \(exchange.answers.map(\.question).joined(separator: " / "))")
    }

    /// The speaker paused for `readingPause` after reading: what came in meanwhile shows, the newest
    /// answer under way in full. Checked every tick of the level meters, which also notes that they're
    /// still talking (their utterance isn't transcribed yet when it ends).
    private func checkReading() {
        guard reading == .reading else { return }
        if micSegmenter.isSpeaking && !systemSegmenter.isSpeaking { presenterSpoke = Date(); return }
        guard Date().timeIntervalSince(presenterSpoke) >= readingPause else { return }
        reading = .done
        let held = heldWhileReading
        heldWhileReading = []
        guard !held.isEmpty, !holding, !listScrolled else { return }
        guard let index = exchanges.lastIndex(where: { held.contains($0.id) && $0.answers.contains(where: \.isUnderWay) }) else { return }
        log.write("📖 Shown now that you've paused: \(exchanges[index].answers.map(\.question).joined(separator: " / "))")
        reveal(index)
    }

    private func position(of answer: UUID) -> (exchange: Int, part: Int)? {
        for (index, exchange) in exchanges.enumerated() {
            if let part = exchange.answers.firstIndex(where: { $0.id == answer }) { return (index, part) }
        }
        return nil
    }

    private static func firstSentence(_ text: String, dropping prefix: String) -> String? {
        let cleaned = prefix.isEmpty ? text : text.replacingOccurrences(of: prefix, with: "")
        guard let end = cleaned.firstIndex(where: { ".!?".contains($0) }) else { return cleaned.isEmpty ? nil : cleaned }
        return String(cleaned[...end])
    }

    private func appendDelta(_ id: UUID, _ text: String) {
        guard let (index, part) = position(of: id) else { return }
        if exchanges[index].answers[part].firstTokenAt == nil { exchanges[index].answers[part].firstTokenAt = Date() }
        exchanges[index].answers[part].text += text
        // The first words of a real answer (not "—") bring it into view, unless a newer one is there.
        let shown = exchanges.firstIndex { $0.id == expandedID }
        if exchanges[index].answers[part].isUnderWay, shown.map({ $0 < index }) ?? true { reveal(index) }
    }

    private func finish(_ id: UUID, error: String?) {
        guard let (index, part) = position(of: id) else { return }
        exchanges[index].answers[part].done = true
        exchanges[index].answers[part].error = error
        let answer = exchanges[index].answers[part]
        let firstWord = answer.firstTokenAt.map { String(format: "first word %.1f s, ", $0.timeIntervalSince(answer.askedAt)) } ?? ""
        let total = String(format: "%.1f", Date().timeIntervalSince(answer.askedAt))
        log.write("💬 **Answer** (\(firstWord)done \(total) s):\n\n\(error.map { "⚠︎ \($0)" } ?? answer.text)\n")
        // Organisational remarks come back as "—": they stay in the list as a dimmed row, and the
        // answer in view stays. A first question that fails still shows why.
        if exchanges[index].isNotAQuestion {
            unseen.remove(exchanges[index].id)
        } else if expandedID == nil && !answer.isNotAQuestion {
            reveal(index)
        }
    }

    func step(_ delta: Int) {
        guard !exchanges.isEmpty else { return }
        expand(exchanges[min(max(selected + delta, 0), exchanges.count - 1)].id)
    }
}
