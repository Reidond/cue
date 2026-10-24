import AVFoundation
import Foundation

/// Markdown record of the session (transcript, questions, answers) for reviewing afterwards.
final class SessionLog {
    let url: URL
    private let handle: FileHandle?
    private let timeFormat: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "HH:mm:ss"
        return format
    }()

    init() {
        let folder = appSupport.appendingPathComponent("sessions")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd-HHmmss"
        url = folder.appendingPathComponent("\(stamp.string(from: Date())).md")
        FileManager.default.createFile(atPath: url.path, contents: Data("# Seminar session\n\n".utf8))
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    func write(_ text: String, at time: Date = Date()) {
        let line = "`\(timeFormat.string(from: time))` \(text)\n"
        try? handle?.write(contentsOf: Data(line.utf8))
    }
}

/// Rehearsal mode: plays an audio file into a channel as if it were live speech
/// (SEMINAR_REHEARSE_PARTICIPANT=/path/to/audio). Handy for testing the whole
/// pipeline with recorded questions, without Google Meet.
enum Rehearsal {
    static func play(fileAt path: String, into push: @escaping ([Float]) -> Void) throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: whisperSampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: file.processingFormat, to: target),
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
        else { throw CaptureError.converter }
        try file.read(into: input)
        let capacity = AVAudioFrameCount(Double(input.frameLength) * whisperSampleRate / file.processingFormat.sampleRate) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { throw CaptureError.converter }
        var consumed = false
        converter.convert(to: output, error: nil) { _, status in
            if consumed { status.pointee = .endOfStream; return nil }
            consumed = true
            status.pointee = .haveData
            return input
        }
        // Trailing silence lets the last utterance end the way live speech would.
        let samples = Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
            + [Float](repeating: 0, count: Int(whisperSampleRate * 3))
        let chunk = Int(whisperSampleRate / 10)
        DispatchQueue.global().async {
            for start in stride(from: 0, to: samples.count, by: chunk) {
                push(Array(samples[start..<min(start + chunk, samples.count)]))
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
    }
}
