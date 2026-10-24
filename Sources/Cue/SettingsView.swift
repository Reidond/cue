import AppKit
import SwiftUI

/// Global preferences (⌘,). Everything about a particular talk lives on its project page.
struct SettingsView: View {
    @ObservedObject var preferences: Preferences
    @ObservedObject var calendar: MeetingCalendar

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $preferences.speakerName, prompt: Text("How notes and answers refer to you"))
            }

            Section("Answers") {
                Picker("Model", selection: $preferences.model) {
                    ForEach(ClaudeService.Model.allCases, id: \.self) { Text($0.title).tag($0) }
                }
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
            } header: {
                Text("Notes")
            } footer: {
                Text("⌃⌥R records a call into the current project. Let people know when you record — consent rules vary by place.")
            }

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
            } header: {
                Text("Calendar")
            } footer: {
                Text("Calls with a Meet, Zoom, Teams or Webex link in these calendars show in Upcoming. When one starts and a call app uses the microphone, Cue offers to record it — calls in Zoom, Teams, Webex, FaceTime or Slack too — and stops a minute after the app lets go of the microphone.")
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
        .frame(width: 480, height: 640)
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
