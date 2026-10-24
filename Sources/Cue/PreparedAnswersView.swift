import SwiftUI

/// The question-and-answer pairs Cue found in a project's materials, so the user
/// can check what it picked up before the talk.
struct PreparedAnswersView: View {
    let answers: [PreparedAnswer]
    let reading: Bool
    @State private var search = ""

    private var filtered: [PreparedAnswer] {
        guard !search.isEmpty else { return answers }
        return answers.filter {
            $0.q.localizedCaseInsensitiveContains(search) || $0.a.localizedCaseInsensitiveContains(search)
                || ($0.who?.localizedCaseInsensitiveContains(search) ?? false)
        }
    }

    var body: some View {
        List(filtered, id: \.self) { item in
            PreparedAnswerRow(item: item)
        }
        .searchable(text: $search, prompt: "Search questions and answers")
        .overlay {
            if answers.isEmpty {
                if reading {
                    ProgressView("Reading materials…")
                } else {
                    ContentUnavailableView("No Prepared Answers", systemImage: "text.book.closed",
                                           description: Text("Add a document with lines like “Q: …” followed by “A: …”, or questions followed by an “Answer:” line, and they show up here."))
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
