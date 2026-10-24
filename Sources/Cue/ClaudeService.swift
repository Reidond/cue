import Foundation

/// Keeps one headless Claude Code session alive (`claude -p` with stream-json on
/// stdin/stdout) so each question skips process start-up and hits the prompt cache
/// holding the dissertation. Uses the user's Claude Code login — no API key.
final class ClaudeService {
    enum Model: String, CaseIterable {
        case sonnet, haiku
        var title: String { self == .sonnet ? "Sonnet (best answers)" : "Haiku (fastest)" }
    }

    struct Handlers {
        var onDelta: (UUID, String) -> Void
        var onDone: (UUID, String?) -> Void   // error message, if any
        var onReady: (Bool, String) -> Void   // ready flag, status text
    }

    private let systemPromptFile: URL
    private let handlers: Handlers
    private let queue = DispatchQueue(label: "claude")
    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = Data()
    /// Requests written to stdin; the CLI answers them strictly in order.
    private var inFlight: [UUID] = []
    private var warmupID: UUID?
    private var lastActivity = Date()
    private var keepAlive: Timer?
    private(set) var model: Model

    init(systemPromptFile: URL, model: Model, handlers: Handlers) {
        self.systemPromptFile = systemPromptFile
        self.model = model
        self.handlers = handlers
    }

    static func findBinary() -> String? {
        // End-to-end tests point this at a stand-in that speaks the same stream-json.
        if let override = ProcessInfo.processInfo.environment["CUE_CLAUDE_BIN"] { return override }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "\(home)/.claude/local/claude"]
        return candidates.first(where: FileManager.default.isExecutableFile)
    }

    func start(model: Model? = nil) {
        queue.async { [self] in
            if let model { self.model = model }
            launch()
        }
    }

    func stop() {
        queue.sync { shutdown() }
    }

    @discardableResult
    func ask(_ text: String) -> UUID {
        let id = UUID()
        queue.async { [self] in
            if process == nil { launch() }
            send(text, id: id)
        }
        return id
    }

    private func launch() {
        shutdown()
        guard let binary = Self.findBinary() else {
            handlers.onReady(false, "Claude Code not found")
            return
        }
        let workDir = appSupport.appendingPathComponent("run")
        try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.currentDirectoryURL = workDir
        process.arguments = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--model", model.rawValue,
            "--system-prompt-file", systemPromptFile.path,
            "--tools", "", "--strict-mcp-config", "--setting-sources", "",
            "--disable-slash-commands", "--no-session-persistence",
        ]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            self?.queue.async { self?.consume(chunk) }
        }
        process.terminationHandler = { [weak self] finished in
            self?.queue.async {
                guard let self, self.process === finished else { return }
                self.failAll("Claude exited (code \(finished.terminationStatus))")
                self.process = nil
                self.handlers.onReady(false, "Claude stopped — restarting…")
                self.queue.asyncAfter(deadline: .now() + 2) { if self.process == nil { self.launch() } }
            }
        }
        do {
            try process.run()
        } catch {
            handlers.onReady(false, "Couldn't start Claude Code: \(error.localizedDescription)")
            return
        }
        self.process = process
        stdin = input.fileHandleForWriting
        handlers.onReady(false, "Warming up Claude \(model.rawValue.capitalized)…")

        // The first turn of a session is slow (~8 s); pay it now, not on the first question.
        let warmup = UUID()
        warmupID = warmup
        send("Connection check before the talk. There is no question here.", id: warmup)

        DispatchQueue.main.async { [weak self] in
            self?.keepAlive?.invalidate()
            // The prompt cache lives an hour; refresh it while the room is quiet.
            self?.keepAlive = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
                self?.queue.async {
                    guard let self, self.inFlight.isEmpty, Date().timeIntervalSince(self.lastActivity) > 45 * 60 else { return }
                    self.send("Connection check. There is no question here.", id: UUID())
                }
            }
        }
    }

    private func shutdown() {
        failAll("Claude session restarted")
        if let process, process.isRunning { process.terminate() }
        process = nil
        stdin = nil
        buffer.removeAll()
    }

    private func send(_ text: String, id: UUID) {
        let message: [String: Any] = ["type": "user", "message": ["role": "user", "content": text]]
        guard let stdin, var line = try? JSONSerialization.data(withJSONObject: message) else {
            handlers.onDone(id, "Claude is unavailable")
            return
        }
        line.append(0x0A)
        inFlight.append(id)
        lastActivity = Date()
        do {
            try stdin.write(contentsOf: line)
        } catch {
            inFlight.removeAll { $0 == id }
            handlers.onDone(id, "Could not send the question")
        }
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            handle(event)
        }
    }

    private func handle(_ event: [String: Any]) {
        guard let current = inFlight.first else { return }
        switch event["type"] as? String {
        case "stream_event":
            guard let inner = event["event"] as? [String: Any],
                  inner["type"] as? String == "content_block_delta",
                  let delta = inner["delta"] as? [String: Any],
                  delta["type"] as? String == "text_delta",
                  let text = delta["text"] as? String,
                  current != warmupID
            else { return }
            handlers.onDelta(current, text)
        case "result":
            inFlight.removeFirst()
            lastActivity = Date()
            let failed = event["is_error"] as? Bool == true
            if current == warmupID {
                warmupID = nil
                handlers.onReady(!failed, failed ? "Claude didn't answer — is Claude Code signed in?" : "Claude \(model.rawValue.capitalized) ready")
            } else {
                handlers.onDone(current, failed ? (event["result"] as? String ?? "Claude error") : nil)
            }
        default:
            break
        }
    }

    private func failAll(_ reason: String) {
        for id in inFlight where id != warmupID {
            handlers.onDone(id, reason)
        }
        inFlight.removeAll()
        warmupID = nil
    }
}
