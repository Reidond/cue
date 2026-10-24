import AVFoundation
import Foundation

/// Records the audio of a call while Cue records its transcript, from the same
/// 16 kHz samples speech recognition gets. Writes, on a background queue:
///
/// - `mic.wav` and `call.wav`, each side on its own (16-bit PCM, 16 kHz mono):
///   working copies for processing the note, kept in the recording's working
///   folder until its notes are ready;
/// - `mixed.m4a`, both sides mixed (AAC, about 15 MB per hour), which
///   `RecordingStore` moves next to the note when Keep audio is on.
///
/// Each chunk is placed by its capture time relative to the start, so both sides
/// line up even when one delivers nothing for a while (ScreenCaptureKit is quiet
/// while the Mac plays nothing): the gap becomes silence. All three files are as
/// long as the recording and start when it starts, so a transcript offset is a
/// time in each of them.
final class AudioRecorder: @unchecked Sendable {  // its state is only touched on `queue`
    struct Recording {
        /// The working folder: `mic.wav`, `call.wav` and, until it is moved, `mixed.m4a`.
        let folder: URL
        /// The mixed AAC file, unless writing it failed.
        let mixed: URL?
        let duration: TimeInterval
        /// The first thing that went wrong, if anything did.
        let error: Error?
    }

    static let micFile = "mic.wav"
    static let callFile = "call.wav"
    static let mixedFile = "mixed.m4a"

    private let queue = DispatchQueue(label: "audio-recorder", qos: .userInitiated)
    /// Only touched on `queue`.
    private var session: AudioSession?

    // MARK: Working folders

    /// Where a recording's working audio lives, found from its start time (a note's `date:`):
    /// `Application Support/Cue/recordings/2026-10-24T110500Z/`.
    static func workingFolder(startedAt date: Date) -> URL {
        let stamp = ISO8601DateFormatter().string(from: date).replacingOccurrences(of: ":", with: "")
        return appSupport.appendingPathComponent("recordings").appendingPathComponent(stamp)
    }

    /// Working audio left behind by recordings that were never processed (Cue quit or crashed meanwhile).
    static func removeStaleWorkingFolders(olderThan age: TimeInterval = 7 * 24 * 3600) {
        let folder = appSupport.appendingPathComponent("recordings")
        let items = (try? FileManager.default.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles)) ?? []
        for item in items {
            let modified = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if Date().timeIntervalSince(modified) > age { try? FileManager.default.removeItem(at: item) }
        }
    }

    // MARK: Recording

    /// Starts recording both sides; `date` is the start of every file.
    func start(at date: Date) {
        let folder = Self.workingFolder(startedAt: date)
        let start = hostSeconds() - Date().timeIntervalSince(date)
        queue.async { [self] in
            session?.cancel()
            session = AudioSession(folder: folder, startDate: date, start: start)
        }
    }

    /// 16 kHz samples from one side; `time` is the host time of the first one. Ignored unless recording.
    func push(_ samples: [Float], from channel: Channel, at time: TimeInterval) {
        queue.async { [self] in session?.add(samples[...], from: channel, at: time) }
    }

    /// Nothing captured after `date` goes into the files; what was captured before may still arrive.
    func stop(at date: Date) {
        queue.async { [self] in session?.stop(at: date) }
    }

    /// Pads both sides to the end, flushes the mix and closes the files.
    func finish() async -> Recording? {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                let recording = session?.close()
                session = nil
                continuation.resume(returning: recording)
            }
        }
    }

    /// Stops and keeps nothing (Cue quits while recording).
    func cancel() {
        queue.sync {
            session?.cancel()
            session = nil
        }
    }
}

/// One recording's files and how far each side has got, in samples from the start.
private final class AudioSession {
    let folder: URL
    let startDate: Date
    /// Host time of the first sample.
    let start: TimeInterval
    private var end: Int?
    private var mic: Side
    private var call: Side
    private let mixer: AVAudioFile?
    /// Samples written to the mix; each side holds what it placed beyond this until the other catches up.
    private var mixed = 0
    private var mixFailed = false
    private var error: Error?

    /// Timestamp jitter smaller than this is ignored: the chunk follows on directly.
    private let tolerance = Int(0.05 * whisperSampleRate)
    /// A side that delivers nothing is filled with silence once it is this far behind the other.
    private let maxLag = Int(1.0 * whisperSampleRate)
    /// Long silences are written in blocks, so neither side holds more than this unmixed.
    private let block = Int(10 * whisperSampleRate)

    private struct Side {
        let file: AVAudioFile?
        var placed = 0
        var unmixed: [Float] = []
    }

    init(folder: URL, startDate: Date, start: TimeInterval) {
        self.folder = folder
        self.startDate = startDate
        self.start = start
        var firstError: Error?
        func open(_ name: String, _ settings: [String: Any]) -> AVAudioFile? {
            do {
                return try AVAudioFile(forWriting: folder.appendingPathComponent(name), settings: settings,
                                       commonFormat: .pcmFormatFloat32, interleaved: false)
            } catch {
                firstError = firstError ?? error
                return nil
            }
        }
        do {
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            firstError = error
        }
        let wav: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: whisperSampleRate, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        // 32 kbit/s AAC: about 15 MB per hour, plenty for speech at 16 kHz.
        let aac: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: whisperSampleRate, AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]
        mic = Side(file: open(AudioRecorder.micFile, wav))
        call = Side(file: open(AudioRecorder.callFile, wav))
        mixer = open(AudioRecorder.mixedFile, aac)
        error = firstError
    }

    private func side(_ channel: Channel) -> ReferenceWritableKeyPath<AudioSession, Side> {
        channel == .me ? \.mic : \.call
    }

    func add(_ samples: ArraySlice<Float>, from channel: Channel, at time: TimeInterval) {
        var position = Int(((time - start) * whisperSampleRate).rounded())
        var chunk = samples
        if position < 0 {
            chunk = chunk.dropFirst(-position)
            position = 0
        }
        if let end { chunk = chunk.prefix(max(0, end - position)) }
        guard !chunk.isEmpty else { return }

        let gap = position - self[keyPath: side(channel)].placed
        if gap > tolerance {
            // The source delivered nothing for a while: silence until this chunk.
            silence(channel, until: position)
        } else if gap < -tolerance {
            // Overlaps what is already placed (clock drift, or late after being padded): keep the new part.
            chunk = chunk.dropFirst(-gap)
        }
        place(chunk, on: channel)
        keepUp(with: channel)
        mix(final: false)
    }

    func stop(at date: Date) {
        end = max(0, Int((date.timeIntervalSince(startDate) * whisperSampleRate).rounded()))
    }

    func close() -> AudioRecorder.Recording {
        // A chunk can run a little past the end: the files are as long as the longest side.
        let length = max(end ?? 0, mic.placed, call.placed)
        silence(.me, until: length)
        silence(.others, until: length)
        mix(final: true)
        mic.file?.close()
        call.file?.close()
        mixer?.close()
        return AudioRecorder.Recording(folder: folder, mixed: mixer != nil && !mixFailed ? mixer?.url : nil,
                                       duration: Double(length) / whisperSampleRate, error: error)
    }

    func cancel() {
        mic.file?.close()
        call.file?.close()
        mixer?.close()
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: Writing

    private func place(_ samples: ArraySlice<Float>, on channel: Channel) {
        guard !samples.isEmpty else { return }
        let side = side(channel)
        if !write(samples, to: self[keyPath: side].file) { self.error = self.error ?? AudioError.write }
        self[keyPath: side].unmixed.append(contentsOf: samples)
        self[keyPath: side].placed += samples.count
    }

    private func silence(_ channel: Channel, until position: Int) {
        while self[keyPath: side(channel)].placed < position {
            let placed = self[keyPath: side(channel)].placed
            place([Float](repeating: 0, count: min(position - placed, block))[...], on: channel)
            keepUp(with: channel)
            mix(final: false)
        }
    }

    /// Fills the other side with silence if it has fallen too far behind this one.
    private func keepUp(with channel: Channel) {
        let other: Channel = channel == .me ? .others : .me
        let behind = self[keyPath: side(channel)].placed - maxLag - self[keyPath: side(other)].placed
        if behind > 0 { place([Float](repeating: 0, count: behind)[...], on: other) }
    }

    /// Sums what both sides have placed beyond the mix and encodes it.
    private func mix(final: Bool) {
        let ready = min(mic.placed, call.placed) - mixed
        guard ready > 0, final || ready >= Int(whisperSampleRate / 10) else { return }
        var sum = [Float](repeating: 0, count: ready)
        for index in 0..<ready {
            sum[index] = min(1, max(-1, mic.unmixed[index] + call.unmixed[index]))
        }
        mic.unmixed.removeFirst(ready)
        call.unmixed.removeFirst(ready)
        mixed += ready
        if mixer != nil, !write(sum[...], to: mixer) {
            mixFailed = true
            error = error ?? AudioError.write
        }
    }

    /// False if the file is missing or the write failed.
    private func write(_ samples: ArraySlice<Float>, to file: AVAudioFile?) -> Bool {
        guard let file,
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(samples.count))
        else { return false }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        return (try? file.write(from: buffer)) != nil
    }

    private enum AudioError: LocalizedError {
        case write
        var errorDescription: String? { "Couldn't write the call's audio" }
    }
}
