import AVFoundation
import Foundation

// The Cue API's live calls (packages/contract: calls.ts). The shapes follow it by hand.
//
// A call is one stretch of listening: the app streams the microphone and the call audio to the Call Durable Object over a WebSocket,
// and the server answers with events (the transcript, the questions it noticed, their answers). Nothing about spotting questions or
// answering them happens on the Mac.

/// A call as `POST /v1/calls` made it.
struct CallInfo: Decodable {
    let callId: String
    let projectId: String
    /// Milliseconds since the epoch.
    let startedAt: Double
}

/// One event of the live socket. Every type uses some of these fields (see `CallEvent` in the contract), the rest stay nil.
struct CallEvent: Decodable {
    let type: String
    let seq: Int
    var callId: String?
    var resumed: Bool?
    var part: String?
    var state: String?
    var detail: String?
    var channel: String?
    var active: Bool?
    var speaker: Int?
    var text: String?
    var start: Double?
    var end: Double?
    var id: String?
    var exchange: String?
    var index: Int?
    var of: Int?
    var opener: String?
    var requested: Bool?
    var forced: Bool?
    var questionId: String?
    var question: String?
    var answer: String?
    var who: String?
    var source: String?
    var score: Double?
    var error: String?
    var code: String?
    var message: String?
    var fatal: Bool?
    var lines: Int?

    var side: Channel? { channel.flatMap(Channel.init(rawValue:)) }
}

extension CueAPI {
    /// Starts a call for a project. The settings can change later with a `config` command. `notesOnly`: a call just for a recording's notes, which
    /// starts over already (nothing listens or answers) and is not stopped by the plan's limit.
    func createCall(projectID: String, speaker: String, auto: Bool, micQuestions: Bool, questions: Bool, notesOnly: Bool = false) async throws -> CallInfo {
        let body: [String: Any] = [
            "projectId": projectID, "speaker": speaker, "auto": auto, "micQuestions": micQuestions, "questions": questions,
            "notesOnly": notesOnly,
        ]
        let data = try await request("POST", "v1/calls", json: try JSONSerialization.data(withJSONObject: body))
        do {
            return try JSONDecoder().decode(CallInfo.self, from: data)
        } catch {
            throw CueAPIError.server("Cue answered something unexpected: \(error.localizedDescription)")
        }
    }

    /// Ends a call: the server closes its speech streams and keeps the live transcript. Best effort.
    func endCall(_ id: String) async {
        _ = try? await request("POST", "v1/calls/\(id)/end", json: Data("{}".utf8))
    }
}

/// A call's live socket: audio goes up, events come down. It reconnects by itself while the call is live, asking for the events it
/// missed (`after`), and says when the call is over for good.
@MainActor
final class LiveCall {
    static let clientVersion = "mac/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")"

    let id: String
    /// When the call began for the app (its `POST` returned): the server's times count from about then.
    let startedAt: Date
    /// Every event, in order, once.
    var onEvent: (CallEvent) -> Void = { _ in }
    /// The call is over for good: ended by the server, or it no longer knows it. Says why.
    var onGone: (String) -> Void = { _ in }
    /// The socket could not be opened or broke (told once for each kind of trouble in a row), for the session log.
    var onTrouble: (String) -> Void = { _ in }
    /// Where the microphone's and the call's audio goes; thread-safe, for the capture threads. It outlives the call (the app owns it).
    nonisolated let audio: AudioSink

    private let api: CueAPI
    private var runner: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var connected = false
    private var live = true
    private var lastSeq = 0
    /// The newest settings sent, which go again on every connection, and the commands sent while there was none.
    private var settings: [String: Any] = [:]
    private var pending: [[String: Any]] = []

    init(api: CueAPI, info: CallInfo, audio: AudioSink) {
        self.api = api
        self.audio = audio
        id = info.callId
        startedAt = Date()
    }

    func connect() {
        guard runner == nil else { return }
        runner = Task { await run() }
    }

    /// Ends the socket for good (the app ends the call itself over HTTP).
    func close() {
        live = false
        runner?.cancel()
        runner = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
        audio.stop()
    }

    /// A command of the contract (`config`, `ask`, `answerNow`, `prepare`). Held until the socket is up, if it is not.
    func send(_ command: [String: Any]) {
        if command["type"] as? String == "config" {
            settings.merge(command) { $1 }
            if !connected { return }
        } else if !connected {
            pending.append(command)
            return
        }
        write(command)
    }

    private func write(_ command: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: command), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    private var url: URL {
        var components = URLComponents(url: CueAPI.baseURL.appendingPathComponent("v1/live"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "call", value: id), URLQueryItem(name: "after", value: String(lastSeq))]
        return components.url!
    }

    private func run() async {
        let delays: [Double] = [0.5, 1, 2, 5]
        var attempt = 0
        var refresh = false
        var lastTrouble = ""
        while live && !Task.isCancelled {
            var gone: String?
            var heard = false
            do {
                let token = try await api.bearer(refreshing: refresh)
                refresh = false
                var request = URLRequest(url: url)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.setValue(Self.clientVersion, forHTTPHeaderField: "Cue-Version")
                let socket = URLSession.shared.webSocketTask(with: request)
                self.socket = socket
                socket.resume()
                do {
                    while live {
                        let message = try await socket.receive()
                        heard = true
                        if case .string(let text) = message, let event = try? JSONDecoder().decode(CallEvent.self, from: Data(text.utf8)) {
                            handle(event, on: socket)
                        }
                    }
                } catch {
                    // A refused upgrade says why in its status; anything else is a connection that broke.
                    let status = (socket.response as? HTTPURLResponse)?.statusCode
                    switch status {
                    case 404: gone = "The call is over."
                    case 401: refresh = true
                    default: break
                    }
                    let trouble = "\(error.localizedDescription)\(status.map { " (HTTP \($0))" } ?? "")"
                    if trouble != lastTrouble {
                        lastTrouble = trouble
                        onTrouble(trouble)
                    }
                }
                socket.cancel(with: .goingAway, reason: nil)
            } catch CueAPIError.ended(let why) {
                gone = why
            } catch {
                // Offline, say: tried again below.
                if error.localizedDescription != lastTrouble {
                    lastTrouble = error.localizedDescription
                    onTrouble(lastTrouble)
                }
            }
            connected = false
            socket = nil
            audio.disconnect()
            guard live else { break }
            if let gone {
                live = false
                onGone(gone)
                break
            }
            if heard { attempt = 0 }
            try? await Task.sleep(for: .seconds(delays[min(attempt, delays.count - 1)]))
            attempt += 1
        }
    }

    private func handle(_ event: CallEvent, on socket: URLSessionWebSocketTask) {
        if event.type == "ready" {
            connected = true
            audio.connect(socket)
            // The settings go again, then what was asked while there was no socket.
            if !settings.isEmpty { write(settings) }
            let waiting = pending
            pending = []
            for command in waiting { write(command) }
            // `ready` says how far the call's events have got; it is not one of them, and the statuses sent after it on a first connection
            // carry older numbers than its own.
            onEvent(event)
            return
        } else if event.seq <= lastSeq {
            return  // replayed: seen already
        }
        lastSeq = max(lastSeq, event.seq)
        onEvent(event)
        if event.type == "ended" || (event.type == "error" && event.fatal == true) {
            live = false
            onGone(event.type == "ended" ? "The call has ended." : event.message ?? "The call stopped.")
        }
    }
}

/// Turns what the capture threads deliver into the socket's binary frames: one byte for the channel (0 me, 1 others) and 16-bit
/// little-endian PCM. The server's clock is the samples it gets, so a source that delivers nothing for a while (ScreenCaptureKit while the
/// Mac plays nothing) is filled with silence by the host clock, and so is the stretch a dropped socket lost, up to `maxGap`.
final class AudioSink: @unchecked Sendable {  // all state is touched under `lock`
    private struct Lane {
        /// Host time (seconds) the audio sent or waiting ends at.
        var end: TimeInterval = 0
        var pending: [Float] = []
    }

    private let lock = NSLock()
    private var socket: URLSessionWebSocketTask?
    private var lanes: [Channel: Lane] = [:]
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "cue.audio-sink")
    /// A frame is at least this many samples (100 ms).
    private let frame = Int(whisperSampleRate / 10)
    /// A gap bigger than this is not filled in.
    private let maxGap: TimeInterval = 20
    /// A source quieter than this long is silent, not late.
    private let lateness: TimeInterval = 0.4

    /// `samples` were captured from `time` (host seconds) on. Dropped while there is no socket.
    func push(_ samples: [Float], from channel: Channel, at time: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        guard socket != nil, !samples.isEmpty else { return }
        var lane = lanes[channel] ?? Lane(end: time)
        // Audio that comes later than the last one ended: the source was silent, or the socket was down.
        if time - lane.end > 0.25 { fill(&lane, seconds: min(time - lane.end, maxGap)) }
        lane.pending.append(contentsOf: samples)
        lane.end += Double(samples.count) / whisperSampleRate
        flush(&lane, channel)
        lanes[channel] = lane
    }

    func connect(_ socket: URLSessionWebSocketTask) {
        lock.lock()
        defer { lock.unlock() }
        self.socket = socket
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in self?.fillSilence() }
        timer.resume()
        self.timer = timer
    }

    /// The socket is gone (maybe for a moment): what waited for it is dropped.
    func disconnect() {
        lock.lock()
        defer { lock.unlock() }
        socket = nil
        for channel in lanes.keys { lanes[channel]?.pending = [] }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        socket = nil
        timer?.cancel()
        timer = nil
        lanes = [:]
    }

    /// Keeps the server's clock going for a source that has delivered nothing lately.
    private func fillSilence() {
        lock.lock()
        defer { lock.unlock() }
        guard socket != nil else { return }
        let now = hostSeconds()
        for channel in Array(lanes.keys) {
            guard var lane = lanes[channel], now - lane.end > lateness else { continue }
            fill(&lane, seconds: min(now - lane.end - 0.1, maxGap))
            flush(&lane, channel)
            lanes[channel] = lane
        }
    }

    private func fill(_ lane: inout Lane, seconds: TimeInterval) {
        guard seconds > 0 else { return }
        let count = Int(seconds * whisperSampleRate)
        lane.pending.append(contentsOf: repeatElement(0, count: count))
        lane.end += Double(count) / whisperSampleRate
    }

    private func flush(_ lane: inout Lane, _ channel: Channel) {
        guard let socket, lane.pending.count >= frame else { return }
        var data = Data(capacity: 1 + lane.pending.count * 2)
        data.append(channel == .me ? 0 : 1)
        for sample in lane.pending {
            withUnsafeBytes(of: Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian) { data.append(contentsOf: $0) }
        }
        lane.pending = []
        socket.send(.data(data)) { _ in }
    }
}

/// How loud a source is right now, smoothed, for the level meters.
final class LevelMeter: @unchecked Sendable {  // a Float written by one thread and read by the main one: stale at worst
    private(set) var level: Float = 0

    func add(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        let rms = (samples.reduce(0) { $0 + $1 * $1 } / Float(samples.count)).squareRoot()
        level = level * 0.7 + rms * 0.3
    }
}
