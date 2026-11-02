using Microsoft.UI.Dispatching;

namespace Cue;

/// <summary>
/// Notices calls: a watched calendar event in progress while a call app uses the microphone, or a call app (Zoom, Teams, …) on its own. Depending on the
/// preference it asks to record, records, or does nothing; a recording it started stops once the call app has let go of the microphone for a minute.
/// The port of the Mac's `MeetingMonitor`: the same checks, words and log lines. UI thread only.
/// </summary>
public sealed class MeetingMonitor : Observable
{
    /// <param name="Key">`event:OCCURRENCE` or `app:NAME`: what "don't ask again" is remembered by.</param>
    public sealed record Call(string Key, string Title, CalendarEvent? Event, CallApp? App);

    private readonly AppState state;
    private readonly MeetingNotifier notifier;
    private DispatcherQueueTimer? timer;
    private bool ticking;

    /// <summary>The call being recorded because Cue noticed it.</summary>
    private Call? recording;

    /// <summary>When that recording started, to tell it from one the person started by hand after stopping it.</summary>
    private DateTime? recordingStarted;

    /// <summary>Prompts waiting for an answer, oldest first.</summary>
    private readonly List<Call> asking = [];

    /// <summary>Calls answered or recorded: not asked about again.</summary>
    private readonly HashSet<string> settled = [];

    /// <summary>When each call was last going on; a call gone for the release window is over.</summary>
    private readonly Dictionary<string, DateTime> lastSeen = [];

    /// <summary>The last time a call app used the microphone during <see cref="recording"/>, and which one.</summary>
    private DateTime? heardAt;

    private CallApp? heardApp;

    /// <summary>Notes of calls Cue stopped itself, by id, until their summary is written.</summary>
    private readonly HashSet<string> waitingForNotes = [];

    // CUE_MEETING_TICK and CUE_MIC_RELEASE (seconds) shorten the check interval and the release window in tests.
    private readonly TimeSpan interval = TimeSpan.FromSeconds(double.TryParse(Env.Get("CUE_MEETING_TICK"), System.Globalization.CultureInfo.InvariantCulture, out var tick) && tick > 0 ? tick : 5);
    private readonly TimeSpan releaseAfter = TimeSpan.FromSeconds(double.TryParse(Env.Get("CUE_MIC_RELEASE"), System.Globalization.CultureInfo.InvariantCulture, out var release) && release >= 0 ? release : 60);

    public MeetingMonitor(AppState state)
    {
        this.state = state;
        notifier = new MeetingNotifier(state)
        {
            OnAnswer = Answer,
            OnOpenNote = id =>
            {
                state.Dashboard.OpenNote(id);
                state.OpenDashboard();
            },
        };
    }

    /// <summary>The event of the call being recorded because Cue noticed it (or because Record was pressed on Upcoming), for the page to say so.</summary>
    public CalendarEvent? RecordingEvent => recording?.Event;

    public void Start()
    {
        state.Recordings.Ready += id =>
        {
            if (!waitingForNotes.Remove(id)) return;
            notifier.NotesReady(state.Recordings.Find(id)?.Title ?? "", id);
        };
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        timer = state.Queue.CreateTimer();
        timer.Interval = interval;
        timer.IsRepeating = true;
        timer.Tick += async (_, _) => await Check();
        timer.Start();
        _ = Check();
    }

    /// <summary>Quit: the notifications' registration goes.</summary>
    public void Shutdown() => notifier.Dispose();

    private async Task Check()
    {
        if (ticking) return;
        ticking = true;
        try
        {
            await Tick();
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            state.Log.Write($"{SessionLog.Warning} Couldn't check for calls: {e.Message}");
        }
        finally
        {
            ticking = false;
        }
    }

    private async Task Tick()
    {
        await state.Calendar.Refresh();
        var now = DateTime.Now;
        var apps = CallApp.UsingMicrophone();
        var call = CurrentCall(apps, now);
        if (call is not null) lastSeen[call.Key] = now;
        foreach (var (key, seen) in lastSeen.ToList())
        {
            if (now - seen < releaseAfter) continue;
            // Over: withdraw its prompt; the next call in the same app is asked about again.
            lastSeen.Remove(key);
            if (key.StartsWith("app:", StringComparison.Ordinal)) settled.Remove(key);
            foreach (var pending in asking.Where(item => item.Key == key).ToList()) Withdraw(pending);
        }

        var recorder = state.Live.Recorder;
        if (recording is { } current)
        {
            // Stopped by hand.
            if (!recorder.IsRecording || recorder.StartedAt != recordingStarted)
            {
                SetRecording(null);
                heardAt = null;
                heardApp = null;
                return;
            }
            if (apps.Count > 0)
            {
                heardAt = now;
                heardApp = apps.FirstOrDefault(app => app == current.App) ?? apps[0];
            }
            else if (heardAt is { } heard && now - heard >= releaseAfter)
            {
                state.Log.Write($"📅 {heardApp?.Name ?? "The call app"} let go of the microphone — stopping the recording");
                Stop(current);
            }
            return;
        }
        // Recording by hand: nothing to ask.
        if (recorder.StartedAt is not null)
        {
            foreach (var pending in asking.ToList()) Withdraw(pending);
            return;
        }
        if (call is null || settled.Contains(call.Key) || asking.Any(item => item.Key == call.Key)) return;
        switch (state.Preferences.MeetingAction)
        {
            case MeetingAction.Nothing:
                break;
            case MeetingAction.Record:
                Record(call, heard: true, RecordingTrigger.CallNoticed);
                break;
            default:
                asking.Add(call);
                var app = call.App is { } named ? $"{named.Name} is using the microphone. " : "";
                notifier.Ask(call, $"{app}Notes go to {ProjectName(call.Event)}.");
                break;
        }
    }

    /// <summary>The calendar call going on now, if a call app uses the microphone; else a call app's own call.</summary>
    private Call? CurrentCall(IReadOnlyList<CallApp> apps, DateTime now)
    {
        if (apps.Count == 0) return null;
        var at = new DateTimeOffset(now);
        var going = state.Calendar.Events.Where(item => item.InProgress(at)).OrderBy(item => Math.Abs((item.Start - at).TotalSeconds)).FirstOrDefault();
        if (going is not null) return new Call($"event:{going.Id}", going.Title, going, apps.FirstOrDefault(app => app.Service == going.Service) ?? apps[0]);
        return apps.FirstOrDefault(app => !app.IsBrowser) is { } native ? new Call($"app:{native.Name}", native.CallName, null, native) : null;
    }

    // MARK: Answers

    private void Answer(string key, bool record)
    {
        if (asking.FirstOrDefault(item => item.Key == key) is not { } call) return;
        asking.RemoveAll(item => item.Key == key);
        settled.Add(key);
        if (record)
        {
            if (state.Live.Recorder.StartedAt is not null) return;
            Record(call, heard: true, RecordingTrigger.Notification);
        }
        else
        {
            state.Log.Write($"🔔 Not now: “{call.Title}”");
        }
    }

    /// <summary>CUE_CONTROL's `notification record|dismiss`: the answer to the latest prompt.</summary>
    public void AnswerLatestPrompt(bool record)
    {
        if (asking.Count > 0) Answer(asking[^1].Key, record);
    }

    private void Withdraw(Call call)
    {
        asking.RemoveAll(item => item.Key == call.Key);
        notifier.Withdraw(call.Key);
    }

    // MARK: Recording

    /// <summary>Records an event in progress from the Upcoming page.</summary>
    public void Record(CalendarEvent item)
    {
        if (state.Live.Recorder.StartedAt is not null) return;
        Record(new Call($"event:{item.Id}", item.Title, item, null), heard: false, RecordingTrigger.Upcoming);
    }

    /// <summary>`heard` when a call app is on the microphone already; otherwise the recording only stops by itself after one has been and gone.</summary>
    private async void Record(Call call, bool heard, RecordingTrigger trigger)
    {
        settled.Add(call.Key);
        foreach (var pending in asking.ToList()) Withdraw(pending);
        // Not signed in yet (or "Meetings" can't be created): the next check tries again.
        if (!state.Api.IsSignedIn || await ProjectFor(call.Event) is not { } project || !state.Api.IsSignedIn)
        {
            settled.Remove(call.Key);
            return;
        }
        state.Log.Write($"📅 Recording “{call.Title}” into {project.Name}");
        state.Live.StartRecording(project, call.Event is { } item ? new MeetingDetails(item.Title, item.Attendees) : null, trigger);
        SetRecording(call);
        recordingStarted = state.Live.Recorder.StartedAt;
        heardAt = heard ? DateTime.Now : null;
        heardApp = heard ? call.App : null;
    }

    private void Stop(Call call)
    {
        SetRecording(null);
        heardAt = null;
        heardApp = null;
        state.Live.StopRecording(
            RecordingTrigger.CallEnded,
            automatically: true,
            id =>
            {
                if (id is null)
                {
                    notifier.NothingRecorded(call.Title);
                }
                else if (state.Recordings.IsProcessing(id))
                {
                    waitingForNotes.Add(id);
                }
                else
                {
                    notifier.NotesReady(state.Recordings.Find(id)?.Title ?? call.Title, id);
                }
            });
    }

    private void SetRecording(Call? call)
    {
        if (recording == call) return;
        recording = call;
        Raise(nameof(RecordingEvent));
    }

    // MARK: Projects

    /// <summary>The project an event's notes go to: the one picked for its series on Upcoming, else "Meetings", created when first needed. Calls without an event go to "Meetings" too.</summary>
    public async Task<Project?> ProjectFor(CalendarEvent? item)
    {
        var projects = state.Projects;
        if (item is not null && state.Calendar.AssignedProject(item) is { } id && projects.Find(id) is { } assigned) return assigned;
        if (projects.FindByName(MeetingCalendar.DefaultProject) is { } meetings) return meetings;
        try
        {
            return await projects.Create(MeetingCalendar.DefaultProject);
        }
        catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The folder of the project an event's notes would go to, without creating "Meetings".</summary>
    public string ProjectId(CalendarEvent item)
    {
        var projects = state.Projects;
        if (state.Calendar.AssignedProject(item) is { } id && projects.Find(id) is not null) return id;
        return projects.FindByName(MeetingCalendar.DefaultProject)?.Id ?? MeetingCalendar.DefaultProject;
    }

    private string ProjectName(CalendarEvent? item)
    {
        var id = item is null ? MeetingCalendar.DefaultProject : ProjectId(item);
        return state.Projects.Find(id)?.Name ?? MeetingCalendar.DefaultProject;
    }
}
