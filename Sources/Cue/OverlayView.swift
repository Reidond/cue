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
                QuestionList(state: state, size: size)
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
            RecordControl(state: state)
            Toggle("Auto", isOn: $preferences.autoAnswer)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .help("Answer questions as they're asked; off, they're listed for Prepare Answer (⌃⌥A)")
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
            Button("Stop Cue", action: state.stopCue)
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

/// Record button; while recording it turns into a red timer whose menu stops it, so a stray click
/// on the bar (its handle for moving the overlay) can't end a call's notes halfway.
private struct RecordControl: View {
    @ObservedObject var state: AppState

    var body: some View {
        if let started = state.recorder.startedAt {
            Menu {
                Button("Stop Recording", systemImage: "stop.circle") { state.stopRecording(.overlay) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: state.recorder.stopping ? "hourglass" : "record.circle.fill")
                        .foregroundStyle(.red)
                    ElapsedTime(since: started).font(.callout)
                }
                .frame(height: 28)
                .contentShape(.rect)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(state.recorder.stopping)
            .help("Recording — open to stop it and write the notes (⌃⌥R)")
            .accessibilityLabel("Recording")
        } else {
            IconButton(symbol: "record.circle", help: "Record this call (⌃⌥R)") { state.toggleRecording(.overlay) }
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

// MARK: - Questions

/// Everything asked so far, newest on top. One exchange shows in full; the others are compact rows
/// (the questions and what to say, or that it's still coming), so a new question never replaces
/// what's being read. Click a row, or use ⌃⌥← →, to show it in full. While an older one is open or
/// the list is scrolled down, new questions stay out of the list, so nothing in it moves, and wait
/// under a button at the top that shows them.
private struct QuestionList: View {
    @ObservedObject var state: AppState
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = ScrollPosition(idType: UUID.self)

    var body: some View {
        Group {
            if state.exchanges.isEmpty {
                EmptyState(state: state)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(state.exchanges.reversed().filter { !state.unseen.contains($0.id) }) { exchange in
                            Group {
                                if exchange.id == state.expandedID {
                                    ExchangeCard(exchange: exchange, size: size, lexicon: state.lexicon,
                                                 prepare: { state.prepare(exchange.id) },
                                                 answerAnyway: { state.ask($0, force: true) })
                                } else {
                                    ExchangeRow(exchange: exchange, size: size,
                                                expand: { state.expand(exchange.id) }, prepare: { state.prepare(exchange.id) })
                                }
                            }
                            .id(exchange.id)
                        }
                    }
                    .scrollTargetLayout()
                }
                .contentMargins(8, for: .scrollContent)
                .scrollPosition($position, anchor: .top)
                .scrollIndicators(.never)
                .scrollEdgeEffectStyle(.soft, for: .vertical)
                .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 24 } action: { _, scrolled in
                    state.listScrolled = scrolled
                }
                .onChange(of: state.exchanges.count) {
                    if !state.holding && !state.listScrolled { position.scrollTo(edge: .top) }
                }
                .onChange(of: state.expandedID) { _, id in
                    guard let id else { return }
                    withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) {
                        if id == state.exchanges.last?.id { position.scrollTo(edge: .top) } else { position.scrollTo(id: id, anchor: .top) }
                    }
                }
                .overlay(alignment: .top) {
                    if !state.unseen.isEmpty {
                        NewQuestionsButton(count: state.unseen.count) {
                            state.showNewest()
                            position.scrollTo(edge: .top)
                        }
                        .padding(.top, 10)
                        .transition(.opacity)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: state.expandedID)
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: state.unseen.isEmpty)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

/// Over the list while it's held in place: the questions that came in meanwhile.
private struct NewQuestionsButton: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(count == 1 ? "1 New Question" : "\(count) New Questions", systemImage: "arrow.up")
        }
        .buttonStyle(AccentCapsuleStyle())
        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
        .help("Show the newest question")
    }
}

/// A capsule in the accent colour for the overlay's main actions. The overlay is seldom the key
/// window, where the system's prominent buttons grey out as if disabled.
private struct AccentCapsuleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.accentColor.opacity(configuration.isPressed ? 0.75 : 1), in: .capsule)
            .contentShape(.capsule)
    }
}

/// A question and its marker: its number when several were asked in one go, else who's asking.
private struct QuestionLine: View {
    let question: String
    let number: Int?
    let size: CGFloat
    let lines: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: number.map { "\($0).circle.fill" } ?? "person.wave.2.fill")
                .foregroundStyle(.secondary)
                .frame(width: size, alignment: .center)
            Text(question)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
                .lineLimit(lines)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: size))
    }
}

/// An exchange in compact form: each question, then what to say, that the answer is coming, or that
/// it isn't a question for the speaker (dimmed). Questions noticed with Auto off get Prepare Answer.
private struct ExchangeRow: View {
    let exchange: Exchange
    let size: CGFloat
    let expand: () -> Void
    let prepare: () -> Void

    private var questionSize: CGFloat { max(size - 2, 12) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: expand) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(exchange.answers.enumerated()), id: \.element.id) { index, answer in
                        VStack(alignment: .leading, spacing: 2) {
                            QuestionLine(question: answer.question, number: exchange.answers.count > 1 ? index + 1 : nil,
                                         size: questionSize, lines: 2)
                            status(answer).padding(.leading, questionSize + 8)
                        }
                        .opacity(answer.isNotAQuestion ? 0.5 : 1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Show in full")
            if exchange.waiting {
                Button("Prepare Answer", action: prepare)
                    .buttonStyle(AccentCapsuleStyle())
                    .padding(.leading, questionSize + 8)
                    .help("Ask Claude what to say")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder private func status(_ answer: Answer) -> some View {
        let small = Font.system(size: max(size - 3, 11))
        if !answer.requested {
            EmptyView()
        } else if let error = answer.error {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(small)
                .foregroundStyle(.orange)
                .lineLimit(1)
        } else if answer.isNotAQuestion {
            Text("Not a question for you")
                .font(small)
                .foregroundStyle(.tertiary)
        } else if let line = answer.firstLine {
            Text(line)
                .font(.system(size: questionSize))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(answer.opener ?? "Thinking…").lineLimit(1)
            }
            .font(small)
            .foregroundStyle(.secondary)
        }
    }
}

/// An exchange in full: each question with its answer, numbered when several were asked in one go.
private struct ExchangeCard: View {
    let exchange: Exchange
    let size: CGFloat
    let lexicon: Lexicon
    let prepare: () -> Void
    let answerAnyway: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(exchange.answers.enumerated()), id: \.element.id) { index, answer in
                if index > 0 { Divider() }
                AnswerContent(answer: answer, number: exchange.answers.count > 1 ? index + 1 : nil,
                              size: size, lexicon: lexicon) { answerAnyway(answer.question) }
            }
            if exchange.waiting {
                Button("Prepare Answer", action: prepare)
                    .buttonStyle(AccentCapsuleStyle())
                    .help("Ask Claude what to say")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 16))
    }
}

private struct AnswerContent: View {
    let answer: Answer
    let number: Int?
    let size: CGFloat
    let lexicon: Lexicon
    let answerAnyway: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            QuestionLine(question: answer.question, number: number, size: size, lines: 6)

            if !answer.requested {
                EmptyView()
            } else if answer.isNotAQuestion {
                Text("Doesn't sound like a question for you.")
                    .font(.system(size: size))
                    .foregroundStyle(.secondary)
                Button("Answer Anyway", action: answerAnyway)
                    .buttonStyle(.glass)
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
                Text(state.preferences.autoAnswer
                     ? "When someone asks a question, what to say appears here.\n⌃⌥⏎ answers the last thing said."
                     : "When someone asks a question, it appears here for Prepare Answer.\n⌃⌥⏎ answers the last thing said.")
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
