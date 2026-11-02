using System.Runtime.InteropServices;
using System.Text.Json;
using Windows.ApplicationModel.Appointments;

namespace Cue;

/// <summary>Whether Cue can read a calendar: it can, Windows' calendar privacy setting is off for desktop apps, or there is no calendar service to ask.</summary>
public enum CalendarAccess
{
    Granted,
    Denied,
    Unavailable,
}

/// <summary>A calendar Cue may look in for calls.</summary>
public sealed record CalendarSource(string Id, string Title, string Account);

/// <summary>
/// Reads today's and tomorrow's calls from the calendars the person watches: Windows' own appointment store (`AppointmentManager`: the calendars of the
/// accounts Windows keeps and of the apps that write there; a desktop program needs no package or sign-in of its own to read it, only the calendar privacy
/// setting to be on). CUE_CALENDAR_EVENTS=file.json stands in for the store in tests and is read again on every refresh. The Mac's `MeetingCalendar`.
/// </summary>
public sealed class MeetingCalendar : Observable
{
    /// <summary>Where calendar recordings go unless their series was given a project on Upcoming.</summary>
    public const string DefaultProject = "Meetings";

    /// <summary>How long the store's answer is kept: asking it is a request to the system's calendar service.</summary>
    private static readonly TimeSpan StoreEvery = TimeSpan.FromSeconds(15);

    private readonly Preferences preferences;
    private readonly string? fixture = Env.Get("CUE_CALENDAR_EVENTS");
    private AppointmentStore? store;
    private DateTime storeRead = DateTime.MinValue;
    private bool refreshing;
    private CalendarAccess access;
    private IReadOnlyList<CalendarSource> calendars = [];
    private IReadOnlyList<CalendarEvent> events = [];
    private string signature = "";

    public MeetingCalendar(Preferences preferences)
    {
        this.preferences = preferences;
        access = CalendarAccess.Granted;
    }

    /// <summary>The calendar comes from a file, not from Windows (a test run).</summary>
    public bool FromFile => fixture is not null;

    public CalendarAccess Access
    {
        get => access;
        private set => Set(ref access, value);
    }

    public IReadOnlyList<CalendarSource> Calendars
    {
        get => calendars;
        private set => Set(ref calendars, value);
    }

    /// <summary>Calls in the watched calendars, by start time.</summary>
    public IReadOnlyList<CalendarEvent> Events
    {
        get => events;
        private set => Set(ref events, value);
    }

    public async Task Refresh(bool force = false)
    {
        if (refreshing) return;
        refreshing = true;
        try
        {
            var day = new DateTimeOffset(DateTime.Today);
            var length = TimeSpan.FromDays(2);
            CalendarAccess now;
            List<CalendarSource> sources;
            List<CalendarEvent> found;
            if (fixture is not null)
            {
                now = CalendarAccess.Granted;
                (sources, found) = ReadFile(fixture);
            }
            else
            {
                // A look at the store a moment ago is as good as another; the page and the settings ask for a fresh one.
                if (!force && DateTime.UtcNow - storeRead < StoreEvery) return;
                storeRead = DateTime.UtcNow;
                (now, sources, found) = await ReadStore(day, length);
            }
            sources.Sort((a, b) => (a.Account, a.Title, a.Id).CompareTo((b.Account, b.Title, b.Id)));
            var watched = found
                .Where(item => !preferences.UnwatchedCalendars.Contains(item.Calendar) && item.End > day && item.Start < day + length)
                .OrderBy(item => item.Start)
                .ToList();
            var seen = $"{now}|{string.Join(',', sources.Select(source => source.Id))}|{string.Join(',', watched.Select(item => $"{item.Id}@{item.Start:O}-{item.End:O}:{item.Title}:{item.Link}:{string.Join('/', item.Attendees)}"))}";
            Access = now;
            if (seen == signature) return;
            signature = seen;
            Calendars = sources;
            Events = watched;
        }
        finally
        {
            refreshing = false;
        }
    }

    // MARK: Projects

    /// <summary>The project folder picked for an event's series on Upcoming, if any.</summary>
    public string? AssignedProject(CalendarEvent item) => preferences.MeetingProjects.GetValueOrDefault(item.Series);

    public void Assign(CalendarEvent item, string project)
    {
        preferences.AssignMeetingProject(item.Series, project);
        Raise(nameof(Events));
    }

    /// <summary>Keeps the picks when a project's folder is renamed.</summary>
    public void ProjectRenamed(string old, string renamed)
    {
        preferences.RenameMeetingProject(old, renamed);
        Raise(nameof(Events));
    }

    // MARK: Windows' appointment store

    private async Task<(CalendarAccess, List<CalendarSource>, List<CalendarEvent>)> ReadStore(DateTimeOffset start, TimeSpan length)
    {
        try
        {
            store ??= await AppointmentManager.RequestStoreAsync(AppointmentStoreAccessType.AllCalendarsReadOnly);
            if (store is null) return (CalendarAccess.Denied, [], []);
            var all = await store.FindAppointmentCalendarsAsync();
            var sources = all.Select(calendar => new CalendarSource(calendar.LocalId, calendar.DisplayName, calendar.SourceDisplayName)).ToList();
            var watched = all.Where(calendar => !preferences.UnwatchedCalendars.Contains(calendar.LocalId)).Select(calendar => calendar.LocalId).ToHashSet();
            if (watched.Count == 0) return (CalendarAccess.Granted, sources, []);
            // The store hands back only the properties asked for: the link is often in the details, and the attendees are the invitees.
            var options = new FindAppointmentsOptions();
            foreach (var property in AppointmentProperties.DefaultProperties) options.FetchProperties.Add(property);
            foreach (var property in new[] { AppointmentProperties.Details, AppointmentProperties.OnlineMeetingLink, AppointmentProperties.Uri, AppointmentProperties.Invitees })
                if (!options.FetchProperties.Contains(property)) options.FetchProperties.Add(property);
            var found = await store.FindAppointmentsAsync(start, length, options);
            return (CalendarAccess.Granted, sources, [.. found.Where(item => watched.Contains(item.CalendarId)).Select(Of).OfType<CalendarEvent>()]);
        }
        catch (UnauthorizedAccessException)
        {
            store = null;
            return (CalendarAccess.Denied, [], []);
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or FileNotFoundException)
        {
            // No calendar service (Windows Server, a stripped image), or it is restarting: the next look tries again.
            store = null;
            return (CalendarAccess.Unavailable, [], []);
        }
    }

    /// <summary>An appointment as a call: null unless it is a timed one with a call link and was not cancelled.</summary>
    private static CalendarEvent? Of(Appointment item)
    {
        if (item.AllDay || item.IsCanceledMeeting) return null;
        if (CallServices.LinkIn(item.OnlineMeetingLink, item.Uri?.AbsoluteUri, item.Location, item.Details) is not { } link) return null;
        var series = string.IsNullOrEmpty(item.RoamingId) ? item.LocalId : item.RoamingId;
        var attendees = item.Invitees.Select(person => string.IsNullOrEmpty(person.DisplayName) ? person.Address : person.DisplayName).Where(name => !string.IsNullOrEmpty(name)).ToList();
        return new CalendarEvent(
            $"{series}/{item.StartTime.ToUnixTimeSeconds()}",
            series,
            string.IsNullOrEmpty(item.Subject) ? "Meeting" : item.Subject,
            item.StartTime,
            item.StartTime + item.Duration,
            item.CalendarId,
            attendees,
            link.Url,
            link.Service,
            item.Recurrence is not null);
    }

    // MARK: The test file

    /// <summary>One event in a CUE_CALENDAR_EVENTS file. Only title, start and end are required; the calendar (by name) defaults to "Calendar" and the series to the event's id or title.</summary>
    private sealed record FileEvent(
        string? Id,
        string? Series,
        string Title,
        DateTimeOffset Start,
        DateTimeOffset End,
        string? Calendar,
        string? Url,
        string? Location,
        string? Notes,
        List<string>? Attendees,
        bool? Recurring);

    private static (List<CalendarSource>, List<CalendarEvent>) ReadFile(string path)
    {
        List<FileEvent> items;
        try
        {
            items = JsonSerializer.Deserialize<List<FileEvent>>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? [];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return ([], []);
        }
        var sources = items.Select(item => item.Calendar ?? "Calendar").Distinct().Select(name => new CalendarSource(name, name, "CUE_CALENDAR_EVENTS")).ToList();
        var found = new List<CalendarEvent>();
        foreach (var item in items)
        {
            if (CallServices.LinkIn(item.Url, item.Location, item.Notes) is not { } link) continue;
            var series = item.Series ?? item.Id ?? item.Title;
            found.Add(new CalendarEvent(
                item.Id ?? $"{series}/{item.Start.ToUnixTimeSeconds()}",
                series,
                item.Title,
                item.Start,
                item.End,
                item.Calendar ?? "Calendar",
                item.Attendees ?? [],
                link.Url,
                link.Service,
                item.Recurring ?? false));
        }
        return (sources, found);
    }
}
