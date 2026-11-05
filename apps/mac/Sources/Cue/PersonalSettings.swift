import Combine
import Foundation

/// The settings that are the person's, not this Mac's (packages/contract: `AccountSettings`, `/v1/me` `settings`): what answers and notes call
/// them, Auto, questions from the room, summaries, keeping audio. Nil where the account has none yet. Encoded, only the ones that are set go
/// (`PATCH /v1/me/settings` changes those).
struct PersonalSettings: Codable, Equatable {
    var speakerName: String?
    var autoAnswer: Bool?
    var micQuestions: Bool?
    var summarize: Bool?
    var keepAudio: Bool?
}

/// Keeps the person's settings in their Cue account, so every Mac and PC they sign in to follows them, and so does the server, which uses them
/// for calls and notes. `Preferences` holds this Mac's copy: what the account changes is put there, and what is changed there (Settings, the
/// overlay's Auto, its hot key) is saved to the account. An account seen without them gets this Mac's, once, at sign-in.
@MainActor
final class SettingsSync {
    private let preferences: Preferences
    private let api: CueAPI
    private let log: SessionLog
    /// The account's settings as last seen: only what the account changes since is put into the preferences, so a read that brings the same
    /// values back leaves a change made here (and not saved yet) alone.
    private var seen = PersonalSettings()
    /// The account's values are being put into the preferences: those are no changes to save.
    private var applying = false
    /// Changes made here, counted per setting, and the count each one's last finished save carried: a setting changed here and not saved yet
    /// (its save waiting or under way) keeps its value whatever the account says meanwhile, an earlier save's answer included.
    private var edits: [String: Int] = [:]
    private var settled: [String: Int] = [:]
    /// The name is saved a moment after the last keystroke.
    private var nameSave: Task<Void, Never>?
    /// Saves go one after another, so the account ends with the last change.
    private var saving: Task<Void, Never>?
    /// What the session log said last (`⚙️ Settings: …`); nil until it is said for this sign-in.
    private var logged: String?
    private var subscriptions: Set<AnyCancellable> = []

    init(preferences: Preferences, api: CueAPI, log: SessionLog) {
        self.preferences = preferences
        self.api = api
        self.log = log
        api.$settings.removeDuplicates().sink { [weak self] settings in self?.accountChanged(settings) }.store(in: &subscriptions)
        api.$phase.removeDuplicates().sink { [weak self] phase in if phase == .signedOut { self?.logged = nil } }.store(in: &subscriptions)
        preferences.$speakerName.dropFirst().removeDuplicates().sink { [weak self] name in self?.nameChanged(name) }.store(in: &subscriptions)
        preferences.$autoAnswer.dropFirst().removeDuplicates()
            .sink { [weak self] on in self?.changed("autoAnswer", PersonalSettings(autoAnswer: on)) }.store(in: &subscriptions)
        preferences.$micQuestions.dropFirst().removeDuplicates()
            .sink { [weak self] on in self?.changed("micQuestions", PersonalSettings(micQuestions: on)) }.store(in: &subscriptions)
        preferences.$summarizeRecordings.dropFirst().removeDuplicates()
            .sink { [weak self] on in self?.changed("summarize", PersonalSettings(summarize: on)) }.store(in: &subscriptions)
        preferences.$keepAudio.dropFirst().removeDuplicates()
            .sink { [weak self] on in self?.changed("keepAudio", PersonalSettings(keepAudio: on)) }.store(in: &subscriptions)
    }

    /// At sign-in, before the projects: the settings the account has none of yet are this Mac's, sent once. Then the account's are in effect.
    func signedIn() async {
        let account = api.settings
        var mine = PersonalSettings()
        if account.speakerName == nil { mine.speakerName = preferences.speakerName }
        if account.autoAnswer == nil { mine.autoAnswer = preferences.autoAnswer }
        if account.micQuestions == nil { mine.micQuestions = preferences.micQuestions }
        if account.summarize == nil { mine.summarize = preferences.summarizeRecordings }
        if account.keepAudio == nil { mine.keepAudio = preferences.keepAudio }
        if mine != PersonalSettings() {
            do {
                try await api.saveSettings(mine)
                log.write("📦 Imported your settings from this Mac")
            } catch {
                log.write("⚠︎ Couldn't save your settings: \(error.localizedDescription)")
            }
        }
        logSettings()
    }

    /// The account's settings changed (signing in, another device, a save here): what changed is put into the preferences, but not over a
    /// change made here that isn't saved yet.
    private func accountChanged(_ settings: PersonalSettings) {
        let before = seen
        seen = settings
        applying = true
        defer { applying = false }
        if settings.speakerName != before.speakerName, !pending("speakerName"), let name = settings.speakerName { preferences.speakerName = name }
        if settings.autoAnswer != before.autoAnswer, !pending("autoAnswer"), let on = settings.autoAnswer { preferences.autoAnswer = on }
        if settings.micQuestions != before.micQuestions, !pending("micQuestions"), let on = settings.micQuestions { preferences.micQuestions = on }
        if settings.summarize != before.summarize, !pending("summarize"), let on = settings.summarize { preferences.summarizeRecordings = on }
        if settings.keepAudio != before.keepAudio, !pending("keepAudio"), let on = settings.keepAudio { preferences.keepAudio = on }
        if api.isSignedIn { logSettings() }
    }

    private func pending(_ key: String) -> Bool { edits[key, default: 0] != settled[key, default: 0] }

    /// The name: pending from the first keystroke, saved a moment after the last.
    private func nameChanged(_ name: String) {
        guard !applying, api.isSignedIn else { return }
        edits["speakerName", default: 0] += 1
        let edit = edits["speakerName"]!
        nameSave?.cancel()
        nameSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, let self else { return }
            nameSave = nil
            save("speakerName", edit, PersonalSettings(speakerName: name))
        }
    }

    /// A setting changed here: saved to the account while someone is signed in (signed out, it stays this Mac's).
    private func changed(_ key: String, _ changes: PersonalSettings) {
        guard !applying, api.isSignedIn else { return }
        edits[key, default: 0] += 1
        save(key, edits[key]!, changes)
    }

    private func save(_ key: String, _ edit: Int, _ changes: PersonalSettings) {
        let previous = saving
        saving = Task { [weak self] in
            await previous?.value
            await self?.send(key, edit, changes)
        }
    }

    private func send(_ key: String, _ edit: Int, _ changes: PersonalSettings) async {
        guard api.isSignedIn else { return }
        do {
            try await api.saveSettings(changes)
            settled[key] = edit
            log.write("☁️ Saved your settings to your account")
            logSettings()
        } catch {
            settled[key] = edit
            log.write("⚠︎ Couldn't save your settings: \(error.localizedDescription)")
            // The account's value is back in effect, unless the setting was changed here again meanwhile.
            seen = PersonalSettings()
            accountChanged(api.settings)
        }
    }

    /// `⚙️ Settings: name “Ann”, Auto on, questions from the room off, summaries on, audio kept`, when that isn't what the log said last.
    private func logSettings() {
        let name = preferences.speakerName.isEmpty ? "no name" : "name “\(preferences.speakerName)”"
        let described = [
            name, "Auto \(preferences.autoAnswer ? "on" : "off")", "questions from the room \(preferences.micQuestions ? "on" : "off")",
            "summaries \(preferences.summarizeRecordings ? "on" : "off")", preferences.keepAudio ? "audio kept" : "audio not kept",
        ].joined(separator: ", ")
        guard described != logged else { return }
        logged = described
        log.write("⚙️ Settings: \(described)")
    }
}
