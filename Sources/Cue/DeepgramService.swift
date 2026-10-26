import Foundation

/// Live speech recognition: whisper-server on this Mac (`WhisperService`) or Deepgram (`DeepgramService`),
/// as Settings › Providers says. A partial is the growing audio of the utterance being said (nil back when
/// it was superseded); a final is all of it, once the speaker pauses (empty when it was too short).
protocol SpeechRecognizer: Actor {
    /// How often a partial is worth asking for, in seconds.
    nonisolated var partialInterval: TimeInterval { get }
    /// Language, the project's prompt and its names and terms, and known artefacts, from the next request on.
    func configure(language: String, prompt: String, terms: [String], hallucinations: [String])
    func start() async throws
    nonisolated func stop()
    /// Someone on `channel` started speaking: a partial or a final follows.
    func begin(channel: Channel)
    func transcribeFinal(_ audio: [Float], channel: Channel) async -> String
    func transcribePartial(_ audio: [Float], channel: Channel) async -> String?
}

/// Deepgram's API (https://api.deepgram.com, or CUE_DEEPGRAM_URL) with the user's key.
enum Deepgram {
    static let base = ProcessInfo.processInfo.environment["CUE_DEEPGRAM_URL"] ?? "https://api.deepgram.com"
    static let model = "nova-3"
    /// Keyterm prompting takes up to 500 tokens of terms; Deepgram suggests the 20–50 that matter most.
    static let maxTerms = 50

    /// `/v1/listen` with the model, language and names and terms; `wss` for a live stream.
    static func listen(language: String, terms: [String], live: Bool, extra: [String: String]) -> URL {
        var components = URLComponents(string: base + "/v1/listen")!
        if live { components.scheme = components.scheme == "http" ? "ws" : "wss" }
        components.queryItems = [
            URLQueryItem(name: "model", value: model), URLQueryItem(name: "language", value: language),
            URLQueryItem(name: "smart_format", value: "true"), URLQueryItem(name: "punctuate", value: "true"),
        ] + extra.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            + terms.prefix(maxTerms).map { URLQueryItem(name: "keyterm", value: $0) }
        // `+` in a term would read as a space; URLComponents leaves it as it is.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    static func authorize(_ request: inout URLRequest, key: String) {
        request.setValue("Token \(key)", forHTTPHeaderField: "Authorization")
    }

    /// What a status a request failed with means for the user.
    static func failure(_ status: Int, _ data: Data = Data()) -> ServiceError {
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let message = json?["err_msg"] as? String ?? json?["message"] as? String ?? ""
        switch status {
        case 401: return ServiceError("The Deepgram API key was rejected — check it in Settings › Providers")
        case 402: return ServiceError("The Deepgram account is out of credit")
        case 429: return ServiceError("Deepgram rate limit: too many requests at once")
        default: return ServiceError("Deepgram: \(message.isEmpty ? "error \(status)" : message)")
        }
    }

    /// Checks the key: any answer but 401 means Deepgram took it (a key limited to transcription may not
    /// list projects). A connection that fails is tried twice more.
    static func check(key: String) async throws {
        var request = URLRequest(url: URL(string: base + "/v1/projects")!, timeoutInterval: 15)
        authorize(&request, key: key)
        var attempt = 0
        while true {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 401 || status == 402 { throw failure(status, data) }
                return
            } catch let error as URLError {
                guard attempt < 2 else { throw ServiceError("Deepgram can't be reached: \(error.localizedDescription)") }
                attempt += 1
                try await Task.sleep(for: .seconds(attempt))
            }
        }
    }

    /// A recorded file's utterances (start, end in seconds, and text), for the second pass.
    /// Utterances end at pauses of 1.6 s rather than Deepgram's 0.8 s: in a real call that gives sentences
    /// (9 words in the middle, like Whisper's), not one to three words a line.
    static func utterances(in file: URL, language: String, terms: [String], key: String) async throws -> [(start: Double, end: Double, text: String)] {
        let url = listen(language: language, terms: terms, live: false, extra: ["utterances": "true", "utt_split": "1.6"])
        var request = URLRequest(url: url, timeoutInterval: 600)
        request.httpMethod = "POST"
        authorize(&request, key: key)
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw failure(status, data) }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = json["results"] as? [String: Any]
        else { throw ServiceError("Deepgram sent no transcript") }
        return (results["utterances"] as? [[String: Any]] ?? []).compactMap { item in
            guard let start = (item["start"] as? NSNumber)?.doubleValue, let end = (item["end"] as? NSNumber)?.doubleValue,
                  let text = item["transcript"] as? String else { return nil }
            return (start, end, text)
        }
    }

    /// 16-bit little-endian PCM, as the live stream is declared.
    static func pcm(_ samples: ArraySlice<Float>) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            withUnsafeBytes(of: Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }
}

/// Recognizes speech with Deepgram's Nova-3 (`SpeechProvider.deepgram`). Each utterance is streamed to
/// Deepgram while it is said, over a WebSocket of its own: opened as soon as speech starts, so it's ready
/// for the first audio; every partial (each 0.2 s) sends the audio that's new and gets back the words so
/// far, and the final closes the stream for the finished text. Only speech is sent (and paid for), never
/// the silence between utterances. On real calls this shows the first words about 1.2 s after someone
/// starts and the finished line about 0.2 s after Cue hears them stop.
actor DeepgramService: SpeechRecognizer {
    nonisolated let partialInterval: TimeInterval = 0.2

    /// One utterance's stream. Only touched on the actor.
    private final class Stream: @unchecked Sendable {
        let socket: URLSessionWebSocketTask
        /// Samples of the utterance sent so far.
        var sent = 0
        /// Results Deepgram won't change any more, in order, and the latest guess at what follows them.
        var finals: [String] = []
        var interim = ""
        var replies = 0
        var closed = false
        /// Cue is ending it (CloseStream, or cancelled): its socket closing is expected.
        var ending = false

        init(_ socket: URLSessionWebSocketTask) { self.socket = socket }

        var text: String { (finals + [interim]).filter { !$0.isEmpty }.joined(separator: " ") }
    }

    private var language = "en"
    private var terms: [String] = []
    private var key: String?
    private var streams: [Channel: Stream] = [:]
    /// Told when a stream fails that Cue didn't end — Deepgram turned it down (a key revoked meanwhile, no
    /// credit left) or the connection broke — and, with nil, when a stream answers again after that.
    private var onProblem: @Sendable (String?) -> Void = { _ in }
    private var troubled = false

    func configure(language: String, prompt: String, terms: [String], hallucinations: [String]) {
        self.language = language
        self.terms = terms
    }

    func setProblemHandler(_ handler: @escaping @Sendable (String?) -> Void) {
        onProblem = handler
    }

    func start() async throws {
        guard let key = APIKey.deepgram.value else {
            self.key = nil
            throw ServiceError("No Deepgram API key — add one in Settings › Providers")
        }
        try await Deepgram.check(key: key)
        self.key = key
    }

    nonisolated func stop() {
        Task { await closeAll() }
    }

    /// Opens the utterance's stream now, so the handshake is done by the time its first audio comes.
    func begin(channel: Channel) {
        if streams[channel] == nil { _ = stream(for: channel, audio: []) }
    }

    func transcribePartial(_ audio: [Float], channel: Channel) async -> String? {
        guard let stream = stream(for: channel, audio: audio) else { return nil }
        let replies = stream.replies
        send(audio, to: stream)
        // What Deepgram makes of the new audio usually comes back within a few hundred milliseconds; the
        // next partial asks again soon.
        let deadline = Date().addingTimeInterval(0.6)
        while stream.replies == replies && !stream.closed && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(40))
        }
        return stream.text
    }

    func transcribeFinal(_ audio: [Float], channel: Channel) async -> String {
        guard !audio.isEmpty else {
            streams.removeValue(forKey: channel).map(close)
            return ""
        }
        guard let stream = stream(for: channel, audio: audio) else { return "" }
        streams[channel] = nil
        send(audio, to: stream)
        close(stream)
        // CloseStream: Deepgram sends what's left as final results, then closes the socket.
        let deadline = Date().addingTimeInterval(5)
        while !stream.closed && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(40))
        }
        if !stream.closed { stream.socket.cancel(with: .goingAway, reason: nil) }
        return stream.text.trimmingCharacters(in: .whitespaces)
    }

    /// The channel's stream for this utterance, opened on its first audio. Audio shorter than what was
    /// sent is a new utterance: the old stream, left open, is closed.
    private func stream(for channel: Channel, audio: [Float]) -> Stream? {
        if let stream = streams[channel], !stream.closed, audio.count >= stream.sent { return stream }
        streams.removeValue(forKey: channel).map(close)
        guard let key else { return nil }
        let url = Deepgram.listen(language: language, terms: terms, live: true, extra: [
            "encoding": "linear16", "sample_rate": String(Int(whisperSampleRate)), "channels": "1", "interim_results": "true",
        ])
        var request = URLRequest(url: url)
        Deepgram.authorize(&request, key: key)
        let stream = Stream(URLSession.shared.webSocketTask(with: request))
        streams[channel] = stream
        stream.socket.resume()
        Task { await receive(stream) }
        return stream
    }

    private func send(_ audio: [Float], to stream: Stream) {
        guard audio.count > stream.sent else { return }
        let data = Deepgram.pcm(audio[stream.sent...])
        stream.sent = audio.count
        stream.socket.send(.data(data)) { _ in }
    }

    private func close(_ stream: Stream) {
        stream.ending = true
        stream.socket.send(.string(#"{"type":"CloseStream"}"#)) { _ in }
    }

    private func closeAll() {
        for stream in streams.values {
            stream.ending = true
            stream.socket.cancel(with: .goingAway, reason: nil)
        }
        streams = [:]
    }

    private func receive(_ stream: Stream) async {
        while true {
            do {
                let message = try await stream.socket.receive()
                guard case .string(let text) = message,
                      let event = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      event["type"] as? String == "Results",
                      let alternatives = (event["channel"] as? [String: Any])?["alternatives"] as? [[String: Any]],
                      let transcript = alternatives.first?["transcript"] as? String
                else { continue }
                if event["is_final"] as? Bool == true {
                    if !transcript.isEmpty { stream.finals.append(transcript) }
                    stream.interim = ""
                } else {
                    stream.interim = transcript
                }
                stream.replies += 1
                if troubled {
                    troubled = false
                    onProblem(nil)
                }
            } catch {
                // A stream Cue ended closes here too. One Deepgram turned down says why in its handshake's
                // status; any other that fails before Cue ends it lost its connection.
                stream.closed = true
                let status = (stream.socket.response as? HTTPURLResponse)?.statusCode ?? 0
                if status >= 400 {
                    troubled = true
                    onProblem(Deepgram.failure(status).message)
                } else if !stream.ending {
                    troubled = true
                    onProblem("Deepgram stopped answering: \(error.localizedDescription)")
                }
                return
            }
        }
    }
}
