import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A project's page: its name and Start Cue on top, then its materials (and what Cue prepared from them), its
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
            ProjectHeader(project: project, active: isActive, running: isActive && state.cueRunning,
                          notes: recordings.files(in: project).count,
                          start: { state.startCue(project) }, stop: state.stopCue)
            switch model.tab {
            case .overview:
                ProjectOverview(projects: projects, project: project, knowledge: knowledge, reading: reading,
                                showAnswers: { model.tab = .answers })
            case .answers:
                PreparedAnswersView(answers: knowledge?.prepared ?? [], reading: reading, brief: project.brief,
                                    hasMaterials: !project.materials.isEmpty)
            case .notes:
                ProjectNotesView(store: recordings, state: state, project: project, selection: $model.note, language: $model.noteLanguage)
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
        .task(id: PreviewKey(project: project)) {
            guard !isActive else { return }
            await preview.read(project, in: projects)
        }
    }

    private struct PreviewKey: Equatable {
        let materials: [Material], brief: ProjectBrief
        init(project: Project) {
            materials = project.materials
            brief = project.brief
        }
    }
}

/// Asks the account for a project's materials for its page.
@MainActor
final class MaterialsPreview: ObservableObject {
    @Published private(set) var knowledge: KnowledgeBase?
    @Published private(set) var reading = false

    func read(_ project: Project, in store: ProjectStore) async {
        reading = true
        let read = await store.knowledge(of: project.serverID)
        guard !Task.isCancelled else { return }
        if let read { knowledge = read }
        reading = false
    }
}

private struct ProjectHeader: View {
    let project: Project
    let active: Bool
    /// Cue runs for this project: the button stops it.
    let running: Bool
    let notes: Int
    let start: () -> Void
    let stop: () -> Void

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
            if running {
                Button(action: stop) {
                    Label("Stop Cue", systemImage: "stop.fill")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.bordered)
                .controlSize(.extraLarge)
                .help("Hide Cue and stop listening (⌘↩)")
            } else {
                Button(action: start) {
                    Label("Start Cue", systemImage: "play.fill")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.extraLarge)
                .help("Show Cue and answer from this project (⌘↩)")
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    private var subtitle: String {
        var parts = [project.materials.count == 1 ? "1 file" : "\(project.materials.count) files"]
        parts.append(notes == 1 ? "1 note" : "\(notes) notes")
        if active { parts.append("Cue answers from this project") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Overview

/// The materials first: everything else Cue writes from them (the brief), and keeps under Advanced for the person to change.
private struct ProjectOverview: View {
    @ObservedObject var projects: ProjectStore
    let project: Project
    let knowledge: KnowledgeBase?
    let reading: Bool
    let showAnswers: () -> Void
    @State private var dropTargeted = false
    @State private var advanced = false

    var body: some View {
        Form {
            Section {
                if project.materials.isEmpty {
                    dropHint
                } else {
                    ForEach(project.materials) { material in
                        MaterialRow(material: material) {
                            Task { await projects.removeMaterial(material, from: project) }
                        }
                    }
                }
                HStack {
                    Button("Add Files…", systemImage: "plus", action: chooseFiles)
                    Spacer()
                    if reading || projects.uploading.contains(project.id) {
                        ProgressView().controlSize(.small)
                    } else if let knowledge, !project.materials.isEmpty {
                        Text(summary(knowledge)).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } header: {
                Text("Materials")
            } footer: {
                Text("Slides, documents and notes: PDF, PowerPoint, Word, Markdown or text, kept in your Cue account. Cue reads them and prepares the rest: what the talk is about, the names and terms to listen for, and answers to the questions people are likely to ask.")
            }
            .dropDestination(for: URL.self) { urls, _ in
                Task { await projects.addMaterials(urls, to: project) }
                return true
            } isTargeted: { dropTargeted = $0 }

            if !project.materials.isEmpty {
                Section {
                    BriefRow(brief: project.brief, showAnswers: showAnswers) {
                        Task { await projects.prepareAgain(project) }
                    }
                }
            }

            Section {
                DisclosureGroup("Advanced", isExpanded: $advanced) {
                    TextField("Occasion", text: field(\.occasion), prompt: Text(occasionPrompt), axis: .vertical)
                        .lineLimit(2...5)
                    TextField("Names and terms", text: field(\.vocabulary), prompt: Text(termsPrompt), axis: .vertical)
                        .lineLimit(2...5)
                }
            } footer: {
                if advanced {
                    Text("Cue writes these from your materials. Type to use your own words instead; clear a field to go back to Cue's. There is no language to choose: Cue hears what is spoken.")
                }
            }
        }
        .formStyle(.grouped)
    }

    private var occasionPrompt: String {
        project.brief.occasion.isEmpty ? "What the talk is about and who will ask, from your materials" : project.brief.occasion
    }

    private var termsPrompt: String {
        project.brief.terms.isEmpty ? "People's names, jargon, product names, from your materials" : project.brief.terms.joined(separator: ", ")
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
            Text("Drop slides, documents and notes here")
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
        panel.allowedContentTypes = Material.supportedExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Add"
        if panel.runModal() == .OK {
            let urls = panel.urls
            Task { await projects.addMaterials(urls, to: project) }
        }
    }
}

/// How Cue's reading of the materials went: under way, what it prepared, or why it couldn't.
private struct BriefRow: View {
    let brief: ProjectBrief
    let showAnswers: () -> Void
    let prepare: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            switch brief.state {
            case .working:
                ProgressView().controlSize(.small)
                Text("Reading your materials…").foregroundStyle(.secondary)
                Spacer()
            case .ready:
                Label(prepared, systemImage: "sparkles")
                Spacer()
                Button("Show Answers", action: showAnswers)
            case .failed:
                Label(brief.error ?? "Cue couldn't read your materials", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Spacer()
                Button("Try Again", action: prepare)
            case .none:
                Text("Cue hasn't read these files yet").foregroundStyle(.secondary)
                Spacer()
                Button("Prepare", action: prepare)
            }
        }
    }

    private var prepared: String {
        let answers = brief.answerCount == 1 ? "1 answer" : "\(brief.answerCount) answers"
        let terms = brief.terms.count == 1 ? "1 name or term" : "\(brief.terms.count) names and terms"
        return "Prepared \(answers) and \(terms) from your materials"
    }
}

private struct MaterialRow: View {
    let material: Material
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(for: UTType(filenameExtension: (material.name as NSString).pathExtension) ?? .data))
                .resizable()
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(material.name).lineLimit(1).truncationMode(.middle)
                Group {
                    if let error = material.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else {
                        Text(material.summary).foregroundStyle(.secondary)
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
            .help("Remove from the project")
            .accessibilityLabel("Remove \(material.name)")
        }
    }
}
