import Foundation

/// Runs a local whisper.cpp server and transcribes utterances through it.
/// The server handles one request at a time, so finals queue ahead of partials
/// and a newer partial replaces an older one that has not started yet.
actor WhisperService {
    /// CUE_WHISPER_PORT lets end-to-end runs in parallel each have their own server.
    static let port = Int(ProcessInfo.processInfo.environment["CUE_WHISPER_PORT"] ?? "") ?? 8178
    static let modelPath = appSupport.appendingPathComponent("models/ggml-large-v3-turbo.bin").path
    static let serverCandidates = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]

    /// Outside actor isolation so the app can kill it synchronously while quitting.
    private nonisolated let server = ChildProcess()
    private let endpoint = URL(string: "http://127.0.0.1:\(port)/inference")!
    private var language = "en"
    private var vocabularyPrompt = ""
    private var hallucinations: [String] = []
    private var busy = false
    private var finals: [(audio: [Float], done: CheckedContinuation<String, Never>)] = []
    private var partials: [Channel: (audio: [Float], done: CheckedContinuation<String?, Never>)] = [:]

    static var serverBinary: String? { serverCandidates.first(where: FileManager.default.isExecutableFile) }
    static var modelInstalled: Bool { FileManager.default.fileExists(atPath: modelPath) }

    /// Language, vocabulary and known artefacts apply from the next request on.
    func configure(language: String, vocabularyPrompt: String, hallucinations: [String]) {
        self.language = language
        self.vocabularyPrompt = vocabularyPrompt
        self.hallucinations = hallucinations
    }

    func start() async throws {
        if await isHealthy() { return }  // reuse a server that is already running
        guard let binary = Self.serverBinary else {
            throw ServiceError("whisper-server is not installed")
        }
        guard Self.modelInstalled else {
            throw ServiceError("Speech model not downloaded")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["-m", Self.modelPath, "--host", "127.0.0.1", "--port", "\(Self.port)",
                             "-t", "8", "-nt"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        server.process = process
        for _ in 0..<120 {
            if await isHealthy() { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw ServiceError("whisper-server did not start within 30 s")
    }

    nonisolated func stop() {
        server.terminate()
    }

    func transcribeFinal(_ audio: [Float]) async -> String {
        await withCheckedContinuation { continuation in
            finals.append((audio, continuation))
            pump()
        }
    }

    /// Returns nil when superseded by a newer partial or a final.
    func transcribePartial(_ audio: [Float], channel: Channel) async -> String? {
        await withCheckedContinuation { continuation in
            partials.removeValue(forKey: channel)?.done.resume(returning: nil)
            partials[channel] = (audio, continuation)
            pump()
        }
    }

    private func pump() {
        guard !busy else { return }
        if !finals.isEmpty {
            let job = finals.removeFirst()
            busy = true
            Task {
                let text = await request(job.audio)
                job.done.resume(returning: text)
                finishJob()
            }
        } else if let channel = partials.keys.first, let job = partials.removeValue(forKey: channel) {
            busy = true
            Task {
                let text = await request(job.audio)
                job.done.resume(returning: text)
                finishJob()
            }
        }
    }

    private func finishJob() {
        busy = false
        pump()
    }

    private func request(_ audio: [Float]) async -> String {
        let boundary = "b-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("response_format", "json")
        field("language", language)
        field("temperature", "0")
        field("prompt", vocabularyPrompt)
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wav(audio))
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = URLRequest(url: endpoint, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        guard let (data, _) = try? await URLSession.shared.upload(for: req, from: body),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["text"] as? String
        else { return "" }
        return Self.clean(text, hallucinations: hallucinations)
    }

    private func isHealthy() async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(Self.port)/")!, timeoutInterval: 1)
        req.httpMethod = "GET"
        return (try? await URLSession.shared.data(for: req)) != nil
    }

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

    private func wav(_ samples: [Float]) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append("RIFF".data(using: .ascii)!); put(36 + bytes)
        data.append("WAVEfmt ".data(using: .ascii)!); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(whisperSampleRate)); put(UInt32(whisperSampleRate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append("data".data(using: .ascii)!); put(bytes)
        for sample in samples {
            put(Int16(max(-1, min(1, sample)) * Float(Int16.max)))
        }
        return data
    }
}

/// A child process that must not outlive the app.
final class ChildProcess: @unchecked Sendable {
    var process: Process?

    func terminate() {
        if let process, process.isRunning { process.terminate() }
        process = nil
    }
}

struct ServiceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
