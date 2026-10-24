import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// Both sources deliver 16 kHz mono Float32, the format Whisper expects.
let whisperSampleRate = 16_000.0

enum CaptureError: LocalizedError {
    case noDisplay
    case micDenied
    case converter

    var errorDescription: String? {
        switch self {
        case .noDisplay: "No display found to capture system audio from"
        case .micDenied: "Microphone access denied (System Settings → Privacy & Security → Microphone)"
        case .converter: "Could not set up microphone audio conversion"
        }
    }
}

/// The presenter's own voice.
final class MicCapture {
    private let engine = AVAudioEngine()
    var onSamples: (([Float]) -> Void)?

    func start() async throws {
        guard await AVCaptureDevice.requestAccess(for: .audio) else { throw CaptureError.micDenied }
        let input = engine.inputNode
        let sourceFormat = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: whisperSampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: sourceFormat, to: target)
        else { throw CaptureError.converter }

        input.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * whisperSampleRate / sourceFormat.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false
            converter.convert(to: out, error: nil) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return buffer
            }
            guard let channel = out.floatChannelData?[0], out.frameLength > 0 else { return }
            self?.onSamples?(Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength))))
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        // Touching inputNode on an engine that never started can block on the microphone permission.
        guard engine.isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

/// Everything the Mac plays — the other Google Meet participants. Needs the
/// "Screen & System Audio Recording" permission.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "system-audio")
    var onSamples: (([Float]) -> Void)?
    var onStop: ((Error) -> Void)?

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(whisperSampleRate)
        config.channelCount = 1
        // Video is mandatory for a display stream; keep it as cheap as possible.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() {
        stream?.stopCapture { _ in }
        stream = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let format = sampleBuffer.formatDescription?.audioStreamBasicDescription
        else { return }
        let channels = max(Int(format.mChannelsPerFrame), 1)
        let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        try? sampleBuffer.withAudioBufferList { buffers, _ in
            guard let first = buffers.first, let data = first.mData else { return }
            let floats = data.assumingMemoryBound(to: Float.self)
            let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let samples: [Float]
            if interleaved && channels > 1 {
                samples = stride(from: 0, to: count, by: channels).map { floats[$0] }
            } else {
                samples = Array(UnsafeBufferPointer(start: floats, count: count))
            }
            onSamples?(samples)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }
}
