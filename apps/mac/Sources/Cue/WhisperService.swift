import Foundation

/// The speech model the second pass reads a recorded call with (whisper-cli, see `SecondPass`). Live speech
/// recognition is the Cue API's.
enum WhisperService {
    static let modelPath = appSupport.appendingPathComponent("models/ggml-large-v3-turbo.bin").path

    static var modelInstalled: Bool { FileManager.default.fileExists(atPath: modelPath) }

    /// Drops the phrases Whisper invents on silence or music (listed in the lexicon).
    static func clean(_ raw: String, hallucinations: [String]) -> String {
        let text = raw.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        let lower = text.lowercased()
        if lower.count < 2 || hallucinations.contains(where: { lower.contains($0) && lower.count < $0.count + 25 }) {
            return ""
        }
        if text.hasPrefix("[") && text.hasSuffix("]") { return "" }  // [music], [BLANK_AUDIO]
        return text
    }
}

struct ServiceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
