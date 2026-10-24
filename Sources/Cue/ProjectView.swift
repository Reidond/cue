import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A project's page: its name and Start Cue on top, then the talk, its
/// prepared answers or its notes, picked in the toolbar.
struct ProjectView: View {
    @ObservedObject var state: AppState
    @ObservedObject var projects: ProjectStore
    @ObservedObject var recordings: RecordingStore
    @ObservedObject var model: DashboardModel
    let project: Project
    @StateObject private var preview = MaterialsPreview()

    private var isActive: Bool { state.activeProject?.id == project.id }
    /// The active project's materials are already read for the overlay; others are read for this page.
    private var knowledge: KnowledgeBase? { isActive ? state.knowledge : preview.knowledge }
    private var reading: Bool { isActive ? state.readingMaterials : preview.reading }

    var body: some View {
        VStack(spacing: 0) {
            ProjectHeader(project: project, active: isActive, notes: recordings.files(in: project).count) {
                state.startCue(project)
            }
            switch model.tab {
            case .overview:
                ProjectOverview(projects: projects, project: project, knowledge: knowledge, reading: reading)
            case .answers:
                PreparedAnswersView(answers: knowledge?.prepared ?? [], reading: reading)
            case .notes:
                ProjectNotesView(store: recordings, state: state, project: project, selection: $model.note)
            }
        }
        .navigationTitle(project.name)
        .toolbar(removing: .title)  // the header shows the name
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Page", selection: $model.tab) {
                    ForEach(ProjectTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
        .task(id: PreviewKey(project: project, speaker: state.preferences.speakerName)) {
            guard !isActive else { return }
            await preview.read(project, speaker: state.preferences.speakerName)
        }
    }

    private struct PreviewKey: Equatable {
        let materials: [URL], language: String, occasion: String, speaker: String
        init(project: Project, speaker: String) {
            materials = project.materials
            language = project.language
            occasion = project.occasion
            self.speaker = speaker
        }
    }
}

/// Reads a project's materials for its page, the way Cue reads them for answers.
@MainActor
final class MaterialsPreview: ObservableObject {
    @Published private(set) var knowledge: KnowledgeBase?
    @Published private(set) var reading = false

    func read(_ project: Project, speaker: String) async {
        reading = true
        let materials = project.materials
        let context = PromptContext(speaker: speaker, occasion: project.occasion, languageCode: project.language)
        let knowledge = await Task.detached(priority: .userInitiated) {
            KnowledgeBase.build(materials: materials, context: context)
        }.value
        guard !Task.isCancelled else { return }
        self.knowledge = knowledge
        reading = false
    }
}

private struct ProjectHeader: View {
    let project: Project
    let active: Bool
    let notes: Int
    let start: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.largeTitle.weight(.bold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(subtitle)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: start) {
                Label("Start Cue", systemImage: "play.fill")
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.extraLarge)
            .help("Show Cue and answer from this project (⌘↩)")
        }
        .padding(.horizontal, 28)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    private var subtitle: String {
        var parts = [SpokenLanguage.named(project.language).name]
        parts.append(project.materials.count == 1 ? "1 file" : "\(project.materials.count) files")
        parts.append(notes == 1 ? "1 note" : "\(notes) notes")
        if active { parts.append("Cue answers from this project") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Overview

private struct ProjectOverview: View {
    @ObservedObject var projects: ProjectStore
    let project: Project
    let knowledge: KnowledgeBase?
    let reading: Bool
    @State private var dropTargeted = false

    var body: some View {
        Form {
            Section {
                TextField("Occasion", text: field(\.occasion),
                          prompt: Text("e.g. PhD pre-defense of my dissertation on …"), axis: .vertical)
                    .lineLimit(2...5)
                Picker("Language", selection: field(\.language)) {
                    ForEach(SpokenLanguage.all) { Text($0.name).tag($0.code) }
                }
                TextField("Names and terms", text: field(\.vocabulary),
                          prompt: Text("People's names, jargon, product names…"), axis: .vertical)
                    .lineLimit(2...5)
            } header: {
                Text("About the Talk")
            } footer: {
                Text("A sentence or two about the talk and who will be asking. Cue listens and answers in this language; names and terms help speech recognition spell what it hears.")
            }

            Section {
                if project.materials.isEmpty {
                    dropHint
                } else {
                    ForEach(project.materials, id: \.self) { url in
                        MaterialRow(url: url, document: knowledge?.documents.first { $0.url == url }, reading: reading) {
                            projects.removeMaterial(url, from: project)
                        }
                    }
                }
                HStack {
                    Button("Add Files…", systemImage: "plus", action: chooseFiles)
                    Spacer()
                    if reading {
                        ProgressView().controlSize(.small)
                    } else if let knowledge, !project.materials.isEmpty {
                        Text(summary(knowledge)).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } header: {
                Text("Materials")
            } footer: {
                Text("PDF, PowerPoint, Word, Markdown or text, copied into the project folder. Prepared answers are picked up from lines like “Q: …” followed by “A: …”, and from questions followed by an “Answer:” line, including in speaker notes.")
            }
            .dropDestination(for: URL.self) { urls, _ in
                projects.addMaterials(urls, to: project)
                return true
            } isTargeted: { dropTargeted = $0 }
        }
        .formStyle(.grouped)
    }

    /// Edits go straight to `project.json`.
    private func field(_ keyPath: WritableKeyPath<Project, String>) -> Binding<String> {
        Binding {
            projects.project(project.id)?[keyPath: keyPath] ?? ""
        } set: { value in
            guard var current = projects.project(project.id) else { return }
            current[keyPath: keyPath] = value
            projects.update(current)
        }
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

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = Materials.supportedExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Add"
        if panel.runModal() == .OK { projects.addMaterials(panel.urls, to: project) }
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
            .help("Move to Trash")
            .accessibilityLabel("Remove \(url.lastPathComponent)")
        }
    }
}
