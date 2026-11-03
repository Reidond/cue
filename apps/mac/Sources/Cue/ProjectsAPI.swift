import Foundation

// The Cue API's projects and materials (packages/contract: projects.ts). The shapes follow it by hand.

/// A project as the account holds it.
struct RemoteProject: Decodable {
    let id: String
    let name: String
    /// The person's own words; empty: the brief's are used.
    let occasion: String
    /// The language Cue last heard in the project's calls (detected, never set).
    let language: String
    let namesAndTerms: String
    let brief: ProjectBrief
    /// Milliseconds since the epoch.
    let createdAt: Double
    let lastUsedAt: Double?
}

/// What Cue wrote from a project's materials: the occasion, the names and terms, answers to the likely questions. Written again (after a few
/// seconds of quiet) whenever a file is added or removed.
struct ProjectBrief: Decodable, Hashable {
    enum State: String, Decodable { case none, working, ready, failed }
    var state: State = .none
    /// Why it couldn't be written.
    var error: String?
    var occasion = ""
    /// One per line.
    var namesAndTerms = ""
    var answerCount = 0
    /// Milliseconds since the epoch.
    var updatedAt: Double?

    /// The names and terms, one by one.
    var terms: [String] { namesAndTerms.split(separator: "\n").map(String.init) }
}

/// A file in a project, and what the server read from it.
struct Material: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let size: Int
    /// Why its text couldn't be read; nil when it was.
    let error: String?
    /// "1,204 words · 3 prepared answers".
    let summary: String
    let preparedCount: Int

    /// What the server reads: the formats of `MATERIAL_EXTENSIONS` (packages/contract).
    static let supportedExtensions: Set<String> = [
        "md", "markdown", "txt", "pptx",
        "pdf", "docx", "xlsx", "xls", "xlsm", "xlsb", "et", "ods", "odt", "csv", "html", "xml", "numbers",
    ]
}

/// A material with the text the server extracted from it.
struct RemoteMaterialText: Decodable {
    let name: String
    let error: String?
    let summary: String
    let text: String
}

struct RemotePreparedAnswer: Decodable {
    let question: String
    let answer: String
    let who: String?
    let source: String
    let materialId: String
    /// `materials`: written in the file; `cue`: prepared by Cue from the materials.
    let from: String
}

/// Fields of a new project; the times are for a project moved in from this Mac.
struct ProjectFields: Encodable {
    var name: String
    var occasion: String?
    var namesAndTerms: String?
    var createdAt: Double?
    var lastUsedAt: Double?
}

/// Fields of a project to change; a nil one stays as it is on the server (and the API refuses any it doesn't know, `createdAt` too).
struct ProjectChanges: Encodable {
    var name: String?
    var occasion: String?
    var namesAndTerms: String?
    var lastUsedAt: Double?
}

extension CueAPI {
    private static let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try Self.decoder.decode(type, from: data)
        } catch {
            throw CueAPIError.server("Cue answered something unexpected: \(error.localizedDescription)")
        }
    }

    func listProjects() async throws -> [RemoteProject] {
        struct Projects: Decodable { let projects: [RemoteProject] }
        return try decode(Projects.self, from: try await get("v1/projects")).projects
    }

    func project(_ id: String) async throws -> RemoteProject {
        try decode(RemoteProject.self, from: try await get("v1/projects/\(id)"))
    }

    func createProject(_ fields: ProjectFields) async throws -> RemoteProject {
        try decode(RemoteProject.self, from: try await request("POST", "v1/projects", json: try JSONEncoder().encode(fields)))
    }

    @discardableResult
    func updateProject(_ id: String, _ fields: ProjectChanges) async throws -> RemoteProject {
        try decode(RemoteProject.self, from: try await request("PATCH", "v1/projects/\(id)", json: try JSONEncoder().encode(fields)))
    }

    func deleteProject(_ id: String) async throws {
        _ = try await request("DELETE", "v1/projects/\(id)")
    }

    func materials(of project: String) async throws -> [Material] {
        struct Materials: Decodable { let materials: [Material] }
        return try decode(Materials.self, from: try await get("v1/projects/\(project)/materials")).materials
    }

    func materialText(_ id: String, in project: String) async throws -> RemoteMaterialText {
        try decode(RemoteMaterialText.self, from: try await get("v1/projects/\(project)/materials/\(id)"))
    }

    func preparedAnswers(of project: String) async throws -> [RemotePreparedAnswer] {
        struct Answers: Decodable { let answers: [RemotePreparedAnswer] }
        return try decode(Answers.self, from: try await get("v1/projects/\(project)/prepared-answers")).answers
    }

    /// Asks the account to write the project's brief again (it does by itself when a file is added or removed).
    func briefAgain(_ project: String) async throws {
        _ = try await request("POST", "v1/projects/\(project)/brief")
    }

    /// Sends a file to a project; the server stores it and reads its text before it answers.
    func uploadMaterial(_ file: URL, to project: String) async throws -> Material {
        let type = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let data = try await request("POST", "v1/projects/\(project)/materials", query: ["name": file.lastPathComponent], file: file, contentType: type)
        return try decode(Material.self, from: data)
    }

    func deleteMaterial(_ id: String, in project: String) async throws {
        _ = try await request("DELETE", "v1/projects/\(project)/materials/\(id)")
    }

    private static let mimeTypes = [
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "md": "text/markdown", "markdown": "text/markdown", "txt": "text/plain", "csv": "text/csv", "html": "text/html",
    ]
}
