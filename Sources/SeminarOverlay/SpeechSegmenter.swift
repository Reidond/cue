import Foundation

/// Cuts a continuous 16 kHz stream into utterances with an adaptive energy VAD.
/// Emits a growing partial every `partialInterval` while someone is talking and a
/// final when they pause, so the overlay can show live text and still get clean
/// sentence-sized chunks for question detection.
final class SpeechSegmenter {
    enum Event {
        case onset
        case partial([Float])
        /// Empty audio means the utterance was too short to transcribe.
        case final([Float], speechEnded: Date)
    }

    var onEvent: ((Event) -> Void)?
    /// Smoothed RMS of the most recent frame, for the level meters.
    private(set) var level: Float = 0
    private(set) var isSpeaking = false

    private let frameSize = 320                 // 20 ms
    private let preRollFrames = 15              // 300 ms kept before speech onset
    private let onsetFrames = 4                 // voiced frames needed to open a segment
    private let hangoverFrames = 40             // 800 ms of silence closes it
    private let maxFrames = 1250                // 25 s — Whisper's window is 30 s
    private let minSpeechFrames = 20            // drop blips shorter than 400 ms
    private let partialInterval = 60            // re-transcribe every 1.2 s
    private let absoluteFloor: Float = 0.003

    private var pending: [Float] = []
    private var preRoll: [[Float]] = []
    private var segment: [Float] = []
    private var voicedRun = 0
    private var silentRun = 0
    private var speechFrames = 0
    private var framesSincePartial = 0
    private var noiseFloor: Float = 0.002

    func push(_ samples: [Float]) {
        pending.append(contentsOf: samples)
        var offset = 0
        while pending.count - offset >= frameSize {
            process(Array(pending[offset..<offset + frameSize]))
            offset += frameSize
        }
        pending.removeFirst(offset)
    }

    /// Closes the current utterance now (e.g. on a manual "answer now").
    func flush() {
        if isSpeaking { finish() }
    }

    private func process(_ frame: [Float]) {
        let rms = sqrt(frame.reduce(0) { $0 + $1 * $1 } / Float(frame.count))
        level = level * 0.7 + rms * 0.3
        // Track the noise floor: follow quiet frames quickly, creep up slowly.
        noiseFloor = rms < noiseFloor ? noiseFloor * 0.9 + rms * 0.1 : noiseFloor * 1.0007
        let voiced = rms > max(noiseFloor * 3.5, absoluteFloor)

        if !isSpeaking {
            preRoll.append(frame)
            if preRoll.count > preRollFrames { preRoll.removeFirst() }
            voicedRun = voiced ? voicedRun + 1 : 0
            if voicedRun >= onsetFrames {
                isSpeaking = true
                segment = preRoll.flatMap { $0 }
                preRoll.removeAll()
                speechFrames = voicedRun
                silentRun = 0
                framesSincePartial = 0
                onEvent?(.onset)
            }
            return
        }

        segment.append(contentsOf: frame)
        framesSincePartial += 1
        if voiced {
            speechFrames += 1
            silentRun = 0
        } else {
            silentRun += 1
        }

        if silentRun >= hangoverFrames || segment.count >= maxFrames * frameSize {
            finish()
        } else if framesSincePartial >= partialInterval {
            framesSincePartial = 0
            onEvent?(.partial(segment))
        }
    }

    private func finish() {
        let audio = segment
        let enoughSpeech = speechFrames >= minSpeechFrames
        let speechEnded = Date().addingTimeInterval(-Double(silentRun * frameSize) / whisperSampleRate)
        isSpeaking = false
        segment.removeAll()
        voicedRun = 0
        silentRun = 0
        speechFrames = 0
        onEvent?(.final(enoughSpeech ? audio : [], speechEnded: speechEnded))
    }
}
