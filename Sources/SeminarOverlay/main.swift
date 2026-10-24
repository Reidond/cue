import AppKit
import Carbon
import SwiftUI

/// Floats above PowerPoint (also in full-screen slide show) without taking focus,
/// and is excluded from screen capture.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let state = AppState()
    private var panel: OverlayPanel!
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
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 620),
            styleMask: [.nonactivatingPanel, .titled, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        // Hidden from screen sharing and screenshots (SEMINAR_ALLOW_CAPTURE=1 shows it, for testing).
        panel.sharingType = ProcessInfo.processInfo.environment["SEMINAR_ALLOW_CAPTURE"] == "1" ? .readOnly : .none
        panel.minSize = NSSize(width: 380, height: 320)
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentView = NSHostingView(rootView: OverlayView(state: state))
        if !panel.setFrameUsingName("overlay"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - 580, y: visible.maxY - 640))
        }
        panel.setFrameAutosaveName("overlay")
        panel.orderFrontRegardless()

        setUpStatusItem()
        setUpHotKeys()
        state.start()
        if let path = ProcessInfo.processInfo.environment["SEMINAR_SNAPSHOT"] { startSnapshots(to: path) }
    }

    /// Testing aid: renders the panel to a PNG every 2 s (the window itself is hidden from screenshots).
    private func startSnapshots(to path: String) {
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let view = self?.panel.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        state.shutdown()
    }

    private func toggle() {
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    private func setUpHotKeys() {
        HotKeys.register(keyCode: kVK_Return) { [weak self] in self?.state.answerNow() }
        HotKeys.register(keyCode: kVK_ANSI_H) { [weak self] in self?.toggle() }
        HotKeys.register(keyCode: kVK_ANSI_A) { [weak self] in self?.state.autoAnswer.toggle() }
        HotKeys.register(keyCode: kVK_LeftArrow) { [weak self] in self?.state.step(-1) }
        HotKeys.register(keyCode: kVK_RightArrow) { [weak self] in self?.state.step(1) }
        HotKeys.register(keyCode: kVK_UpArrow) { [weak self] in
            guard let state = self?.state else { return }
            state.fontSize = min(state.fontSize + 1, 32)
        }
        HotKeys.register(keyCode: kVK_DownArrow) { [weak self] in
            guard let state = self?.state else { return }
            state.fontSize = max(state.fontSize - 1, 11)
        }
    }

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "graduationcap", accessibilityDescription: "Seminar Overlay")
        let menu = NSMenu()
        menu.addItem(withTitle: "Show / hide  ⌃⌥H", action: #selector(menuToggle), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Answer now  ⌃⌥⏎", action: #selector(menuAnswer), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Restart Claude", action: #selector(menuRestart), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    @objc private func menuToggle() { toggle() }
    @objc private func menuAnswer() { state.answerNow() }
    @objc private func menuRestart() { state.restartClaude() }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
