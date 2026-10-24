import SwiftUI

private let sayNowColor = Color(red: 0.55, green: 1.0, blue: 0.65)
private let questionColor = Color(red: 1.0, green: 0.86, blue: 0.4)
private let dimColor = Color.white.opacity(0.55)

struct OverlayView: View {
    @ObservedObject var state: AppState
    @State private var typed = ""
    @State private var showPrepared = true

    private var size: CGFloat { CGFloat(state.fontSize) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let error = state.fatalError {
                Text(error).foregroundStyle(.red).font(.system(size: size))
            }
            ScrollView {
                answerSection
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: .infinity)
            Divider().overlay(Color.white.opacity(0.2))
            transcript
            inputRow
        }
        .padding(14)
        .foregroundStyle(.white)
        .background(Color.black.opacity(state.opacity))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .ignoresSafeArea()  // use the transparent title-bar strip too
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Meter(label: "Mic", level: state.micLevel, status: state.mic)
            Meter(label: "Meet", level: state.systemLevel, status: state.meet)
            StatusDot(label: "Whisper", status: state.whisper)
            StatusDot(label: state.model.rawValue, status: state.claude)
            Spacer()
            Toggle("Auto", isOn: $state.autoAnswer)
                .toggleStyle(.switch).controlSize(.mini)
                .help("Answer participants' questions automatically (⌃⌥A)")
            if state.answers.count > 1 {
                Button { state.step(-1) } label: { Image(systemName: "chevron.left") }
                Text("\(state.selected + 1)/\(state.answers.count)").font(.caption).monospacedDigit()
                Button { state.step(1) } label: { Image(systemName: "chevron.right") }
            }
            Menu {
                Picker("Model", selection: $state.model) {
                    ForEach(ClaudeService.Model.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Toggle("Questions from the microphone (people in the room)", isOn: $state.micQuestions)
                Divider()
                Button("Larger text  ⌃⌥↑") { state.fontSize = min(state.fontSize + 1, 32) }
                Button("Smaller text  ⌃⌥↓") { state.fontSize = max(state.fontSize - 1, 11) }
                Picker("Background opacity", selection: $state.opacity) {
                    ForEach([1.0, 0.92, 0.85, 0.7, 0.55], id: \.self) { Text("\(Int($0 * 100))%").tag($0) }
                }
                Divider()
                Button("Restart Claude") { state.restartClaude() }
            } label: {
                Image(systemName: "gearshape")
            }
            .menuStyle(.borderlessButton).fixedSize()
        }
        .buttonStyle(.borderless)
        .font(.system(size: 12))
    }

    // MARK: Answer

    @ViewBuilder private var answerSection: some View {
        if let answer = state.current {
            VStack(alignment: .leading, spacing: 10) {
                Text("❓ " + answer.question)
                    .font(.system(size: size - 2))
                    .foregroundStyle(questionColor)
                    .lineLimit(4)

                if answer.isNotAQuestion {
                    Text("Doesn't look like a question for you. ⌃⌥⏎ answers anyway.")
                        .font(.system(size: size)).foregroundStyle(dimColor)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SAY NOW").font(.system(size: 10, weight: .bold)).foregroundStyle(sayNowColor.opacity(0.7))
                        Text(answer.sayNowDraft ?? answer.sayNow)
                            .font(.system(size: size + 5, weight: .semibold))
                            .foregroundStyle(sayNowColor)
                    }
                    if !answer.points.isEmpty {
                        Text(answer.points).font(.system(size: size)).lineSpacing(3)
                    } else if !answer.done {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(answer.text.isEmpty ? "Claude is preparing the answer…" : "Points coming…").foregroundStyle(dimColor)
                        }
                        .font(.system(size: size - 3))
                    }
                    if let error = answer.error {
                        Text("⚠︎ " + error).foregroundStyle(.orange).font(.system(size: size - 3))
                    }
                }

                if let prepared = answer.prepared {
                    VStack(alignment: .leading, spacing: 4) {
                        Button {
                            showPrepared.toggle()
                        } label: {
                            Text("\(showPrepared ? "▾" : "▸") Prepared answer\(prepared.who.map { " (\($0))" } ?? "") · \(Int(answer.preparedScore * 100))% match")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(dimColor)
                        }
                        .buttonStyle(.plain)
                        if showPrepared {
                            Text(prepared.a).font(.system(size: size - 3)).foregroundStyle(.white.opacity(0.8))
                        }
                    }
                    .padding(.top, 6)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("Listening. When a participant asks a question, what to say appears here.")
                    .font(.system(size: size)).foregroundStyle(dimColor)
                Text("⌃⌥⏎ answer now · ⌃⌥H hide · ⌃⌥A auto · ⌃⌥←/→ history · ⌃⌥↑/↓ text size")
                    .font(.system(size: 11)).foregroundStyle(dimColor)
            }
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(state.utterances.suffix(40)) { line in
                        (Text("[\(line.channel.rawValue)] ").bold() + Text(line.text))
                            .foregroundStyle(line.channel == .others ? questionColor.opacity(0.75) : dimColor)
                            .onTapGesture { state.ask(line.text, force: true) }
                            .help("Click to get an answer for this line")
                    }
                    ForEach([Channel.others, Channel.me], id: \.self) { channel in
                        if let live = state.partial[channel], !live.isEmpty {
                            (Text("[\(channel.rawValue)] ").bold() + Text(live)).italic().foregroundStyle(.white.opacity(0.35))
                        }
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .font(.system(size: max(size - 5, 10)))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 110)
            .onChange(of: state.utterances.count) { proxy.scrollTo("end") }
            .onChange(of: state.partial) { proxy.scrollTo("end") }
        }
    }

    private var inputRow: some View {
        HStack {
            TextField("Type a question and press Enter", text: $typed)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    let question = typed.trimmingCharacters(in: .whitespaces)
                    guard !question.isEmpty else { return }
                    state.ask(question, force: true)
                    typed = ""
                }
            Button("Answer now ⌃⌥⏎") { state.answerNow() }
        }
        .font(.system(size: 12))
    }
}

private struct Meter: View {
    let label: String
    let level: Float
    let status: ServiceStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(status.ok ? .green : .red).frame(width: 7, height: 7)
            Text(label)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.15))
                    Capsule().fill(Color.green.opacity(0.8))
                        .frame(width: geo.size.width * CGFloat(min(sqrt(level) * 3, 1)))
                }
            }
            .frame(width: 34, height: 4)
        }
        .help(status.detail)
    }
}

private struct StatusDot: View {
    let label: String
    let status: ServiceStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(status.ok ? .green : .orange).frame(width: 7, height: 7)
            Text(label)
        }
        .help(status.detail)
    }
}
