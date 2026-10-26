import Foundation

/// A conversation with Claude that answers one message after another: Claude Code's
/// (`ClaudeService`) or the Anthropic API's (`ClaudeAPIService`), as Settings › Providers says.
protocol ClaudeSession: AnyObject {
    var model: ClaudeService.Model { get }
    func start(model: ClaudeService.Model?)
    func stop()
    /// `id` names the request in the handlers' calls.
    @discardableResult func ask(_ text: String, id: UUID) -> UUID
}

extension ClaudeSession {
    @discardableResult func ask(_ text: String) -> UUID { ask(text, id: UUID()) }
}

func makeClaudeSession(_ provider: ClaudeProvider, systemPromptFile: URL, model: ClaudeService.Model,
                       handlers: ClaudeService.Handlers) -> ClaudeSession {
    switch provider {
    case .claudeCode: ClaudeService(systemPromptFile: systemPromptFile, model: model, handlers: handlers)
    case .anthropicAPI: ClaudeAPIService(systemPromptFile: systemPromptFile, model: model, handlers: handlers)
    }
}

extension ClaudeService.Model {
    /// The model on the Anthropic API.
    var apiID: String { self == .sonnet ? "claude-sonnet-5-5" : "claude-haiku-5-5" }
    /// No thinking before a live answer or verdict: the first word matters more. (Claude Sonnet 5.5
    /// turns it off with `between_tools`, which without tools is never.)
    var noThinking: [String: Any] { ["type": self == .sonnet ? "between_tools" : "disabled"] }
}

/// The Messages API (https://api.anthropic.com, or CUE_ANTHROPIC_URL), over HTTP: Swift has no Anthropic SDK.
enum AnthropicAPI {
    static let messages = URL(string: (ProcessInfo.processInfo.environment["CUE_ANTHROPIC_URL"] ?? "https://api.anthropic.com") + "/v1/messages")!
    static let version = "2026-10-21"

    struct Failure: LocalizedError {
        let status: Int
        let type: String
        let message: String

        /// Worth another try: rate limits, overload, server errors.
        var transient: Bool { status == 429 || status >= 500 || type == "overloaded_error" }

        var errorDescription: String? {
            switch status {
            case 401: "The Anthropic API key was rejected — check it in Settings › Providers"
            case 403: "The Anthropic API key isn't allowed to do this: \(message)"
            case 429: "Anthropic API rate limit: \(message)"
            case 529: "The Anthropic API is overloaded — try again in a moment"
            default: "Anthropic API: \(message.isEmpty ? "error \(status)" : message)"
            }
        }
    }

    /// A connection that failed (no network, a TLS handshake that broke off), saying where it was going.
    struct Unreachable: LocalizedError {
        let reason: URLError
        var errorDescription: String? { "Can't reach the Anthropic API: \(reason.localizedDescription)" }
    }

    /// Worth trying again in a moment: rate limits, overload, server errors, a connection that failed.
    static func transient(_ error: Error) -> Bool {
        if let error = error as? Failure { return error.transient }
        if let error = error as? URLError { return error.code != .cancelled }
        return error is Unreachable
    }

    /// Sends a request and waits for the whole reply (no streaming, as for warming the cache). What's
    /// transient is tried twice more.
    static func send(_ body: [String: Any], key: String) async throws {
        var attempt = 0
        while true {
            do {
                let (data, response) = try await URLSession.shared.data(for: request(body, key: key))
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200 else { throw failure(status, data) }
                return
            } catch {
                guard transient(error), attempt < 2, !Task.isCancelled else { throw unreachable(error) }
                attempt += 1
                try await Task.sleep(for: .seconds(attempt))
            }
        }
    }

    /// Streams a reply's text through `onText`, piece by piece, and returns all of it. Rate limits, overload
    /// and dropped connections are tried twice more, unless some of the reply has come already.
    static func stream(_ body: [String: Any], key: String, onText: @escaping (String) -> Void) async throws -> String {
        var streamed = body
        streamed["stream"] = true
        var attempt = 0
        while true {
            var text = ""
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request(streamed, key: key))
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200 else {
                    var data = Data()
                    for try await byte in bytes { data.append(byte) }
                    throw failure(status, data)
                }
                var stopReason: String?
                events: for try await line in bytes.lines where line.hasPrefix("data:") {
                    guard let event = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(5).utf8)) as? [String: Any] else { continue }
                    switch event["type"] as? String {
                    case "content_block_delta":
                        guard let delta = event["delta"] as? [String: Any], delta["type"] as? String == "text_delta",
                              let piece = delta["text"] as? String else { continue }
                        text += piece
                        onText(piece)
                    case "message_delta":
                        stopReason = (event["delta"] as? [String: Any])?["stop_reason"] as? String ?? stopReason
                    case "error":
                        let error = event["error"] as? [String: Any]
                        let type = error?["type"] as? String ?? ""
                        throw Failure(status: type == "overloaded_error" ? 529 : 500, type: type, message: error?["message"] as? String ?? "")
                    case "message_stop":
                        break events
                    default:
                        break
                    }
                }
                if stopReason == "refusal" && text.isEmpty { throw ServiceError("Claude declined to answer this") }
                return text
            } catch {
                guard transient(error), text.isEmpty, attempt < 2, !Task.isCancelled else { throw unreachable(error) }
                attempt += 1
                try await Task.sleep(for: .seconds(attempt))
            }
        }
    }

    private static func unreachable(_ error: Error) -> Error {
        guard let error = error as? URLError, error.code != .cancelled else { return error }
        return Unreachable(reason: error)
    }

    private static func request(_ body: [String: Any], key: String) throws -> URLRequest {
        var request = URLRequest(url: messages, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue(version, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private static func failure(_ status: Int, _ data: Data) -> Failure {
        let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
        return Failure(status: status, type: error?["type"] as? String ?? "",
                       message: error?["message"] as? String ?? String(decoding: data.prefix(200), as: UTF8.self))
    }
}

/// `ClaudeService`'s session over the Anthropic API with the user's key. Each question goes with the
/// conversation so far; the system prompt (the materials) is cached for an hour, written before the
/// first question and kept warm while the room is quiet, so an answer starts as quickly as Claude Code's.
final class ClaudeAPIService: ClaudeSession, @unchecked Sendable {  // its state is only touched on `queue`
    private let systemPromptFile: URL
    private let handlers: ClaudeService.Handlers
    private let queue = DispatchQueue(label: "claude-api")
    private(set) var model: ClaudeService.Model
    private var key: String?
    private var system = ""
    /// The questions answered so far, each followed by its answer.
    private var history: [[String: Any]] = []
    private var requests: [UUID: Task<Void, Never>] = [:]
    /// Bumped whenever the session restarts or stops: replies to what was asked before don't count.
    private var generation = 0
    private var lastActivity = Date()
    private var keepAlive: Timer?

    private static let cache: [String: Any] = ["type": "ephemeral", "ttl": "1h"]

    init(systemPromptFile: URL, model: ClaudeService.Model, handlers: ClaudeService.Handlers) {
        self.systemPromptFile = systemPromptFile
        self.model = model
        self.handlers = handlers
    }

    func start(model: ClaudeService.Model? = nil) {
        queue.async { [self] in
            if let model { self.model = model }
            launch()
        }
    }

    func stop() {
        queue.sync { shutdown() }
        DispatchQueue.main.async { [weak self] in self?.keepAlive?.invalidate() }
    }

    @discardableResult
    func ask(_ text: String, id: UUID) -> UUID {
        queue.async { [self] in
            if key == nil { launch() }
            send(text, id: id)
        }
        return id
    }

    private func launch() {
        shutdown()
        history = []
        system = (try? String(contentsOf: systemPromptFile, encoding: .utf8)) ?? ""
        key = APIKey.anthropic.value
        guard let key else {
            handlers.onReady(false, "No Anthropic API key — add one in Settings › Providers")
            return
        }
        handlers.onReady(false, "Warming up Claude \(model.rawValue.capitalized)…")
        warmUp(key)

        DispatchQueue.main.async { [weak self] in
            self?.keepAlive?.invalidate()
            // The prompt cache lives an hour; refresh it while the room is quiet.
            self?.keepAlive = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
                self?.queue.async {
                    guard let self, let key = self.key, self.requests.isEmpty,
                          Date().timeIntervalSince(self.lastActivity) > 45 * 60 else { return }
                    self.warm(key) { _ in }
                }
            }
        }
    }

    /// The first warm-up, which says whether the session is ready. One that failed for a passing reason
    /// (the network, overload) is tried again every 15 s, as Claude Code's session restarts itself: the
    /// judge asks nothing until it's ready.
    private func warmUp(_ key: String) {
        let generation = generation
        warm(key) { [self] error in
            handlers.onReady(error == nil, error.map { $0.localizedDescription } ?? "Claude \(model.rawValue.capitalized) ready")
            guard let error, AnthropicAPI.transient(error) else { return }
            queue.asyncAfter(deadline: .now() + 15) { [weak self] in
                guard let self, generation == self.generation else { return }
                self.warmUp(key)
            }
        }
    }

    /// Writes the system prompt into the cache without an answer (`max_tokens: 0`), with the settings the
    /// questions have so that they read it. `done` gets the error, if any, on `queue`.
    private func warm(_ key: String, done: @escaping (Error?) -> Void) {
        lastActivity = Date()
        let body = request(messages: [["role": "user", "content": "Connection check before the talk."]], maxTokens: 0, warmup: true)
        let generation = generation
        Task {
            var failed: Error?
            do { try await AnthropicAPI.send(body, key: key) } catch { failed = error }
            queue.async { [self] in if generation == self.generation { done(failed) } }
        }
    }

    private func send(_ text: String, id: UUID) {
        guard let key else {
            handlers.onDone(id, "No Anthropic API key — add one in Settings › Providers")
            return
        }
        lastActivity = Date()
        let question: [String: Any] = ["role": "user", "content": text]
        let body = request(messages: history + [question], maxTokens: 4096, warmup: false)
        let generation = generation, handlers = handlers
        requests[id] = Task {
            var result: Result<String, Error>
            do {
                result = .success(try await AnthropicAPI.stream(body, key: key) { handlers.onDelta(id, $0) })
            } catch {
                result = .failure(error)
            }
            queue.async { [self] in
                guard generation == self.generation else { return }  // `shutdown` has told the handlers already
                requests[id] = nil
                lastActivity = Date()
                switch result {
                case .success(let answer):
                    if !answer.isEmpty { history += [question, ["role": "assistant", "content": answer]] }
                    handlers.onDone(id, nil)
                case .failure(let error):
                    handlers.onDone(id, error.localizedDescription)
                }
            }
        }
    }

    /// The system prompt has its own hour-long cache entry; a question also caches the conversation up to it
    /// (top-level `cache_control`), which the warm-up leaves out: its placeholder question isn't asked again.
    private func request(messages: [[String: Any]], maxTokens: Int, warmup: Bool) -> [String: Any] {
        var body: [String: Any] = ["model": model.apiID, "max_tokens": maxTokens, "thinking": model.noThinking, "messages": messages]
        if !system.isEmpty { body["system"] = [["type": "text", "text": system, "cache_control": Self.cache]] }
        if !warmup { body["cache_control"] = Self.cache }
        return body
    }

    private func shutdown() {
        generation += 1
        for (id, request) in requests {
            request.cancel()
            handlers.onDone(id, "Claude session restarted")
        }
        requests = [:]
        key = nil
    }
}
