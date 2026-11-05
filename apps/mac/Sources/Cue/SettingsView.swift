import AppKit
import SwiftUI

/// The panes of the Settings window (⌘,), one per toolbar tab. Everything about a particular talk
/// lives on its project page.
enum SettingsTab: String, CaseIterable {
    case general, account, calendar

    var title: String { rawValue.capitalized }
    /// Each pane's window size: the window takes it when its tab is picked.
    var size: CGSize {
        switch self {
        case .general: CGSize(width: 500, height: 780)
        case .account: CGSize(width: 500, height: 600)
        case .calendar: CGSize(width: 500, height: 440)
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .account: "person.crop.circle"
        case .calendar: "calendar"
        }
    }
}

/// General: who the speaker is, the languages Cue is read in, how answers show, what notes keep, where the library is, and updates.
struct GeneralSettings: View {
    @ObservedObject var preferences: Preferences
    /// The account, which keeps the languages.
    @ObservedObject var api: CueAPI
    /// Saves the languages to the account (`AppState.setLanguages`).
    let setLanguages: ([String]) -> Void
    @ObservedObject var updater: Updater

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $preferences.speakerName, prompt: Text("How notes and answers refer to you"))
            } footer: {
                Text("Your name, Auto, questions from the room and what notes keep are kept in your Cue account: the same on every Mac and PC you sign in to.")
            }

            Section {
                Picker("Read Cue in", selection: firstLanguage) {
                    Text("None").tag("")
                    ForEach(CueLanguage.all) { Text($0.native).tag($0.code) }
                }
                if let first = api.languages.first {
                    Picker("Also in", selection: secondLanguage) {
                        Text("None").tag("")
                        ForEach(CueLanguage.all.filter { $0.code != first }) { Text($0.native).tag($0.code) }
                    }
                }
                if api.languages.count == 2 {
                    Picker("Answers", selection: $preferences.answerLayout) {
                        ForEach(AnswerLayout.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Notes", selection: $preferences.noteLayout) {
                        ForEach(NoteLayout.allCases) { Text($0.title).tag($0) }
                    }
                }
            } header: {
                Text("Languages")
            } footer: {
                Text(api.languages.count == 2
                     ? "Answers come in the language you speak, each line with its translation; notes are translated too."
                     : "Cue answers and takes notes in the language it hears. Add a second language to have both.")
            }
            .disabled(!api.isSignedIn)

            Section("Answers") {
                Toggle("Answer questions automatically", isOn: $preferences.autoAnswer)
                Toggle("Also listen for questions from people in the room", isOn: $preferences.micQuestions)
                Toggle("Show the transcript under answers", isOn: $preferences.showTranscript)
                LabeledContent("Text size") {
                    Stepper(value: $preferences.textSize, in: 11...28, step: 1) {
                        Text("\(Int(preferences.textSize)) pt").monospacedDigit()
                    }
                }
            }

            Section {
                Toggle("Write a summary of each call", isOn: $preferences.summarizeRecordings)
                Toggle(isOn: $preferences.keepAudio) {
                    Text("Keep audio")
                    Text("Saved next to the notes, about 15 MB per hour")
                }
            } header: {
                Text("Notes")
            } footer: {
                Text("⌃⌥R records a call into the current project. Let people know when you record — consent rules vary by place.")
            }

            Section {
                LabeledContent("Location") {
                    HStack(spacing: 8) {
                        Text(preferences.libraryFolder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(.secondary)
                        Button("Choose…", action: chooseLibrary)
                    }
                }
            } header: {
                Text("Library")
            } footer: {
                Text("One folder per project, with its materials and notes. Choosing another folder doesn’t move the projects already there.")
            }

            // Only in a Cue that updates itself (a release build): a local or test build's General pane stays as it was.
            if updater.feed != nil {
                Section {
                    LabeledContent("Version", value: updater.version)
                    Toggle("Update Cue automatically", isOn: $preferences.automaticUpdates)
                    LabeledContent {
                        if case .installed = updater.phase {
                            Button("Restart to Update", action: updater.restart)
                        } else {
                            Button("Check Now") { Task { await updater.check() } }
                                .disabled(updater.busy)
                        }
                    } label: {
                        Text(updater.status)
                    }
                } header: {
                    Text("Updates")
                } footer: {
                    Text("Cue looks for a new version when it opens and every few hours, and puts it in place of this one. macOS asks again for the microphone and call audio afterwards.")
                }
            }
        }
        .formStyle(.grouped)
    }

    /// The first language: None clears both; the second one picked first swaps them.
    private var firstLanguage: Binding<String> {
        Binding {
            api.languages.first ?? ""
        } set: { code in
            let current = api.languages
            if code.isEmpty {
                setLanguages([])
            } else if current.count == 2, current[1] == code {
                setLanguages([code, current[0]])
            } else {
                setLanguages([code] + current.dropFirst().filter { $0 != code })
            }
        }
    }

    private var secondLanguage: Binding<String> {
        Binding {
            api.languages.count > 1 ? api.languages[1] : ""
        } set: { code in
            guard let first = api.languages.first else { return }
            setLanguages(code.isEmpty ? [first] : [first, code])
        }
    }

    private func chooseLibrary() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.directoryURL = preferences.libraryFolder
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url { preferences.libraryFolder = url }
    }
}

/// Calendar: what Cue does when a meeting starts, and which calendars it looks in for calls.
struct CalendarSettings: View {
    @ObservedObject var preferences: Preferences
    @ObservedObject var calendar: MeetingCalendar

    var body: some View {
        Form {
            Section {
                Picker("When a meeting starts", selection: $preferences.meetingAction) {
                    ForEach(MeetingAction.allCases) { Text($0.title).tag($0) }
                }
                switch calendar.access {
                case .granted:
                    ForEach(calendar.calendars) { source in
                        Toggle(isOn: watching(source)) {
                            Label {
                                Text(source.title)
                                Text(source.account)
                            } icon: {
                                Image(systemName: "circle.fill").foregroundStyle(source.color ?? .accentColor).imageScale(.small)
                            }
                        }
                    }
                case .notDetermined:
                    LabeledContent("Calendars") { Button("Allow Access…", action: calendar.requestAccess) }
                case .denied:
                    LabeledContent("Calendars") {
                        Button("Open Privacy Settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    }
                }
            } footer: {
                Text("Calls with a Meet, Zoom, Teams or Webex link in these calendars show in Upcoming. When one starts and a call app uses the microphone, Cue offers to record it — calls in Zoom, Teams, Webex, FaceTime or Slack too — and stops a minute after the app lets go of the microphone.")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: calendar.refresh)
    }

    private func watching(_ source: MeetingCalendar.Source) -> Binding<Bool> {
        Binding {
            !preferences.unwatchedCalendars.contains(source.id)
        } set: { watched in
            if watched { preferences.unwatchedCalendars.remove(source.id) } else { preferences.unwatchedCalendars.insert(source.id) }
            calendar.refresh()
        }
    }
}
