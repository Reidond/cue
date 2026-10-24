// Stand-in for the `claude` CLI in end-to-end tests (Cue finds it through
// CUE_CLAUDE_BIN). Speaks the stream-json protocol Cue uses and records every
// request in FAKE_CLAUDE_LOG as TIME-PID-KIND.txt, so cases can check what Cue sent.
//
//   answer session (`--input-format stream-json`): answer-system, ask
//   one-shot summary (`-p` with the transcript on stdin): summary-system, summary-input
//
// FAKE_CLAUDE_ANSWER (text) and FAKE_CLAUDE_SUMMARY (a file) set the replies.
import Foundation

let arguments = CommandLine.arguments
let environment = ProcessInfo.processInfo.environment

func value(after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func record(_ kind: String, _ text: String) {
    guard let folder = environment["FAKE_CLAUDE_LOG"] else { return }
    let url = URL(fileURLWithPath: folder)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    // Several processes can write at once; time and pid keep names unique and in order.
    let name = String(format: "%.6f-%d-%@.txt", Date().timeIntervalSince1970, getpid(), kind)
    FileManager.default.createFile(atPath: url.appendingPathComponent(name).path, contents: Data(text.utf8))
}

func emit(_ event: [String: Any]) {
    guard var line = try? JSONSerialization.data(withJSONObject: event) else { return }
    line.append(0x0A)
    FileHandle.standardOutput.write(line)
}

/// Streams `text` in a few deltas, then the final result.
func reply(_ text: String) {
    let words = text.split(separator: " ", omittingEmptySubsequences: false)
    let pieces = stride(from: 0, to: words.count, by: 6).map { words[$0..<min($0 + 6, words.count)].joined(separator: " ") }
    for (index, piece) in pieces.enumerated() {
        emit(["type": "stream_event", "event": [
            "type": "content_block_delta",
            "delta": ["type": "text_delta", "text": (index == 0 ? "" : " ") + piece],
        ]])
    }
    emit(["type": "result", "subtype": "success", "is_error": false, "result": text])
}

let defaultSummary = """
# E2E rehearsal notes

## Summary
The participant asked when the report is due, and it was agreed to send it by Friday.

## Key points
- The report is due on Friday.

## Action items
- [ ] Speaker: send the report (Friday)
"""

if value(after: "--input-format") == "stream-json" {
    if let file = value(after: "--system-prompt-file") {
        record("answer-system", (try? String(contentsOfFile: file, encoding: .utf8)) ?? "")
    }
    emit(["type": "system", "subtype": "init"])
    let answer = environment["FAKE_CLAUDE_ANSWER"]
        ?? "Fake answer from the end-to-end tests.\n- A supporting point\nSource: tests"
    while let line = readLine() {
        guard let message = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let body = message["message"] as? [String: Any],
              let content = body["content"] as? String
        else { continue }
        record("ask", content)
        reply(content.hasPrefix("Connection check") ? "—" : answer)
    }
} else {
    record("summary-system", value(after: "--system-prompt") ?? "")
    let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    record("summary-input", input)
    let summary = environment["FAKE_CLAUDE_SUMMARY"].flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? defaultSummary
    reply(summary)
}
