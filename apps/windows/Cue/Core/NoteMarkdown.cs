using System.Globalization;
using System.Text.RegularExpressions;

namespace Cue;

/// <summary>
/// A note as Markdown: the copy Cue keeps in the project's `Notes` folder (YAML front matter, the title, the summary, and the transcript after an HTML
/// comment marker), written from the account's note and, for the notes a PC had before it had an account, read back into one.
/// </summary>
public static partial class NoteMarkdown
{
    /// <summary>0:42 → "1 min"; under a minute "&lt;1 min"; "1 hr, 5 min".</summary>
    public static string Duration(double seconds)
    {
        var minutes = (int)Math.Round(seconds / 60, MidpointRounding.AwayFromZero);
        if (minutes <= 0) return "<1 min";
        var hours = minutes / 60;
        minutes %= 60;
        return string.Join(", ", new[] { hours > 0 ? $"{hours} hr" : null, minutes > 0 ? $"{minutes} min" : null }.OfType<string>());
    }

    /// <summary>00:12:05, the way a transcript turn starts.</summary>
    public static string Offset(double seconds)
    {
        var whole = Math.Max(0, (int)seconds);
        return string.Create(CultureInfo.InvariantCulture, $"{whole / 3600:00}:{whole / 60 % 60:00}:{whole % 60:00}");
    }

    public static string Stamp(DateTime date) => date.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>
    /// The file's text for `note`. `stamp` is the note's `date:` (kept as it was written), `audio` the file name of the local audio next to it, `audioOnline`
    /// that the account still has the audio and the player may stream it. `existing` is the file's text when the note has no transcript of its own (the live
    /// transcript this PC saved is the better one then).
    /// </summary>
    public static string Render(RemoteNote note, string project, string stamp, string? audio, bool audioOnline, string? existing = null)
    {
        var front = new List<string>
        {
            $"title: {RecordingFile.Quoted(note.Title)}",
            $"date: {stamp}",
            $"duration: {Duration(note.DurationSeconds)}",
            $"participants: {string.Join(", ", note.Participants)}",
            $"project: {RecordingFile.Quoted(project)}",
        };
        if (note.Meeting is { } meeting)
        {
            front.Add($"event: {RecordingFile.Quoted(meeting.Title)}");
            front.Add($"attendees: {RecordingFile.List(meeting.Attendees)}");
        }
        if (audio is not null) front.Add($"audio: {RecordingFile.Quoted(audio)}");
        else if (audioOnline) front.Add("audio-online: yes");
        if (note.Suggestions.Count > 0) front.Add($"suggestions: {RecordingFile.Names(note.Suggestions)}");
        front.Add($"note: {note.Id}");

        var summary = note.Summary.Trim();
        var transcript = $"{RecordingFile.TranscriptMarker}\n## {note.TranscriptHeading}\n\n"
            + string.Join("\n\n", note.Transcript.Select(turn => $"**{Offset(turn.Start)} · {turn.Label}**\n{turn.Text}")) + "\n";
        if (note.Transcript.Count == 0 && existing is not null && existing.IndexOf(RecordingFile.TranscriptMarker, StringComparison.Ordinal) is var marker and >= 0)
            transcript = existing[marker..];
        return "---\n" + string.Join("\n", front) + $"\n---\n\n# {note.Title}\n\n" + (summary.Length == 0 ? "" : summary + "\n\n") + transcript;
    }

    [GeneratedRegex(@"^\*\*(\d+):(\d{2}):(\d{2}) · (.+)\*\*$")]
    private static partial Regex SpeakerLine();

    [GeneratedRegex(@" (\d+)$")]
    private static partial Regex Numbered();

    [GeneratedRegex(@"(\d+)\s*(\p{L})")]
    private static partial Regex DurationPart();

    /// <summary>
    /// The account's note for a file of the library that was written before there was one: its front matter, summary and transcript taken apart.
    /// Null when the file isn't a note Cue wrote.
    /// </summary>
    public static NoteImportBody? ImportBody(string text, Project project, string stamp)
    {
        var front = RecordingFile.FrontMatter(text);
        if (!front.TryGetValue("title", out var title) || !DateTime.TryParse(stamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
            || project.ServerId is not { } serverId || !text.StartsWith("---\n", StringComparison.Ordinal))
            return null;
        var end = text.IndexOf("\n---\n", 3, StringComparison.Ordinal);
        if (end < 0) return null;
        var body = text[(end + 5)..];
        var marker = body.IndexOf(RecordingFile.TranscriptMarker, StringComparison.Ordinal);
        var head = marker >= 0 ? body[..marker] : body;
        var tail = marker >= 0 ? body[(marker + RecordingFile.TranscriptMarker.Length)..] : "";

        // The summary is everything between the H1 title and the transcript.
        var summaryLines = head.Split('\n').ToList();
        var heading = summaryLines.FindIndex(line => line.StartsWith("# ", StringComparison.Ordinal));
        if (heading >= 0) summaryLines.RemoveRange(0, heading + 1);
        var summary = string.Join("\n", summaryLines).Trim();
        if (summary == "_…_") summary = "";

        var participants = RecordingFile.Participants(front.GetValueOrDefault("participants"));
        var speaker = participants.FirstOrDefault() ?? "You";
        var transcriptHeading = Lexicon.Load(project.Language).TranscriptHeading;
        var turns = new List<RemoteTurn>();
        (double Start, string Label, List<string> Lines)? current = null;
        void Flush()
        {
            if (current is not { } turn) return;
            current = null;
            var isMe = turn.Label == speaker;
            var number = Numbered().Match(turn.Label) is { Success: true } numbered ? int.Parse(numbered.Groups[1].Value, CultureInfo.InvariantCulture) : (int?)null;
            turns.Add(new RemoteTurn(isMe ? "me" : "others", isMe ? null : number, turn.Label, turn.Start, string.Join(" ", turn.Lines)));
        }
        foreach (var raw in tail.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (SpeakerLine().Match(line) is { Success: true } match)
            {
                Flush();
                var seconds = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) * 3600
                    + double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture) * 60
                    + double.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
                current = (seconds, match.Groups[4].Value, new List<string>());
            }
            else if (current is not null)
            {
                if (line.Trim().Length == 0) Flush();
                else current.Value.Lines.Add(line);
            }
            else if (line.StartsWith("## ", StringComparison.Ordinal))
            {
                transcriptHeading = line[3..].Trim();
            }
        }
        Flush();

        var meeting = front.TryGetValue("event", out var eventTitle) ? new RemoteMeeting(eventTitle, [.. RecordingFile.ListOf(front.GetValueOrDefault("attendees"))]) : null;
        return new NoteImportBody(
            stamp,
            serverId,
            title,
            new DateTimeOffset(date, TimeSpan.Zero).ToUnixTimeMilliseconds(),
            Seconds(front.GetValueOrDefault("duration")) ?? turns.LastOrDefault()?.Start ?? 0,
            project.Language,
            speaker,
            meeting,
            participants.Count == 0 ? [speaker] : participants,
            summary,
            transcriptHeading,
            turns,
            RecordingFile.Names(front.GetValueOrDefault("suggestions")));
    }

    /// <summary>"1 hr, 5 min", "12 min", "&lt;1 min" read back (the units begin with h or г for hours, m or х for minutes); null when there is nothing to read.</summary>
    private static double? Seconds(string? duration)
    {
        if (string.IsNullOrEmpty(duration)) return null;
        if (duration.StartsWith('<')) return 30;
        double total = 0;
        var found = false;
        foreach (Match match in DurationPart().Matches(duration))
        {
            var number = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            switch (match.Groups[2].Value.ToLowerInvariant())
            {
                case "h" or "г":
                    total += number * 3600;
                    break;
                case "m" or "х":
                    total += number * 60;
                    break;
                default:
                    continue;
            }
            found = true;
        }
        return found ? total : null;
    }
}
