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
    private let preferences = Preferences()
    private lazy var state = AppState(preferences: preferences)
    private let dashboard = DashboardModel()
    private var panel: OverlayPanel!
    private var settingsWindow: NSWindow?
    private var dashboardWindow: NSWindow?
    private var recordingObserver: Any?
    private var statusItem: NSStatusItem!
    private var signalSources: [DispatchSourceSignal] = []
    private var controlLinesDone = 0

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
        let hosting = NSHostingView(rootView: OverlayView(state: state, preferences: preferences))
        hosting.sizingOptions = []
        panel.contentView = hosting
        if !panel.setFrameUsingName("overlay"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - 540, y: visible.maxY - 660))
        }
        panel.setFrameAutosaveName("overlay")

        state.openSettings = { [weak self] in self?.showSettings() }
        state.openDashboard = { [weak self] in self?.showDashboard() }
        state.openRecordings = { [weak self] id in self?.showDashboard(note: id) }
        state.showOverlay = { [weak self] in self?.panel.orderFrontRegardless() }
        setUpMainMenu()
        setUpStatusItem()
        setUpHotKeys()
        state.start()
        // The dashboard opens first; Start Cue shows the overlay. A rehearsal is a run-through
        // of the talk, so it shows the overlay straight away.
        let environment = ProcessInfo.processInfo.environment
        showDashboard()
        if environment["CUE_REHEARSE_PARTICIPANT"] != nil { panel.orderFrontRegardless() }
        if environment["CUE_SHOW_SETTINGS"] == "1" { showSettings() }
        if let path = environment["CUE_SNAPSHOT"] { startSnapshots(to: path) }
        if let path = environment["CUE_CONTROL"] { startControl(from: path) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        state.shutdown()
    }

    /// Clicking the Dock icon with no window open brings the dashboard back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showDashboard() }
        return true
    }

    private func toggleOverlay() {
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
                styleMask: [.titled, .closable],
                backing: .buffered, defer: false
            )
            window.title = "Settings"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(preferences: preferences))
            window.center()
            window.setFrameAutosaveName("settings")
            settingsWindow = window
        }
        NSApp.activate()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    /// The dashboard, optionally opened on a note (e.g. the one just recorded).
    func showDashboard(note id: String? = nil) {
        state.projects.reload()  // pick up folders added or changed in Finder
        state.recordings.reload()
        if let file = id.flatMap(state.recordings.file) { dashboard.show(file) }
        if dashboardWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1060, height: 700),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false
            )
            window.title = "Cue"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentView = NSHostingView(rootView: DashboardView(state: state, projects: state.projects, model: dashboard))
            window.center()
            window.setFrameAutosaveName("dashboard")
            dashboardWindow = window
        }
        NSApp.activate()
        dashboardWindow?.makeKeyAndOrderFront(nil)
    }

    /// A note's audio stops with the dashboard.
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === dashboardWindow { state.player.load(nil, note: nil) }
    }

    /// Start Cue (⌘↩) for the project open in the dashboard, else the current one.
    private func startCue() {
        if let project = state.projects.project(dashboard.selectedProject) ?? state.activeProject {
            state.startCue(project)
        } else {
            showDashboard()
            dashboard.creatingProject = true
        }
    }

    private func setUpHotKeys() {
        HotKeys.register(keyCode: kVK_Return) { [weak self] in self?.state.answerNow() }
        HotKeys.register(keyCode: kVK_ANSI_R) { [weak self] in self?.state.toggleRecording() }
        HotKeys.register(keyCode: kVK_ANSI_H) { [weak self] in self?.toggleOverlay() }
        HotKeys.register(keyCode: kVK_ANSI_A) { [weak self] in self?.preferences.autoAnswer.toggle() }
        HotKeys.register(keyCode: kVK_LeftArrow) { [weak self] in self?.state.step(-1) }
        HotKeys.register(keyCode: kVK_RightArrow) { [weak self] in self?.state.step(1) }
        HotKeys.register(keyCode: kVK_UpArrow) { [weak self] in
            guard let preferences = self?.preferences else { return }
            preferences.textSize = min(preferences.textSize + 1, 28)
        }
        HotKeys.register(keyCode: kVK_DownArrow) { [weak self] in
            guard let preferences = self?.preferences else { return }
            preferences.textSize = max(preferences.textSize - 1, 11)
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
        menu.addItem(withTitle: "Dashboard…", action: #selector(menuDashboard), keyEquivalent: "").target = self
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
    @objc private func menuDashboard() { showDashboard() }
    @objc private func menuNewProject() {
        showDashboard()
        dashboard.creatingProject = true
    }
    @objc private func menuStartCue() { startCue() }

    /// The app menu, File (New Project, Start Cue), Edit for text fields, and Window.
    private func setUpMainMenu() {
        let main = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let menu = NSMenu(title: title)
            main.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
            return menu
        }

        let app = submenu("Cue")
        app.addItem(withTitle: "About Cue", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(menuSettings), keyEquivalent: ",").target = self
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Cue", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Cue", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = submenu("File")
        file.addItem(withTitle: "New Project…", action: #selector(menuNewProject), keyEquivalent: "n").target = self
        file.addItem(withTitle: "Start Cue", action: #selector(menuStartCue), keyEquivalent: "\r").target = self
        file.addItem(.separator())
        file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = submenu("Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let window = submenu("Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Dashboard", action: #selector(menuDashboard), keyEquivalent: "0").target = self
        window.addItem(withTitle: "Show or Hide Cue  ⌃⌥H", action: #selector(menuToggle), keyEquivalent: "").target = self
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window

        NSApp.mainMenu = main
    }

    /// Testing aid: renders the overlay (and the dashboard and Settings, when open) to PNGs every 2 s.
    /// Offscreen rendering shows layout and text but not the glass, which the window server composites.
    private func startSnapshots(to path: String) {
        // Glass and scroll-edge effects cache as white: in the light appearance text stays dark and readable on them.
        NSApp.appearance = NSAppearance(named: .aqua)
        /// A window with its title bar, on an opaque background (the window server draws the real one).
        func write(_ window: NSWindow?, to path: String) {
            guard let root = window?.contentView?.superview,
                  let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(root.bounds.width * 2), pixelsHigh: Int(root.bounds.height * 2),
                                                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
            else { return }
            canvas.size = root.bounds.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: canvas)
            func draw(_ view: NSView, background: Bool) {
                var rect = view.convert(view.bounds, to: root)
                if root.isFlipped { rect.origin.y = root.bounds.height - rect.maxY }
                if background {
                    view.effectiveAppearance.performAsCurrentDrawingAppearance {
                        NSColor.windowBackgroundColor.setFill()
                        rect.fill()
                    }
                }
                guard !rect.isEmpty, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
            }
            draw(root, background: true)
            // Glass (the sidebar, toolbar items) caches empty: draw what's inside it on top, and
            // the sidebar's rows one by one, which the list doesn't draw into the cache either.
            func glass(in view: NSView) {
                for subview in view.subviews where !subview.isHidden {
                    if let effect = subview as? NSGlassEffectView, let content = effect.contentView {
                        draw(content, background: true)
                    }
                    if let table = subview as? NSTableView {
                        for row in 0..<table.numberOfRows {
                            if let rowView = table.rowView(atRow: row, makeIfNecessary: false) { draw(rowView, background: false) }
                        }
                    }
                    glass(in: subview)
                }
            }
            glass(in: root)
            NSGraphicsContext.restoreGraphicsState()
            try? canvas.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        // The overlay is all glass, which caches as a blank window: render its view instead.
        func writeOverlay(_ delegate: AppDelegate, to path: String) {
            let size = delegate.panel.frame.size
            let renderer = ImageRenderer(content: OverlayView(state: delegate.state, preferences: delegate.preferences)
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
                    write(self?.settingsWindow, to: path.replacingOccurrences(of: ".png", with: "-settings.png"))
                }
                if self?.dashboardWindow?.isVisible == true {
                    write(self?.dashboardWindow, to: path.replacingOccurrences(of: ".png", with: "-dashboard.png"))
                }
            }
        }
    }

    /// Testing aid: CUE_CONTROL=FILE. Each line appended to the file does what a click
    /// would: `new NAME` (New Project), `add PATH` (a file dropped on the open project's
    /// materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu),
    /// `page home|upcoming|NAME|NAME/answers|NAME/notes` (a dashboard page), `ask TEXT`
    /// (the Ask field) and `timestamp HH:MM:SS` (a timestamp in the open note's transcript).
    private func startControl(from path: String) {
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
                let lines = text.split(separator: "\n").map(String.init)
                for line in lines.dropFirst(self.controlLinesDone) { self.control(line) }
                self.controlLinesDone = max(self.controlLinesDone, lines.count)
            }
        }
    }

    private func control(_ line: String) {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let command = parts.first ?? "", argument = parts.count > 1 ? parts[1] : ""
        switch command {
        case "new":
            showDashboard()
            if let project = try? state.projects.create(named: argument) { dashboard.open(project) }
        case "add":
            if let project = state.projects.project(dashboard.selectedProject) ?? state.activeProject {
                state.projects.addMaterials([URL(fileURLWithPath: argument)], to: project)
            }
        case "project":
            if let project = state.projects.project(named: argument) { state.activate(project) }
        case "start":
            if let project = state.projects.project(named: argument) { state.startCue(project) }
        case "ask":
            state.ask(argument, force: true)
        case "timestamp":
            if let seconds = MarkdownView.seconds(argument) { state.player.play(from: seconds) }
        case "page":
            showDashboard()
            switch argument {
            case "home": dashboard.selection = .home
            case "upcoming": dashboard.selection = .upcoming
            default:
                var name = argument, tab = ProjectTab.overview
                if let slash = argument.lastIndex(of: "/") {
                    let suffix = argument[argument.index(after: slash)...]
                    if let match = [("overview", ProjectTab.overview), ("answers", .answers), ("notes", .notes)].first(where: { $0.0 == suffix }) {
                        name = String(argument[..<slash])
                        tab = match.1
                    }
                }
                if let project = state.projects.project(named: name) {
                    dashboard.selection = .project(project.id)
                    dashboard.tab = tab
                }
            }
        default:
            break
        }
    }
}

/// `Cue --inspect FILE…` prints what Cue reads from each file, including prepared answers,
/// in the language of the last project used.
if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "--inspect" {
    let language = MainActor.assumeIsolated {
        let preferences = Preferences()
        return ProjectStore(preferences: preferences).project(preferences.activeProject)?.language
    }
    let lexicon = Lexicon.load(language ?? appDefaults.string(forKey: "language") ?? "en")
    for path in CommandLine.arguments.dropFirst(2) {
        let document = Materials.read(URL(fileURLWithPath: path), lexicon: lexicon)
        print("\(document.name): \(document.error ?? document.summary)")
        for item in document.prepared {
            print("  Q\(item.who.map { " (\($0))" } ?? ""): \(item.q.prefix(90))\n  A: \(item.a.prefix(90))")
        }
    }
    exit(0)
}

/// `Cue --render NOTES.md OUT.png` renders Markdown the way the dashboard shows notes.
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
    app.setActivationPolicy(.regular)
    app.run()
}
