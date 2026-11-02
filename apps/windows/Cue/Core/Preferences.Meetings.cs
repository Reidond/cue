using System.Text.Json.Nodes;

namespace Cue;

/// <summary>The preferences of calls from the calendar: what Cue does when one starts, which calendars it looks in, and the project each recurring call goes to.</summary>
public sealed partial class Preferences
{
    private MeetingAction? meetingAction;
    private HashSet<string>? unwatchedCalendars;
    private Dictionary<string, string>? meetingProjects;

    /// <summary>When a call starts: ask to record it, record it, or do nothing.</summary>
    public MeetingAction MeetingAction
    {
        get => meetingAction ??= MeetingActions.Parse(file.String("meetingAction"));
        set
        {
            if (MeetingAction == value) return;
            meetingAction = value;
            file.Set("meetingAction", value.Key());
            Raise();
        }
    }

    /// <summary>Calendars Cue doesn't look in for calls, by id; new calendars are watched.</summary>
    public IReadOnlySet<string> UnwatchedCalendars =>
        unwatchedCalendars ??= file.Node("unwatchedCalendars") is JsonArray array
            ? [.. array.Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : null).OfType<string>()]
            : [];

    public void SetWatched(string calendar, bool watched)
    {
        var set = (HashSet<string>)UnwatchedCalendars;
        if (watched ? !set.Remove(calendar) : !set.Add(calendar)) return;
        file.Set("unwatchedCalendars", new JsonArray([.. set.OrderBy(name => name, StringComparer.Ordinal).Select(name => (JsonNode?)JsonValue.Create(name))]));
        Raise(nameof(UnwatchedCalendars));
    }

    /// <summary>The project folder picked for each series of recurring calls on Upcoming, by the series' id.</summary>
    public IReadOnlyDictionary<string, string> MeetingProjects =>
        meetingProjects ??= file.Node("meetingProjects") is JsonObject projects
            ? projects.Select(pair => (pair.Key, Value: pair.Value is JsonValue value && value.TryGetValue<string>(out var text) ? text : null)).Where(pair => pair.Value is not null).ToDictionary(pair => pair.Key, pair => pair.Value!)
            : [];

    private void SaveMeetingProjects()
    {
        var projects = (Dictionary<string, string>)MeetingProjects;
        var saved = new JsonObject();
        foreach (var (series, project) in projects.OrderBy(pair => pair.Key, StringComparer.Ordinal)) saved[series] = project;
        file.Set("meetingProjects", saved);
        Raise(nameof(MeetingProjects));
    }

    public void AssignMeetingProject(string series, string project)
    {
        var projects = (Dictionary<string, string>)MeetingProjects;
        if (projects.TryGetValue(series, out var current) && current == project) return;
        projects[series] = project;
        SaveMeetingProjects();
    }

    /// <summary>Keeps the picks when a project's folder is renamed.</summary>
    public void RenameMeetingProject(string old, string renamed)
    {
        var projects = (Dictionary<string, string>)MeetingProjects;
        var changed = false;
        foreach (var series in projects.Where(pair => pair.Value == old).Select(pair => pair.Key).ToList())
        {
            projects[series] = renamed;
            changed = true;
        }
        if (changed) SaveMeetingProjects();
    }
}
