import AppKit
import SwiftUI

/// Today's and tomorrow's calls from the calendar, each with the project its notes go to.
struct UpcomingView: View {
    @ObservedObject var calendar: MeetingCalendar
    @ObservedObject var meetings: MeetingMonitor
    @ObservedObject var projects: ProjectStore
    @ObservedObject var recorder: CallRecorder
    @ObservedObject var preferences: Preferences
    let openSettings: () -> Void

    var body: some View {
        Group {
            switch calendar.access {
            case .notDetermined:
                ContentUnavailableView {
                    Label("Calls From Your Calendar", systemImage: "calendar")
                } description: {
                    Text("Let Cue read your calendar to list today’s and tomorrow’s calls here and offer to record each one when it starts.")
                } actions: {
                    Button("Allow Calendar Access", action: calendar.requestAccess)
                        .buttonStyle(.borderedProminent)
                }
            case .denied:
                ContentUnavailableView {
                    Label("No Access to Your Calendar", systemImage: "calendar.badge.exclamationmark")
                } description: {
                    Text("Allow Cue in System Settings › Privacy & Security › Calendars, with full access.")
                } actions: {
                    Button("Open Privacy Settings") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
            case .granted:
                if calendar.events.isEmpty {
                    ContentUnavailableView {
                        Label("No Upcoming Calls", systemImage: "calendar")
                    } description: {
                        Text("Calls in your calendar today and tomorrow with a Google Meet, Zoom, Teams or Webex link appear here, so Cue can offer to record them.")
                    }
                } else {
                    list
                }
            }
        }
        .navigationTitle("Upcoming")
    }

    private var list: some View {
        ScrollView {
            // In progress changes with the clock, not only with the calendar.
            TimelineView(.everyMinute) { context in
                VStack(alignment: .leading, spacing: 28) {
                    ForEach(days, id: \.title) { day in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(day.title).font(.title2.weight(.semibold))
                            GroupBox {
                                VStack(spacing: 0) {
                                    ForEach(Array(day.events.enumerated()), id: \.element.id) { index, event in
                                        if index > 0 { Divider() }
                                        EventRow(event: event, projects: choices, project: project(of: event),
                                                 recording: meetings.recording?.event?.id == event.id,
                                                 canRecord: event.inProgress(at: context.date) && recorder.startedAt == nil) {
                                            meetings.record(event)
                                        }
                                    }
                                }
                                .padding(.horizontal, 6)
                            }
                        }
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(footer).foregroundStyle(.secondary)
                        Button("Change…", action: openSettings).buttonStyle(.link)
                    }
                    .font(.callout)
                }
            }
            // A comfortable reading measure, centred in wide windows.
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
    }

    private var days: [(title: String, events: [CalendarEvent])] {
        let tomorrow = calendar.events.filter { Calendar.current.isDateInTomorrow($0.start) }
        let today = calendar.events.filter { !Calendar.current.isDateInTomorrow($0.start) }
        return [("Today", today), ("Tomorrow", tomorrow)].filter { !$0.1.isEmpty }
    }

    /// Every project, and "Meetings" even before it exists (it is created for the first recording).
    private var choices: [(id: String, name: String)] {
        let all = projects.projects.map { (id: $0.id, name: $0.name) }
        guard projects.project(named: MeetingCalendar.defaultProject) == nil else { return all }
        return [(MeetingCalendar.defaultProject, MeetingCalendar.defaultProject)] + all
    }

    private func project(of event: CalendarEvent) -> Binding<String> {
        Binding { meetings.projectID(for: event) } set: { calendar.assign(event, to: $0) }
    }

    private var footer: String {
        switch preferences.meetingAction {
        case .ask: "When a call starts and a call app uses the microphone, Cue asks whether to record it."
        case .record: "When a call starts and a call app uses the microphone, Cue records it."
        case .nothing: "Cue doesn’t record calls when they start."
        }
    }
}

private struct EventRow: View {
    let event: CalendarEvent
    let projects: [(id: String, name: String)]
    @Binding var project: String
    let recording: Bool
    let canRecord: Bool
    let record: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .trailing, spacing: 2) {
                Text(event.start, format: .dateTime.hour().minute())
                Text(event.end, format: .dateTime.hour().minute()).foregroundStyle(.secondary)
            }
            .font(.callout.monospacedDigit())
            .frame(minWidth: 52, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(event.title).lineLimit(1)
                    if event.recurring {
                        Image(systemName: "repeat")
                            .imageScale(.small)
                            .foregroundStyle(.secondary)
                            .help("Repeats — its project is remembered for every time")
                            .accessibilityLabel("Repeats")
                    }
                }
                HStack(spacing: 6) {
                    Link(event.service.rawValue, destination: event.link)
                        .foregroundStyle(.tint)
                        .help("Join the call")
                    if !event.attendees.isEmpty {
                        Text("·")
                        Text(event.attendees.joined(separator: ", ")).lineLimit(1).truncationMode(.tail)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if recording {
                Label("Recording", systemImage: "record.circle.fill")
                    .foregroundStyle(.red)
                    .labelStyle(.titleAndIcon)
            } else if canRecord {
                Button("Record", systemImage: "record.circle", action: record)
                    .help("Record this call now")
            }
            Picker("Project", selection: $project) {
                ForEach(projects, id: \.id) { Text($0.name).tag($0.id) }
            }
            .labelsHidden()
            .fixedSize()
            .help("The project this call’s notes go to")
        }
        .padding(.vertical, 8)
    }
}
