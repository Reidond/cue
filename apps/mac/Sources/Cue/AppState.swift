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

    /// The microphone picking up the call through speakers produces a near-copy of a participant line (the second pass drops those;
    /// the live call drops them on the server).
    static func isEcho(_ text: String, of other: String, stopWords: Set<String>) -> Bool {
        let words = Set(stems(text, stopWords: stopWords))
        guard words.count >= 3 else { return false }
        let otherWords = Set(stems(other, stopWords: stopWords))
        return Double(words.intersection(otherWords).count) / Double(words.count) > 0.6
    }

    /// Crude stemming that works well enough across European languages: lowercase,
    /// keep words of 4+ letters that are not stop words, cut to 6 letters.
    static func stems(_ text: String, stopWords: Set<String>) -> [String] {
        text.lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'-")).inverted)
            .filter { $0.count >= 4 && !stopWords.contains($0) }
            .map { String($0.prefix(6)) }
    }
}

/// What was asked in one go: one question or several, each answered on its own and shown together.
struct Exchange: Identifiable {
    let id = UUID()
    /// The server's name for the questions asked in one go (what `prepare` says).
    let serverID: String
    var answers: [Answer]

    /// Noticed with Auto off: the questions wait for Prepare Answer.
    var waiting: Bool { answers.contains { !$0.requested } }
    var isNotAQuestion: Bool { answers.allSatisfy(\.isNotAQuestion) }
}

struct Answer: Identifiable {
    let id = UUID()
    /// The server's id of the question: the events of its answer name it.
    let questionID: String
    let question: String
    /// Its place among the questions asked in one go, and how many there were.
    var part = 0
    var parts = 1
    var askedAt = Date()
    /// Shown the instant the question lands, before Claude says anything.
    let opener: String?
    /// The prepared answer that matches, once the server has found it.
    var prepared: PreparedAnswer?
    var preparedScore = 0.0
    /// Being answered (a question noticed with Auto off isn't, until Prepare Answer).
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
    /// Getting there, as opposed to something that needs attention.
    var working = false

    /// Before a call exists: nothing is running yet, and that is not a problem.
    static let idle = ServiceStatus(ok: false, detail: "Starts when you start listening", working: true)
}

/// The question judge, as the server reports it.
enum JudgeState { case starting, ready, unavailable }

/// Orchestrates the audio going up to the live call and what comes back: the transcript, the questions and their answers.
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
    /// The Cue API and who is signed in: Cue works only while someone is.
    let api: CueAPI
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
    /// Speech recognition, as the live call reports it.
    @Published var speech = ServiceStatus.idle
    /// Claude, as the live call reports it.
    @Published var claude = ServiceStatus.idle
    @Published private(set) var knowledge: KnowledgeBase?
    @Published private(set) var readingMaterials = false
    /// Between Start Cue and Stop Cue: the overlay is up and Cue listens for questions.
    @Published private(set) var cueRunning = false
    /// The microphone and call audio are open: while Cue runs, or while a call is recorded.
    private var capturing = false

    var openSettings: () -> Void = {}
    var openDashboard: () -> Void = {}
    var openRecordings: (_ selecting: String?) -> Void = { _ in }
    var showOverlay: () -> Void = {}
    var hideOverlay: () -> Void = {}

    private var rehearsalStarted = false
    private let micCapture = MicCapture()
    private let systemCapture = SystemAudioCapture()
    private let micMeter = LevelMeter()
    private let callMeter = LevelMeter()
    private let audioRecorder = AudioRecorder()
    /// Where the captured audio goes while a call is live.
    private let audioSink = AudioSink()
    /// The live call, from when capture starts to when it stops.
    private var liveCall: LiveCall?
    /// Counts the calls started and ended, so a call that took long to start finds it was ended meanwhile.
    private var callGeneration = 0
    /// The call's socket is up: audio goes to the server and its events come back.
    private var callConnected = false
    private var callRestarts = 0
    /// The project the live call listens for.
    private var callProjectID: String?
    private var judgeState = JudgeState.starting
    private var speechUnavailable = false
    /// Who is talking right now, by the server's word.
    private var speaking: [Channel: Bool] = [:]
    /// Commands (Ask…) given while the call was still being made.
    private var heldCommands: [[String: Any]] = []
    /// Questions being answered whose line in the session log waits for the prepared answer that matches (it comes right after the question).
    private var unlogged: Set<String> = []
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
        var materials: [Material]
        var language: String
    }

    init(preferences: Preferences) {
        self.preferences = preferences
        let log = SessionLog()
        self.log = log
        api = CueAPI(log: log)
        projects = ProjectStore(preferences: preferences, api: api, log: log)
        projects.migrateLegacySettings(log: log)
        speakerModels = SpeakerModels(log: log)
        recordings = RecordingStore(preferences: preferences, projects: projects, speakerModels: speakerModels, api: api, log: log)
        recordings.reload()
        player = NotePlayer(log: log)
        AudioRecorder.removeStaleWorkingFolders()
        calendar = MeetingCalendar(preferences: preferences)
        // The projects are the account's: once someone is signed in they are loaded (and the ones found in the library imported), and one is chosen.
        api.onSignedIn = { [weak self] in
            await self?.projects.syncWithAccount()
            await self?.chooseProject()
        }
    }

    /// The project Cue is bound to after signing in. CUE_PROJECT=name picks it (creating it when missing); otherwise the last one used.
    private func chooseProject() async {
        if let name = ProcessInfo.processInfo.environment["CUE_PROJECT"] {
            if projects.project(named: name) == nil { _ = try? await projects.create(named: name) }
            activeProject = projects.project(named: name)
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
        if !speech.ok { return (speech.detail, speech.working ? .working : .problem) }
        if !claude.ok { return (claude.detail, claude.working ? .working : .problem) }
        if !call.ok && !mic.ok { return ("No audio", .problem) }
        guard let activeProject else { return ("No project", .problem) }
        if activeProject.materials.isEmpty { return ("No materials", .problem) }
        return ("Listening", .ready)
    }

    enum StatusKind { case ready, working, problem }

    // MARK: - Lifecycle

    func start() {
        api.start()
        // Signing out (or losing the session) ends listening: the overlay goes, and so does anything that would answer.
        api.$phase.removeDuplicates().sink { [weak self] phase in if phase == .signedOut { self?.stopCue() } }.store(in: &subscriptions)
        micCapture.onSamples = { [micMeter, audioSink, audioRecorder] samples, time in
            micMeter.add(samples)
            audioSink.push(samples, from: .me, at: time)
            audioRecorder.push(samples, from: .me, at: time)
        }
        systemCapture.onSamples = { [callMeter, audioSink, audioRecorder] samples, time in
            callMeter.add(samples)
            audioSink.push(samples, from: .others, at: time)
            audioRecorder.push(samples, from: .others, at: time)
        }
        systemCapture.onStop = { error in
            Task { @MainActor in self.call = ServiceStatus(ok: false, detail: "Call audio stopped: \(error.localizedDescription)") }
        }
        log.write("🤖 Claude: Cue plan")
        log.write("🗣 Speech recognition: Cue plan")

        rebuildKnowledge()
        startRehearsalIfRequested()
        // Listening starts with Start Cue (or a recording), not at launch.
        mic = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
        call = ServiceStatus(ok: false, detail: "Not listening — Start Cue to listen")
        observeSettings()
        meetings.start()

        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            Task { @MainActor in
                self.micLevel = self.micMeter.level
                self.callLevel = self.callMeter.level
                self.checkReading()
            }
        }
    }

    func shutdown() {
        recordings.cancelAll()
        audioRecorder.cancel()
        micCapture.stop()
        systemCapture.stop()
        endCall()
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

        // The materials the project's page and Home show are read again when its files or language change.
        $activeProject
            .map { Self.knowledgeInputs(project: $0) }
            .removeDuplicates()
            .dropFirst()
            .debounce(for: .seconds(1.2), scheduler: RunLoop.main)
            .sink { [weak self] inputs in
                guard let self, inputs != self.knowledgeInputs else { return }
                self.rebuildKnowledge()
            }
            .store(in: &subscriptions)

        // A call listens for one project: another project means another call.
        $activeProject.map { $0?.id }.removeDuplicates().dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self, self.capturing, self.activeProject?.serverID != self.callProjectID else { return }
                self.startCall()
            }
            .store(in: &subscriptions)

        // What the server does with the questions follows these.
        Publishers.CombineLatest3(preferences.$speakerName, preferences.$autoAnswer, preferences.$micQuestions)
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.sendConfig() }
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

    private static func knowledgeInputs(project: Project?) -> KnowledgeInputs {
        KnowledgeInputs(materials: project?.materials ?? [], language: project?.language ?? Project.defaultLanguage)
    }

    /// Reads what the account has of the active project's files, for its page.
    func rebuildKnowledge() {
        knowledgeGeneration += 1
        let generation = knowledgeGeneration
        knowledgeInputs = Self.knowledgeInputs(project: activeProject)
        let serverID = activeProject?.serverID
        let project = activeProject?.name ?? "no project"
        readingMaterials = true
        Task {
            let documents = await self.projects.documents(of: serverID)
            guard generation == self.knowledgeGeneration else { return }
            guard let documents else {
                self.readingMaterials = false
                return
            }
            let knowledge = KnowledgeBase(documents: documents)
            self.knowledge = knowledge
            self.readingMaterials = false
            let files = knowledge.documents.map { "\($0.name) — \($0.error ?? $0.summary)" }.joined(separator: "; ")
            self.log.write("📚 Materials for \(project) (~\(knowledge.estimatedTokens / 1000)k tokens): \(files.isEmpty ? "none" : files)")
        }
    }

    // MARK: - The live call

    /// Makes a call for the active project and connects to it; whatever call there was ends first. The server reads the project's
    /// materials, warms Claude and opens the speech streams, and says how that goes in `status` events.
    private func startCall() {
        endCall()
        let generation = callGeneration
        guard let project = activeProject ?? recordingProject, let serverID = project.serverID else {
            let detail = activeProject == nil ? "No project" : "Waiting for the project to reach your account"
            claude = ServiceStatus(ok: false, detail: detail)
            speech = ServiceStatus(ok: false, detail: detail)
            return
        }
        callProjectID = serverID
        claude = ServiceStatus(ok: false, detail: "Warming up Claude…", working: true)
        speech = ServiceStatus(ok: false, detail: "Starting speech recognition…", working: true)
        Task {
            do {
                let info = try await api.createCall(projectID: serverID, speaker: preferences.speakerName, auto: preferences.autoAnswer,
                                                    micQuestions: preferences.micQuestions, questions: cueRunning)
                guard generation == callGeneration else {
                    await api.endCall(info.callId)
                    return
                }
                let call = LiveCall(api: api, info: info, audio: audioSink)
                call.onEvent = { [weak self] event in self?.handle(event) }
                let callID = info.callId
                call.onGone = { [weak self] why in self?.callEnded(callID, why: why) }
                liveCall = call
                sendConfig()
                for command in heldCommands { call.send(command) }
                heldCommands = []
                call.connect()
            } catch {
                guard generation == callGeneration else { return }
                claude = ServiceStatus(ok: false, detail: error.localizedDescription)
                speech = ServiceStatus(ok: false, detail: error.localizedDescription)
                log.write("⚠︎ Couldn't start the live call: \(error.localizedDescription)")
            }
        }
    }

    /// Ends the call, if there is one: the server closes its speech streams and keeps the transcript.
    private func endCall() {
        callGeneration += 1
        callProjectID = nil
        speaking = [:]
        callConnected = false
        heldCommands = []
        unlogged = []
        judgeState = .starting
        speechUnavailable = false
        claude = .idle
        speech = .idle
        guard let call = liveCall else { return }
        liveCall = nil
        call.close()
        Task { await api.endCall(call.id) }
    }

    /// The server has no more to say about the call (it ended, or no longer knows it). While Cue still listens, a new call takes over.
    private func callEnded(_ id: String, why: String) {
        guard liveCall?.id == id else { return }
        endCall()
        log.write("⚠︎ The live call stopped: \(why)")
        guard capturing, callRestarts < 3 else { return }
        callRestarts += 1
        let generation = callGeneration
        Task {
            try? await Task.sleep(for: .seconds(2))
            if generation == callGeneration, capturing { startCall() }
        }
    }

    /// Menu › Restart Live Call.
    func restartCall() {
        callRestarts = 0
        if capturing { startCall() }
    }

    /// The settings the server follows while it listens for questions.
    private func sendConfig() {
        liveCall?.send([
            "type": "config", "speaker": preferences.speakerName, "auto": preferences.autoAnswer,
            "micQuestions": preferences.micQuestions, "questions": cueRunning,
        ])
    }

    /// A command for the call; held when the call is still being made, dropped when there is none to come.
    private func sendCommand(_ command: [String: Any]) {
        if let liveCall { liveCall.send(command) } else if capturing { heldCommands.append(command) }
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
            callRestarts = 0
            startCall()
            log.write("🎤 Listening")
        } else {
            micCapture.stop()
            systemCapture.stop()
            endCall()
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
            // Nothing is heard before someone is signed in (and Cue running, which signing in starts for a rehearsal), and the call's
            // socket is up with Claude, the judge and speech recognition warm: the first question is answered as in a real talk.
            while !callConnected || !claude.ok || !speech.ok || judgeState == .starting || !api.isSignedIn || !cueRunning {
                try? await Task.sleep(for: .milliseconds(300))
            }
            do {
                // CUE_REHEARSE_RECORD=1 also records the rehearsal and writes its notes.
                let record = ProcessInfo.processInfo.environment["CUE_REHEARSE_RECORD"] == "1"
                if record { startRecording(.rehearsal) }
                var length = try Rehearsal.play(fileAt: path) { [callMeter, audioSink, audioRecorder] samples, time in
                    callMeter.add(samples)
                    audioSink.push(samples, from: .others, at: time)
                    // ScreenCaptureKit delivers nothing while the Mac plays nothing; the recorder gets the same here.
                    if samples.contains(where: { $0 != 0 }) { audioRecorder.push(samples, from: .others, at: time) }
                }
                // CUE_REHEARSE_ME plays a second recording as your microphone, in parallel.
                if let mine = ProcessInfo.processInfo.environment["CUE_REHEARSE_ME"] {
                    length = max(length, try Rehearsal.play(fileAt: mine) { [micMeter, audioSink, audioRecorder] samples, time in
                        micMeter.add(samples)
                        audioSink.push(samples, from: .me, at: time)
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

    // MARK: - What the live call says

    private func handle(_ event: CallEvent) {
        switch event.type {
        case "ready":
            callConnected = true
            callRestarts = 0
        case "status":
            statusChanged(event)
        case "speaking":
            guard let channel = event.side else { return }
            let active = event.active ?? false
            speaking[channel] = active
            if active {
                speechStarted(channel)
            } else if partial[channel]?.isEmpty == true {
                partial[channel] = nil
            }
        case "transcript.partial":
            if let channel = event.side, let text = event.text, !text.isEmpty { partial[channel] = text }
        case "transcript.final":
            utteranceFinished(event)
        case "question":
            questionAsked(event)
        case "prepared":
            preparedFound(event)
        case "answer.delta":
            if let id = event.questionId, let text = event.text { appendDelta(id, text) }
        case "answer.done":
            if let id = event.questionId { finish(id, error: event.error) }
        case "error":
            log.write("⚠︎ \(event.message ?? "The live call had a problem")")
        default:
            break
        }
    }

    /// What the server says about Claude, the question judge and speech recognition, in the words the session log has always used.
    private func statusChanged(_ event: CallEvent) {
        let state = event.state ?? "", detail = event.detail ?? ""
        let status = ServiceStatus(ok: state == "ready", detail: detail, working: state == "starting")
        switch event.part {
        case "claude":
            claude = status
        case "speech":
            speech = status
            if state == "unavailable" {
                speechUnavailable = true
                log.write("⚠︎ Speech recognition unavailable: \(detail)")
            } else if state == "ready", speechUnavailable {
                speechUnavailable = false
                log.write("🗣 Speech recognition ready again: Cue plan")
            }
        case "judge":
            switch state {
            case "ready":
                if judgeState != .ready { log.write("🧐 Question judge ready: Claude Haiku") }
                judgeState = .ready
            case "unavailable":
                if judgeState != .unavailable { log.write("⚠︎ Question judge unavailable (\(detail)) — going by question marks") }
                judgeState = .unavailable
            default:
                judgeState = .starting
            }
        default:
            break
        }
    }

    private func speechStarted(_ channel: Channel) {
        partial[channel] = ""
        // With speakers instead of headphones the mic also hears the call; don't mistake that for the user.
        guard channel == .me, speaking[.others] != true else { return }
        presenterSpoke = Date()
        if reading == .notYet && expandedID != nil { reading = .reading }
    }

    /// The server's times count from when the call began; the transcript's lines are stamped with the clock.
    private func utteranceFinished(_ event: CallEvent) {
        guard let channel = event.side else { return }
        partial[channel] = nil
        guard let text = event.text, !text.isEmpty else { return }
        let origin = liveCall?.startedAt ?? Date()
        let started = origin.addingTimeInterval(event.start ?? 0)
        let ended = origin.addingTimeInterval(event.end ?? event.start ?? 0)
        // `event.speaker` (the live recognizer's guess at the voice) is not used: the notes tell the voices apart in the second pass.
        let utterance = Utterance(channel: channel, text: text, started: started, time: max(started, ended))
        utterances.append(utterance)
        if utterances.count > 300 { utterances.removeFirst(utterances.count - 300) }
        recorder.add(utterance)
        log.write("**[\(promptLabel(channel))]** \(text)", at: utterance.time)
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
        rebuildKnowledge()
    }

    /// The project page's Start Cue: shows the overlay and listens, answering from this project.
    func startCue(_ project: Project) {
        activate(project)
        startListening()
    }

    /// Everything that listens, answers or records needs a signed-in account: without one, the dashboard shows the sign-in.
    private func requireSignIn() -> Bool {
        guard !api.isSignedIn else { return true }
        log.write("⚠︎ Sign in to Cue first")
        openDashboard()
        return false
    }

    /// A rehearsal runs once the person has signed in.
    func startListeningOnceSignedIn() {
        // `$phase` publishes before the value is set (willSet), so hop to the next turn of the run loop: by then `isSignedIn` holds.
        api.$phase.filter { $0 == .signedIn }.first().receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.startListening() }.store(in: &subscriptions)
    }

    /// Shows the overlay and listens, with the current project (a rehearsal, ⌃⌥H).
    func startListening() {
        guard requireSignIn() else { return }
        showOverlay()
        guard !cueRunning else { return }
        cueRunning = true
        log.write("▶︎ Cue started\(activeProject.map { ": \($0.name)" } ?? "")")
        updateCapture()
        sendConfig()
    }

    /// Stop Cue: hides the overlay and stops listening. A call being recorded keeps recording.
    func stopCue() {
        guard cueRunning else { return }
        cueRunning = false
        hideOverlay()
        log.write("⏹ Cue stopped")
        updateCapture()
        sendConfig()
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
        guard requireSignIn() else { return }
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
            var target = recordingProject.flatMap { projects.project($0.id) } ?? activeProject ?? projects.project(named: "Meetings")
            if target == nil { target = try? await projects.create(named: "Meetings") }
            guard let project = target else { return }
            // The language live recognition used: the bound project's, which a meeting's project may not share.
            let spoken = activeProject?.language ?? Project.defaultLanguage
            let id = recordings.save(transcript, into: project, meeting: meeting, audio: audio, spokenIn: spoken)
            if let id, !automatically { openRecordings(id) }
            saved(id)
        }
    }

    // MARK: - Answers

    /// The "answer now" hot key: the server takes what the participants are saying right now, else their last line, and answers its
    /// questions each on its own (or all of it when it holds none).
    func answerNow() {
        sendCommand(["type": "answerNow"])
    }

    /// The Ask field: this question, answered now.
    func ask(_ question: String, force: Bool = false) {
        guard api.isSignedIn, !question.isEmpty else { return }
        sendCommand(["type": "ask", "text": question])
    }

    /// Prepare Answer on questions noticed with Auto off.
    func prepare(_ id: UUID) {
        guard let index = exchanges.firstIndex(where: { $0.id == id }) else { return }
        sendCommand(["type": "prepare", "exchange": exchanges[index].serverID])
        for part in exchanges[index].answers.indices where !exchanges[index].answers[part].requested {
            exchanges[index].answers[part].requested = true
            exchanges[index].answers[part].askedAt = Date()
            unlogged.insert(exchanges[index].answers[part].questionID)
            logQuestion(exchanges[index].answers[part].questionID)
        }
        expand(id)
    }

    /// A question the server noticed (or was asked): the exchange it belongs to gets it, and once the exchange is whole it takes its place
    /// in the list. Asked for by the user: shown at once. Noticed by Cue: it waits as a row until it's a real answer, or under the button
    /// while the view is held or the speaker reads the answer in view.
    private func questionAsked(_ event: CallEvent) {
        guard let questionID = event.id, let exchangeID = event.exchange, let text = event.text else { return }
        let requested = event.requested ?? true
        var answer = Answer(questionID: questionID, question: text, opener: event.opener, requested: requested)
        answer.part = event.index ?? 0
        answer.parts = event.of ?? 1
        let index: Int
        if let found = exchanges.firstIndex(where: { $0.serverID == exchangeID }) {
            index = found
            exchanges[index].answers.append(answer)
        } else {
            exchanges.append(Exchange(serverID: exchangeID, answers: [answer]))
            index = exchanges.count - 1
        }
        if requested {
            unlogged.insert(questionID)
        } else {
            log.write("❔ **Question (Auto is off):** \(text)")
        }
        guard exchanges[index].answers.count >= answer.parts else { return }
        let exchange = exchanges[index]
        if event.forced == true {
            expand(exchange.id)
        } else if holding || listScrolled {
            unseen.insert(exchange.id)
        } else if reading == .reading {
            hold(exchange.id)
        }
    }

    /// The prepared answer that matches a question.
    private func preparedFound(_ event: CallEvent) {
        guard let id = event.questionId, let (index, part) = position(ofQuestion: id) else { return }
        exchanges[index].answers[part].prepared = PreparedAnswer(q: event.question ?? "", a: event.answer ?? "", who: event.who,
                                                                 source: event.source ?? "")
        exchanges[index].answers[part].preparedScore = event.score ?? 0
        logQuestion(id)
    }

    /// The line for a question being answered, once (it says which prepared answer matched, which the server sends right after the question).
    private func logQuestion(_ id: String) {
        guard unlogged.remove(id) != nil, let (index, part) = position(ofQuestion: id) else { return }
        let answer = exchanges[index].answers[part]
        let of = answer.parts > 1 ? " _(\(answer.part + 1) of \(answer.parts))_" : ""
        let match = answer.prepared.map { _ in " _(prepared match \(Int(answer.preparedScore * 100))%)_" } ?? ""
        log.write("❓ **Question:** \(answer.question)\(of)\(match)")
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
        if speaking[.me] == true && speaking[.others] != true { presenterSpoke = Date(); return }
        guard Date().timeIntervalSince(presenterSpoke) >= readingPause else { return }
        reading = .done
        let held = heldWhileReading
        heldWhileReading = []
        guard !held.isEmpty, !holding, !listScrolled else { return }
        guard let index = exchanges.lastIndex(where: { held.contains($0.id) && $0.answers.contains(where: \.isUnderWay) }) else { return }
        log.write("📖 Shown now that you've paused: \(exchanges[index].answers.map(\.question).joined(separator: " / "))")
        reveal(index)
    }

    private func position(ofQuestion id: String) -> (exchange: Int, part: Int)? {
        for (index, exchange) in exchanges.enumerated() {
            if let part = exchange.answers.firstIndex(where: { $0.questionID == id }) { return (index, part) }
        }
        return nil
    }

    private func appendDelta(_ id: String, _ text: String) {
        logQuestion(id)
        guard let (index, part) = position(ofQuestion: id) else { return }
        if exchanges[index].answers[part].firstTokenAt == nil { exchanges[index].answers[part].firstTokenAt = Date() }
        exchanges[index].answers[part].text += text
        // The first words of a real answer (not "—") bring it into view, unless a newer one is there.
        let shown = exchanges.firstIndex { $0.id == expandedID }
        if exchanges[index].answers[part].isUnderWay, shown.map({ $0 < index }) ?? true { reveal(index) }
    }

    private func finish(_ id: String, error: String?) {
        logQuestion(id)
        guard let (index, part) = position(ofQuestion: id) else { return }
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
