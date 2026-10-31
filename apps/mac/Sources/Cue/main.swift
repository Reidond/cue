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

extension NSAlert {
    /// Shows the alert and writes it to the session log (`⚠︎ …`); under CUE_BACKGROUND only there,
    /// as a modal alert would come to the front and hold up a test run until someone answers it.
    func show(logging log: SessionLog) {
        log.write("⚠︎ \(messageText)" + (informativeText.isEmpty ? "" : ": \(informativeText)"))
        guard ProcessInfo.processInfo.environment["CUE_BACKGROUND"] != "1" else { return }
        runModal()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let preferences = Preferences()
    private lazy var state = AppState(preferences: preferences)
    private let dashboard = DashboardModel()
    private var panel: OverlayPanel!
    private var settingsWindow: NSWindow?
    private var settingsTabs: NSTabViewController?
    private var dashboardWindow: NSWindow?
    private var recordingObserver: Any?
    private var cueObserver: Any?
    private var statusItem: NSStatusItem!
    private var signalSources: [DispatchSourceSignal] = []
    private var controlLinesDone = 0
    /// Testing aid: CUE_BACKGROUND=1 keeps a test run out of the way of whoever is using the Mac.
    /// Cue never comes to the front or takes focus, and has no Dock icon, menu bar icon or hot keys;
    /// its windows stay behind every other one (see `keepBehind`).
    private let background = ProcessInfo.processInfo.environment["CUE_BACKGROUND"] == "1"
    /// Under CUE_BACKGROUND: App Nap would slow the timers of an app whose windows are all covered.
    private var activity: NSObjectProtocol?

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
        let environment = ProcessInfo.processInfo.environment
        // Testing aid: CUE_APPEARANCE=light|dark instead of the system appearance.
        if let look = environment["CUE_APPEARANCE"] {
            NSApp.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
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
        // Hidden from screen sharing and screenshots (CUE_ALLOW_CAPTURE=1 shows it, and so do snapshots, for testing).
        panel.sharingType = environment["CUE_ALLOW_CAPTURE"] == "1" || environment["CUE_SNAPSHOT"] != nil ? .readOnly : .none
        panel.minSize = NSSize(width: 400, height: 360)
        let hosting = NSHostingView(rootView: OverlayView(state: state, preferences: preferences))
        hosting.sizingOptions = []
        panel.contentView = hosting
        if isSandboxed || !panel.setFrameUsingName("overlay"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - 540, y: visible.maxY - 660))
        }
        if !isSandboxed { panel.setFrameAutosaveName("overlay") }
        if background {
            keepBehind(panel)
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "CUE_BACKGROUND")
        }

        state.openSettings = { [weak self] in self?.showSettings() }
        state.openProviders = { [weak self] in self?.showSettings(.providers) }
        state.openDashboard = { [weak self] in self?.showDashboard() }
        state.openRecordings = { [weak self] id in self?.showDashboard(note: id) }
        state.showOverlay = { [weak self] in self?.panel.orderFrontRegardless() }
        state.hideOverlay = { [weak self] in self?.panel.orderOut(nil) }
        setUpMainMenu()
        if !background {
            setUpStatusItem()
            setUpHotKeys()
        }
        state.start()
        // The dashboard opens first; Start Cue shows the overlay. A rehearsal is a run-through
        // of the talk, so it shows the overlay straight away.
        showDashboard()
        if environment["CUE_REHEARSE_PARTICIPANT"] != nil { state.startListeningOnceSignedIn() }
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

    /// ⌃⌥H: hides or shows the overlay while Cue runs (it keeps listening); starts Cue when it doesn't.
    private func toggleOverlay() {
        if !state.cueRunning { state.startListening() } else if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    /// The Settings window, with a toolbar tab per pane; `tab` picks one, otherwise the last one shown stays.
    func showSettings(_ tab: SettingsTab? = nil) {
        if settingsWindow == nil {
            let tabs = NSTabViewController()
            tabs.tabStyle = .toolbar
            for pane in SettingsTab.allCases {
                let content: AnyView = switch pane {
                case .general: AnyView(GeneralSettings(preferences: preferences))
                case .account: AnyView(AccountSettings(api: state.api))
                case .providers: AnyView(ProviderSettings(preferences: preferences, state: state))
                case .calendar: AnyView(CalendarSettings(preferences: preferences, calendar: state.calendar))
                }
                let hosting = NSHostingController(rootView: content.frame(width: pane.size.width, height: pane.size.height))
                hosting.title = pane.title
                hosting.preferredContentSize = pane.size
                let item = NSTabViewItem(viewController: hosting)
                item.label = pane.title
                item.image = NSImage(systemSymbolName: pane.symbol, accessibilityDescription: pane.title)
                tabs.addTabViewItem(item)
            }
            let window = NSWindow(contentViewController: tabs)
            window.styleMask = [.titled, .closable]
            window.toolbarStyle = .preference
            window.isReleasedWhenClosed = false
            window.setContentSize(SettingsTab.general.size)
            window.center()
            if !isSandboxed { window.setFrameAutosaveName("settings") }
            if background { keepBehind(window) }
            settingsWindow = window
            settingsTabs = tabs
        }
        if let tab, let index = SettingsTab.allCases.firstIndex(of: tab) { settingsTabs?.selectedTabViewItemIndex = index }
        present(settingsWindow)
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
            // The toolbar floats over the page's own background rather than a band of its own
            // (the pages' scroll views keep their edge effect under it).
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentView = NSHostingView(rootView: DashboardView(state: state, projects: state.projects, model: dashboard))
            window.center()
            if !isSandboxed { window.setFrameAutosaveName("dashboard") }
            if background { keepBehind(window) }
            dashboardWindow = window
        }
        present(dashboardWindow)
    }

    /// Brings Cue to the front with the window; under CUE_BACKGROUND only orders the window in.
    private func present(_ window: NSWindow?) {
        if background {
            window?.orderFrontRegardless()
        } else {
            NSApp.activate()
            window?.makeKeyAndOrderFront(nil)
        }
    }

    /// Under CUE_BACKGROUND: the window sits just above the desktop picture, under the desktop's
    /// icons and every app's windows, in every Space — out of sight, yet on screen for snapshots.
    private func keepBehind(_ window: NSWindow) {
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }

    /// A note's audio stops with the dashboard.
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === dashboardWindow { state.player.load(nil, note: nil) }
    }

    /// ⌘↩: Stop Cue while it runs for the project open in the dashboard (or with none open);
    /// otherwise Start Cue for that project, else the current one.
    private func startCue() {
        let open = state.projects.project(dashboard.selectedProject)
        if state.cueRunning, open == nil || open?.id == state.activeProject?.id {
            state.stopCue()
        } else if let project = open ?? state.activeProject {
            state.startCue(project)
        } else {
            showDashboard()
            dashboard.creatingProject = true
        }
    }

    private func setUpHotKeys() {
        HotKeys.register(keyCode: kVK_Return) { [weak self] in self?.state.answerNow() }
        HotKeys.register(keyCode: kVK_ANSI_R) { [weak self] in self?.state.toggleRecording(.hotKey) }
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
    @objc private func menuRecord() { state.toggleRecording(.menuBar) }
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
        let startCue = file.addItem(withTitle: "Start Cue", action: #selector(menuStartCue), keyEquivalent: "\r")
        startCue.target = self
        cueObserver = state.$cueRunning.sink { running in startCue.title = running ? "Stop Cue" : "Start Cue" }
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

    /// Testing aid: CUE_SNAPSHOT=PNG writes the overlay to PNG every 2 s, and the dashboard and
    /// Settings, when open, to …-dashboard.png / …-settings.png (see `Snapshots`).
    private func startSnapshots(to path: String) {
        let snapshots = Snapshots(log: state.log)
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // The overlay is all glass, which caches as a blank window: drawn by the app, it is its view rendered.
                let state = self.state, preferences = self.preferences, size = self.panel.frame.size
                var targets = [Snapshots.Target(name: "Overlay", window: self.panel, path: path) {
                    let renderer = ImageRenderer(content: OverlayView(state: state, preferences: preferences).frame(width: size.width, height: size.height))
                    renderer.scale = 2
                    return renderer.cgImage
                }]
                for (name, window, suffix) in [("Settings", self.settingsWindow, "-settings.png"), ("Dashboard", self.dashboardWindow, "-dashboard.png")] {
                    guard let window, window.isVisible else { continue }
                    targets.append(Snapshots.Target(name: name, window: window, path: path.replacingOccurrences(of: ".png", with: suffix)) {
                        Snapshots.draw(window)
                    })
                }
                snapshots.take(targets)
            }
        }
    }

    /// Testing aid: CUE_CONTROL=FILE. Each line appended to the file does what a click
    /// would: `new NAME` (New Project), `add PATH` (a file dropped on the open project's
    /// materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu),
    /// `page home|upcoming|NAME|NAME/answers|NAME/notes` (a dashboard page), `ask TEXT`
    /// (the Ask field), `timestamp HH:MM:SS` (a timestamp in the open note's transcript),
    /// `assign EVENT | PROJECT` (an Upcoming call's project picker),
    /// `notification record|dismiss` (the latest Record / Not Now prompt), `rename NAME | NEW`
    /// (a speaker's name clicked and renamed in the open note), `apply LABEL` / `dismiss LABEL`
    /// (a name suggestion on the open note), `download speakers` (Home's Download for the
    /// speaker models), `show TEXT` (the overlay's row of the question with TEXT in it), `newest`
    /// (the overlay's New Questions button), `prepare` (Prepare Answer on the newest questions
    /// waiting for it), `record` (the overlay's record button, or Stop Recording in its timer's
    /// menu), `settings general|account|providers|calendar` (a Settings tab), `provider NAME` (a provider
    /// picked in Settings › Providers: claudeCode, anthropicAPI, whisper or deepgram),
    /// `key anthropic|deepgram [KEY]` (a key pasted into its field and saved; without one, Remove) and
    /// `size W H` (the dashboard's edge dragged until it's W × H points, or as small as it goes),
    /// `signin` (Sign In on the sign-in screen) and `signout` (Sign Out in Settings › Account). Until someone is signed in, only these,
    /// `page`, `size` and the Settings ones do anything.
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
        if !state.api.isSignedIn, !["signin", "signout", "settings", "page", "size", "provider", "key"].contains(command) {
            state.log.write("⚠︎ Sign in to Cue first (\(command) ignored)")
            return
        }
        switch command {
        case "signin":
            Task { await self.state.api.signIn() }
        case "signout":
            Task { await self.state.api.signOut() }
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
        case "stop":
            state.stopCue()
        case "record":
            state.toggleRecording(.overlay)
        case "ask":
            state.ask(argument, force: true)
        case "timestamp":
            if let seconds = MarkdownView.seconds(argument) { state.player.play(from: seconds) }
        case "assign":
            let sides = argument.components(separatedBy: " | ")
            if sides.count == 2, let event = state.calendar.events.first(where: { $0.title == sides[0] }) {
                state.calendar.assign(event, to: state.projects.project(named: sides[1])?.id ?? sides[1])
            }
        case "notification":
            state.meetings.answerLatestPrompt(record: argument == "record")
        case "rename":
            let sides = argument.components(separatedBy: " | ")
            if sides.count == 2, let note = dashboard.note { state.recordings.rename(speaker: sides[0], to: sides[1], in: note) }
        case "apply":
            if let note = dashboard.note, let name = state.recordings.file(note)?.suggestions[argument] {
                state.recordings.rename(speaker: argument, to: name, in: note)
            }
        case "dismiss":
            if let note = dashboard.note { state.recordings.dismissSuggestion(for: argument, in: note) }
        case "download":
            if argument == "speakers" { state.speakerModels.start() }
        case "show":
            if let exchange = state.exchanges.last(where: { $0.answers.contains { $0.question.localizedCaseInsensitiveContains(argument) } }) {
                state.expand(exchange.id)
            }
        case "newest":
            state.showNewest()
        case "prepare":
            if let exchange = state.exchanges.last(where: \.waiting) { state.prepare(exchange.id) }
        case "settings":
            showSettings(SettingsTab(rawValue: argument))
        case "size":
            // The dashboard's edge dragged to make it W × H points (as small as it lets it be).
            let numbers = argument.split(separator: " ").compactMap { Double($0) }
            if numbers.count == 2, let window = dashboardWindow { window.setContentSize(NSSize(width: numbers[0], height: numbers[1])) }
        case "provider":
            if let provider = ClaudeProvider(rawValue: argument) { preferences.claudeProvider = provider }
            if let provider = SpeechProvider(rawValue: argument) { preferences.speechProvider = provider }
        case "key":
            let sides = argument.split(separator: " ", maxSplits: 1).map(String.init)
            guard let key = sides.first.flatMap(APIKey.init(rawValue:)) else { break }
            if sides.count > 1 { try? preferences.saveKey(sides[1], for: key) } else { preferences.removeKey(key) }
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
    app.setActivationPolicy(ProcessInfo.processInfo.environment["CUE_BACKGROUND"] == "1" ? .accessory : .regular)
    app.run()
}
