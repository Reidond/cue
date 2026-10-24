import AppKit
import EventKit
import SwiftUI

/// What Cue does when a call starts.
enum MeetingAction: String, CaseIterable, Identifiable {
    case ask, record, nothing
    var id: String { rawValue }

    var title: String {
        switch self {
        case .ask: "Ask"
        case .record: "Record automatically"
        case .nothing: "Do nothing"
        }
    }
}

/// The video call services Cue recognises by their links.
enum CallService: String {
    case meet = "Google Meet", zoom = "Zoom", teams = "Microsoft Teams", webex = "Webex"

    init?(link url: URL) {
        guard let host = url.host?.lowercased() else { return nil }
        let path = url.path.lowercased()
        if host == "meet.google.com", path.count > 1 {
            self = .meet
        } else if host == "zoom.us" || host.hasSuffix(".zoom.us") || host.hasSuffix("zoomgov.com"),
                  ["/j/", "/my/", "/w/", "/s/", "/wc/"].contains(where: path.hasPrefix) {
            self = .zoom
        } else if (host == "teams.microsoft.com" && path.contains("meet")) || (host == "teams.live.com" && path.hasPrefix("/meet")) {
            self = .teams
        } else if host.hasSuffix(".webex.com"), path.count > 1 {
            self = .webex
        } else {
            return nil
        }
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// The first call link in an event's URL, location or notes, in that order.
    static func link(in texts: [String?]) -> (url: URL, service: CallService)? {
        for case let text? in texts {
            let range = NSRange(text.startIndex..., in: text)
            for match in detector?.matches(in: text, range: range) ?? [] {
                if let url = match.url, let service = CallService(link: url) { return (url, service) }
            }
        }
        return nil
    }
}

/// A calendar event with a call link, today or tomorrow.
struct CalendarEvent: Identifiable, Hashable {
    /// One occurrence.
    let id: String
    /// The same for every occurrence of a recurring event, so its project is remembered for the series.
    let series: String
    let title: String
    let start: Date
    let end: Date
    let calendar: String
    /// Everyone invited except you, by name (or address when the calendar has no name).
    let attendees: [String]
    let link: URL
    let service: CallService
    let recurring: Bool

    /// From five minutes before the start until the end.
    func inProgress(at date: Date = Date()) -> Bool { start.addingTimeInterval(-5 * 60) <= date && date <= end }
}

/// Reads today's and tomorrow's calls from the calendars the user watches (EventKit, full access).
/// CUE_CALENDAR_EVENTS=file.json stands in for the calendar database in tests; it is read again on every refresh.
@MainActor
final class MeetingCalendar: ObservableObject {
    enum Access { case granted, notDetermined, denied }

    struct Source: Identifiable, Hashable {
        let id: String
        let title: String
        let account: String
        let color: Color?
    }

    /// Where calendar recordings go unless their series was given a project on Upcoming.
    static let defaultProject = "Meetings"

    @Published private(set) var access: Access
    @Published private(set) var calendars: [Source] = []
    /// Calls in the watched calendars, by start time.
    @Published private(set) var events: [CalendarEvent] = []

    private let preferences: Preferences
    private let fixture = ProcessInfo.processInfo.environment["CUE_CALENDAR_EVENTS"]
    private lazy var store = EKEventStore()

    init(preferences: Preferences) {
        self.preferences = preferences
        access = fixture == nil ? Self.systemAccess : .granted
    }

    /// Whether Cue can read the calendar (for the Home checklist).
    nonisolated static var hasAccess: Bool {
        ProcessInfo.processInfo.environment["CUE_CALENDAR_EVENTS"] != nil || systemAccess == .granted
    }

    nonisolated static var systemAccess: Access {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: .granted
        case .notDetermined: .notDetermined
        default: .denied
        }
    }

    func requestAccess() {
        guard fixture == nil else { return }
        store.requestFullAccessToEvents { _, _ in
            Task { @MainActor in
                self.store = EKEventStore()  // a store made before the answer doesn't see the calendars
                self.refresh()
            }
        }
    }

    func refresh() {
        let day = Calendar.current.startOfDay(for: Date())
        let window = DateInterval(start: day, end: Calendar.current.date(byAdding: .day, value: 2, to: day) ?? day)
        var calendars: [Source] = [], events: [CalendarEvent] = []
        if let fixture {
            (calendars, events) = Self.read(fixture: fixture, in: window)
        } else {
            access = Self.systemAccess
            if access == .granted {
                let all = store.calendars(for: .event)
                calendars = all.map { Source(id: $0.calendarIdentifier, title: $0.title, account: $0.source.title, color: Color(nsColor: $0.color)) }
                let watched = all.filter { !preferences.unwatchedCalendars.contains($0.calendarIdentifier) }
                if !watched.isEmpty {
                    let predicate = store.predicateForEvents(withStart: window.start, end: window.end, calendars: watched)
                    events = store.events(matching: predicate).compactMap(Self.event)
                }
            }
        }
        calendars.sort { ($0.account, $0.title) < ($1.account, $1.title) }
        events = events.filter { !preferences.unwatchedCalendars.contains($0.calendar) && $0.end > window.start && $0.start < window.end }
            .sorted { $0.start < $1.start }
        if calendars != self.calendars { self.calendars = calendars }
        if events != self.events { self.events = events }
    }

    // MARK: Projects

    /// The project folder picked for an event's series on Upcoming, if any.
    func assignedProject(_ event: CalendarEvent) -> String? { preferences.meetingProjects[event.series] }

    func assign(_ event: CalendarEvent, to project: String) {
        preferences.meetingProjects[event.series] = project
    }

    /// Keeps the picks when a project folder is renamed.
    func projectRenamed(from old: String, to new: String) {
        preferences.meetingProjects = preferences.meetingProjects.mapValues { $0 == old ? new : $0 }
    }

    // MARK: Reading events

    private static func event(_ event: EKEvent) -> CalendarEvent? {
        guard !event.isAllDay, event.status != .canceled,
              let link = CallService.link(in: [event.url?.absoluteString, event.location, event.notes])
        else { return nil }
        let series = event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier
        let occurrence = event.occurrenceDate ?? event.startDate ?? Date()
        let attendees = (event.attendees ?? [])
            .filter { !$0.isCurrentUser && ($0.participantType == .person || $0.participantType == .unknown) }
            .compactMap { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
        return CalendarEvent(id: "\(series)/\(occurrence.timeIntervalSince1970)", series: series,
                             title: event.title ?? "Meeting", start: event.startDate, end: event.endDate,
                             calendar: event.calendar.calendarIdentifier, attendees: attendees,
                             link: link.url, service: link.service, recurring: event.hasRecurrenceRules)
    }

    /// One event in a CUE_CALENDAR_EVENTS file. Only title, start and end are required;
    /// the calendar (by name) defaults to "Calendar" and the series to the event's id or title.
    private struct FixtureEvent: Decodable {
        var id: String?
        var series: String?
        var title: String
        var start: Date
        var end: Date
        var calendar: String?
        var url: String?
        var location: String?
        var notes: String?
        var attendees: [String]?
        var recurring: Bool?
    }

    private static func read(fixture path: String, in window: DateInterval) -> ([Source], [CalendarEvent]) {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = FileManager.default.contents(atPath: path),
              let fixtures = try? decoder.decode([FixtureEvent].self, from: data)
        else { return ([], []) }
        let calendars = Set(fixtures.map { $0.calendar ?? "Calendar" })
            .map { Source(id: $0, title: $0, account: "CUE_CALENDAR_EVENTS", color: nil) }
        let events = fixtures.compactMap { fixture -> CalendarEvent? in
            guard let link = CallService.link(in: [fixture.url, fixture.location, fixture.notes]) else { return nil }
            let series = fixture.series ?? fixture.id ?? fixture.title
            return CalendarEvent(id: fixture.id ?? "\(series)/\(fixture.start.timeIntervalSince1970)", series: series,
                                 title: fixture.title, start: fixture.start, end: fixture.end,
                                 calendar: fixture.calendar ?? "Calendar", attendees: fixture.attendees ?? [],
                                 link: link.url, service: link.service, recurring: fixture.recurring ?? false)
        }
        return (calendars, events)
    }
}
