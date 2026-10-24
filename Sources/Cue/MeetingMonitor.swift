import AppKit
import Combine
import CoreAudio
import UserNotifications

/// An app people take calls in. Browsers count only during a calendar call; the others on their own too.
struct CallApp: Hashable {
    let name: String
    /// Bundle ID prefixes: browsers capture the microphone in helper processes with their own IDs.
    let bundlePrefixes: [String]
    let isBrowser: Bool
    var service: CallService? = nil
    var callName: String { "\(name) call" }

    static let all = [
        CallApp(name: "Google Chrome", bundlePrefixes: ["com.google.Chrome"], isBrowser: true),
        // Safari captures in WebKit's GPU process.
        CallApp(name: "Safari", bundlePrefixes: ["com.apple.Safari", "com.apple.WebKit"], isBrowser: true),
        CallApp(name: "Arc", bundlePrefixes: ["company.thebrowser."], isBrowser: true),
        CallApp(name: "Microsoft Edge", bundlePrefixes: ["com.microsoft.edgemac"], isBrowser: true),
        CallApp(name: "Zoom", bundlePrefixes: ["us.zoom."], isBrowser: false, service: .zoom),
        CallApp(name: "Microsoft Teams", bundlePrefixes: ["com.microsoft.teams"], isBrowser: false, service: .teams),
        CallApp(name: "Webex", bundlePrefixes: ["Cisco-Systems.Spark", "com.webex.", "com.cisco.webex"], isBrowser: false, service: .webex),
        CallApp(name: "FaceTime", bundlePrefixes: ["com.apple.FaceTime", "com.apple.avconferenced"], isBrowser: false),
        CallApp(name: "Slack", bundlePrefixes: ["com.tinyspeck.slackmacgap"], isBrowser: false),
    ]

    /// Call apps using the microphone right now, in the order of `all`.
    static func usingMicrophone() -> [CallApp] {
        let bundles = microphoneUsers().map { $0.lowercased() }
        return all.filter { app in
            bundles.contains { bundle in app.bundlePrefixes.contains { bundle.hasPrefix($0.lowercased()) } }
        }
    }

    /// Bundle IDs of the processes recording from an input device, from Core Audio's process list.
    /// CUE_MIC_APPS=file stands in for it in tests: one bundle ID per line, read again on every call.
    private static func microphoneUsers() -> [String] {
        if let path = ProcessInfo.processInfo.environment["CUE_MIC_APPS"] {
            let text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
            return text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        let system = AudioObjectID(kAudioObjectSystemObject)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &processes) == noErr else { return [] }
        return processes.compactMap { process in
            var input = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyIsRunningInput,
                                                   mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var running: UInt32 = 0, runningSize = UInt32(MemoryLayout<UInt32>.size)
            guard AudioObjectGetPropertyData(process, &input, 0, nil, &runningSize, &running) == noErr, running != 0 else { return nil }
            var bundle = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID,
                                                    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var name: Unmanaged<CFString>?
            var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(process, &bundle, 0, nil, &nameSize, &name) == noErr else { return nil }
            return name?.takeRetainedValue() as String?
        }
    }
}

/// Notices calls: a watched calendar event in progress while a call app uses the microphone,
/// or a native call app (Zoom, Teams, …) on its own. Depending on the preference it asks to
/// record, records, or does nothing; a recording it started stops once the call app has let go
/// of the microphone for a minute.
@MainActor
final class MeetingMonitor: ObservableObject {
    struct Call: Equatable {
        /// `event:<occurrence>` or `app:<name>`: what "don't ask again" is remembered by.
        let key: String
        let title: String
        let event: CalendarEvent?
        let app: CallApp?
    }

    /// The call being recorded because Cue noticed it.
    @Published private(set) var recording: Call?
    /// When that recording started, to tell it from one the user started by hand after stopping it.
    private var recordingStarted: Date?

    private unowned let state: AppState
    private let notifier: MeetingNotifier
    private var timer: Timer?
    private var subscriptions: Set<AnyCancellable> = []
    /// Prompts waiting for an answer, oldest first.
    private var asking: [Call] = []
    /// Calls answered or recorded: not asked about again.
    private var settled: Set<String> = []
    /// When each call was last going on; a call gone for the release window is over.
    private var lastSeen: [String: Date] = [:]
    /// The last time a call app used the microphone during `recording`, and which one.
    private var heardAt: Date?
    private var heardApp: CallApp?
    /// Notes of calls Cue stopped itself, by id, until their summary is written.
    private var waitingForNotes: Set<String> = []

    // CUE_MEETING_TICK and CUE_MIC_RELEASE (seconds) shorten the check interval and the release window in tests.
    private let interval = ProcessInfo.processInfo.environment["CUE_MEETING_TICK"].flatMap(TimeInterval.init) ?? 5
    private let releaseAfter = ProcessInfo.processInfo.environment["CUE_MIC_RELEASE"].flatMap(TimeInterval.init) ?? 60

    init(state: AppState) {
        self.state = state
        notifier = MeetingNotifier(log: state.log)
        notifier.onAnswer = { [weak self] key, record in self?.answer(key, record: record) }
        notifier.onOpenNote = { [weak self] id in self?.state.openRecordings(id) }
    }

    func start() {
        state.recordings.onNotesReady = { [weak self] id in
            guard let self, self.waitingForNotes.remove(id) != nil else { return }
            self.notifier.notesReady(title: self.state.recordings.file(id)?.title ?? "", note: id)
        }
        state.preferences.$meetingAction.removeDuplicates()
            .sink { [weak self] action in if action != .nothing { self?.notifier.requestPermission() } }
            .store(in: &subscriptions)
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        state.calendar.refresh()
        let now = Date()
        let apps = CallApp.usingMicrophone()
        let call = currentCall(apps: apps, at: now)
        if let call { lastSeen[call.key] = now }
        for (key, seen) in lastSeen where now.timeIntervalSince(seen) >= releaseAfter {
            // Over: withdraw its prompt; the next call in the same app is asked about again.
            lastSeen[key] = nil
            if key.hasPrefix("app:") { settled.remove(key) }
            asking.filter { $0.key == key }.forEach(withdraw)
        }

        if let recording {
            guard state.recorder.isRecording, state.recorder.startedAt == recordingStarted else {  // stopped by hand
                self.recording = nil
                heardAt = nil
                heardApp = nil
                return
            }
            if let app = apps.first {
                heardAt = now
                heardApp = apps.first { $0 == recording.app } ?? app
            } else if let heardAt, now.timeIntervalSince(heardAt) >= releaseAfter {
                state.log.write("📅 \(heardApp?.name ?? "The call app") let go of the microphone — stopping the recording")
                stop(recording)
            }
            return
        }
        guard state.recorder.startedAt == nil else {  // recording by hand: nothing to ask
            let pending = asking
            pending.forEach(withdraw)
            return
        }
        guard let call, !settled.contains(call.key), !asking.contains(where: { $0.key == call.key }) else { return }
        switch state.preferences.meetingAction {
        case .nothing:
            break
        case .record:
            record(call, heard: true)
        case .ask:
            asking.append(call)
            let app = call.app.map { "\($0.name) is using the microphone. " } ?? ""
            notifier.ask(call, detail: "\(app)Notes go to \(projectName(for: call.event)).")
        }
    }

    /// The calendar call going on now, if a call app uses the microphone; else a native call app's own call.
    private func currentCall(apps: [CallApp], at now: Date) -> Call? {
        guard let first = apps.first else { return nil }
        let events = state.calendar.events.filter { $0.inProgress(at: now) }
        if let event = events.min(by: { abs($0.start.timeIntervalSince(now)) < abs($1.start.timeIntervalSince(now)) }) {
            return Call(key: "event:\(event.id)", title: event.title, event: event, app: apps.first { $0.service == event.service } ?? first)
        }
        guard let app = apps.first(where: { !$0.isBrowser }) else { return nil }
        return Call(key: "app:\(app.name)", title: app.callName, event: nil, app: app)
    }

    // MARK: Answers

    private func answer(_ key: String, record: Bool) {
        guard let call = asking.first(where: { $0.key == key }) else { return }
        asking.removeAll { $0.key == key }
        settled.insert(key)
        if record {
            guard state.recorder.startedAt == nil else { return }
            self.record(call, heard: true)
        } else {
            state.log.write("🔔 Not now: “\(call.title)”")
        }
    }

    /// CUE_CONTROL's `notification record|dismiss`: the answer to the latest prompt.
    func answerLatestPrompt(record: Bool) {
        if let key = asking.last?.key { answer(key, record: record) }
    }

    private func withdraw(_ call: Call) {
        asking.removeAll { $0.key == call.key }
        notifier.withdraw(call.key)
    }

    // MARK: Recording

    /// Records an event in progress from the Upcoming page.
    func record(_ event: CalendarEvent) {
        guard state.recorder.startedAt == nil else { return }
        record(Call(key: "event:\(event.id)", title: event.title, event: event, app: nil), heard: false)
    }

    /// `heard` when a call app is on the microphone already; otherwise the recording only stops by
    /// itself after one has been and gone.
    private func record(_ call: Call, heard: Bool) {
        settled.insert(call.key)
        let pending = asking
        pending.forEach(withdraw)
        guard let project = project(for: call.event) else { return }
        state.log.write("📅 Recording “\(call.title)” into \(project.name)")
        state.startRecording(into: project, meeting: call.event.map { MeetingDetails(title: $0.title, attendees: $0.attendees) })
        recording = call
        recordingStarted = state.recorder.startedAt
        heardAt = heard ? Date() : nil
        heardApp = heard ? call.app : nil
    }

    private func stop(_ call: Call) {
        recording = nil
        heardAt = nil
        heardApp = nil
        state.stopRecording(automatically: true) { [weak self] id in
            guard let self else { return }
            guard let id else { return self.notifier.nothingRecorded(title: call.title) }
            if self.state.recordings.isProcessing(id) {
                self.waitingForNotes.insert(id)
            } else {
                self.notifier.notesReady(title: self.state.recordings.file(id)?.title ?? call.title, note: id)
            }
        }
    }

    // MARK: Projects

    /// The project an event's notes go to: the one picked for its series on Upcoming, else "Meetings",
    /// created when first needed. Calls without an event go to "Meetings" too.
    func project(for event: CalendarEvent?) -> Project? {
        let projects = state.projects
        if let event, let id = state.calendar.assignedProject(event), let project = projects.project(id) { return project }
        return projects.project(named: MeetingCalendar.defaultProject) ?? (try? projects.create(named: MeetingCalendar.defaultProject))
    }

    /// The folder of the project an event's notes would go to, without creating "Meetings".
    func projectID(for event: CalendarEvent) -> String {
        let projects = state.projects
        if let id = state.calendar.assignedProject(event), projects.project(id) != nil { return id }
        return projects.project(named: MeetingCalendar.defaultProject)?.id ?? MeetingCalendar.defaultProject
    }

    private func projectName(for event: CalendarEvent?) -> String {
        let id = event.map(projectID) ?? MeetingCalendar.defaultProject
        return state.projects.project(id)?.name ?? MeetingCalendar.defaultProject
    }
}

/// Notification Center prompts (Record / Not Now) and notices. Every one is written to the
/// session log; under CUE_CONTROL they go only there, and the case answers through the control file.
@MainActor
final class MeetingNotifier: NSObject, UNUserNotificationCenterDelegate {
    var onAnswer: (_ key: String, _ record: Bool) -> Void = { _, _ in }
    var onOpenNote: (_ id: String) -> Void = { _ in }

    private let log: SessionLog
    private var center: UNUserNotificationCenter?

    init(log: SessionLog) {
        self.log = log
        super.init()
        guard ProcessInfo.processInfo.environment["CUE_CONTROL"] == nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let record = UNNotificationAction(identifier: "record", title: "Record")
        let later = UNNotificationAction(identifier: "dismiss", title: "Not Now")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "meeting", actions: [record, later], intentIdentifiers: [], options: [.customDismissAction]),
        ])
        self.center = center
    }

    /// macOS asks once; prompts can't show until the user allows them.
    func requestPermission() {
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func ask(_ call: MeetingMonitor.Call, detail: String) {
        log.write("🔔 Record “\(call.title)”?")
        post(id: call.key, title: "Record “\(call.title)”?", body: detail, category: "meeting")
    }

    func withdraw(_ id: String) {
        center?.removeDeliveredNotifications(withIdentifiers: [id])
        center?.removePendingNotificationRequests(withIdentifiers: [id])
    }

    func notesReady(title: String, note id: String) {
        log.write("🔔 Notes from “\(title)” are ready")
        post(id: "notes:\(id)", title: "Notes Ready", body: title, note: id)
    }

    func nothingRecorded(title: String) {
        log.write("🔔 Nothing was recorded in “\(title)”")
        post(id: "empty:\(title)", title: "Nothing Was Recorded", body: "Cue didn’t hear any speech in “\(title)”, so no notes were saved.")
    }

    private func post(id: String, title: String, body: String, category: String? = nil, note: String? = nil) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let category {
            content.categoryIdentifier = category
            content.sound = .default
        }
        if let note { content.userInfo = ["note": note] }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.identifier, action = response.actionIdentifier
        let content = response.notification.request.content
        let note = content.userInfo["note"] as? String, prompt = content.categoryIdentifier == "meeting"
        Task { @MainActor in
            if let note {
                self.onOpenNote(note)
            } else if prompt {
                // Clicking the prompt itself means Record; closing it means Not Now.
                self.onAnswer(id, action == "record" || action == UNNotificationDefaultActionIdentifier)
            }
        }
        completionHandler()
    }

    /// Show prompts even while Cue is the frontmost app.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
