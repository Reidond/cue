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
                    LabeledContent("Used this month", value: "\(me.usage.usd.formatted(.currency(code: "USD"))) · \(Int(me.usage.audioSeconds / 60)) min of audio")
                    LabeledContent("Monthly limit", value: me.limits.monthlyUsd.map { $0.formatted(.currency(code: "USD")) } ?? "None set")
                } header: {
                    Text("Usage")
                } footer: {
                    Text("What the Cue plan spent on your calls this month, counted in US dollars from the models and speech recognition it used.")
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
}
