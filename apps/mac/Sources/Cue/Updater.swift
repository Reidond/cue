import AppKit
import CryptoKit
import Foundation

/// Keeps Cue up to date from its GitHub releases (`.github/workflows/release.yml` publishes one for every push to main). When Cue opens and
/// every 6 hours it reads the latest release; when that one is newer it downloads `Cue-VERSION.zip`, checks it against the size and SHA-256
/// the release gives, and the app in it (Cue's bundle identifier, the release's version, a valid code signature, a macOS this Mac has), and
/// puts it in place of this Cue.app. The running Cue goes on as it is: the new one opens the next time Cue starts, or now with Restart to Update.
///
/// Only a release build looks (build.sh stamps `CueUpdates`, the repository, when CUE_UPDATES is set), and only from a Cue.app. Under CUE_HOME
/// nothing is read from GitHub: CUE_UPDATE_URL is the latest release's address instead (a case's stand-in), and CUE_UPDATE_TICK the seconds between checks.
@MainActor
final class Updater: ObservableObject {
    enum Phase: Equatable {
        case idle
        case checking
        case downloading(String)
        /// In place of this Cue.app: it opens when Cue starts again.
        case installed(String)
        case failed(String)
    }

    @Published private(set) var phase = Phase.idle
    /// When the latest release was last read.
    @Published private(set) var checked: Date?
    /// This Cue's version.
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    /// The latest release's address (GitHub's API); nil when this Cue doesn't update itself.
    let feed: URL? = {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }
        if let url = ProcessInfo.processInfo.environment["CUE_UPDATE_URL"] { return URL(string: url) }
        guard !isSandboxed, let repository = Bundle.main.infoDictionary?["CueUpdates"] as? String else { return nil }
        return URL(string: "https://api.github.com/repos/\(repository)/releases/latest")
    }()

    private let log: SessionLog
    private let preferences: Preferences
    private let tick = ProcessInfo.processInfo.environment["CUE_UPDATE_TICK"].flatMap(TimeInterval.init) ?? 6 * 3600
    private var timer: Timer?
    /// Where a download is unpacked and checked, and the note of what was installed (`installed.json`) waits for the next start.
    private let folder = appSupport.appendingPathComponent("updates")
    private var marker: URL { folder.appendingPathComponent("installed.json") }

    init(log: SessionLog, preferences: Preferences) {
        self.log = log
        self.preferences = preferences
    }

    /// Says whether the last run installed this version, then looks for a newer one now and every `tick` (while automatic updates are on).
    func start() {
        if let data = try? Data(contentsOf: marker), let installed = try? JSONDecoder().decode([String: String].self, from: data),
           installed["to"] == version {
            log.write("✅ Cue was updated from \(installed["from"] ?? "an earlier version") to \(version)")
        }
        try? FileManager.default.removeItem(at: folder)
        guard feed != nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { _ in
            Task { @MainActor in if self.preferences.automaticUpdates { await self.check() } }
        }
        if preferences.automaticUpdates { Task { await check() } }
    }

    /// Reads the latest release, and installs it when it is newer than this Cue (Check for Updates, and each automatic look).
    func check() async {
        guard let feed else { return }
        switch phase {
        case .checking, .downloading, .installed: return
        case .idle, .failed: break
        }
        phase = .checking
        do {
            let release = try await Self.latest(from: feed, version: version)
            checked = Date()
            guard Self.isNewer(release.version, than: version) else {
                log.write("✅ Cue is up to date (\(version))")
                phase = .idle
                return
            }
            let app = Bundle.main.bundleURL
            if app.path.contains("/AppTranslocation/") {
                throw ServiceError("Cue is running from a copy macOS made of it: move Cue.app to Applications and open it from there")
            }
            guard FileManager.default.isWritableFile(atPath: app.deletingLastPathComponent().path) else {
                throw ServiceError("you can't change \(app.deletingLastPathComponent().path) — download Cue \(release.version) from GitHub")
            }
            log.write("🔄 Downloading Cue \(release.version) (this is \(version))…")
            phase = .downloading(release.version)
            let folder = self.folder, current = self.version, next = release.version
            let zip = try await Self.download(release, into: folder)
            try await Task.detached { try Self.install(zip, version: next, over: app, from: current, folder: folder) }.value
            phase = .installed(release.version)
            log.write("✅ Cue \(release.version) is installed: it opens the next time Cue starts")
        } catch {
            phase = .failed(error.localizedDescription)
            log.write("⚠︎ Couldn't update Cue: \(error.localizedDescription)")
        }
    }

    /// Restart to Update: Cue quits and the Cue.app now in its place opens, as the person would open it. Under CUE_HOME it is the executable
    /// itself, with this environment but CUE_CONTROL (whose lines were for this Cue), so the case's sandbox stays its sandbox.
    func restart() {
        guard case .installed(let next) = phase else { return }
        log.write("🔄 Restarting Cue to finish the update to \(next)")
        let app = Bundle.main.bundleURL
        var environment = ProcessInfo.processInfo.environment
        let command: [String]
        if isSandboxed {
            command = [app.appendingPathComponent("Contents/MacOS/Cue").path] + CommandLine.arguments.dropFirst()
            environment["CUE_CONTROL"] = nil
        } else {
            command = ["/usr/bin/open", app.path]
        }
        // A shell that waits for this Cue to be gone, then opens the new one.
        let waiter = Process()
        waiter.executableURL = URL(fileURLWithPath: "/bin/sh")
        waiter.arguments = ["-c", "while /bin/kill -0 \(getpid()) 2>/dev/null; do /bin/sleep 0.2; done; exec \"$@\"", "cue-restart"] + command
        waiter.environment = environment
        do {
            try waiter.run()
        } catch {
            log.write("⚠︎ Couldn't restart Cue: \(error.localizedDescription)")
            return
        }
        NSApp.terminate(nil)
    }

    /// Reading the release or downloading it: Check Now waits.
    var busy: Bool {
        switch phase {
        case .checking, .downloading: true
        case .idle, .installed, .failed: false
        }
    }

    /// A line for Settings: where updating is.
    var status: String {
        switch phase {
        case .idle: checked.map { "Cue is up to date. Checked at \($0.formatted(date: .omitted, time: .shortened))." } ?? "Cue looks for updates when it opens."
        case .checking: "Checking for updates…"
        case .downloading(let next): "Downloading Cue \(next)…"
        case .installed(let next): "Cue \(next) is installed. It opens the next time Cue starts."
        case .failed(let why): "Couldn't update Cue: \(why)"
        }
    }

    // MARK: - The release

    /// What GitHub says about a release (`GET /repos/OWNER/NAME/releases/latest`): its tag and its files.
    private struct Release: Decodable {
        struct Asset: Decodable {
            let name: String
            let size: Int
            /// "sha256:HEX".
            let digest: String?
            let browserDownloadUrl: URL
        }
        let tagName: String
        let assets: [Asset]

        /// "2.0.18", from the tag "v2.0.18".
        var version: String { tagName.hasPrefix("v") ? String(tagName.dropFirst()) : tagName }
    }

    private nonisolated static func latest(from feed: URL, version: String) async throws -> Release {
        var request = URLRequest(url: feed, timeoutInterval: 30)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("Cue/\(version) (mac)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ServiceError("GitHub answered \(status) for the latest release") }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(Release.self, from: data)
        } catch {
            throw ServiceError("GitHub's answer about the latest release couldn't be read")
        }
    }

    /// Whether `candidate` is a later version than `current` ("2.0.10" is later than "2.0.9", and "2.0.1" than "2.0").
    nonisolated static func isNewer(_ candidate: String, than current: String) -> Bool {
        let new = candidate.split(separator: ".").map { Int($0) ?? 0 }, old = current.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(new.count, old.count) {
            let a = index < new.count ? new[index] : 0, b = index < old.count ? old[index] : 0
            if a != b { return a > b }
        }
        return false
    }

    /// The release's `Cue-VERSION.zip`, downloaded into `folder` and checked against the size and SHA-256 the release gives.
    private nonisolated static func download(_ release: Release, into folder: URL) async throws -> URL {
        let name = "Cue-\(release.version).zip"
        guard let asset = release.assets.first(where: { $0.name == name }) else { throw ServiceError("the release has no \(name)") }
        guard let digest = asset.digest, digest.hasPrefix("sha256:") else { throw ServiceError("the release doesn't give \(name)'s checksum") }
        try? FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let (downloaded, response) = try await URLSession.shared.download(for: URLRequest(url: asset.browserDownloadUrl, timeoutInterval: 120))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ServiceError("GitHub answered \(status) for \(name)") }
        let zip = folder.appendingPathComponent(name)
        try FileManager.default.moveItem(at: downloaded, to: zip)
        let data = try Data(contentsOf: zip, options: .mappedIfSafe)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard data.count == asset.size, "sha256:\(hash)" == digest.lowercased() else { throw ServiceError("the download of \(name) doesn't match the release") }
        return zip
    }

    /// Unpacks the release, checks the app in it and puts it in place of `app` (one swap: the old bundle is gone, the new one is there).
    private nonisolated static func install(_ zip: URL, version: String, over app: URL, from current: String, folder: URL) throws {
        let unpacked = folder.appendingPathComponent("unpacked")
        try run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])
        let new = unpacked.appendingPathComponent("Cue.app")
        guard let plist = try? Data(contentsOf: new.appendingPathComponent("Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any]
        else { throw ServiceError("the download has no Cue.app") }
        guard info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else { throw ServiceError("the app in the download isn't Cue") }
        guard info["CFBundleShortVersionString"] as? String == version else { throw ServiceError("the app in the download isn't Cue \(version)") }
        if let minimum = info["LSMinimumSystemVersion"] as? String {
            let parts = minimum.split(separator: ".").map { Int($0) ?? 0 } + [0, 0]
            if !ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: parts[0], minorVersion: parts[1], patchVersion: parts[2])) {
                throw ServiceError("Cue \(version) needs macOS \(minimum)")
            }
        }
        do {
            try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", new.path])
        } catch {
            throw ServiceError("Cue \(version)'s code signature isn't valid")
        }
        _ = try FileManager.default.replaceItemAt(app, withItemAt: new)
        let note = try JSONEncoder().encode(["from": current, "to": version])
        try? FileManager.default.removeItem(at: zip)
        try? FileManager.default.removeItem(at: unpacked)
        try note.write(to: folder.appendingPathComponent("installed.json"))
    }

    /// Runs a tool and waits for it; one that fails throws what it said.
    private nonisolated static func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let errors = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        try process.run()
        let said = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw ServiceError(String(decoding: said, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
