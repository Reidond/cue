import AppKit
import SwiftUI

enum SidebarItem: Hashable {
    case home, upcoming
    case project(String)
}

enum ProjectTab: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case answers = "Prepared Answers"
    case notes = "Notes"
    var id: String { rawValue }
}

/// Where the dashboard is, so the app can open it on a page (e.g. the note just recorded).
@MainActor
final class DashboardModel: ObservableObject {
    @Published var selection: SidebarItem? = .home
    @Published var tab: ProjectTab = .overview
    @Published var note: String?
    @Published var creatingProject = false

    var selectedProject: String? {
        if case .project(let id) = selection { id } else { nil }
    }

    func open(_ project: Project) {
        selection = .project(project.id)
        tab = .overview
    }

    func show(_ file: RecordingFile) {
        selection = .project(file.projectID)
        tab = .notes
        note = file.id
    }
}

/// The window Cue opens with: Home, Upcoming and the projects in the sidebar.
struct DashboardView: View {
    @ObservedObject var state: AppState
    @ObservedObject var projects: ProjectStore
    @ObservedObject var model: DashboardModel
    @State private var newName = ""
    @State private var renaming: Project?
    @State private var deleting: Project?

    var body: some View {
        SignInGate(api: state.api) { content }
    }

    private var content: some View {
        NavigationSplitView {
            List(selection: $model.selection) {
                Section {
                    Label("Home", systemImage: "house").tag(SidebarItem.home)
                    Label("Upcoming", systemImage: "calendar").tag(SidebarItem.upcoming)
                }
                Section("Projects") {
                    ForEach(projects.projects) { project in
                        ProjectSidebarRow(project: project, active: project.id == state.activeProject?.id)
                            .tag(SidebarItem.project(project.id))
                            .contextMenu {
                                if state.cueRunning && project.id == state.activeProject?.id {
                                    Button("Stop Cue", action: state.stopCue)
                                } else {
                                    Button("Start Cue") { state.startCue(project) }
                                }
                                Divider()
                                Button("Rename…") { newName = project.name; renaming = project }
                                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([project.folder]) }
                                Divider()
                                Button("Move to Trash…", role: .destructive) { deleting = project }
                            }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    model.creatingProject = true
                } label: {
                    Label("New Project", systemImage: "plus")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.borderless)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .help("New project (⌘N)")
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 300)
        } detail: {
            switch model.selection {
            case .home, nil:
                HomeView(state: state, projects: projects, recordings: state.recordings, downloader: state.downloader,
                         speakers: state.speakerModels, model: model)
            case .upcoming:
                UpcomingView(calendar: state.calendar, meetings: state.meetings, projects: projects, recorder: state.recorder,
                             preferences: state.preferences, openSettings: state.openSettings)
            case .project(let id):
                if let project = projects.project(id) {
                    ProjectView(state: state, projects: projects, recordings: state.recordings, model: model, project: project)
                        .id(id)
                } else {
                    ContentUnavailableView("No Project Selected", systemImage: "folder")
                }
            }
        }
        .frame(minWidth: 820, minHeight: 520)
        .onChange(of: model.creatingProject) { if model.creatingProject { newName = "" } }
        .alert("New Project", isPresented: $model.creatingProject) {
            TextField("Name", text: $newName, prompt: Text("e.g. PhD defense"))
            Button("Create", action: createProject)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A project holds what Cue needs for one talk — the occasion, your slides and documents — and the notes of its calls.")
        }
        .alert("Rename Project", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename", action: renameProject)
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Move “\(deleting?.name ?? "")” to the Trash?",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Move to Trash", role: .destructive, action: deleteProject)
        } message: {
            Text("Its materials are deleted from your account, and its notes go to the Trash. You can restore the folder from the Trash in Finder.")
        }
    }

    private func createProject() {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do {
                model.open(try await projects.create(named: name))
            } catch {
                NSAlert(error: error).show(logging: state.log)
            }
        }
    }

    private func renameProject() {
        guard let project = renaming else { return }
        renaming = nil
        let name = newName
        Task {
            do {
                let renamed = try await projects.rename(project, to: name)
                state.projectsChanged(renamed: project, to: renamed)
                if model.selection == .project(project.id) { model.selection = .project(renamed.id) }
            } catch {
                NSAlert(error: error).show(logging: state.log)
            }
        }
    }

    private func deleteProject() {
        guard let project = deleting else { return }
        deleting = nil
        Task {
            do {
                try await projects.delete(project)
                if model.selection == .project(project.id) { model.selection = .home }
                state.projectsChanged()
            } catch {
                NSAlert(error: error).show(logging: state.log)
            }
        }
    }
}

private struct ProjectSidebarRow: View {
    let project: Project
    let active: Bool

    var body: some View {
        Label {
            HStack {
                Text(project.name).lineLimit(1)
                Spacer()
                if active {
                    Image(systemName: "waveform")
                        .foregroundStyle(.secondary)
                        .imageScale(.small)
                        .help("Cue answers from this project")
                        .accessibilityLabel("Active")
                }
            }
        } icon: {
            Image(systemName: "folder")
        }
    }
}
