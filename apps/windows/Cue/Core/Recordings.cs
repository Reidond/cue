using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Cue;

/// <summary>What started or stopped a recording. The session log names it, so notes that end early say why.</summary>
public enum RecordingTrigger
{
    HotKey,
    Overlay,
    Dashboard,
    Tray,
    Upcoming,
    Notification,
    CallNoticed,
    CallEnded,
    Rehearsal,
}

public static class RecordingTriggers
{
    public static string Text(this RecordingTrigger trigger) =>
        trigger switch
        {
            RecordingTrigger.HotKey => "Win+Alt+C",
            RecordingTrigger.Overlay => "overlay",
            RecordingTrigger.Dashboard => "dashboard",
            RecordingTrigger.Tray => "notification area",
            RecordingTrigger.Upcoming => "Upcoming",
            RecordingTrigger.Notification => "Record in the notification",
            RecordingTrigger.CallNoticed => "call noticed",
            RecordingTrigger.CallEnded => "call ended",
            _ => "rehearsal",
        };
}

/// <summary>
/// Collects the transcript while a call is being recorded. Lines keep arriving for a moment after Stop, because the last phrase is still being
/// transcribed. UI thread only.
/// </summary>
public sealed class CallRecorder : Observable
{
    private DateTime? startedAt;
    private DateTime? endedAt;
    private bool stopping;
    private List<Utterance> lines = [];

    public DateTime? StartedAt
    {
        get => startedAt;
        private set => Set(ref startedAt, value);
    }

    /// <summary>Stopped, and waiting for the last phrase to be transcribed.</summary>
    public bool Stopping
    {
        get => stopping;
        private set => Set(ref stopping, value);
    }

    public bool IsRecording => StartedAt is not null && !Stopping;

    /// <summary>Returns the start, which is also where the call's audio begins.</summary>
    public DateTime Start()
    {
        var now = DateTime.Now;
        lines = [];
        endedAt = null;
        Stopping = false;
        StartedAt = now;
        return now;
    }

    public void Add(Utterance utterance)
    {
        if (startedAt is not { } start || utterance.Time < start || utterance.Started >= (endedAt ?? DateTime.MaxValue)) return;
        lines.Add(utterance);
    }

    /// <summary>Returns the end of the recording.</summary>
    public DateTime BeginStop()
    {
        var now = DateTime.Now;
        endedAt = now;
        Stopping = true;
        return now;
    }

    public CallTranscript? Finish()
    {
        var start = startedAt;
        var ended = endedAt;
        var heard = lines;
        lines = [];
        endedAt = null;
        Stopping = false;
        StartedAt = null;
        return start is { } began ? new CallTranscript(began, ended ?? DateTime.Now, [.. heard.OrderBy(line => line.Started)]) : null;
    }
}

public sealed record CallTranscript(DateTime StartedAt, DateTime EndedAt, IReadOnlyList<Utterance> Lines)
{
    /// <summary>Consecutive lines from the same speaker with short pauses become one paragraph.</summary>
    private List<(Side Side, DateTime Started, string Text)> Turns()
    {
        var turns = new List<(Side Side, DateTime Started, DateTime Ended, string Text)>();
        foreach (var line in Lines)
        {
            if (turns.Count > 0 && turns[^1].Side == line.Side && (line.Started - turns[^1].Ended).TotalSeconds < 4)
                turns[^1] = (turns[^1].Side, turns[^1].Started, line.Time, turns[^1].Text + " " + line.Text);
            else
                turns.Add((line.Side, line.Started, line.Time, line.Text));
        }
        return [.. turns.Select(turn => (turn.Side, turn.Started, turn.Text))];
    }

    private string Offset(DateTime date) => NoteMarkdown.Offset((date - StartedAt).TotalSeconds);

    /// <summary>`names` labels a side.</summary>
    public string Markdown(Func<Side, string> names) => string.Join("\n\n", Turns().Select(turn => $"**{Offset(turn.Started)} · {names(turn.Side)}**\n{turn.Text}"));
}

/// <summary>
/// A saved recording: Markdown with YAML front matter, the summary, and the transcript after an HTML comment marker so the summary can be replaced later.
/// </summary>
public sealed record RecordingFile(
    string Path,
    string Id,
    string Title,
    DateTime Date,
    string Duration,
    string? Audio,
    IReadOnlyDictionary<string, string> Suggestions,
    string? NoteId,
    bool StreamsAudio)
{
    public const string TranscriptMarker = "<!-- transcript -->";

    public bool HasAudio => Audio is not null || StreamsAudio;

    /// <summary>Folder name of the project the note belongs to (`PROJECT\Notes\NOTE.md`).</summary>
    public string ProjectId => System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(System.IO.Path.GetDirectoryName(Path)) ?? "");

    /// <summary>Each side of the call on its own (`mic.wav`, `call.wav`), there while the note is being processed.</summary>
    public string WorkingAudio => AudioRecorder.WorkingFolder(Date);

    /// <summary>The note's identity, which stays the same when its title (and file name) changes: its project folder and start time.</summary>
    public static string IdOf(string project, string stamp) => $"{project}/{stamp}";

    public static RecordingFile? Load(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        var front = FrontMatter(text);
        if (!front.TryGetValue("date", out var stamp)
            || !DateTime.TryParse(stamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date))
            return null;
        var folder = System.IO.Path.GetDirectoryName(path) ?? "";
        var project = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(folder) ?? "");
        string? audio = front.TryGetValue("audio", out var name) ? System.IO.Path.Combine(folder, name) : null;
        return new RecordingFile(
            path,
            IdOf(project, stamp),
            front.GetValueOrDefault("title") ?? System.IO.Path.GetFileNameWithoutExtension(path),
            date,
            front.GetValueOrDefault("duration") ?? "",
            audio is not null && File.Exists(audio) ? audio : null,
            Names(front.GetValueOrDefault("suggestions")),
            front.GetValueOrDefault("note"),
            front.GetValueOrDefault("audio-online") == "yes");
    }

    public static string Quoted(string value) => "\"" + value.Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    /// <summary>A list of names as YAML (and JSON): `["Olena Mulesa", "Petro Ivanenko"]`.</summary>
    public static string List(IEnumerable<string> values) => "[" + string.Join(", ", values.Select(Quoted)) + "]";

    public static IReadOnlyList<string> ListOf(string? value)
    {
        try
        {
            return value is null ? [] : JsonSerializer.Deserialize<string[]>(value) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>Names by label as YAML (and JSON): `{"Participant 1": "Olena Mulesa"}`.</summary>
    public static string Names(IReadOnlyDictionary<string, string> values) =>
        "{" + string.Join(", ", values.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{Quoted(pair.Key)}: {Quoted(pair.Value)}")) + "}";

    public static IReadOnlyDictionary<string, string> Names(string? value)
    {
        try
        {
            return value is null ? new Dictionary<string, string>() : JsonSerializer.Deserialize<Dictionary<string, string>>(value) ?? [];
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }

    /// <summary>The people in the note's `participants:`, the user first.</summary>
    public static IReadOnlyList<string> Participants(string? value) =>
        [.. (value ?? "").Split(", ").Select(name => name.Trim()).Where(name => name.Length > 0)];

    /// <summary>Sets (or, with null, removes) one key of a note's front matter.</summary>
    public static string Setting(string key, string? value, string text)
    {
        if (!text.StartsWith("---\n", StringComparison.Ordinal)) return text;
        var end = text.IndexOf("\n---\n", 3, StringComparison.Ordinal);
        if (end < 0) return text;
        var lines = text[4..end].Split('\n').ToList();
        var index = lines.FindIndex(line => line.StartsWith(key + ":", StringComparison.Ordinal));
        switch (index, value)
        {
            case ( >= 0, not null):
                lines[index] = $"{key}: {value}";
                break;
            case ( >= 0, null):
                lines.RemoveAt(index);
                break;
            case (_, not null):
                lines.Add($"{key}: {value}");
                break;
            default:
                return text;
        }
        return "---\n" + string.Join("\n", lines) + text[end..];
    }

    public static Dictionary<string, string> FrontMatter(string text)
    {
        var lines = text.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var values = new Dictionary<string, string>();
        if (lines.Length == 0 || lines[0] != "---") return values;
        var end = Array.IndexOf(lines, "---", 1);
        if (end < 0) return values;
        foreach (var line in lines[1..end])
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon < 0) continue;
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            if (value.Length >= 2 && value.StartsWith('"') && value.EndsWith('"')) value = value[1..^1];
            values[key] = value.Replace("\\\"", "\"", StringComparison.Ordinal);
        }
        return values;
    }
}

/// <summary>The calendar event a call was recorded for: the note is named after it, and its attendees go into the front matter and the summary prompt.</summary>
public sealed record MeetingDetails(string Title, IReadOnlyList<string> Attendees);

/// <summary>What a new note goes through after Stop, in order; its page lists them as they happen. The live transcript is saved before any of them, so a step that fails loses nothing.</summary>
public enum NoteStep
{
    SavingAudio,
    UploadingRecording,
    ImprovingTranscript,
    FindingSpeakers,
    WritingSummary,
}

public static class NoteSteps
{
    public static string Title(this NoteStep step) =>
        step switch
        {
            NoteStep.SavingAudio => "Saving audio",
            NoteStep.UploadingRecording => "Uploading recording",
            NoteStep.ImprovingTranscript => "Improving transcript",
            NoteStep.FindingSpeakers => "Finding speakers",
            _ => "Writing summary",
        };
}

public enum StepState
{
    Pending,
    Running,
    Done,
    Failed,
}

/// <summary>One step of a note being processed, with how far it has got (when the step knows) or why it failed.</summary>
public sealed class NoteProgress(NoteStep step, StepState state, string? detail = null)
{
    public NoteStep Step { get; } = step;
    public StepState State { get; set; } = state;
    public string? Detail { get; set; } = detail;

    public bool IsFinished => State is StepState.Done or StepState.Failed;
    public bool Failed => State == StepState.Failed;
}
