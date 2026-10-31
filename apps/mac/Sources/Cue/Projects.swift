import AppKit
import Foundation

/// One talk or series of calls. It lives in the Cue account (its settings and its materials); the folder in the library holds what stays on
/// this Mac until the notes move too: `project.json`, which ties the folder to the account's project, and the notes.
struct Project: Codable, Identifiable, Hashable {
    var name: String
    var occasion = ""
    var language: String
    /// Names and terms that speech recognition should spell right.
    var vocabulary = ""
    var created = Date()
    var lastUsed: Date?
    /// The project in the account (the Cue API); nil for one that is only on this Mac so far.
    var serverID: String?

    /// The project's folder; its name is the project's identity here (notes and calendar assignments point at it).
    var folder: URL = URL(fileURLWithPath: "/")
    /// The files of the project, as the account holds them.
    var materials: [Material] = []

    var id: String { folder.lastPathComponent }
    /// Files that were copied here before projects moved to the account; they go up with the project at the first sign-in.
    var materialsFolder: URL { folder.appendingPathComponent("Materials") }
    var notesFolder: URL { folder.appendingPathComponent("Notes") }

    var lexicon: Lexicon { Lexicon.load(language) }

    /// Initial prompt for Whisper: biases recognition towards the names and terms that will come up.
    var whisperPrompt: String {
        [occasion, vocabulary].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: ". ")
    }

    private enum CodingKeys: String, CodingKey {
        case name, occasion, language, vocabulary = "namesAndTerms", created, lastUsed, serverID
    }

    init(name: String, language: String = Project.defaultLanguage) {
        self.name = name
        self.language = language
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        occasion = try container.decodeIfPresent(String.self, forKey: .occasion) ?? ""
        language = try container.decodeIfPresent(String.self, forKey: .language) ?? Self.defaultLanguage
        vocabulary = try container.decodeIfPresent(String.self, forKey: .vocabulary) ?? ""
        created = try container.decodeIfPresent(Date.self, forKey: .created) ?? Date()
        lastUsed = try container.decodeIfPresent(Date.self, forKey: .lastUsed)
        serverID = try container.decodeIfPresent(String.self, forKey: .serverID)
    }

    static var defaultLanguage: String { Locale.current.language.languageCode?.identifier ?? "en" }
}

/// The signed-in person's projects: the account holds them (settings and materials, through the Cue API) and the library folder
/// (`~/Documents/Cue` by default) has one subfolder for each, for the notes.
@MainActor
final class ProjectStore: ObservableObject {
    @Published private(set) var projects: [Project] = []
    /// The projects with a file on its way to the account (by folder name).
    @Published private(set) var uploading: Set<String> = []

    private let preferences: Preferences
    private let api: CueAPI
    private let log: SessionLog
    /// Settings changes waiting to be saved to the account, by project.
    private var saves: [String: Task<Void, Never>] = [:]
    private var syncing = false
    /// Changes in flight (create, rename, delete, adding files), and how many have finished: a re-read of the account that
    /// overlapped one is out of date and is thrown away.
    private var changing = 0
    private var changes = 0

    init(preferences: Preferences, api: CueAPI, log: SessionLog) {
        self.preferences = preferences
        self.api = api
        self.log = log
    }

    var library: URL { preferences.libraryFolder }

    /// Reads the account again, and picks up folders added in Finder.
    func reload() {
        guard api.isSignedIn, changing == 0 else { return }
        Task { await syncWithAccount() }
    }

    func project(_ id: String?) -> Project? { projects.first { $0.id == id } }

    /// The project used last (or created last, if none was used yet).
    var mostRecent: Project? { projects.max { ($0.lastUsed ?? $0.created) < ($1.lastUsed ?? $1.created) } }

    /// By name or folder name (CUE_PROJECT, the migration).
    func project(named name: String) -> Project? {
        projects.first { $0.name == name } ?? projects.first { $0.id == name }
    }

    // MARK: The account

    /// Loads the projects of the account and their files. The first time on this Mac, the projects found in the library that the account
    /// doesn't know yet go up with their materials ("📦 Imported …"). Every project has its folder here, made when it is first seen.
    func syncWithAccount() async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        let changesAtStart = changes
        let local = localProjects()
        do {
            var remote = try await api.listProjects()
            var imported: [Project] = []
            var files = 0
            for project in local where project.serverID == nil {
                if let result = await importProject(project) {
                    imported.append(result.project)
                    files += result.files
                }
            }
            if !imported.isEmpty {
                log.write("📦 Imported \(imported.count) project\(imported.count == 1 ? "" : "s") from this Mac (\(files) file\(files == 1 ? "" : "s"))")
                remote = try await api.listProjects()
            }

            // A create or rename in flight has the account's side done and the folder's not yet: look again once it's over, so nothing is made twice.
            guard changing == 0, changes == changesAtStart else {
                Task { await self.syncWithAccount() }
                return
            }
            var folders: [String: Project] = [:]
            for project in localProjects() {
                if let id = project.serverID, folders[id] == nil { folders[id] = project }
            }
            var synced: [Project] = []
            for item in remote {
                var project = folders[item.id] ?? makeFolder(for: item)
                // A change waiting to be saved is newer than the account's.
                if saves[item.id] == nil { Self.apply(item, to: &project) }
                if let materials = try? await api.materials(of: item.id) { project.materials = materials }
                try? write(project)
                synced.append(project)
            }
            guard changing == 0, changes == changesAtStart else {
                Task { await self.syncWithAccount() }
                return
            }
            projects = synced.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch {
            log.write("⚠︎ Couldn't load your projects: \(error.localizedDescription)")
            if projects.isEmpty { projects = local.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }
        }
    }

    /// What the account says about a project, applied to the one here.
    private static func apply(_ remote: RemoteProject, to project: inout Project) {
        project.name = remote.name
        project.occasion = remote.occasion
        project.language = remote.language
        project.vocabulary = remote.namesAndTerms
        project.created = Date(timeIntervalSince1970: remote.createdAt / 1000)
        project.lastUsed = remote.lastUsedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    private func fields(of project: Project) -> ProjectFields {
        ProjectFields(name: project.name, occasion: project.occasion, language: project.language, namesAndTerms: project.vocabulary,
                      createdAt: project.created.timeIntervalSince1970 * 1000,
                      lastUsedAt: project.lastUsed.map { $0.timeIntervalSince1970 * 1000 })
    }

    private func changes(of project: Project) -> ProjectChanges {
        ProjectChanges(name: project.name, occasion: project.occasion, language: project.language, namesAndTerms: project.vocabulary,
                       lastUsedAt: project.lastUsed.map { $0.timeIntervalSince1970 * 1000 })
    }

    /// Sends a project found in the library to the account, with the files it kept in `Materials/`.
    private func importProject(_ project: Project) async -> (project: Project, files: Int)? {
        var project = project
        do {
            project.serverID = try await api.createProject(fields(of: project)).id
            try write(project)
        } catch {
            log.write("⚠︎ Couldn't import “\(project.name)”: \(error.localizedDescription)")
            return nil
        }
        var files = 0
        let staged = (try? FileManager.default.contentsOfDirectory(at: project.materialsFolder, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)) ?? []
        for url in staged.filter({ Material.supportedExtensions.contains($0.pathExtension.lowercased()) })
            .sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
            do {
                _ = try await api.uploadMaterial(url, to: project.serverID ?? "")
                files += 1
            } catch {
                log.write("⚠︎ Couldn't import \(url.lastPathComponent) of “\(project.name)”: \(error.localizedDescription)")
            }
        }
        return (project, files)
    }

    // MARK: Changes

    /// A new project in the account, and its folder here.
    @discardableResult
    func create(named name: String, language: String = Project.defaultLanguage) async throws -> Project {
        changing += 1
        defer {
            changing -= 1
            changes += 1
        }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let remote = try await api.createProject(ProjectFields(name: name, language: language))
        var project = makeFolder(for: remote)
        Self.apply(remote, to: &project)
        try write(project)
        projects = (projects + [project]).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return project
    }

    /// Saves the fields (name, occasion, language, names and terms, dates): at once here, and to the account a moment after the last edit.
    func update(_ project: Project) {
        guard let index = projects.firstIndex(where: { $0.id == project.id }), projects[index] != project else { return }
        projects[index] = project
        try? write(project)
        guard let serverID = project.serverID else { return }
        saves[serverID]?.cancel()
        saves[serverID] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await self?.save(serverID)
        }
    }

    private func save(_ serverID: String) async {
        saves[serverID] = nil
        guard let project = projects.first(where: { $0.serverID == serverID }) else { return }
        do {
            try await api.updateProject(serverID, changes(of: project))
            log.write("☁️ Saved “\(project.name)” to your account")
        } catch {
            log.write("⚠︎ Couldn't save “\(project.name)”: \(error.localizedDescription)")
        }
    }

    /// Renames the project in the account, and its folder here; returns the renamed project.
    func rename(_ project: Project, to name: String) async throws -> Project {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != project.name else { return project }
        changing += 1
        defer {
            changing -= 1
            changes += 1
        }
        if let serverID = project.serverID { try await api.updateProject(serverID, ProjectChanges(name: name)) }
        var renamed = self.project(project.id) ?? project
        renamed.name = name
        if Self.folderName(for: name) != project.id {
            renamed.folder = library.appendingPathComponent(uniqueFolderName(for: name))
            try FileManager.default.moveItem(at: project.folder, to: renamed.folder)
        }
        try write(renamed)
        projects = (projects.filter { $0.id != project.id } + [renamed]).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return renamed
    }

    /// Deletes the project and its materials from the account, and moves its folder here, notes included, to the Trash.
    func delete(_ project: Project) async throws {
        changing += 1
        defer {
            changing -= 1
            changes += 1
        }
        if let serverID = project.serverID {
            saves[serverID]?.cancel()
            saves[serverID] = nil
            try await api.deleteProject(serverID)
        }
        try FileManager.default.trashItem(at: project.folder, resultingItemURL: nil)
        projects.removeAll { $0.id == project.id }
    }

    /// Sends files to the project; the account stores them and reads their text. Files of a kind it doesn't read are skipped.
    @discardableResult
    func addMaterials(_ urls: [URL], to project: Project) async -> Int {
        guard let serverID = project.serverID else { return 0 }
        changing += 1
        uploading.insert(project.id)
        defer {
            changing -= 1
            changes += 1
            uploading.remove(project.id)
        }
        var added = 0
        for url in urls where Material.supportedExtensions.contains(url.pathExtension.lowercased()) {
            guard FileManager.default.isReadableFile(atPath: url.path) else { continue }
            do {
                let material = try await api.uploadMaterial(url, to: serverID)
                added += 1
                log.write("📎 Added \(material.name) to \(project.name): \(material.error ?? material.summary)")
            } catch {
                log.write("⚠︎ Couldn't add \(url.lastPathComponent) to \(project.name): \(error.localizedDescription)")
            }
        }
        await refreshMaterials(of: project.id)
        return added
    }

    func removeMaterial(_ material: Material, from project: Project) async {
        guard let serverID = project.serverID else { return }
        changing += 1
        defer {
            changing -= 1
            changes += 1
        }
        do {
            try await api.deleteMaterial(material.id, in: serverID)
            log.write("🗑 Removed \(material.name) from \(project.name)")
        } catch {
            log.write("⚠︎ Couldn't remove \(material.name): \(error.localizedDescription)")
        }
        await refreshMaterials(of: project.id)
    }

    private func refreshMaterials(of id: String) async {
        guard let serverID = project(id)?.serverID, let materials = try? await api.materials(of: serverID) else { return }
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[index].materials = materials
    }

    /// What the account read from the project's files, for the project's page. Nil when it couldn't be asked.
    func documents(of serverID: String?) async -> [MaterialDocument]? {
        guard let serverID else { return [] }
        do {
            let materials = try await api.materials(of: serverID)
            let answers = try await api.preparedAnswers(of: serverID)
            var documents: [MaterialDocument] = []
            for material in materials {
                var document = MaterialDocument(name: material.name, summary: material.summary, error: material.error)
                if material.error == nil { document.text = try await api.materialText(material.id, in: serverID).text }
                document.prepared = answers.filter { $0.materialId == material.id }.map {
                    PreparedAnswer(q: $0.question, a: $0.answer, who: $0.who, source: $0.source)
                }
                documents.append(document)
            }
            return documents
        } catch {
            // A page that was left, or a newer read that replaced this one, cancels it: nothing went wrong.
            if !Task.isCancelled { log.write("⚠︎ Couldn't read your materials: \(error.localizedDescription)") }
            return nil
        }
    }

    // MARK: Files

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func write(_ project: Project) throws {
        try FileManager.default.createDirectory(at: project.folder, withIntermediateDirectories: true)
        try Self.encoder.encode(project).write(to: project.folder.appendingPathComponent("project.json"), options: .atomic)
    }

    /// Every folder in the library is a project; one without `project.json` is named after its folder.
    private func localProjects() -> [Project] {
        let folders = (try? FileManager.default.contentsOfDirectory(
            at: library, includingPropertiesForKeys: [.isDirectoryKey], options: .skipsHiddenFiles)) ?? []
        return folders
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(Self.load)
    }

    private static func load(_ folder: URL) -> Project {
        let data = try? Data(contentsOf: folder.appendingPathComponent("project.json"))
        var project = data.flatMap { try? decoder.decode(Project.self, from: $0) } ?? Project(name: folder.lastPathComponent)
        if project.name.trimmingCharacters(in: .whitespaces).isEmpty { project.name = folder.lastPathComponent }
        project.folder = folder
        return project
    }

    /// The project's folder here, made when the account's project is first seen on this Mac.
    private func makeFolder(for remote: RemoteProject) -> Project {
        var project = Project(name: remote.name, language: remote.language)
        project.serverID = remote.id
        project.folder = library.appendingPathComponent(uniqueFolderName(for: remote.name))
        try? FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
        return project
    }

    private static func folderName(for name: String) -> String {
        let safe = name.components(separatedBy: CharacterSet(charactersIn: "/:\\\n")).joined(separator: "-")
            .trimmingCharacters(in: CharacterSet.whitespaces.union(["."]))
        return safe.isEmpty ? "Project" : String(safe.prefix(80))
    }

    private func uniqueFolderName(for name: String) -> String {
        let base = Self.folderName(for: name)
        var candidate = base, number = 2
        while FileManager.default.fileExists(atPath: library.appendingPathComponent(candidate).path) {
            candidate = "\(base) \(number)"
            number += 1
        }
        return candidate
    }

    // MARK: Upgrade

    /// One-time move from the single set of settings Cue had before projects: the
    /// talk settings and materials become the project "My project", and the notes
    /// in the old recordings folder move into its `Notes/`. The project is only a folder here;
    /// signing in sends it to the account. Safe to run again.
    func migrateLegacySettings(log: SessionLog) {
        let defaults = appDefaults
        guard !defaults.bool(forKey: "migratedToProjects") else { return }
        defer { defaults.set(true, forKey: "migratedToProjects") }

        let materials = (defaults.stringArray(forKey: "materials") ?? []).map { URL(fileURLWithPath: $0) }
        let occasion = defaults.string(forKey: "occasion") ?? ""
        let vocabulary = defaults.string(forKey: "vocabulary") ?? ""
        let language = defaults.string(forKey: "language")
        let oldNotesFolder = defaults.string(forKey: "recordingsFolder").map { URL(fileURLWithPath: $0) }
            ?? documentsFolder.appendingPathComponent("Cue Recordings")
        let notes = ((try? FileManager.default.contentsOfDirectory(at: oldNotesFolder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "md" }
        guard !materials.isEmpty || !occasion.isEmpty || !vocabulary.isEmpty || language != nil || !notes.isEmpty else { return }

        let name = "My project"
        do {
            var project = localProjects().first { $0.name == name || $0.id == name } ?? Project(name: name)
            if project.folder.path == "/" { project.folder = library.appendingPathComponent(uniqueFolderName(for: name)) }
            project.occasion = occasion
            project.vocabulary = vocabulary
            project.language = language ?? project.language
            try FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
            try write(project)
            let copied = copyMaterials(materials, into: project)

            var moved = 0
            for note in notes {
                let target = project.notesFolder.appendingPathComponent(note.lastPathComponent)
                guard !FileManager.default.fileExists(atPath: target.path),
                      (try? FileManager.default.moveItem(at: note, to: target)) != nil else { continue }
                RecordingFile.setProject(name, in: target)
                moved += 1
            }
            let left = (try? FileManager.default.contentsOfDirectory(atPath: oldNotesFolder.path))?.filter { $0 != ".DS_Store" }
            if left?.isEmpty == true { try? FileManager.default.removeItem(at: oldNotesFolder) }

            preferences.activeProject = project.id
            log.write("📦 Moved your settings into the project “\(name)”: \(copied) of \(materials.count) materials copied, \(moved) notes moved")
        } catch {
            log.write("⚠︎ Couldn't move your settings into a project: \(error.localizedDescription)")
        }
    }

    /// Copies files into the project's `Materials/`, to go up to the account with it. A file already there with the same contents is
    /// skipped; a different one with the same name gets a number.
    private func copyMaterials(_ urls: [URL], into project: Project) -> Int {
        let manager = FileManager.default
        try? manager.createDirectory(at: project.materialsFolder, withIntermediateDirectories: true)
        var copied = 0
        for url in urls where Material.supportedExtensions.contains(url.pathExtension.lowercased()) {
            guard manager.isReadableFile(atPath: url.path), url.deletingLastPathComponent() != project.materialsFolder else { continue }
            var target = project.materialsFolder.appendingPathComponent(url.lastPathComponent)
            var number = 2
            while manager.fileExists(atPath: target.path) {
                if manager.contentsEqual(atPath: url.path, andPath: target.path) { break }
                target = project.materialsFolder.appendingPathComponent(
                    "\(url.deletingPathExtension().lastPathComponent) \(number).\(url.pathExtension)")
                number += 1
            }
            guard !manager.fileExists(atPath: target.path) else { continue }
            if (try? manager.copyItem(at: url, to: target)) != nil { copied += 1 }
        }
        return copied
    }
}
