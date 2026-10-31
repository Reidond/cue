import AppKit
import SwiftUI

/// The panes of the Settings window (⌘,), one per toolbar tab. Everything about a particular talk
/// lives on its project page.
enum SettingsTab: String, CaseIterable {
    case general, account, providers, calendar

    var title: String { rawValue.capitalized }
    /// Each pane's window size: the window takes it when its tab is picked.
    var size: CGSize {
        switch self {
        case .general: CGSize(width: 500, height: 660)
        case .account: CGSize(width: 500, height: 440)
        case .providers: CGSize(width: 500, height: 700)
        case .calendar: CGSize(width: 500, height: 440)
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .account: "person.crop.circle"
        case .providers: "cpu"
        case .calendar: "calendar"
        }
    }
}

/// General: who the speaker is, how answers show, what notes keep, where the library is.
struct GeneralSettings: View {
    @ObservedObject var preferences: Preferences

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $preferences.speakerName, prompt: Text("How notes and answers refer to you"))
            }

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
                Toggle("Write a summary with Claude", isOn: $preferences.summarizeRecordings)
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
        }
        .formStyle(.grouped)
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

/// Providers: who answers and summarizes (Claude Code or the Anthropic API), and who turns speech into
/// text (Whisper on this Mac or Deepgram), with the keys of the cloud ones.
struct ProviderSettings: View {
    @ObservedObject var preferences: Preferences
    @ObservedObject var state: AppState

    var body: some View {
        Form {
            Section {
                Picker("Provider", selection: $preferences.claudeProvider) {
                    ForEach(ClaudeProvider.allCases) { provider in
                        ProviderOption(title: provider.title, detail: provider.detail).tag(provider)
                    }
                }
                .pickerStyle(.radioGroup)
                Picker("Model", selection: $preferences.model) {
                    ForEach(ClaudeService.Model.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                switch preferences.claudeProvider {
                case .claudeCode:
                    LabeledContent("Claude Code") {
                        if ClaudeService.findBinary() != nil {
                            Text("Installed").foregroundStyle(.secondary)
                        } else {
                            Link("Get Claude Code", destination: URL(string: "https://claude.com/claude-code")!)
                        }
                    }
                case .anthropicAPI:
                    KeyField(key: .anthropic, prompt: "sk-ant-…", preferences: preferences)
                }
                // Without a key, the field above says what's missing.
                if preferences.claudeProvider == .claudeCode || preferences.savedKeys.contains(.anthropic) {
                    ProviderStatus(status: state.claude)
                }
            } header: {
                Text("Claude")
            } footer: {
                Text("Answers, the question judge and call summaries. Claude Code goes through your Claude plan; the Anthropic API bills each request to your Claude Console account.")
            }

            Section {
                Picker("Provider", selection: $preferences.speechProvider) {
                    ForEach(SpeechProvider.allCases) { provider in
                        ProviderOption(title: provider.title, detail: provider.detail).tag(provider)
                    }
                }
                .pickerStyle(.radioGroup)
                if preferences.speechProvider == .deepgram {
                    KeyField(key: .deepgram, prompt: "Paste your key", preferences: preferences)
                }
                if preferences.speechProvider == .whisper || preferences.savedKeys.contains(.deepgram) {
                    ProviderStatus(status: state.speech)
                }
            } header: {
                Text("Speech Recognition")
            } footer: {
                Text("The live transcript, and the second pass over a recorded call. Keys are kept in your keychain, never in Cue’s settings.")
            }
        }
        .formStyle(.grouped)
    }
}

/// A provider in a radio group: its name over what choosing it means.
private struct ProviderOption: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}

/// A cloud provider's API key: a field to paste it into until it's saved, then where it is and a way to
/// replace or remove it. The key itself is never shown again.
struct KeyField: View {
    let key: APIKey
    let prompt: String
    @ObservedObject var preferences: Preferences
    @State private var draft = ""
    @State private var editing = false
    @State private var error: String?

    var body: some View {
        if preferences.savedKeys.contains(key) && !editing {
            LabeledContent("API key") {
                HStack(spacing: 8) {
                    Label("In your keychain", systemImage: "key.fill")
                        .foregroundStyle(.secondary)
                    Button("Change…") { editing = true }
                    Button("Remove", role: .destructive) { preferences.removeKey(key) }
                }
            }
        } else {
            LabeledContent {
                HStack(spacing: 8) {
                    SecureField("API key", text: $draft, prompt: Text(prompt))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .frame(width: 210)
                        .onSubmit(save)
                    if editing {
                        Button("Cancel") { draft = ""; editing = false; error = nil }
                    }
                    Button("Save", action: save)
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } label: {
                Text("API key")
                if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    Link("Get a key", destination: key.console).font(.caption)
                }
            }
        }
    }

    private func save() {
        do {
            try preferences.saveKey(draft, for: key)
            draft = ""
            editing = false
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// How a provider is doing right now: ready, getting there, or what's wrong.
private struct ProviderStatus: View {
    let status: ServiceStatus

    var body: some View {
        LabeledContent("Status") {
            HStack(spacing: 6) {
                if status.ok {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } else if working {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                Text(status.detail)
                    .foregroundStyle(status.ok || working ? .secondary : .primary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var working: Bool { status.detail.contains("…") }
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
