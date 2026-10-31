import AppKit
import Foundation

/// One talk or series of calls: a folder in the library holding `project.json`,
/// copies of its materials and its notes.
struct Project: Codable, Identifiable, Hashable {
    var name: String
    var occasion = ""
    var language: String
    /// Names and terms that speech recognition should spell right.
    var vocabulary = ""
    var created = Date()
    var lastUsed: Date?

    /// The project's folder; its name is the project's identity.
    var folder: URL = URL(fileURLWithPath: "/")
    /// Files in `Materials/`, by name.
    var materials: [URL] = []

    var id: String { folder.lastPathComponent }
    var materialsFolder: URL { folder.appendingPathComponent("Materials") }
    var notesFolder: URL { folder.appendingPathComponent("Notes") }

    var lexicon: Lexicon { Lexicon.load(language) }

    /// Initial prompt for Whisper: biases recognition towards the names and terms that will come up.
    var whisperPrompt: String {
        [occasion, vocabulary].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: ". ")
    }

    /// The names and terms one by one, as Deepgram's keyterms: they're written one per line or
    /// separated by commas or semicolons.
    var terms: [String] {
        vocabulary.components(separatedBy: CharacterSet(charactersIn: ",;\n"))
            .map { $0.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "."))) }
            .filter { !$0.isEmpty }
    }

    private enum CodingKeys: String, CodingKey {
        case name, occasion, language, vocabulary = "namesAndTerms", created, lastUsed
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
    }

    static var defaultLanguage: String { Locale.current.language.languageCode?.identifier ?? "en" }
}

/// The library folder (`~/Documents/Cue` by default): one subfolder per project.
@MainActor
final class ProjectStore: ObservableObject {
    @Published private(set) var projects: [Project] = []

    private let preferences: Preferences

    init(preferences: Preferences) {
        self.preferences = preferences
        reload()
    }

    var library: URL { preferences.libraryFolder }

    /// Every folder in the library is a project; one without `project.json` is named after its folder.
    func reload() {
        let folders = (try? FileManager.default.contentsOfDirectory(
            at: library, includingPropertiesForKeys: [.isDirectoryKey], options: .skipsHiddenFiles)) ?? []
        projects = folders
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(Self.load)
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func project(_ id: String?) -> Project? { projects.first { $0.id == id } }

    /// The project used last (or created last, if none was used yet).
    var mostRecent: Project? { projects.max { ($0.lastUsed ?? $0.created) < ($1.lastUsed ?? $1.created) } }

    /// By name or folder name (CUE_PROJECT, the migration).
    func project(named name: String) -> Project? {
        projects.first { $0.name == name } ?? projects.first { $0.id == name }
    }

    private static func load(_ folder: URL) -> Project {
        let data = try? Data(contentsOf: folder.appendingPathComponent("project.json"))
        var project = data.flatMap { try? decoder.decode(Project.self, from: $0) } ?? Project(name: folder.lastPathComponent)
        if project.name.trimmingCharacters(in: .whitespaces).isEmpty { project.name = folder.lastPathComponent }
        project.folder = folder
        let files = (try? FileManager.default.contentsOfDirectory(
            at: project.materialsFolder, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)) ?? []
        project.materials = files
            .filter { Materials.supportedExtensions.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        return project
    }

    // MARK: Changes

    @discardableResult
    func create(named name: String, language: String = Project.defaultLanguage) throws -> Project {
        var project = Project(name: name.trimmingCharacters(in: .whitespacesAndNewlines), language: language)
        project.folder = library.appendingPathComponent(uniqueFolderName(for: project.name))
        try FileManager.default.createDirectory(at: project.materialsFolder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
        try write(project)
        reload()
        return self.project(project.id) ?? project
    }

    /// Saves the fields in `project.json` (name, occasion, language, names and terms, dates).
    func update(_ project: Project) {
        guard let index = projects.firstIndex(where: { $0.id == project.id }), projects[index] != project else { return }
        projects[index] = project
        try? write(project)
    }

    /// Renames the project and its folder; returns the renamed project.
    func rename(_ project: Project, to name: String) throws -> Project {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != project.name else { return project }
        var renamed = project
        renamed.name = name
        let folderName = Self.folderName(for: name)
        if folderName != project.id {
            renamed.folder = library.appendingPathComponent(uniqueFolderName(for: name))
            try FileManager.default.moveItem(at: project.folder, to: renamed.folder)
        }
        try write(renamed)
        reload()
        return self.project(renamed.id) ?? renamed
    }

    /// Moves the whole project folder, materials and notes included, to the Trash.
    func delete(_ project: Project) throws {
        try FileManager.default.trashItem(at: project.folder, resultingItemURL: nil)
        reload()
    }

    /// Copies files into `Materials/`, so the project keeps working after the originals move.
    /// A file already there with the same contents is skipped; a different one with the same name gets a number.
    @discardableResult
    func addMaterials(_ urls: [URL], to project: Project) -> Int {
        let manager = FileManager.default
        try? manager.createDirectory(at: project.materialsFolder, withIntermediateDirectories: true)
        var copied = 0
        for url in urls where Materials.supportedExtensions.contains(url.pathExtension.lowercased()) {
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
        reload()
        return copied
    }

    func removeMaterial(_ url: URL, from project: Project) {
        guard url.deletingLastPathComponent() == project.materialsFolder else { return }
        try? FileManager.default.trashItem(at: url, resultingItemURL: nil)
        reload()
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
    /// in the old recordings folder move into its `Notes/`. Safe to run again.
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
            var project = try self.project(named: name) ?? create(named: name, language: language ?? Project.defaultLanguage)
            project.occasion = occasion
            project.vocabulary = vocabulary
            if let language { project.language = language }
            update(project)
            addMaterials(materials, to: project)

            try FileManager.default.createDirectory(at: project.notesFolder, withIntermediateDirectories: true)
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

            reload()
            preferences.activeProject = project.id
            let copied = self.project(project.id)?.materials.count ?? 0
            log.write("📦 Moved your settings into the project “\(name)”: \(copied) of \(materials.count) materials copied, \(moved) notes moved")
        } catch {
            log.write("⚠︎ Couldn't move your settings into a project: \(error.localizedDescription)")
        }
    }
}
