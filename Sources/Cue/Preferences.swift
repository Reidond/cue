import Foundation

/// Spoken languages Cue can listen to. Whisper understands all of them; question
/// cues and spoken openers come from Resources/lexicons/<code>.json when present.
struct SpokenLanguage: Identifiable, Hashable {
    let code: String
    let name: String
    var id: String { code }

    static let all = [
        SpokenLanguage(code: "en", name: "English"),
        SpokenLanguage(code: "uk", name: "Ukrainian"),
        SpokenLanguage(code: "pl", name: "Polish"),
        SpokenLanguage(code: "de", name: "German"),
        SpokenLanguage(code: "fr", name: "French"),
        SpokenLanguage(code: "es", name: "Spanish"),
        SpokenLanguage(code: "it", name: "Italian"),
        SpokenLanguage(code: "pt", name: "Portuguese"),
    ]

    static func named(_ code: String) -> SpokenLanguage {
        all.first { $0.code == code } ?? SpokenLanguage(code: code, name: code)
    }
}

/// Global preferences, persisted in UserDefaults; everything about a talk lives in its `Project`.
@MainActor
final class Preferences: ObservableObject {
    private let defaults = appDefaults

    @Published var speakerName: String { didSet { defaults.set(speakerName, forKey: "speakerName") } }
    @Published var model: ClaudeService.Model { didSet { defaults.set(model.rawValue, forKey: "model") } }
    @Published var autoAnswer: Bool { didSet { defaults.set(autoAnswer, forKey: "autoAnswer") } }
    /// Also treat questions the microphone picks up (people in the room) as questions.
    @Published var micQuestions: Bool { didSet { defaults.set(micQuestions, forKey: "micQuestions") } }
    @Published var showTranscript: Bool { didSet { defaults.set(showTranscript, forKey: "showTranscript") } }
    @Published var textSize: Double { didSet { defaults.set(textSize, forKey: "textSize") } }
    @Published var libraryFolder: URL { didSet { defaults.set(libraryFolder.path, forKey: "libraryFolder") } }
    @Published var summarizeRecordings: Bool { didSet { defaults.set(summarizeRecordings, forKey: "summarizeRecordings") } }
    /// Keep the call's audio next to its notes.
    @Published var keepAudio: Bool { didSet { defaults.set(keepAudio, forKey: "keepAudio") } }
    /// Folder name of the project Cue was last bound to.
    @Published var activeProject: String? { didSet { defaults.set(activeProject, forKey: "activeProject") } }
    /// When a meeting starts: ask to record it, record it, or do nothing.
    @Published var meetingAction: MeetingAction { didSet { defaults.set(meetingAction.rawValue, forKey: "meetingAction") } }
    /// Calendars Cue doesn't look in for calls, by identifier; new calendars are watched.
    @Published var unwatchedCalendars: Set<String> { didSet { defaults.set(unwatchedCalendars.sorted(), forKey: "unwatchedCalendars") } }
    /// Project folder for each calendar event series, picked on the Upcoming page.
    @Published var meetingProjects: [String: String] { didSet { defaults.set(meetingProjects, forKey: "meetingProjects") } }

    init() {
        speakerName = defaults.string(forKey: "speakerName") ?? NSFullUserName()
        model = ClaudeService.Model(rawValue: defaults.string(forKey: "model") ?? "") ?? .sonnet
        autoAnswer = defaults.object(forKey: "autoAnswer") as? Bool ?? true
        micQuestions = defaults.bool(forKey: "micQuestions")
        showTranscript = defaults.object(forKey: "showTranscript") as? Bool ?? true
        textSize = defaults.object(forKey: "textSize") as? Double ?? 15
        libraryFolder = defaults.string(forKey: "libraryFolder").map { URL(fileURLWithPath: $0) }
            ?? documentsFolder.appendingPathComponent("Cue")
        summarizeRecordings = defaults.object(forKey: "summarizeRecordings") as? Bool ?? true
        keepAudio = defaults.object(forKey: "keepAudio") as? Bool ?? true
        activeProject = defaults.string(forKey: "activeProject")
        meetingAction = MeetingAction(rawValue: defaults.string(forKey: "meetingAction") ?? "") ?? .ask
        unwatchedCalendars = Set(defaults.stringArray(forKey: "unwatchedCalendars") ?? [])
        meetingProjects = defaults.dictionary(forKey: "meetingProjects") as? [String: String] ?? [:]
    }
}

/// Per-language data (stop words, Whisper artefacts, spoken openers, labels)
/// kept in Resources/lexicons so the code stays language-neutral.
struct Lexicon: Decodable {
    var name: String
    var stopWords: Set<String>
    var hallucinations: [String]
    var questionLabels: [String]
    var answerLabels: [String]
    var thanksPrefix: String
    var defaultOpener: String
    var numbersLabel: String
    var sourceLabel: String
    var participantLabel: String?
    /// One of several voices told apart on the call side: "Participant %d".
    var numberedParticipantLabel: String?
    var transcriptHeading: String?
    /// Words that give away a remark about the transcript or speech recognition ("transcript",
    /// "misheard"): a summary's parenthetical remarks with one are dropped.
    var transcriptRemarkWords: [String]?

    var participant: String { participantLabel ?? "Participant" }
    /// «Учасник 2», "Participant 2".
    func numberedParticipant(_ number: Int) -> String {
        (numberedParticipantLabel ?? participant + " %d").replacingOccurrences(of: "%d", with: String(number))
    }
    /// Whether a name is one of the labels Cue gives the people on the call, rather than a name.
    func isParticipantLabel(_ name: String) -> Bool {
        let numbered = (numberedParticipantLabel ?? participant + " %d").components(separatedBy: "%d")
        return name == participant || numbered.count == 2 && name.hasPrefix(numbered[0]) && name.hasSuffix(numbered[1])
            && Int(name.dropFirst(numbered[0].count).dropLast(numbered[1].count)) != nil
    }
    var transcript: String { transcriptHeading ?? "Transcript" }
    var transcriptRemarks: [String] { transcriptRemarkWords ?? [] }

    private static var cache: [String: Lexicon] = [:]
    private static let lock = NSLock()

    static func load(_ code: String) -> Lexicon {
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[code] { return cached }
        let english = decode("en") ?? Lexicon(name: "English", stopWords: [], hallucinations: [],
                                              questionLabels: ["q"], answerLabels: ["a"], thanksPrefix: "",
                                              defaultOpener: "", numbersLabel: "Numbers", sourceLabel: "Source")
        // Unknown languages still get the universal "?" cue and English labels.
        var lexicon = decode(code) ?? Lexicon(name: SpokenLanguage.named(code).name, stopWords: [],
                                              hallucinations: english.hallucinations, questionLabels: english.questionLabels,
                                              answerLabels: english.answerLabels, thanksPrefix: "", defaultOpener: "",
                                              numbersLabel: english.numbersLabel, sourceLabel: english.sourceLabel)
        // Prepared materials are often in English even when the talk is not (and so can be an aside in a summary).
        if code != "en" {
            lexicon.questionLabels += english.questionLabels
            lexicon.answerLabels += english.answerLabels
            lexicon.transcriptRemarkWords = lexicon.transcriptRemarks + english.transcriptRemarks
        }
        cache[code] = lexicon
        return lexicon
    }

    private static func decode(_ code: String) -> Lexicon? {
        guard let url = Bundle.main.url(forResource: code, withExtension: "json", subdirectory: "lexicons"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(Lexicon.self, from: data)
    }
}
