import FluidAudio
import Foundation

/// Who is who on the call side. The microphone is always the user, but everyone else shares the
/// call's audio; after the second pass, FluidAudio's offline diarizer (segmentation, voice
/// embeddings and VBx clustering, all on this Mac) tells their voices apart in `call.wav`, and each
/// call-side line goes to the voice heard most while it was said.
enum Speakers {
    /// One stretch of one voice, in seconds from the start of the recording.
    struct Turn: Sendable {
        let voice: String
        let start: TimeInterval
        let end: TimeInterval
    }

    /// Who speaks when in one side's recording. `progress` gets the share done (0…1).
    static func voices(in audio: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> [Turn] {
        guard FileManager.default.fileExists(atPath: audio.path) else { throw ServiceError("The call's audio is missing") }
        return try await Task.detached(priority: .utility) {
            let diarizer = OfflineDiarizerManager(config: .default)
            try await diarizer.prepareModels(directory: SpeakerModels.folder)
            let result = try await diarizer.process(audio) { done, total in progress(Double(done) / Double(max(total, 1))) }
            return result.segments.map {
                Turn(voice: $0.speakerId, start: TimeInterval($0.startTimeSeconds), end: TimeInterval($0.endTimeSeconds))
            }
        }.value
    }

    /// Gives each call-side line the voice heard most while it was said (the nearest one when none
    /// was), numbered 1, 2, … in the order they first speak. Returns how many voices speak in the
    /// transcript; with fewer than two the transcript is returned as it was, under the plain label.
    static func label(_ transcript: CallTranscript, voices turns: [Turn]) -> (transcript: CallTranscript, count: Int) {
        func distance(_ turn: Turn, _ start: TimeInterval, _ end: TimeInterval) -> TimeInterval {
            max(turn.start - end, start - turn.end, 0)
        }
        var numbers: [String: Int] = [:]
        var lines = transcript.lines
        for index in lines.indices where lines[index].channel == .others {
            let start = lines[index].started.timeIntervalSince(transcript.startedAt)
            let end = max(start, lines[index].time.timeIntervalSince(transcript.startedAt))
            var heard: [String: TimeInterval] = [:]
            for turn in turns where turn.end > start && turn.start < end {
                heard[turn.voice, default: 0] += min(turn.end, end) - max(turn.start, start)
            }
            // Ties go the same way every time.
            let voice = heard.max { ($0.value, $1.key) < ($1.value, $0.key) }?.key
                ?? turns.min { distance($0, start, end) < distance($1, start, end) }?.voice
            guard let voice else { continue }
            if numbers[voice] == nil { numbers[voice] = numbers.count + 1 }
            lines[index].speaker = numbers[voice]
        }
        guard numbers.count > 1 else { return (transcript, numbers.count) }
        return (CallTranscript(startedAt: transcript.startedAt, endedAt: transcript.endedAt, lines: lines), numbers.count)
    }
}

/// The speaker models: FluidAudio's offline diarizer, from Hugging Face. They live next to the speech
/// model, in `Application Support/Cue/models/speaker-diarization/` (CUE_SPEAKER_MODELS=dir
/// keeps them in `dir` instead), and are downloaded from the Home checklist or by the first note
/// that needs them.
@MainActor
final class SpeakerModels: ObservableObject {
    /// The folder FluidAudio keeps its `speaker-diarization` folder in.
    nonisolated static let folder: URL = ProcessInfo.processInfo.environment["CUE_SPEAKER_MODELS"]
        .map { URL(fileURLWithPath: $0) } ?? appSupport.appendingPathComponent("models")

    nonisolated static var repository: URL { folder.appendingPathComponent(Repo.diarizer.folderName) }

    /// Every model the offline diarizer loads is there, compiled.
    nonisolated static var installed: Bool {
        ModelNames.OfflineDiarizer.requiredModels.allSatisfy { name in
            let path = repository.appendingPathComponent(name)
            return FileManager.default.fileExists(atPath: name.hasSuffix(".mlmodelc") ? path.appendingPathComponent("coremldata.bin").path : path.path)
        }
    }

    /// Fraction done while downloading, nil when idle.
    @Published private(set) var progress: Double?
    @Published private(set) var error: String?

    private let log: SessionLog
    private var download: Task<Void, Error>?

    init(log: SessionLog) {
        self.log = log
    }

    /// The Download button on Home.
    func start() {
        Task { try? await prepare() }
    }

    /// Downloads (and compiles) the models unless they are there; a download under way is joined.
    func prepare() async throws {
        if let download { return try await download.value }
        guard !Self.installed else { return }
        error = nil
        progress = 0
        log.write("👥 Downloading speaker models…")
        let started = Date()
        let report: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in if self?.progress != nil { self?.progress = fraction } }
        }
        let task = Task.detached(priority: .utility) {
            _ = try await OfflineDiarizerModels.load(from: SpeakerModels.folder) { report($0.fractionCompleted) }
        }
        download = task
        defer {
            download = nil
            progress = nil
        }
        do {
            try await task.value
            let took = String(format: "%.1f", Date().timeIntervalSince(started))
            log.write("👥 Speaker models downloaded: \(String(format: "%.1f", Double(Self.size) / 1_000_000)) MB (\(took) s)")
        } catch {
            self.error = error.localizedDescription
            log.write("⚠︎ Couldn't download the speaker models: \(error.localizedDescription)")
            throw error
        }
    }

    /// What the models take on disk.
    nonisolated static var size: Int64 {
        let files = FileManager.default.enumerator(at: repository, includingPropertiesForKeys: [.fileSizeKey])
        return (files?.allObjects as? [URL] ?? []).reduce(0) { total, file in
            total + Int64((try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        }
    }
}
