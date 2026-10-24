// `audio-sync AUDIO TIMELINE [SIDE…]` checks that a recording has each line of a
// dialogue's timeline.tsv (see dialogue.swift) where the timeline puts it, and
// nothing anywhere else — how end-to-end cases tell that a call's sides are in
// sync. With SIDEs, only those sides' lines should be heard (a per-side file).
//
// For every line: speech must start within ±0.1 s of the line's start and be
// heard over most of it; outside the lines (0.3 s away from any) the audio must
// be near-silent. Prints what it measured; exits 1 if anything is off.
import AVFoundation

let window = 0.02                      // 20 ms frames
let speechLevel = -40.0, silenceLevel = -55.0  // dBFS
let onsetTolerance = 0.1, margin = 0.3

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data("audio-sync: \(message)\n".utf8))
    exit(2)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { die("usage: audio-sync AUDIO TIMELINE [SIDE…]") }
let sides = Set(arguments.dropFirst(3))

guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: arguments[1])),
      let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
      (try? file.read(into: buffer)) != nil, let channel = buffer.floatChannelData?[0]
else { die("can't read \(arguments[1])") }
let rate = file.processingFormat.sampleRate
let samples = UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))
let duration = Double(samples.count) / rate

/// Level of each 20 ms frame in dBFS.
let frameLength = Int(window * rate)
let levels: [Double] = stride(from: 0, to: samples.count, by: frameLength).map { start in
    let frame = samples[start..<min(start + frameLength, samples.count)]
    let power = frame.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(frame.count)
    return 10 * log10(max(power, 1e-12))
}
func frame(_ time: Double) -> Int { min(max(Int(time / window), 0), levels.count) }

guard let timeline = try? String(contentsOfFile: arguments[2], encoding: .utf8) else { die("can't read \(arguments[2])") }
struct Line { let start: Double, end: Double, side: String, text: String }
let lines = timeline.split(separator: "\n").compactMap { row -> Line? in
    let fields = row.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
    guard fields.count >= 5, let start = Double(fields[0]), let end = Double(fields[1]) else { return nil }
    return Line(start: start, end: end, side: fields[2], text: fields[4])
}.filter { sides.isEmpty || sides.contains($0.side) }
guard !lines.isEmpty else { die("no lines to check") }

var problems: [String] = []
print(String(format: "%.2f s of audio, %d lines", duration, lines.count))
for line in lines {
    guard line.end <= duration else {
        problems.append(String(format: "the audio ends (%.2f s) before the line at %.2f s", duration, line.start))
        continue
    }
    // Where speech starts, looking from a little before the line.
    let from = frame(line.start - 1), to = frame(line.end)
    let onset = (from..<to).first { levels[$0] > speechLevel }.map { Double($0) * window }
    let span = levels[frame(line.start)..<max(frame(line.start) + 1, frame(line.end))]
    let heard = Double(span.filter { $0 > speechLevel }.count) / Double(span.count)
    let shift = onset.map { $0 - line.start }
    print(String(format: "%6.2f–%6.2f %-6@ onset %@, heard %3.0f%%  %@", line.start, line.end, line.side,
                 shift.map { String(format: "%+.2f s", $0) } ?? "none", heard * 100, String(line.text.prefix(40))))
    if let shift, abs(shift) > onsetTolerance {
        problems.append(String(format: "the line at %.2f s starts %+.2f s off", line.start, shift))
    } else if shift == nil {
        problems.append(String(format: "no speech in the line at %.2f s", line.start))
    }
    if heard < 0.4 { problems.append(String(format: "the line at %.2f s is heard only %.0f%% of the time", line.start, heard * 100)) }
}

// Everything away from the lines is quiet.
var loudest = -120.0, loudestAt = 0.0
for index in levels.indices {
    let time = (Double(index) + 0.5) * window
    guard !lines.contains(where: { time > $0.start - margin && time < $0.end + margin }) else { continue }
    if levels[index] > loudest { (loudest, loudestAt) = (levels[index], time) }
}
print(String(format: "outside the lines: loudest %.0f dB at %.2f s", loudest, loudestAt))
if loudest > silenceLevel { problems.append(String(format: "sound outside the lines: %.0f dB at %.2f s", loudest, loudestAt)) }

for problem in problems { print("problem: \(problem)") }
exit(problems.isEmpty ? 0 : 1)
