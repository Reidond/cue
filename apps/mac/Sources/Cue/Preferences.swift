import Foundation

/// Global preferences, persisted in UserDefaults; everything about a talk lives in its `Project`. The person's own — their name, Auto,
/// questions from the room, summaries, keeping audio — are kept in their Cue account, and this is this Mac's copy (`SettingsSync`).
@MainActor
final class Preferences: ObservableObject {
    private let defaults = appDefaults

    @Published var speakerName: String { didSet { defaults.set(speakerName, forKey: "speakerName") } }
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
    /// With two languages: how the overlay shows an answer in both (the languages themselves are the account's).
    @Published var answerLayout: AnswerLayout { didSet { defaults.set(answerLayout.rawValue, forKey: "answerLayout") } }
    /// With two languages: how a note's page shows its translation.
    @Published var noteLayout: NoteLayout { didSet { defaults.set(noteLayout.rawValue, forKey: "noteLayout") } }
    /// A translated note's transcript shows each line's translation under it (the Translations switch by its heading).
    @Published var noteTranslations: Bool { didSet { defaults.set(noteTranslations, forKey: "noteTranslations") } }
    /// Look for a new Cue when it opens and every few hours, and install it (`Updater`).
    @Published var automaticUpdates: Bool { didSet { defaults.set(automaticUpdates, forKey: "automaticUpdates") } }

    init() {
        speakerName = defaults.string(forKey: "speakerName") ?? NSFullUserName()
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
        answerLayout = AnswerLayout(rawValue: defaults.string(forKey: "answerLayout") ?? "") ?? .subtitles
        noteLayout = NoteLayout(rawValue: defaults.string(forKey: "noteLayout") ?? "") ?? .switching
        noteTranslations = defaults.object(forKey: "noteTranslations") as? Bool ?? true
        automaticUpdates = defaults.object(forKey: "automaticUpdates") as? Bool ?? true
    }
}

/// Per-language data (spoken openers, labels) kept in Resources/lexicons so the code stays
/// language-neutral. (The server keeps the rest of each language's data for the notes.)
struct Lexicon: Decodable {
    var name: String
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

    var participant: String { participantLabel ?? "Participant" }
    /// «Учасник 2», "Participant 2".
    func numberedParticipant(_ number: Int) -> String {
        (numberedParticipantLabel ?? participant + " %d").replacingOccurrences(of: "%d", with: String(number))
    }
    var transcript: String { transcriptHeading ?? "Transcript" }

    private static var cache: [String: Lexicon] = [:]
    private static let lock = NSLock()

    static func load(_ code: String) -> Lexicon {
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[code] { return cached }
        let english = decode("en") ?? Lexicon(name: "English",
                                              questionLabels: ["q"], answerLabels: ["a"], thanksPrefix: "",
                                              defaultOpener: "", numbersLabel: "Numbers", sourceLabel: "Source")
        // Unknown languages still get the universal "?" cue and English labels.
        let name = Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
        var lexicon = decode(code) ?? Lexicon(name: name, questionLabels: english.questionLabels,
                                              answerLabels: english.answerLabels, thanksPrefix: "", defaultOpener: "",
                                              numbersLabel: english.numbersLabel, sourceLabel: english.sourceLabel)
        // Prepared materials are often in English even when the talk is not (and so can be an aside in a summary).
        if code != "en" {
            lexicon.questionLabels += english.questionLabels
            lexicon.answerLabels += english.answerLabels
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
