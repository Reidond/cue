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
    /// Folder name of the project Cue was last bound to.
    @Published var activeProject: String? { didSet { defaults.set(activeProject, forKey: "activeProject") } }

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
        activeProject = defaults.string(forKey: "activeProject")
    }
}

/// Per-language data (question cues, stop words, Whisper artefacts, spoken openers)
/// kept in Resources/lexicons so the code stays language-neutral.
struct Lexicon: Decodable {
    var name: String
    var questionCues: [String]
    var stopWords: Set<String>
    var hallucinations: [String]
    var questionLabels: [String]
    var answerLabels: [String]
    var thanksPrefix: String
    var defaultOpener: String
    var numbersLabel: String
    var sourceLabel: String
    var participantLabel: String?
    var transcriptHeading: String?

    var participant: String { participantLabel ?? "Participant" }
    var transcript: String { transcriptHeading ?? "Transcript" }

    private static var cache: [String: Lexicon] = [:]
    private static let lock = NSLock()

    static func load(_ code: String) -> Lexicon {
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[code] { return cached }
        let english = decode("en") ?? Lexicon(name: "English", questionCues: [], stopWords: [], hallucinations: [],
                                              questionLabels: ["q"], answerLabels: ["a"], thanksPrefix: "",
                                              defaultOpener: "", numbersLabel: "Numbers", sourceLabel: "Source")
        // Unknown languages still get the universal "?" cue and English labels.
        var lexicon = decode(code) ?? Lexicon(name: SpokenLanguage.named(code).name, questionCues: [], stopWords: [],
                                              hallucinations: english.hallucinations, questionLabels: english.questionLabels,
                                              answerLabels: english.answerLabels, thanksPrefix: "", defaultOpener: "",
                                              numbersLabel: english.numbersLabel, sourceLabel: english.sourceLabel)
        // Prepared materials are often in English even when the talk is not.
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
