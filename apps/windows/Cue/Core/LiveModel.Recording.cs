namespace Cue;

/// <summary>
/// Recording a call (the Mac's AppState, recording half): the transcript the live call hears and both sides' audio are collected from Record to Stop,
/// then saved as a note (<see cref="RecordingStore"/>) and sent to the account, which makes the notes. Recording needs the audio and the live call open
/// as Cue does, so <see cref="UpdateCapture"/> keeps them while a recording is under way, with Cue stopped or not.
/// </summary>
public sealed partial class LiveModel
{
    private readonly AudioRecorder audioRecorder = new();
    private Project? recordingProject;
    private MeetingDetails? recordingMeeting;

    /// <summary>The call being recorded: when it began, and whether it is waiting for the last phrase to be transcribed.</summary>
    public CallRecorder Recorder { get; } = new();

    private RecordingStore Recordings => state.Recordings;

    /// <summary>Called once from <see cref="Start"/>: the overlay, the tray icon and the pages watch the recorder through the model.</summary>
    private void WatchRecorder()
    {
        Recorder.PropertyChanged += (_, _) =>
        {
            Touch();
            Raise(nameof(Recorder));
        };
        Recordings.Ready += _ => Touch();
        AudioRecorder.RemoveStaleWorkingFolders();
    }

    public void ToggleRecording(RecordingTrigger trigger)
    {
        if (Recorder.IsRecording) StopRecording(trigger);
        else if (!Recorder.Stopping) StartRecording(trigger);
    }

    public void StartRecording(RecordingTrigger trigger) => StartRecording(ActiveProject, null, trigger);

    /// <summary>Records into a given project, e.g. a calendar event's, named after the event when there is one.</summary>
    public void StartRecording(Project? project, MeetingDetails? meeting, RecordingTrigger trigger)
    {
        if (!RequireSignIn()) return;
        recordingProject = project;
        recordingMeeting = meeting;
        audioRecorder.Start(Recorder.Start());
        Log.Write($"⏺ Recording started ({trigger.Text()})");
        UpdateCapture();
    }

    /// <summary>Waits for the last phrase to be transcribed, then saves the notes and audio and summarizes.</summary>
    public void StopRecording(RecordingTrigger trigger, bool automatically = false, Action<string?>? saved = null)
    {
        if (!Recorder.IsRecording || Recorder.StartedAt is not { } started) return;
        var ended = Recorder.BeginStop();
        audioRecorder.Stop(ended);
        Log.Write($"⏹ Recording stopped after {RecordingStore.Clock(Math.Floor((ended - started).TotalSeconds))} ({trigger.Text()})");
        var meeting = recordingMeeting;
        recordingMeeting = null;
        _ = FinishRecording(automatically, meeting, saved);
    }

    private async Task FinishRecording(bool automatically, MeetingDetails? meeting, Action<string?>? saved)
    {
        await Task.Delay(TimeSpan.FromSeconds(2.5));
        var audio = await audioRecorder.Finish();
        var transcript = Recorder.Finish();
        UpdateCapture(); // closes the audio again unless Cue is running
        if (transcript is null) return;
        if (transcript.Lines.Count == 0)
        {
            if (audio is not null)
            {
                try
                {
                    Directory.Delete(audio.Folder, recursive: true);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                }
            }
            saved?.Invoke(null);
            if (!automatically) state.Alert("Nothing was recorded", "Cue didn't hear any speech while recording, so no notes were saved.");
            return;
        }
        // Without a project (none created yet), recordings go to "Meetings".
        var projects = state.Projects;
        var target = (recordingProject is { } chosen ? projects.Find(chosen.Id) : null) ?? ActiveProject ?? projects.FindByName("Meetings");
        if (target is null)
        {
            try
            {
                target = await projects.Create("Meetings");
            }
            catch (CueApiException e)
            {
                state.Alert("Couldn't make the project “Meetings”", e.Message);
                return;
            }
        }
        // The language the call was held in, as live recognition heard it (the server hears it again in the recording).
        var spoken = SpokenLanguage;
        var id = Recordings.Save(transcript, target, meeting, audio, spoken, liveCall?.Id);
        if (id is not null && !automatically) state.Dashboard.OpenNote(id);
        if (id is not null && !automatically) state.OpenDashboard();
        saved?.Invoke(id);
    }
}
