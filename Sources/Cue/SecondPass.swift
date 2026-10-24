import AVFoundation
import Foundation

/// The second pass over a recorded call. Live recognition hears one phrase at a time and
/// gets words wrong that the rest of the conversation makes obvious; after Stop, whisper-cli
/// reads each side's whole recording (`mic.wav`, `call.wav`) with beam search and the
/// project's names and terms, and the two sides are merged back into one transcript by time.
///
/// It runs as a separate process at background priority, so recognition in a call that
/// starts meanwhile keeps the machine first.
enum SecondPass {
    static let candidates = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]

    /// CUE_WHISPER_CLI=path runs that binary instead.
    static var binary: String? {
        ProcessInfo.processInfo.environment["CUE_WHISPER_CLI"] ?? candidates.first(where: FileManager.default.isExecutableFile)
    }

    struct Job {
        /// The recording's working folder, with `mic.wav` and `call.wav`.
        let folder: URL
        let startedAt: Date
        let endedAt: Date
        let language: String
        /// The project's occasion and names and terms.
        let prompt: String
        let lexicon: Lexicon
    }

    struct Result {
        let transcript: CallTranscript
        /// Length of the recording, in seconds.
        let duration: TimeInterval
    }

    /// `progress` gets the share done (0…1) as whisper-cli reports it; `child` lets the caller stop it.
    static func run(_ job: Job, child: SecondPassProcess, progress: @escaping @Sendable (Double) -> Void) async throws -> Result {
        guard let binary else { throw ServiceError("whisper-cli is not installed (brew install whisper-cpp)") }
        guard FileManager.default.isExecutableFile(atPath: binary) else { throw ServiceError("whisper-cli not found at \(binary)") }
        guard WhisperService.modelInstalled else { throw ServiceError("Speech model not downloaded") }
        let sides: [(channel: Channel, audio: URL)] = [
            (.me, job.folder.appendingPathComponent(AudioRecorder.micFile)),
            (.others, job.folder.appendingPathComponent(AudioRecorder.callFile)),
        ]
        guard sides.allSatisfy({ FileManager.default.fileExists(atPath: $0.audio.path) }) else {
            throw ServiceError("The call's audio is missing")
        }
        let outputs = sides.map { $0.audio.deletingPathExtension() }  // whisper-cli adds .json
        for output in outputs { try? FileManager.default.removeItem(at: output.appendingPathExtension("json")) }

        var arguments = ["-m", WhisperService.modelPath, "-l", job.language, "-bs", "5", "-ojf", "-np", "-pp"]
        // The names and terms bias every 30 s window, not only the first.
        if !job.prompt.isEmpty { arguments += ["--prompt", job.prompt, "--carry-initial-prompt"] }
        arguments += outputs.flatMap { ["-of", $0.path] } + sides.map(\.audio.path)
        try await whisper(binary, arguments, child: child, files: sides.count, progress: progress)

        return try await Task.detached(priority: .utility) {
            var lines: [Utterance] = []
            var duration: TimeInterval = 0
            for (side, output) in zip(sides, outputs) {
                let segments = try segments(in: output.appendingPathExtension("json"))
                let levels = try SpeechLevels(side.audio)
                duration = max(duration, levels.duration)
                lines += utterances(segments, levels: levels, channel: side.channel, job: job)
            }
            let stopWords = job.lexicon.stopWords
            let others = lines.filter { $0.channel == .others }
            // With speakers instead of headphones the microphone also hears the call: drop those copies.
            lines.removeAll { line in
                line.channel == .me && others.contains { other in
                    other.started < line.time.addingTimeInterval(1) && other.time > line.started.addingTimeInterval(-1)
                        && Utterance.isEcho(line.text, of: other.text, stopWords: stopWords)
                }
            }
            guard !lines.isEmpty else { throw ServiceError("whisper-cli found no speech in the call's audio") }
            return Result(transcript: CallTranscript(startedAt: job.startedAt, endedAt: job.endedAt,
                                                     lines: lines.sorted { $0.started < $1.started }),
                          duration: duration)
        }.value
    }

    /// Runs whisper-cli to the end at background priority, following the progress it prints.
    private static func whisper(_ binary: String, _ arguments: [String], child: SecondPassProcess, files: Int,
                                progress: @escaping @Sendable (Double) -> Void) async throws {
        let errors = Pipe()
        let pid = try spawn(binary, arguments, standardError: errors.fileHandleForWriting.fileDescriptor)
        try? errors.fileHandleForWriting.close()
        // Like `taskpolicy -b`: low CPU, I/O and GPU priority for the whole process.
        setpriority(PRIO_DARWIN_PROCESS, id_t(pid), PRIO_DARWIN_BG)
        child.started(pid)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .utility).async {
                var buffer = Data(), last = "", file = -1, reported = -1
                let handle = errors.fileHandleForReading
                while case let chunk = handle.availableData, !chunk.isEmpty {
                    buffer.append(chunk)
                    while let newline = buffer.firstIndex(of: 0x0A) {
                        let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self).trimmingCharacters(in: .whitespaces)
                        buffer.removeSubrange(buffer.startIndex...newline)
                        if line.hasPrefix("read_audio_data: reading") { file += 1 }
                        if let match = line.firstMatch(of: #/progress = +(\d+)%/#), let percent = Int(match.1) {
                            let done = Int(Double(max(file, 0) * 100 + percent) / Double(files))
                            if done != reported { reported = done; progress(Double(done) / 100) }
                        } else if !line.isEmpty, !line.hasPrefix("[") {
                            last = line
                        }
                    }
                }
                child.exiting()
                var status: Int32 = 0
                while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
                let signal = status & 0x7f, code = (status >> 8) & 0xff
                if signal != 0 {
                    continuation.resume(throwing: ServiceError(child.cancelled ? "Cancelled" : "whisper-cli stopped (signal \(signal))"))
                } else if code != 0 {
                    continuation.resume(throwing: ServiceError("whisper-cli failed (exit \(code))\(last.isEmpty ? "" : ": \(last)")"))
                } else {
                    continuation.resume()
                }
            }
        }
    }

    /// Starts a process with its arguments exactly as given. Foundation's `Process` passes them
    /// through `fileSystemRepresentation`, which decomposes «й» and «ї» into a letter and a combining
    /// mark, and Whisper would read the names and terms in that form.
    private static func spawn(_ binary: String, _ arguments: [String], standardError: Int32) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, standardError, 2)
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Nothing else of Cue's is inherited, and every thread starts at background QoS.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_set_qos_class_np(&attributes, QOS_CLASS_BACKGROUND)
        let argv = ([binary] + arguments).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        let status = posix_spawn(&pid, binary, &actions, &attributes, argv, environ)
        guard status == 0 else { throw ServiceError("Couldn't start whisper-cli: \(String(cString: strerror(status)))") }
        return pid
    }

    private struct Segment {
        let start: TimeInterval
        let end: TimeInterval
        let text: String
    }

    /// The segments of a `-ojf` JSON file: `transcription[].offsets.from/to` (ms) and `text`.
    private static func segments(in file: URL) throws -> [Segment] {
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["transcription"] as? [[String: Any]]
        else { throw ServiceError("whisper-cli wrote no transcript") }
        return items.compactMap { item in
            guard let offsets = item["offsets"] as? [String: Any], let text = item["text"] as? String,
                  let from = (offsets["from"] as? NSNumber)?.doubleValue, let to = (offsets["to"] as? NSNumber)?.doubleValue
            else { return nil }
            return Segment(start: from / 1000, end: to / 1000, text: text)
        }
    }

    /// Whisper's segment times are loose: a segment after a silence often starts where the previous one
    /// ended, and may end before the speech does. So each stretch of speech in the audio goes to the
    /// segment it overlaps most, and a segment takes its time from its stretches: when the line was
    /// said, as in the live transcript. A segment that shares a stretch with another (sentences without
    /// a pause between them) keeps Whisper's times within it; one with no speech under it was made up
    /// and is dropped.
    private static func utterances(_ segments: [Segment], levels: SpeechLevels, channel: Channel, job: Job) -> [Utterance] {
        func overlap(_ run: ClosedRange<TimeInterval>, _ start: TimeInterval, _ end: TimeInterval) -> TimeInterval {
            min(run.upperBound, end) - max(run.lowerBound, start)
        }
        var owned = [[ClosedRange<TimeInterval>]](repeating: [], count: segments.count)
        for run in levels.speech {
            let overlaps = segments.map { overlap(run, $0.start - 0.5, $0.end + 0.5) }
            if let best = overlaps.indices.max(by: { overlaps[$0] < overlaps[$1] }), overlaps[best] > 0 { owned[best].append(run) }
        }
        return zip(segments, owned).compactMap { segment, runs in
            let text = WhisperService.clean(segment.text, hallucinations: job.lexicon.hallucinations)
            guard !text.isEmpty else { return nil }
            let shared = levels.speech.filter { overlap($0, segment.start, segment.end) > 0 }
            let start: TimeInterval, end: TimeInterval
            if let first = runs.first, let last = runs.last {
                // A stretch that began well before Whisper's start is one this segment shares.
                start = first.lowerBound >= segment.start - 0.5 ? first.lowerBound : segment.start
                end = max(start, last.upperBound)
            } else if let first = shared.first, let last = shared.last,
                      shared.reduce(0, { $0 + overlap($1, segment.start, segment.end) }) >= 0.2 {
                start = max(segment.start, first.lowerBound)
                end = max(start, min(segment.end, last.upperBound))
            } else {
                return nil
            }
            return Utterance(channel: channel, text: text, started: job.startedAt.addingTimeInterval(start),
                             time: job.startedAt.addingTimeInterval(end))
        }
    }
}

/// Where one side of a recording has speech: its loudness in 20 ms frames, well above the side's
/// background noise (its quietest tenth), as in the live segmenter.
private struct SpeechLevels {
    static let frame = 320  // 20 ms at 16 kHz
    let duration: TimeInterval
    /// Stretches of speech, in seconds from the start: pauses under 300 ms are bridged, and anything
    /// shorter than 200 ms (a click) doesn't count.
    let speech: [ClosedRange<TimeInterval>]

    init(_ url: URL) throws {
        let file = try AVAudioFile(forReading: url)
        let chunk = AVAudioFrameCount(Self.frame * 500)  // 10 s
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else {
            throw ServiceError("Couldn't read \(url.lastPathComponent)")
        }
        var rms: [Float] = []
        rms.reserveCapacity(Int(file.length) / Self.frame + 1)
        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: chunk)
            guard buffer.frameLength > 0, let samples = buffer.floatChannelData?[0] else { break }
            for start in stride(from: 0, to: Int(buffer.frameLength), by: Self.frame) {
                let count = min(Self.frame, Int(buffer.frameLength) - start)
                var sum: Float = 0
                for index in start..<start + count { sum += samples[index] * samples[index] }
                rms.append(sqrt(sum / Float(count)))
            }
        }
        let noise = rms.isEmpty ? 0 : rms.sorted()[rms.count / 10]
        let threshold = max(noise * 3.5, 0.003)

        let seconds = { (frame: Int) in Double(frame * Self.frame) / whisperSampleRate }
        var runs: [ClosedRange<TimeInterval>] = []
        var first: Int?, last = 0
        for (index, level) in rms.enumerated() where level > threshold {
            if let start = first, index - last > 15 {
                if last + 1 - start >= 10 { runs.append(seconds(start)...seconds(last + 1)) }
                first = nil
            }
            if first == nil { first = index }
            last = index
        }
        if let start = first, last + 1 - start >= 10 { runs.append(seconds(start)...seconds(last + 1)) }
        speech = runs
        duration = seconds(rms.count)
    }
}

/// whisper-cli while it runs, so it can be stopped when its note goes to the Trash or Cue quits.
final class SecondPassProcess: @unchecked Sendable {  // its state is only touched under `lock`
    private let lock = NSLock()
    private var pid: pid_t?
    private var stopped = false

    var cancelled: Bool { lock.withLock { stopped } }

    func terminate() {
        lock.withLock {
            stopped = true
            if let pid { kill(pid, SIGTERM) }
        }
    }

    fileprivate func started(_ pid: pid_t) {
        lock.withLock {
            self.pid = pid
            if stopped { kill(pid, SIGTERM) }
        }
    }

    /// Before the process is reaped, so its id is never signalled once the system may reuse it.
    fileprivate func exiting() { lock.withLock { pid = nil } }
}
