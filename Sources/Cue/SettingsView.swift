import AppKit
import SwiftUI

/// Global preferences (⌘,). Everything about a particular talk lives on its project page.
struct SettingsView: View {
    @ObservedObject var preferences: Preferences

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
        .frame(width: 480, height: 470)
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
