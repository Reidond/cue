import SwiftUI

/// The prepared answers of a project, so the person can check them before the talk: the ones written in their files, then the ones Cue
/// prepared from the materials for the questions people are likely to ask.
struct PreparedAnswersView: View {
    let answers: [PreparedAnswer]
    let reading: Bool
    let brief: ProjectBrief
    let hasMaterials: Bool
    @State private var search = ""

    private var filtered: [PreparedAnswer] {
        guard !search.isEmpty else { return answers }
        return answers.filter {
            $0.q.localizedCaseInsensitiveContains(search) || $0.a.localizedCaseInsensitiveContains(search)
                || ($0.who?.localizedCaseInsensitiveContains(search) ?? false)
        }
    }

    var body: some View {
        let own = filtered.filter { !$0.byCue }, prepared = filtered.filter(\.byCue)
        List {
            if !own.isEmpty {
                Section("From Your Files") {
                    ForEach(own, id: \.self) { PreparedAnswerRow(item: $0) }
                }
            }
            if !prepared.isEmpty || (brief.state == .working && !answers.isEmpty) {
                Section {
                    ForEach(prepared, id: \.self) { PreparedAnswerRow(item: $0) }
                } header: {
                    HStack(spacing: 6) {
                        Text("Prepared by Cue")
                        if brief.state == .working { ProgressView().controlSize(.mini) }
                    }
                }
            }
        }
        // On the page's own background, with the rows' text on the header's 28 pt margin
        // (the list insets it 18).
        .scrollContentBackground(.hidden)
        .padding(.leading, 10)
        .searchable(text: $search, prompt: "Search questions and answers")
        .overlay {
            if answers.isEmpty {
                if reading || brief.state == .working {
                    ProgressView("Preparing answers…")
                } else if brief.state == .failed {
                    ContentUnavailableView("Couldn't Prepare Answers", systemImage: "exclamationmark.triangle",
                                           description: Text(brief.error ?? "Cue couldn't read your materials."))
                } else {
                    ContentUnavailableView("No Prepared Answers", systemImage: "text.book.closed",
                                           description: Text(hasMaterials
                                               ? "Cue found no questions to prepare for in these files."
                                               : "Add your slides, documents or notes on the Overview, and Cue prepares answers to the questions people are likely to ask."))
                }
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
    }
}

private struct PreparedAnswerRow: View {
    let item: PreparedAnswer

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.q).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
            Text(item.a).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                if let who = item.who { Label(who, systemImage: "person"); Text("·") }
                Text(item.source)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}
