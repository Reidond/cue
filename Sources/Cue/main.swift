import AppKit
import Combine
import Carbon
import SwiftUI

/// Floats above full-screen slides without taking focus, and is excluded from
/// screen capture. Borderless and transparent: the glass elements are the window.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let profile = Profile()
    private lazy var state = AppState(profile: profile)
    private var panel: OverlayPanel!
    private var settingsWindow: NSWindow?
    private var recordingsWindow: NSWindow?
    private var recordingSelection = RecordingSelection()
    private var recordingObserver: Any?
    private var statusItem: NSStatusItem!
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)  // writing to a Claude process that just died must not kill the app
        // Quit cleanly on Ctrl-C / kill so whisper-server doesn't linger.
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }

        panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered, defer: false
        )
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false  // each glass element casts its own
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        // Hidden from screen sharing and screenshots (CUE_ALLOW_CAPTURE=1 shows it, for testing).
        panel.sharingType = ProcessInfo.processInfo.environment["CUE_ALLOW_CAPTURE"] == "1" ? .readOnly : .none
        panel.minSize = NSSize(width: 400, height: 360)
        let hosting = NSHostingView(rootView: OverlayView(state: state, profile: profile))
        hosting.sizingOptions = []
        panel.contentView = hosting
        if !panel.setFrameUsingName("overlay"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - 540, y: visible.maxY - 660))
        }
        panel.setFrameAutosaveName("overlay")
        panel.orderFrontRegardless()

        state.openSettings = { [weak self] in self?.showSettings() }
        state.openRecordings = { [weak self] id in self?.showRecordings(selecting: id) }
        setUpStatusItem()
        setUpHotKeys()
        state.start()
        if profile.materials.isEmpty || ProcessInfo.processInfo.environment["CUE_SHOW_SETTINGS"] == "1" { showSettings() }
        if let path = ProcessInfo.processInfo.environment["CUE_SNAPSHOT"] { startSnapshots(to: path) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        state.shutdown()
    }

    private func toggleOverlay() {
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 720),
                styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.title = "Cue Settings"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(state: state, profile: profile, downloader: state.downloader))
            window.center()
            window.setFrameAutosaveName("settings")
            settingsWindow = window
        }
        NSApp.activate()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    func showRecordings(selecting id: String? = nil) {
        if let id { recordingSelection.id = id }
        if recordingsWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 980, height: 680),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.title = "Recordings"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: RecordingsWindowContent(state: state, selection: recordingSelection))
            window.center()
            window.setFrameAutosaveName("recordings")
            recordingsWindow = window
        }
        state.recordings.reload()
        NSApp.activate()
        recordingsWindow?.makeKeyAndOrderFront(nil)
    }

    private func setUpHotKeys() {
        HotKeys.register(keyCode: kVK_Return) { [weak self] in self?.state.answerNow() }
        HotKeys.register(keyCode: kVK_ANSI_R) { [weak self] in self?.state.toggleRecording() }
        HotKeys.register(keyCode: kVK_ANSI_H) { [weak self] in self?.toggleOverlay() }
        HotKeys.register(keyCode: kVK_ANSI_A) { [weak self] in self?.profile.autoAnswer.toggle() }
        HotKeys.register(keyCode: kVK_LeftArrow) { [weak self] in self?.state.step(-1) }
        HotKeys.register(keyCode: kVK_RightArrow) { [weak self] in self?.state.step(1) }
        HotKeys.register(keyCode: kVK_UpArrow) { [weak self] in
            guard let profile = self?.profile else { return }
            profile.textSize = min(profile.textSize + 1, 28)
        }
        HotKeys.register(keyCode: kVK_DownArrow) { [weak self] in
            guard let profile = self?.profile else { return }
            profile.textSize = max(profile.textSize - 1, 11)
        }
    }

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "text.bubble", accessibilityDescription: "Cue")
        let menu = NSMenu()
        menu.addItem(withTitle: "Show or Hide Cue  ⌃⌥H", action: #selector(menuToggle), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Answer Now  ⌃⌥⏎", action: #selector(menuAnswer), keyEquivalent: "").target = self
        let record = menu.addItem(withTitle: "Start Recording  ⌃⌥R", action: #selector(menuRecord), keyEquivalent: "")
        record.target = self
        menu.addItem(withTitle: "Recordings…", action: #selector(menuRecordings), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(menuSettings), keyEquivalent: ",").target = self
        menu.addItem(withTitle: "Restart Claude", action: #selector(menuRestart), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Cue", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu

        // The menu bar icon turns red while recording, even with the overlay hidden.
        recordingObserver = state.recorder.$startedAt.sink { [weak self] started in
            self?.statusItem.button?.contentTintColor = started == nil ? nil : .systemRed
            record.title = started == nil ? "Start Recording  ⌃⌥R" : "Stop Recording  ⌃⌥R"
        }
    }

    @objc private func menuToggle() { toggleOverlay() }
    @objc private func menuAnswer() { state.answerNow() }
    @objc private func menuSettings() { showSettings() }
    @objc private func menuRestart() { state.restartClaude() }
    @objc private func menuRecord() { state.toggleRecording() }
    @objc private func menuRecordings() { showRecordings() }

    /// Testing aid: renders the overlay (and Settings, when open) to PNGs every 2 s.
    /// Offscreen rendering shows layout and text but not the glass, which the window server composites.
    private func startSnapshots(to path: String) {
        func write(_ view: NSView?, to path: String) {
            guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        // The overlay is all glass, which caches as a blank window: render its view instead.
        func writeOverlay(_ delegate: AppDelegate, to path: String) {
            let size = delegate.panel.frame.size
            let renderer = ImageRenderer(content: OverlayView(state: delegate.state, profile: delegate.profile)
                .frame(width: size.width, height: size.height))
            renderer.scale = 2
            if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
        }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                if let self { writeOverlay(self, to: path) }
                if self?.settingsWindow?.isVisible == true {
                    write(self?.settingsWindow?.contentView, to: path.replacingOccurrences(of: ".png", with: "-settings.png"))
                }
                if self?.recordingsWindow?.isVisible == true {
                    write(self?.recordingsWindow?.contentView, to: path.replacingOccurrences(of: ".png", with: "-recordings.png"))
                }
            }
        }
    }
}

/// `Cue --inspect FILE…` prints what Cue reads from each file, including prepared answers.
if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "--inspect" {
    let lexicon = Lexicon.load(appDefaults.string(forKey: "language") ?? "en")
    for path in CommandLine.arguments.dropFirst(2) {
        let document = Materials.read(URL(fileURLWithPath: path), lexicon: lexicon)
        print("\(document.name): \(document.error ?? document.summary)")
        for item in document.prepared {
            print("  Q\(item.who.map { " (\($0))" } ?? ""): \(item.q.prefix(90))\n  A: \(item.a.prefix(90))")
        }
    }
    exit(0)
}

/// Lets the app pick which recording the library shows (e.g. the one just saved).
@MainActor
final class RecordingSelection: ObservableObject {
    @Published var id: String?
}

private struct RecordingsWindowContent: View {
    let state: AppState
    @ObservedObject var selection: RecordingSelection

    var body: some View {
        RecordingsView(store: state.recordings, state: state, selection: $selection.id)
    }
}

/// `Cue --render NOTES.md OUT.png` renders Markdown the way the Recordings window does.
if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--render" {
    MainActor.assumeIsolated {
        let markdown = (try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)) ?? ""
        let view = MarkdownView(markdown: markdown).padding(32).frame(width: 760).background(.white)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
        }
    }
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
