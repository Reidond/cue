import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

/// Standard grouped form; on macOS 26+ the system draws its controls in Liquid Glass.
struct SettingsView: View {
    @ObservedObject var state: AppState
    @ObservedObject var profile: Profile
    @ObservedObject var downloader: ModelDownloader
    @State private var checks = SetupCheck.all()
    @State private var dropTargeted = false

    private let refresh = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        Form {
            Section {
                TextField("Your name", text: $profile.speakerName, prompt: Text("How the transcript refers to you"))
                Picker("Language", selection: $profile.languageCode) {
                    ForEach(SpokenLanguage.all) { Text($0.name).tag($0.code) }
                }
            } header: {
                Text("Talk")
            } footer: {
                Text("Cue listens and answers in this language.")
            }

            Section {
                TextField("Occasion", text: $profile.occasion,
                          prompt: Text("e.g. PhD pre-defense of my dissertation on …"), axis: .vertical)
                    .labelsHidden()
                    .lineLimit(2...5)
            } header: {
                Text("Occasion")
            } footer: {
                Text("A sentence or two about the talk and who will be asking.")
            }

            Section {
                if profile.materials.isEmpty {
                    dropHint
                } else {
                    ForEach(profile.materials, id: \.self) { url in
                        MaterialRow(url: url, document: state.knowledge?.documents.first { $0.url == url },
                                    reading: state.readingMaterials) {
                            profile.materials.removeAll { $0 == url }
                        }
                    }
                }
                HStack {
                    Button("Add Files…", systemImage: "plus", action: chooseFiles)
                    Spacer()
                    if state.readingMaterials {
                        ProgressView().controlSize(.small)
                    } else if let knowledge = state.knowledge, !profile.materials.isEmpty {
                        Text(summary(knowledge)).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } header: {
                Text("Materials")
            } footer: {
                Text("PDF, PowerPoint, Word, Markdown or text. Prepared answers are picked up from lines like “Q: …” followed by “A: …”, and from questions followed by an “Answer:” line, including in speaker notes.")
            }
            .dropDestination(for: URL.self) { urls, _ in
                profile.addMaterials(urls)
                return true
            } isTargeted: { dropTargeted = $0 }

            Section {
                TextField("Names and terms", text: $profile.vocabulary,
                          prompt: Text("People's names, jargon, product names…"), axis: .vertical)
                    .labelsHidden()
                    .lineLimit(2...5)
            } header: {
                Text("Names and Terms")
            } footer: {
                Text("Helps speech recognition spell the names and jargon it will hear.")
            }

            Section("Answers") {
                Picker("Model", selection: $profile.model) {
                    ForEach(ClaudeService.Model.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Toggle("Answer questions automatically", isOn: $profile.autoAnswer)
                Toggle("Also listen for questions from people in the room", isOn: $profile.micQuestions)
                LabeledContent("Text size") {
                    Stepper(value: $profile.textSize, in: 11...28, step: 1) {
                        Text("\(Int(profile.textSize)) pt").monospacedDigit()
                    }
                }
            }

            Section {
                LabeledContent("Save to") {
                    HStack(spacing: 8) {
                        Text(profile.recordingsFolder.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(.secondary)
                        Button("Choose…", action: chooseRecordingsFolder)
                    }
                }
                Toggle("Write a summary with Claude", isOn: $profile.summarizeRecordings)
                Button("Open Recordings") { state.openRecordings(nil) }
            } header: {
                Text("Recordings")
            } footer: {
                Text("⌃⌥R records a call. Notes are saved as Markdown with a summary and the full transcript. Let people know when you record — consent rules vary by place.")
            }

            Section("Setup") {
                ForEach(checks) { check in
                    SetupRow(check: check, downloader: downloader)
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 480, idealWidth: 520, minHeight: 560, idealHeight: 720)
        .onReceive(refresh) { _ in checks = SetupCheck.all() }
    }

    private var dropHint: some View {
        VStack(spacing: 8) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(dropTargeted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            Text("Drop slides, documents and prepared answers here")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    private func summary(_ knowledge: KnowledgeBase) -> String {
        let tokens = knowledge.estimatedTokens
        let size = tokens >= 1000 ? "\(tokens / 1000)k" : "\(tokens)"
        return "~\(size) tokens · \(knowledge.prepared.count) prepared answers"
    }

    private func chooseRecordingsFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.directoryURL = profile.recordingsFolder
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url { profile.recordingsFolder = url }
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = Materials.supportedExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Add"
        if panel.runModal() == .OK { profile.addMaterials(panel.urls) }
    }
}

private struct MaterialRow: View {
    let url: URL
    let document: MaterialDocument?
    let reading: Bool
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                .resizable()
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(url.lastPathComponent).lineLimit(1).truncationMode(.middle)
                Group {
                    if let error = document?.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else if let document {
                        Text(document.summary).foregroundStyle(.secondary)
                    } else {
                        Text(reading ? "Reading…" : " ").foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
            Spacer()
            Button(action: remove) {
                Image(systemName: "minus.circle.fill")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("Remove")
            .accessibilityLabel("Remove \(url.lastPathComponent)")
        }
    }
}

private struct SetupRow: View {
    let check: SetupCheck
    @ObservedObject var downloader: ModelDownloader

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: check.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(check.ok ? .green : .orange)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.title)
                Text(downloadError ?? check.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            action
        }
    }

    private var downloadError: String? { check.item == .model ? downloader.error : nil }

    @ViewBuilder private var action: some View {
        if !check.ok {
            switch check.item {
            case .model:
                if let progress = downloader.progress {
                    ProgressView(value: progress).frame(width: 90)
                    Button("Cancel", action: downloader.cancel)
                } else {
                    Button("Download", action: downloader.start)
                }
            case .whisper:
                Button("Copy Command") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("brew install whisper-cpp", forType: .string)
                }
            case .microphone, .screenAudio:
                if let url = check.settingsURL {
                    Button("Open Settings") { NSWorkspace.shared.open(url) }
                }
            case .claude:
                Link("Get Claude Code", destination: URL(string: "https://claude.com/claude-code")!)
            }
        }
    }
}
