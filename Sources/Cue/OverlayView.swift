import SwiftUI

/// The floating prompter. Following the HIG for Liquid Glass, every piece is its
/// own glass element floating over the user's slides (no glass on glass), grouped
/// in one container so neighbouring shapes blend; text uses semantic colors so the
/// glass can keep it legible over any background.
struct OverlayView: View {
    @ObservedObject var state: AppState
    @ObservedObject var preferences: Preferences
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var size: CGFloat { CGFloat(preferences.textSize) }

    var body: some View {
        // Spacing below the gaps keeps the pieces distinct instead of melting together.
        GlassEffectContainer(spacing: 4) {
            VStack(spacing: 10) {
                ControlBar(state: state, preferences: preferences)
                AnswerCard(state: state, size: size)
                    .frame(maxHeight: .infinity)
                if preferences.showTranscript {
                    TranscriptCard(state: state, size: size)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
                }
                AskBar(state: state)
            }
            .animation(.smooth(duration: 0.2), value: preferences.showTranscript)
        }
        .padding(10)
    }
}

// MARK: - Control bar

private struct ControlBar: View {
    @ObservedObject var state: AppState
    @ObservedObject var preferences: Preferences

    var body: some View {
        HStack(spacing: 12) {
            LevelIcon(symbol: "mic.fill", level: state.micLevel, ok: state.mic.ok, help: state.mic.detail)
            LevelIcon(symbol: "speaker.wave.3.fill", level: state.callLevel, ok: state.call.ok, help: state.call.detail)
            ProjectMenu(state: state)
            StatusLabel(state: state)
            Spacer(minLength: 4)
            if state.answers.count > 1 {
                HistoryControl(state: state)
            }
            RecordControl(state: state)
            Toggle("Auto", isOn: $preferences.autoAnswer)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .help("Answer questions automatically (⌃⌥A)")
            IconButton(symbol: "text.bubble", active: preferences.showTranscript, help: "Show transcript") {
                preferences.showTranscript.toggle()
            }
            IconButton(symbol: "gearshape", help: "Settings") { state.openSettings() }
        }
        .font(.callout)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 38)
        .contentShape(.capsule)
        .gesture(WindowDragGesture())  // the bar is the handle for moving the overlay
        .glassEffect(.regular, in: .capsule)
    }
}

/// The project Cue answers from and records into, with a menu to switch it or open the dashboard.
private struct ProjectMenu: View {
    @ObservedObject var state: AppState

    var body: some View {
        Menu {
            ForEach(state.projects.projects) { project in
                Toggle(project.name, isOn: Binding(get: { project.id == state.activeProject?.id },
                                                   set: { _ in state.activate(project) }))
            }
            if !state.projects.projects.isEmpty { Divider() }
            Button("Open Dashboard…", action: state.openDashboard)
        } label: {
            HStack(spacing: 3) {
                Text(name).fontWeight(.semibold)
                Image(systemName: "chevron.up.chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
            }
            .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .help("Project — switch it, or open the dashboard")
    }

    /// Short enough to leave room for the status.
    private var name: String {
        let name = state.activeProject?.name ?? "No Project"
        return name.count > 22 ? String(name.prefix(21)) + "…" : name
    }
}

/// Record button; while recording it turns into a red timer that stops on click.
private struct RecordControl: View {
    @ObservedObject var state: AppState

    var body: some View {
        if let started = state.recorder.startedAt {
            Button(action: state.stopRecording) {
                HStack(spacing: 5) {
                    Image(systemName: state.recorder.stopping ? "hourglass" : "stop.circle.fill")
                        .foregroundStyle(.red)
                    ElapsedTime(since: started).font(.callout)
                }
                .frame(height: 28)
                .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .disabled(state.recorder.stopping)
            .help("Stop recording and write the notes (⌃⌥R)")
            .accessibilityLabel("Stop recording")
        } else {
            IconButton(symbol: "record.circle", help: "Record this call (⌃⌥R)", action: state.toggleRecording)
        }
    }
}

/// An audio source with its live level drawn through the symbol's variable color.
private struct LevelIcon: View {
    let symbol: String
    let level: Float
    let ok: Bool
    let help: String

    var body: some View {
        Image(systemName: ok ? symbol : symbol.replacingOccurrences(of: ".fill", with: ".slash.fill"),
              variableValue: ok ? Double(min(sqrt(level) * 3, 1)) : nil)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(ok ? AnyShapeStyle(.primary) : AnyShapeStyle(.red))
            .frame(width: 18)
            .help(help)
            .accessibilityLabel(help)
    }
}

private struct StatusLabel: View {
    @ObservedObject var state: AppState

    var body: some View {
        let status = state.status
        Button(action: state.openDashboard) {
            HStack(spacing: 6) {
                switch status.kind {
                case .ready: Circle().fill(.green).frame(width: 7, height: 7)
                case .working: ProgressView().controlSize(.mini)
                case .problem: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                }
                Text(status.text)
                    .foregroundStyle(status.kind == .problem ? .primary : .secondary)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
        }
        .buttonStyle(.plain)
        .disabled(status.kind == .ready)
        .help(status.kind == .problem ? "Open the dashboard to fix this" : status.text)
        .animation(.smooth(duration: 0.2), value: status.text)
    }
}

private struct HistoryControl: View {
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 2) {
            IconButton(symbol: "chevron.left", help: "Previous answer (⌃⌥←)") { state.step(-1) }
                .disabled(state.selected == 0)
            Text("\(state.selected + 1)/\(state.answers.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            IconButton(symbol: "chevron.right", help: "Next answer (⌃⌥→)") { state.step(1) }
                .disabled(state.selected == state.answers.count - 1)
        }
    }
}

/// A borderless symbol button with a 28 pt hit area.
private struct IconButton: View {
    let symbol: String
    var active = false
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: active ? symbol + ".fill" : symbol)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: - Answer

private struct AnswerCard: View {
    @ObservedObject var state: AppState
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let answer = state.current {
                ScrollView {
                    AnswerContent(answer: answer, size: size, lexicon: state.lexicon)
                        .id(answer.id)
                        .transition(reduceMotion ? AnyTransition.opacity : AnyTransition(.blurReplace))
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollIndicators(.never)
                .scrollEdgeEffectStyle(.soft, for: .vertical)
            } else {
                EmptyState(state: state)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Only a newly arriving answer animates in; browsing history with the keyboard swaps instantly.
        .animation(.smooth(duration: 0.25), value: state.answers.count)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

private struct AnswerContent: View {
    let answer: Answer
    let size: CGFloat
    let lexicon: Lexicon

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            DetailRow(symbol: "person.wave.2", size: size) {
                Text(answer.question).lineLimit(4)
            }
            .font(.system(size: size - 2))
            .foregroundStyle(.secondary)

            if answer.isNotAQuestion {
                Text("Doesn't sound like a question for you. Press ⌃⌥⏎ to answer anyway.")
                    .font(.system(size: size))
                    .foregroundStyle(.secondary)
            } else {
                SayNow(answer: answer, size: size)
                AnswerLines(lines: answer.rest, size: size, lexicon: lexicon)
                if !answer.done && answer.firstLine != nil && answer.rest.isEmpty {
                    ProgressView().controlSize(.small)
                }
                if let error = answer.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: size - 2))
                        .foregroundStyle(.orange)
                }
            }

            if let prepared = answer.prepared {
                PreparedAnswerView(prepared: prepared, score: answer.preparedScore, size: size)
            }
        }
    }
}

/// The line to say first: the instant opener, replaced by Claude's first line when it lands.
private struct SayNow: View {
    let answer: Answer
    let size: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Say")
                .font(.system(size: max(size - 4, 10), weight: .semibold))
                .foregroundStyle(.tint)
                .textCase(.uppercase)
            if let line = answer.sayNow {
                Text(line)
                    .font(.system(size: size * 1.4, weight: .semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.opacity)
                    .animation(.smooth(duration: 0.2), value: answer.firstLine != nil)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Thinking…").foregroundStyle(.secondary)
                }
                .font(.system(size: size))
            }
        }
    }
}

/// Points with hanging bullets; the numbers and source lines set as secondary detail.
private struct AnswerLines: View {
    let lines: [String]
    let size: CGFloat
    let lexicon: Lexicon

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                row(line)
            }
        }
    }

    @ViewBuilder private func row(_ line: String) -> some View {
        if line.hasPrefix("•") || line.hasPrefix("- ") {
            DetailRow(symbol: nil, size: size) {
                Text(line.drop(while: { "•- ".contains($0) }))
            }
            .font(.system(size: size))
        } else if let detail = strip(line, label: lexicon.numbersLabel) {
            DetailRow(symbol: "number", size: size) { Text(detail) }
                .font(.system(size: size - 1).monospacedDigit())
                .foregroundStyle(.secondary)
        } else if let detail = strip(line, label: lexicon.sourceLabel) {
            DetailRow(symbol: "book.closed", size: size) { Text(detail) }
                .font(.system(size: size - 3))
                .foregroundStyle(.secondary)
        } else {
            DetailRow(symbol: nil, size: size) { Text(line) }
                .font(.system(size: size))
        }
    }

    private func strip(_ line: String, label: String) -> String? {
        guard line.lowercased().hasPrefix(label.lowercased() + ":") else { return nil }
        return line.dropFirst(label.count + 1).trimmingCharacters(in: .whitespaces)
    }
}

/// A row whose marker (bullet or symbol) sits in a fixed leading column, so
/// wrapped lines hang and every row's text starts at the same x.
private struct DetailRow<Content: View>: View {
    let symbol: String?
    let size: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if let symbol {
                    Image(systemName: symbol).imageScale(.small)
                } else {
                    Text("•")
                }
            }
            .foregroundStyle(.tertiary)
            .frame(width: size, alignment: .center)
            content.fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PreparedAnswerView: View {
    let prepared: PreparedAnswer
    let score: Double
    let size: CGFloat
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(prepared.a)
                .font(.system(size: size - 2))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
        } label: {
            Label {
                Text("Prepared answer\(prepared.who.map { " · \($0)" } ?? "")")
            } icon: {
                Image(systemName: "text.book.closed")
            }
            .font(.system(size: size - 3, weight: .medium))
        }
        .help("\(Int(score * 100))% match · \(prepared.source)")
    }
}

private struct EmptyState: View {
    @ObservedObject var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if state.activeProject == nil {
            ContentUnavailableView {
                Label("Create a project", systemImage: "rectangle.stack.badge.plus")
            } description: {
                Text("A project holds your slides, documents and prepared answers for a talk. Cue answers from them.")
            } actions: {
                Button("Open Dashboard", action: state.openDashboard)
                    .buttonStyle(.glassProminent)
            }
        } else if state.activeProject?.materials.isEmpty == true {
            ContentUnavailableView {
                Label("Add your materials", systemImage: "doc.on.doc")
            } description: {
                Text("Drop your slides, documents and prepared answers onto the project in the dashboard. Cue reads them and answers from them.")
            } actions: {
                Button("Open Dashboard", action: state.openDashboard)
                    .buttonStyle(.glassProminent)
            }
        } else {
            ContentUnavailableView {
                Label("Listening", systemImage: "waveform")
                    .symbolEffect(.variableColor.iterative, options: .repeating, isActive: state.status.kind == .ready && !reduceMotion)
            } description: {
                Text("When someone asks a question, what to say appears here.\n⌃⌥⏎ answers the last thing said.")
            }
        }
    }
}

// MARK: - Transcript

private struct TranscriptCard: View {
    @ObservedObject var state: AppState
    let size: CGFloat

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(state.utterances.suffix(30)) { line in
                        TranscriptLine(channel: line.channel, text: line.text, size: size)
                            .onTapGesture { state.ask(line.text, force: true) }
                            .help("Click to get an answer for this")
                    }
                    ForEach([Channel.others, Channel.me], id: \.self) { channel in
                        if let live = state.partial[channel], !live.isEmpty {
                            TranscriptLine(channel: channel, text: live, size: size).opacity(0.5)
                        }
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.never)
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            .defaultScrollAnchor(.bottom)
            .onChange(of: state.utterances.count) { proxy.scrollTo("end") }
            .onChange(of: state.partial) { proxy.scrollTo("end") }
        }
        .frame(height: 104)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }
}

private struct TranscriptLine: View {
    let channel: Channel
    let text: String
    let size: CGFloat

    var body: some View {
        let name = Text(channel.label).fontWeight(.semibold)
            .foregroundStyle(channel == .others ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        Text("\(name)  \(text)")
            .foregroundStyle(.secondary)
            .font(.system(size: max(size - 3, 11)))
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Ask

private struct AskBar: View {
    @ObservedObject var state: AppState
    @State private var typed = ""

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble").foregroundStyle(.secondary)
                TextField("Ask anything", text: $typed)
                    .textFieldStyle(.plain)
                    .onSubmit(submit)
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .glassEffect(.regular.interactive(), in: .capsule)

            Button(action: state.answerNow) {
                Image(systemName: "text.bubble.fill")
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .controlSize(.large)
            .help("Answer the last thing said (⌃⌥⏎)")
            .accessibilityLabel("Answer now")
        }
    }

    private func submit() {
        let question = typed.trimmingCharacters(in: .whitespaces)
        guard !question.isEmpty else { return }
        state.ask(question, force: true)
        typed = ""
    }
}
