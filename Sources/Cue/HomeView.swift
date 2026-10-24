import AppKit
import Combine
import SwiftUI

/// The dashboard's first page: what still needs setting up, recent notes across
/// projects, and a way in for someone who has no project yet.
struct HomeView: View {
    @ObservedObject var state: AppState
    @ObservedObject var projects: ProjectStore
    @ObservedObject var recordings: RecordingStore
    @ObservedObject var downloader: ModelDownloader
    @ObservedObject var speakers: SpeakerModels
    @ObservedObject var model: DashboardModel
    @State private var checks = SetupCheck.all()

    private let refresh = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if projects.projects.isEmpty {
                    FirstProject { model.creatingProject = true }
                }
                if !checks.allSatisfy(\.ok) {
                    SetupCard(checks: checks, downloader: downloader, speakers: speakers, calendar: state.calendar)
                }
                if !projects.projects.isEmpty {
                    RecentNotes(files: Array(recordings.files.prefix(8)), projects: projects) { model.show($0) }
                }
            }
            // A comfortable reading measure, centred in wide windows.
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(maxWidth: .infinity)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle("Home")
        .onReceive(refresh) { _ in checks = SetupCheck.all() }
        .onChange(of: speakers.progress == nil) { checks = SetupCheck.all() }
        .onAppear { recordings.reload() }
    }
}

private struct FirstProject: View {
    let create: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "rectangle.stack.badge.plus")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(.tint)
            Text("Create Your First Project")
                .font(.title.weight(.semibold))
            Text("A project holds what Cue needs for one talk — the occasion, your slides, documents and prepared answers — and the notes of its calls.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 440)
            Button(action: create) {
                Label("New Project", systemImage: "plus").padding(.horizontal, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.extraLarge)
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

private struct SetupCard: View {
    let checks: [SetupCheck]
    @ObservedObject var downloader: ModelDownloader
    let speakers: SpeakerModels
    let calendar: MeetingCalendar

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Finish Setting Up").font(.title2.weight(.semibold))
                Spacer()
                Text("\(checks.filter(\.ok).count) of \(checks.count) done")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            GroupBox {
                VStack(spacing: 0) {
                    ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                        if index > 0 { Divider() }
                        SetupRow(check: check, downloader: downloader, speakers: speakers, calendar: calendar).padding(.vertical, 8)
                    }
                }
                .padding(.horizontal, 6)
            }
        }
    }
}

struct SetupRow: View {
    let check: SetupCheck
    @ObservedObject var downloader: ModelDownloader
    @ObservedObject var speakers: SpeakerModels
    let calendar: MeetingCalendar

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: check.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(check.ok ? .green : .orange)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.title)
                Text(downloadError ?? check.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            action
        }
    }

    private var downloadError: String? {
        switch check.item {
        case .model: downloader.error
        case .speakerModels: speakers.error
        default: nil
        }
    }

    @ViewBuilder private var action: some View {
        if !check.ok {
            switch check.item {
            case .model:
                if let progress = downloader.progress {
                    ProgressView(value: progress).frame(width: 90)
                    Button("Cancel", action: downloader.cancel)
                } else {
                    Button("Download", action: downloader.start)
                }
            case .speakerModels:
                if let progress = speakers.progress {
                    ProgressView(value: progress).frame(width: 90)
                } else {
                    Button("Download", action: speakers.start)
                }
            case .whisper:
                Button("Copy Command") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("brew install whisper-cpp", forType: .string)
                }
            case .microphone, .screenAudio:
                if let url = check.settingsURL {
                    Button("Open Settings") { NSWorkspace.shared.open(url) }
                }
            case .claude:
                Link("Get Claude Code", destination: URL(string: "https://claude.com/claude-code")!)
            case .calendar:
                if MeetingCalendar.systemAccess == .notDetermined {
                    Button("Allow Access", action: calendar.requestAccess)
                } else if let url = check.settingsURL {
                    Button("Open Settings") { NSWorkspace.shared.open(url) }
                }
            }
        }
    }
}

private struct RecentNotes: View {
    let files: [RecordingFile]
    let projects: ProjectStore
    let open: (RecordingFile) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recent Notes").font(.title2.weight(.semibold))
            if files.isEmpty {
                Text("Notes from recorded calls appear here. Press ⌃⌥R, or the record button in Cue, to record a call.")
                    .foregroundStyle(.secondary)
            } else {
                GroupBox {
                    VStack(spacing: 0) {
                        ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                            if index > 0 { Divider() }
                            Button { open(file) } label: {
                                NoteRow(file: file, project: projects.project(file.projectID)?.name ?? file.projectID)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 6)
                }
            }
        }
    }
}

private struct NoteRow: View {
    let file: RecordingFile
    let project: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.title).lineLimit(1)
                HStack(spacing: 6) {
                    Text(project)
                    Text("·")
                    Text(file.date.formatted(date: .abbreviated, time: .shortened))
                    if !file.duration.isEmpty { Text("·"); Text(file.duration) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary).imageScale(.small)
        }
        .padding(.vertical, 8)
    }
}
