import AppKit
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

    private func setUpHotKeys() {
        HotKeys.register(keyCode: kVK_Return) { [weak self] in self?.state.answerNow() }
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
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(menuSettings), keyEquivalent: ",").target = self
        menu.addItem(withTitle: "Restart Claude", action: #selector(menuRestart), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Cue", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    @objc private func menuToggle() { toggleOverlay() }
    @objc private func menuAnswer() { state.answerNow() }
    @objc private func menuSettings() { showSettings() }
    @objc private func menuRestart() { state.restartClaude() }

    /// Testing aid: renders the overlay (and Settings, when open) to PNGs every 2 s.
    /// Offscreen rendering shows layout and text but not the glass, which the window server composites.
    private func startSnapshots(to path: String) {
        func write(_ view: NSView?, to path: String) {
            guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                write(self?.panel.contentView, to: path)
                if self?.settingsWindow?.isVisible == true {
                    write(self?.settingsWindow?.contentView, to: path.replacingOccurrences(of: ".png", with: "-settings.png"))
                }
            }
        }
    }
}

/// `Cue --inspect FILE…` prints what Cue reads from each file, including prepared answers.
if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "--inspect" {
    let lexicon = Lexicon.load(UserDefaults.standard.string(forKey: "language") ?? "en")
    for path in CommandLine.arguments.dropFirst(2) {
        let document = Materials.read(URL(fileURLWithPath: path), lexicon: lexicon)
        print("\(document.name): \(document.error ?? document.summary)")
        for item in document.prepared {
            print("  Q\(item.who.map { " (\($0))" } ?? ""): \(item.q.prefix(90))\n  A: \(item.a.prefix(90))")
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
