import CoreGraphics
import Foundation

/// A language a person can read Cue in (packages/contract: `LANGUAGES`; the list follows it by hand): its code, and its name in English
/// and in itself. With two chosen (Settings › General › Languages, kept in the account), every answer comes in the language spoken with each
/// line's translation into the other, and every note is translated too.
struct CueLanguage: Identifiable, Hashable {
    let code: String
    /// "Ukrainian".
    let name: String
    /// "Українська".
    let native: String

    var id: String { code }

    /// In the contract's order.
    static let all: [CueLanguage] = [
        CueLanguage(code: "en", name: "English", native: "English"),
        CueLanguage(code: "uk", name: "Ukrainian", native: "Українська"),
        CueLanguage(code: "pl", name: "Polish", native: "Polski"),
        CueLanguage(code: "de", name: "German", native: "Deutsch"),
        CueLanguage(code: "fr", name: "French", native: "Français"),
        CueLanguage(code: "es", name: "Spanish", native: "Español"),
        CueLanguage(code: "it", name: "Italian", native: "Italiano"),
        CueLanguage(code: "pt", name: "Portuguese", native: "Português"),
        CueLanguage(code: "nl", name: "Dutch", native: "Nederlands"),
        CueLanguage(code: "cs", name: "Czech", native: "Čeština"),
    ]

    /// "Ukrainian" for `uk`; a code Cue doesn't list by the system's English name for it.
    static func name(of code: String) -> String {
        all.first { $0.code == code }?.name ?? Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
    }

    /// "Українська" for `uk`; a code Cue doesn't list by the system's name for it in itself.
    static func native(of code: String) -> String {
        all.first { $0.code == code }?.native ?? Locale(identifier: code).localizedString(forLanguageCode: code) ?? code
    }

    /// What the session log says about the person's languages: "English, Ukrainian", or that there are none.
    static func describe(_ codes: [String]) -> String {
        codes.isEmpty ? "none — Cue follows the language it hears" : codes.map(name(of:)).joined(separator: ", ")
    }
}

/// How an answer shows its two languages in the overlay (Settings › General › Languages › Answers; `answerLayout`).
enum AnswerLayout: String, CaseIterable, Identifiable {
    /// Each line, and right under it its translation, smaller and secondary.
    case subtitles
    /// Two columns under the languages' names, row for row; the other language's column secondary.
    case mirror
    /// The answer as with one language, then every translation in one compact paragraph under a hairline.
    case focus

    /// Side by side needs room for two columns: an overlay narrower than this shows subtitles instead.
    static let mirrorWidth: CGFloat = 560

    var id: String { rawValue }

    var title: String {
        switch self {
        case .subtitles: "Subtitles"
        case .mirror: "Side by side"
        case .focus: "Focus"
        }
    }
}

/// How a note shows its translation on its page (Settings › General › Languages › Notes; `noteLayout`).
enum NoteLayout: String, CaseIterable, Identifiable {
    /// A switch above the note between its own language and the other.
    case switching = "switch"
    /// The summary, then the translated one under the language's name, then the transcript with its translations.
    case both

    var id: String { rawValue }

    var title: String {
        switch self {
        case .switching: "Switch between them"
        case .both: "One after another"
        }
    }
}
