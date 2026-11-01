import Foundation

// The Cue API's notes and recording uploads (packages/contract: notes.ts). The shapes follow it by hand.
//
// After a call the recording goes up as a resumable multipart upload (`RecordingUploader`), the server's notes Workflow reads it, and the
// notes are kept on the server. The app follows the Workflow's progress events, then keeps a Markdown copy of the note in the library.

/// Where an upload of one side of a recording stands (`Upload`).
struct RemoteUpload: Decodable {
    struct Part: Decodable {
        let partNumber: Int
        let size: Int
    }
    let uploadId: String
    let side: String
    /// "open" or "done".
    let status: String
    /// The parts that landed: a resumed upload sends the rest.
    let parts: [Part]
    let size: Int?
}

/// One paragraph of a note's transcript (`Turn`). `speaker` is encoded even when nil: the contract wants the key.
struct RemoteTurn: Codable, Hashable {
    /// "me" or "others".
    let channel: String
    let speaker: Int?
    let label: String
    /// Seconds since the recording began.
    let start: Double
    let text: String

    private enum CodingKeys: String, CodingKey { case channel, speaker, label, start, text }

    init(channel: String, speaker: Int?, label: String, start: Double, text: String) {
        self.channel = channel
        self.speaker = speaker
        self.label = label
        self.start = start
        self.text = text
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        channel = try container.decode(String.self, forKey: .channel)
        speaker = try container.decodeIfPresent(Int.self, forKey: .speaker)
        label = try container.decode(String.self, forKey: .label)
        start = try container.decode(Double.self, forKey: .start)
        text = try container.decode(String.self, forKey: .text)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(channel, forKey: .channel)
        try container.encode(speaker, forKey: .speaker)
        try container.encode(label, forKey: .label)
        try container.encode(start, forKey: .start)
        try container.encode(text, forKey: .text)
    }
}

struct RemoteMeeting: Codable, Hashable {
    let title: String
    let attendees: [String]
}

/// A step of the notes Workflow as the note lists it (`NoteStep`).
struct RemoteNoteStep: Decodable {
    /// "transcript", "speakers", "names" or "summary".
    let id: String
    let title: String
    /// "pending", "running", "done" or "failed".
    let state: String
    let detail: String?
}

/// A note as the account holds it (`Note`).
struct RemoteNote: Decodable {
    let id: String
    let callId: String?
    let projectId: String?
    let title: String
    /// Milliseconds since the epoch.
    let startedAt: Double
    let durationSeconds: Double
    /// "processing" or "ready".
    let status: String
    let language: String
    let speaker: String
    let meeting: RemoteMeeting?
    let participants: [String]
    let summary: String
    let transcriptHeading: String
    let transcript: [RemoteTurn]
    let suggestions: [String: String]
    let steps: [RemoteNoteStep]
    /// The sides still in storage: "me", "others", "mixed".
    let audio: [String]
    let createdAt: Double

    var started: Date { Date(timeIntervalSince1970: startedAt / 1000) }
}

/// What the Workflow does, one event per line of the session log (`NoteEvent`).
struct NoteProgressEvent: Decodable {
    let seq: Int
    /// "step", "suggestion" or "note".
    let kind: String
    /// "transcript", "speakers", "names" or "summary" for a step.
    let step: String?
    /// "running", "done", "failed" or (the `note` event) "ready".
    let state: String
    /// The session log line this event stands for, if it stands for one.
    let line: String?
    let detail: String?
    let at: Double
}

/// `POST /v1/calls/:id/notes` (`NewNotes`).
struct NewNotesBody: Encodable {
    var title: String?
    let take: Int64
    let endedAt: Int64
    let sides: [String]
    let speaker: String
    var meeting: RemoteMeeting?
    let keepAudio: Bool
    let summarize: Bool
    var language: String?
    var projectId: String?
}

/// `POST /v1/notes/import` (`NoteImport`): an old note of this Mac's library, taken apart.
struct NoteImportBody: Encodable {
    let stamp: String
    let projectId: String
    let title: String
    let startedAt: Int64
    let durationSeconds: Double
    let language: String
    let speaker: String
    var meeting: RemoteMeeting?
    let participants: [String]
    let summary: String
    let transcriptHeading: String
    let transcript: [RemoteTurn]
    let suggestions: [String: String]
}

/// `PATCH /v1/notes/:id` (`NotePatch`): one change.
enum NotePatchBody: Encodable {
    case rename(from: String, to: String)
    case apply(String)
    case dismiss(String)

    private enum CodingKeys: String, CodingKey { case rename, apply, dismiss }
    private struct Rename: Encodable {
        let from: String
        let to: String
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .rename(let from, let to): try container.encode(Rename(from: from, to: to), forKey: .rename)
        case .apply(let label): try container.encode(label, forKey: .apply)
        case .dismiss(let label): try container.encode(label, forKey: .dismiss)
        }
    }
}

extension CueAPI {
    private func decoded<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw CueAPIError.server("Cue answered something unexpected: \(error.localizedDescription)")
        }
    }

    // MARK: Recording upload

    private func recordingPath(_ call: String, _ side: String) -> String { "v1/calls/\(call)/recording/\(side)" }

    /// Begins the upload of one side of a recording; the same call again says what already arrived.
    func beginUpload(call: String, side: String, take: Int64) async throws -> RemoteUpload {
        try decoded(RemoteUpload.self, from: try await request("POST", recordingPath(call, side), query: ["take": String(take)],
                                                              json: Data("{}".utf8)))
    }

    /// Sends one part (numbered from 1) of an upload.
    func putPart(call: String, side: String, take: Int64, part: Int, data: Data) async throws {
        _ = try await request("PUT", recordingPath(call, side), query: ["take": String(take), "part": String(part)], body: data,
                              contentType: "application/octet-stream", timeout: 180)
    }

    func completeUpload(call: String, side: String, take: Int64) async throws -> RemoteUpload {
        try decoded(RemoteUpload.self, from: try await request("POST", recordingPath(call, side) + "/complete", query: ["take": String(take)],
                                                              json: Data("{}".utf8)))
    }

    // MARK: Notes

    /// Starts the notes of a recording once its uploads are in. The same `take` again returns the same note.
    func startNotes(call: String, _ body: NewNotesBody) async throws -> RemoteNote {
        try decoded(RemoteNote.self, from: try await request("POST", "v1/calls/\(call)/notes", json: try JSONEncoder().encode(body)))
    }

    func listNotes() async throws -> [RemoteNote] {
        struct Notes: Decodable { let notes: [RemoteNote] }
        return try decoded(Notes.self, from: try await get("v1/notes")).notes
    }

    func note(_ id: String) async throws -> RemoteNote {
        try decoded(RemoteNote.self, from: try await get("v1/notes/\(id)"))
    }

    func patchNote(_ id: String, _ patch: NotePatchBody) async throws -> RemoteNote {
        try decoded(RemoteNote.self, from: try await request("PATCH", "v1/notes/\(id)", json: try JSONEncoder().encode(patch)))
    }

    /// Moves a note to the trash (its audio is deleted from storage).
    func deleteNote(_ id: String) async throws {
        _ = try await request("DELETE", "v1/notes/\(id)")
    }

    func importNote(_ body: NoteImportBody) async throws -> RemoteNote {
        try decoded(RemoteNote.self, from: try await request("POST", "v1/notes/import", json: try JSONEncoder().encode(body)))
    }

    /// The mixed audio of an imported note, as one request.
    func putImportAudio(_ noteID: String, file: URL) async throws {
        _ = try await request("PUT", "v1/notes/\(noteID)/audio/mixed", file: file, contentType: "audio/mp4", timeout: 300)
    }

    /// Where a note's audio is served from (range requests); the request needs the bearer token (`bearer()`).
    func audioURL(note id: String, side: String = "mixed") -> URL {
        Self.baseURL.appendingPathComponent("v1/notes/\(id)/audio/\(side)")
    }

    // MARK: Progress

    /// Follows a note's progress events (server-sent events) after `after` until the stream ends: the server ends it after the `note` event.
    /// `onEvent` gets each event once, in order.
    func followNoteEvents(_ id: String, after: Int, onEvent: (NoteProgressEvent) -> Void) async throws {
        var token = try await bearer()
        for attempt in 0..<2 {
            var components = URLComponents(url: Self.baseURL.appendingPathComponent("v1/notes/\(id)/events"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "after", value: String(after))]
            var request = URLRequest(url: components.url!, timeoutInterval: 600)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue(LiveCall.clientVersion, forHTTPHeaderField: "Cue-Version")
            let opened: (URLSession.AsyncBytes, URLResponse)
            do {
                opened = try await URLSession.shared.bytes(for: request)
            } catch {
                throw CueAPIError.network(error.localizedDescription)
            }
            let status = (opened.1 as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 && attempt == 0 {
                token = try await bearer(refreshing: true)
                continue
            }
            guard status == 200 else {
                var data = Data()
                for try await byte in opened.0 { data.append(byte) }
                let message = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
                if status == 401 { throw CueAPIError.ended(message ?? "Your session has ended. Sign in to Cue again.") }
                throw CueAPIError.server(message ?? "Cue answered \(status).")
            }
            var last = after
            do {
                for try await line in opened.0.lines where line.hasPrefix("data:") {
                    guard let event = try? JSONDecoder().decode(NoteProgressEvent.self, from: Data(line.dropFirst(5).utf8)),
                          event.seq > last
                    else { continue }
                    last = event.seq
                    onEvent(event)
                }
            } catch {
                throw CueAPIError.network(error.localizedDescription)
            }
            return
        }
        throw CueAPIError.server("Cue didn't accept the sign-in.")
    }
}

/// Sends the files of a recording to the account as resumable multipart uploads: parts of `partBytes`, each tried again when it fails, and
/// an upload that broke (the connection, the app quitting) carries on from the parts the server already has.
///
/// Test hooks: `CUE_UPLOAD_PART_BYTES=n` sets the part size (default 8 MiB; the server wants 5 MiB at least for all but the last part),
/// and `CUE_UPLOAD_BREAK=n` loses the connection once, as the part after the first `n` sent in this launch is about to go.
@MainActor
final class RecordingUploader {
    static let partBytes = ProcessInfo.processInfo.environment["CUE_UPLOAD_PART_BYTES"].flatMap(Int.init).map { max($0, 1) } ?? 8 * 1024 * 1024
    private static let breakAfter = ProcessInfo.processInfo.environment["CUE_UPLOAD_BREAK"].flatMap(Int.init)
    private static var partsSent = 0
    private static var broke = false
    /// How many times an upload starts over (from what the server has) before it gives up.
    private static let retries = 3

    private let api: CueAPI
    private let log: SessionLog

    init(api: CueAPI, log: SessionLog) {
        self.api = api
        self.log = log
    }

    /// Uploads a file as `side` ("me", "others" or "mixed") of the recording that began at `take`; returns its size in bytes.
    func upload(_ file: URL, side: String, call: String, take: Int64) async throws -> Int {
        let size = ((try FileManager.default.attributesOfItem(atPath: file.path))[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0 else { throw ServiceError("The audio of \(Self.name(side)) is empty") }
        let count = (size + Self.partBytes - 1) / Self.partBytes
        var attempt = 0
        while true {
            do {
                let state = try await api.beginUpload(call: call, side: side, take: take)
                if state.status == "done" { return size }
                if !state.parts.isEmpty {
                    log.write("⬆️ Resuming the upload of \(Self.name(side)): \(state.parts.count) of \(count) parts are there")
                }
                let have = Dictionary(state.parts.map { ($0.partNumber, $0.size) }, uniquingKeysWith: { $1 })
                for part in 1...count {
                    let offset = (part - 1) * Self.partBytes
                    let length = min(Self.partBytes, size - offset)
                    if have[part] == length { continue }
                    if let limit = Self.breakAfter, !Self.broke, Self.partsSent >= limit {
                        Self.broke = true
                        throw CueAPIError.network("The connection was lost")
                    }
                    let data = try await Task.detached { try RecordingUploader.read(file, offset: offset, length: length) }.value
                    try await api.putPart(call: call, side: side, take: take, part: part, data: data)
                    Self.partsSent += 1
                }
                let done = try await api.completeUpload(call: call, side: side, take: take)
                guard done.status == "done" else { throw ServiceError("The server didn't finish the upload") }
                return size
            } catch {
                // A session that ended is not worth trying again; anything else starts over from what the server has.
                if case CueAPIError.ended = error { throw error }
                attempt += 1
                if attempt > Self.retries || Task.isCancelled { throw error }
                log.write("⚠︎ The upload stopped: \(error.localizedDescription) — trying again")
                try await Task.sleep(for: .seconds(0.5 * Double(1 << (attempt - 1))))
            }
        }
    }

    nonisolated private static func read(_ file: URL, offset: Int, length: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: length) ?? Data()
    }

    /// "your side", "the call side", "the mixed audio".
    private static func name(_ side: String) -> String {
        switch side {
        case "me": "your side"
        case "others": "the call side"
        default: "the mixed audio"
        }
    }
}
