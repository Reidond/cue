// `dialogue SCRIPT OUTDIR` builds a spoken call for end-to-end cases from a
// script of lines like
//
//   call | Daniel   | Good morning. When is the report due?
//   me   | Samantha | By Friday.
//   pause | 3
//
// Each line is spoken by a macOS voice (`say`) on its side, one after another
// with a short gap; every side becomes OUTDIR/SIDE.wav (16 kHz mono 16-bit,
// silence while the other sides talk, all the same length), and
// OUTDIR/timeline.tsv lists start, end, side, voice and text of each line.
import AVFoundation

let sampleRate = 16_000.0
let gap = 1.2, lead = 0.5, tail = 1.5

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data("dialogue: \(message)\n".utf8))
    exit(1)
}

func speak(_ text: String, voice: String, scratch: URL) -> [Float] {
    let file = scratch.appendingPathComponent("line.wav")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice, "-o", file.path, "--file-format=WAVE", "--data-format=LEF32@16000", "--", text]
    do { try say.run() } catch { die("say: \(error.localizedDescription)") }
    say.waitUntilExit()
    guard say.terminationStatus == 0,
          let audio = try? AVAudioFile(forReading: file),
          audio.processingFormat.sampleRate == sampleRate,
          let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(audio.length)),
          (try? audio.read(into: buffer)) != nil,
          let channel = buffer.floatChannelData?[0]
    else { die("couldn't speak with voice \(voice): \(text)") }
    return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
}

func write(_ samples: [Float], to url: URL) {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    ]
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
          let file = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    else { die("couldn't write \(url.path)") }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    do { try file.write(from: buffer) } catch { die("couldn't write \(url.path): \(error.localizedDescription)") }
}

guard CommandLine.arguments.count == 3 else { die("usage: dialogue SCRIPT OUTDIR") }
guard let script = try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8) else { die("can't read the script") }
let out = URL(fileURLWithPath: CommandLine.arguments[2])
let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("dialogue-\(getpid())")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: scratch) }

var sides: [String: [Float]] = [:]
var order: [String] = []
var timeline = ""
var cursor = lead
for raw in script.components(separatedBy: .newlines) {
    let line = raw.trimmingCharacters(in: .whitespaces)
    guard !line.isEmpty, !line.hasPrefix("#") else { continue }
    let fields = line.split(separator: "|", maxSplits: 2).map { $0.trimmingCharacters(in: .whitespaces) }
    if fields.count == 2, fields[0] == "pause", let seconds = Double(fields[1]) {
        cursor += seconds
        continue
    }
    guard fields.count == 3 else { die("bad line: \(line)") }
    let (side, voice, text) = (fields[0], fields[1], fields[2])
    if sides[side] == nil { sides[side] = []; order.append(side) }
    let speech = speak(text, voice: voice, scratch: scratch)
    let start = Int(cursor * sampleRate)
    sides[side]! += [Float](repeating: 0, count: max(0, start - sides[side]!.count))
    sides[side]! += speech
    let end = cursor + Double(speech.count) / sampleRate
    timeline += String(format: "%.2f\t%.2f\t%@\t%@\t%@\n", cursor, end, side, voice, text)
    cursor = end + gap
}
guard !order.isEmpty else { die("the script has no lines") }

let total = Int((cursor - gap + tail) * sampleRate)
for side in order {
    let samples = sides[side]!
    write(samples + [Float](repeating: 0, count: max(0, total - samples.count)), to: out.appendingPathComponent("\(side).wav"))
}
try? timeline.write(to: out.appendingPathComponent("timeline.tsv"), atomically: true, encoding: .utf8)
