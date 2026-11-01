import SwiftUI

/// Shows `content` while someone is signed in to Cue, and the sign-in screen until then.
struct SignInGate<Content: View>: View {
    @ObservedObject var api: CueAPI
    let content: Content

    init(api: CueAPI, @ViewBuilder content: () -> Content) {
        self.api = api
        self.content = content()
    }

    var body: some View {
        if api.isSignedIn {
            content
        } else {
            SignInView(api: api)
        }
    }
}

/// Home before anyone is signed in: Cue is for invited people, and nothing else works until they are.
struct SignInView: View {
    @ObservedObject var api: CueAPI

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(.tint)
            Text("Sign in to Cue")
                .font(.title.weight(.semibold))
            Text("Cue is invite-only. Sign in with the Google or GitHub account your invitation went to.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 440)
            if let problem = api.problem {
                Text(problem)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: 440)
            }
            if api.phase == .restoring || api.phase == .signingIn {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(api.phase == .restoring ? "Signing in…" : "Continue in the sign-in window…").foregroundStyle(.secondary)
                }
                .padding(.top, 6)
            } else {
                Button {
                    Task { await api.signIn() }
                } label: {
                    Label("Sign In", systemImage: "arrow.right.circle").padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.extraLarge)
                .padding(.top, 6)
            }
            Text("Cue's servers do the listening, answering and note-taking, so a call's audio, transcript and notes are processed and kept there, not only on this Mac.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 440)
                .padding(.top, 10)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

/// Account: who is signed in, the plan, this month's usage, and Sign Out.
struct AccountSettings: View {
    @ObservedObject var api: CueAPI

    var body: some View {
        Form {
            if let me = api.me, api.isSignedIn {
                Section {
                    LabeledContent("Signed in as", value: me.account.email)
                    if me.account.name != me.account.email { LabeledContent("Name", value: me.account.name) }
                    LabeledContent("Plan", value: me.plan.name)
                }
                Section {
                    UsageBar(usage: me.usage, limit: me.limits.monthlyUsd)
                    LabeledContent("Monthly limit", value: me.limits.monthlyUsd.map { $0.formatted(.currency(code: "USD")) } ?? "None set")
                    LabeledContent("Starts over", value: "\(me.usage.renewsText) (UTC)")
                    LabeledContent("Audio", value: "\(Int(me.usage.audioSeconds / 60)) min")
                } header: {
                    Text("Usage")
                } footer: {
                    Text(me.usage.limitReached
                        ? "You've used this month's allowance: Cue won't answer questions or write summaries until the month starts over or your limit is raised. Live transcripts and recordings are still kept."
                        : "What the Cue plan spent on your calls this month, counted in US dollars from the models and speech recognition it used.")
                }
                if !me.usage.byFeature.isEmpty {
                    Section("Where it went") {
                        ForEach(me.usage.byFeature, id: \.feature) { item in
                            LabeledContent(Self.name(of: item.feature), value: item.usd.formatted(.currency(code: "USD")))
                        }
                    }
                }
                Section {
                    Button("Sign Out", role: .destructive) { Task { await api.signOut() } }
                } footer: {
                    Text("Signing out ends this Mac's session. Your projects and notes stay as they are.")
                }
            } else {
                Section {
                    LabeledContent("Account", value: "Not signed in")
                    Button("Sign In") { Task { await api.signIn() } }
                        .disabled(api.phase == .signingIn || api.phase == .restoring)
                } footer: {
                    if let problem = api.problem { Text(problem).foregroundStyle(.orange) }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { Task { await api.refreshMe() } }
    }

    /// What a usage feature is called for people.
    private static func name(of feature: String) -> String {
        switch feature {
        case "answer": "Answers"
        case "question_judge": "Spotting questions"
        case "live_transcript": "Live transcript"
        case "note_transcript": "Transcript clean-up"
        case "note_names": "Suggested names"
        case "notes_summary": "Summaries"
        case "material_text": "Reading files"
        default: feature
        }
    }
}

/// This month's spend against the limit: a bar that turns orange near it and red at it, with the amounts.
private struct UsageBar: View {
    let usage: CueMe.Usage
    let limit: Double?

    var body: some View {
        let money = FloatingPointFormatStyle<Double>.Currency(code: "USD")
        if let limit, limit > 0 {
            ProgressView(value: min(usage.usd, limit), total: limit) {
                Text("Used this month")
            } currentValueLabel: {
                Text("\(usage.usd.formatted(money)) of \(limit.formatted(money))").monospacedDigit()
            }
            .tint(usage.limitReached ? Color.red : (usage.usd / limit > 0.8 ? Color.orange : Color.accentColor))
        } else {
            LabeledContent("Used this month", value: usage.usd.formatted(money))
        }
    }
}
