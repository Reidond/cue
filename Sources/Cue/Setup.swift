import AVFoundation
import CoreGraphics
import Foundation

/// Downloads the Whisper model into Application Support with progress.
@MainActor
final class ModelDownloader: NSObject, ObservableObject {
    static let source = URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin")!

    /// Fraction done while downloading, nil when idle.
    @Published private(set) var progress: Double?
    @Published private(set) var error: String?
    var onFinished: (() -> Void)?

    private var session: URLSession?

    func start() {
        guard progress == nil else { return }
        error = nil
        progress = 0
        let session = URLSession(configuration: .default, delegate: Delegate(owner: self), delegateQueue: nil)
        self.session = session
        session.downloadTask(with: Self.source).resume()
    }

    func cancel() {
        session?.invalidateAndCancel()
        session = nil
        progress = nil
    }

    fileprivate func update(_ fraction: Double) { progress = fraction }

    fileprivate func finish(error message: String?) {
        session?.finishTasksAndInvalidate()
        session = nil
        progress = nil
        error = message
        if message == nil { onFinished?() }
    }

    private final class Delegate: NSObject, URLSessionDownloadDelegate {
        weak let owner: ModelDownloader?
        init(owner: ModelDownloader) { self.owner = owner }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            guard totalBytesExpectedToWrite > 0 else { return }
            let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
            Task { @MainActor in self.owner?.update(fraction) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            // The temporary file is deleted when this method returns, so move it now.
            var message: String?
            let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
            let size = (try? FileManager.default.attributesOfItem(atPath: location.path)[.size] as? Int) ?? 0
            if status != 200 || size < 100_000_000 {
                message = "Download failed (HTTP \(status))"
            } else {
                let target = URL(fileURLWithPath: WhisperService.modelPath)
                do {
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? FileManager.default.removeItem(at: target)
                    try FileManager.default.moveItem(at: location, to: target)
                } catch {
                    message = error.localizedDescription
                }
            }
            Task { @MainActor in self.owner?.finish(error: message) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let error, (error as NSError).code != NSURLErrorCancelled else { return }
            Task { @MainActor in self.owner?.finish(error: error.localizedDescription) }
        }
    }
}

/// What Cue needs from the Mac, checked on demand for the Settings window.
struct SetupCheck: Identifiable {
    enum Item: String { case whisper, model, claude, microphone, screenAudio }

    let item: Item
    let ok: Bool
    var id: Item { item }

    var title: String {
        switch item {
        case .whisper: "Speech recognizer"
        case .model: "Speech model"
        case .claude: "Claude Code"
        case .microphone: "Microphone access"
        case .screenAudio: "Call audio access"
        }
    }

    var detail: String {
        switch (item, ok) {
        case (.whisper, true): "whisper.cpp is installed"
        case (.whisper, false): "Install with Homebrew: brew install whisper-cpp"
        case (.model, true): "Whisper large-v3-turbo, runs on this Mac"
        case (.model, false): "1.6 GB download, stays on this Mac"
        case (.claude, true): "Answers use your Claude Code login"
        case (.claude, false): "Install Claude Code and sign in once in Terminal"
        case (.microphone, true): "Hears your side of the conversation"
        case (.microphone, false): "Allow in System Settings › Privacy & Security › Microphone"
        case (.screenAudio, true): "Hears the other people on the call"
        case (.screenAudio, false): "Allow in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen Cue"
        }
    }

    static func all() -> [SetupCheck] {
        [
            SetupCheck(item: .whisper, ok: WhisperService.serverBinary != nil),
            SetupCheck(item: .model, ok: WhisperService.modelInstalled),
            SetupCheck(item: .claude, ok: ClaudeService.findBinary() != nil),
            SetupCheck(item: .microphone, ok: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized),
            SetupCheck(item: .screenAudio, ok: CGPreflightScreenCaptureAccess()),
        ]
    }

    var settingsURL: URL? {
        switch item {
        case .microphone: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        case .screenAudio: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        default: nil
        }
    }
}
