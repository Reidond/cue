using System.Globalization;

namespace Cue;

/// <summary>
/// Saves recordings as Markdown in each project's `Notes` folder and keeps them listed, newest first. The notes themselves are the account's: the server
/// makes them after each call (see <see cref="Process"/>) and keeps them, and the Markdown here is the copy Cue shows and the user owns. The port of the
/// Mac's RecordingStore. UI thread only.
/// </summary>
public sealed class RecordingStore
{
    private readonly AppState state;
    private readonly RecordingUploader uploader;

    /// <summary>What uploads and follows each recording being processed, by recording id.</summary>
    private readonly Dictionary<string, CancellationTokenSource> tasks = [];

    /// <summary>The steps of each note being processed, by recording id; kept after processing only if one failed.</summary>
    private readonly Dictionary<string, List<NoteProgress>> progress = [];

    private IReadOnlyList<RecordingFile> files = [];
    private bool syncing;

    public RecordingStore(AppState state)
    {
        this.state = state;
        uploader = new RecordingUploader(state.Api, state.Log);
    }

    /// <summary>Raised when the list or any note's steps change.</summary>
    public event Action? Changed;

    /// <summary>Raised with a recording's id once its notes are ready: every step done (or failed).</summary>
    public event Action<string>? Ready;

    private CueApi Api => state.Api;
    private SessionLog Log => state.Log;
    private Preferences Prefs => state.Preferences;
    private ProjectStore Projects => state.Projects;

    public IReadOnlyList<RecordingFile> Files => files;

    public void Reload()
    {
        var found = new List<RecordingFile>();
        foreach (var project in Projects.Projects)
        {
            if (!Directory.Exists(project.NotesFolder)) continue;
            try
            {
                foreach (var path in Directory.EnumerateFiles(project.NotesFolder, "*.md"))
                {
                    if (RecordingFile.Load(path) is { } file) found.Add(file);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
        files = [.. found.OrderByDescending(file => file.Date)];
        Changed?.Invoke();
    }

    /// <summary>Forgets the notes held in memory (signing out); the files and the account keep theirs.</summary>
    public void Clear()
    {
        CancelAll();
        progress.Clear();
        files = [];
        Changed?.Invoke();
    }

    public RecordingFile? Find(string? id) => id is null ? null : files.FirstOrDefault(file => file.Id == id);

    public IReadOnlyList<RecordingFile> FilesIn(Project project) => [.. files.Where(file => file.ProjectId == project.Id)];

    public string Contents(string id) => Find(id) is { } file ? ReadAll(file.Path) : "";

    private static string ReadAll(string path)
    {
        try
        {
            return System.IO.File.ReadAllText(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    /// <summary>The steps of a note being processed (or one that failed), for its page; null when it has none.</summary>
    public IReadOnlyList<NoteProgress>? Steps(string id) => progress.GetValueOrDefault(id);

    /// <summary>Still going through its steps after Stop.</summary>
    public bool IsProcessing(string id) => progress.TryGetValue(id, out var steps) && steps.Any(step => !step.IsFinished);

    /// <summary>
    /// Writes the transcript into the project's notes right away so nothing is lost, puts the call's audio next to it (with Keep audio on), then has the
    /// account make the notes (see <see cref="Process"/>). A call recorded for a calendar event is named after the event and lists its attendees.
    /// `spokenIn` is what the call was recognized in live, when it isn't the project's language; `callId` the live call that heard it, if there is one.
    /// </summary>
    public string? Save(CallTranscript transcript, Project project, MeetingDetails? meeting = null, AudioRecording? audio = null, string? spokenIn = null, string? callId = null)
    {
        var lexicon = Lexicon.Load(project.Language);
        var speaker = Prefs.SpeakerName.Length == 0 ? "You" : Prefs.SpeakerName;
        string NameOf(Side side) => side == Side.Me ? speaker : lexicon.Participant;
        var stamp = NoteMarkdown.Stamp(transcript.StartedAt);
        var id = RecordingFile.IdOf(project.Id, stamp);
        var title = meeting?.Title ?? "Call " + transcript.StartedAt.ToString("MMM d, yyyy, h:mm tt", CultureInfo.CurrentCulture);
        var duration = NoteMarkdown.Duration((transcript.EndedAt - transcript.StartedAt).TotalSeconds);
        var summarize = Prefs.SummarizeRecordings;
        var folder = project.NotesFolder;
        var path = Path.Combine(folder, FileName(transcript.StartedAt, meeting?.Title ?? "Call"));
        try
        {
            Directory.CreateDirectory(folder);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            state.Alert("Couldn't save the notes", e.Message);
            return null;
        }

        // The mixed audio goes next to the note, under the same name; the working copies stay for processing.
        string? audioFile = null;
        var steps = new List<NoteProgress>();
        if (audio is not null && Prefs.KeepAudio)
        {
            try
            {
                var mixed = audio.Mixed ?? throw new IOException(audio.Error ?? "Couldn't write the call's audio");
                var target = Path.ChangeExtension(path, ".m4a");
                System.IO.File.Move(mixed, target, overwrite: true);
                audioFile = target;
                steps.Add(new NoteProgress(NoteStep.SavingAudio, StepState.Done, Clock(audio.Duration)));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Log.Write($"{SessionLog.Warning} Couldn't save the audio: {e.Message}");
                steps.Add(new NoteProgress(NoteStep.SavingAudio, StepState.Failed, e.Message));
            }
        }
        else if (audio?.Mixed is { } unused)
        {
            TryDelete(unused);
        }
        if (audio is not null)
        {
            steps.Add(new NoteProgress(NoteStep.UploadingRecording, StepState.Pending));
            steps.Add(new NoteProgress(NoteStep.ImprovingTranscript, StepState.Pending));
            steps.Add(new NoteProgress(NoteStep.FindingSpeakers, StepState.Pending));
        }
        if (summarize) steps.Add(new NoteProgress(NoteStep.WritingSummary, StepState.Pending));

        var front = new List<string>
        {
            $"title: {RecordingFile.Quoted(title)}",
            $"date: {stamp}",
            $"duration: {duration}",
            $"participants: {speaker}, {lexicon.Participant}",
            $"project: {RecordingFile.Quoted(project.Name)}",
        };
        if (meeting is not null)
        {
            front.Add($"event: {RecordingFile.Quoted(meeting.Title)}");
            front.Add($"attendees: {RecordingFile.List(meeting.Attendees)}");
        }
        if (audioFile is not null) front.Add($"audio: {RecordingFile.Quoted(Path.GetFileName(audioFile))}");
        var document = "---\n" + string.Join("\n", front) + $"\n---\n\n# {title}\n\n{(summarize ? "_…_" : "")}\n\n{RecordingFile.TranscriptMarker}\n## {lexicon.TranscriptHeading}\n\n"
            + transcript.Markdown(NameOf) + "\n";
        try
        {
            Storage.WriteAtomically(path, document);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            state.Alert("Couldn't save the notes", e.Message);
            return null;
        }
        Log.Write($"🎙 Transcript saved: {path}");
        if (audio is not null)
        {
            var length = Clock(audio.Duration);
            if (audio.Error is not null) Log.Write($"{SessionLog.Warning} Audio incomplete: {audio.Error}");
            if (audioFile is not null) Log.Write($"🔊 Audio saved: {audioFile} ({length})");
            else if (!Prefs.KeepAudio) Log.Write($"🔊 Audio not kept (Keep audio is off): {length}");
            Log.Write($"🎚 Working audio: {audio.Folder} ({AudioRecorder.MicFile}, {AudioRecorder.CallFile})");
        }
        progress[id] = steps;
        Reload();
        var cancel = new CancellationTokenSource();
        tasks[id] = cancel;
        var mixedAudio = audioFile;
        _ = Run(id, transcript, project, title, meeting, audio, mixedAudio, spokenIn ?? project.Language, speaker, callId, cancel);
        return id;
    }

    // MARK: The notes

    private async Task Run(string id, CallTranscript live, Project project, string title, MeetingDetails? meeting, AudioRecording? audio, string? mixed, string language, string speaker, string? callId, CancellationTokenSource cancel)
    {
        try
        {
            await Process(id, live, project, title, meeting, audio, mixed, language, speaker, callId, cancel.Token);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception e)
        {
            Abandon(id, e.Message);
        }
        finally
        {
            if (tasks.GetValueOrDefault(id) == cancel) tasks.Remove(id);
        }
    }

    /// <summary>
    /// What happens after the live transcript is saved: the recording goes up to the account (each side of the call, and the mixed audio for playing),
    /// the account's notes Workflow reads it again, tells the voices apart, suggests names and writes the summary, and this follows its progress. A step
    /// that fails leaves the note as it was (the live transcript stays) and the Workflow goes on to the next.
    /// </summary>
    private async Task Process(string id, CallTranscript live, Project project, string title, MeetingDetails? meeting, AudioRecording? audio, string? mixed, string language, string speaker, string? callId, CancellationToken cancel)
    {
        if (project.ServerId is not { } serverId)
        {
            Abandon(id, "this project isn't in your account yet");
            return;
        }
        // A recording belongs to the call that heard it. Without one (the live call never started), a call is made just for the notes.
        string? made = null;
        if (callId is null)
        {
            try
            {
                made = (await Api.CreateCall(serverId, speaker, auto: false, micQuestions: false, questions: false, notesOnly: true)).CallId;
            }
            catch (CueApiException e)
            {
                Abandon(id, e.Message);
                return;
            }
        }
        var temporary = made is not null;
        var call = callId ?? made!;
        try
        {
            var take = new DateTimeOffset(live.StartedAt).ToUnixTimeMilliseconds();

            var sides = new List<string>();
            if (audio is not null)
            {
                Set(NoteStep.UploadingRecording, id, StepState.Running);
                Log.Write("⬆️ Uploading the recording…");
                long total = 0;
                Exception? failure = null;
                foreach (var (side, name) in new[] { ("me", AudioRecorder.MicFile), ("others", AudioRecorder.CallFile) })
                {
                    try
                    {
                        total += await uploader.Upload(Path.Combine(audio.Folder, name), side, call, take, cancel);
                        sides.Add(side);
                    }
                    catch (Exception e) when (e is CueApiException or IOException)
                    {
                        failure = e;
                        break;
                    }
                }
                if (failure is null && mixed is not null)
                {
                    try
                    {
                        total += await uploader.Upload(mixed, "mixed", call, take, cancel);
                        sides.Add("mixed");
                    }
                    catch (Exception e) when (e is CueApiException or IOException)
                    {
                        Log.Write($"{SessionLog.Warning} Couldn't upload the audio for playing: {e.Message}");
                    }
                }
                if (failure is not null)
                {
                    sides.Clear();
                    Log.Write($"{SessionLog.Warning} Couldn't upload the recording: {failure.Message} — the live transcript is kept");
                    Set(NoteStep.UploadingRecording, id, StepState.Failed, Sentence(failure.Message) + " The live transcript is kept.");
                    // The server has no recording to read again.
                    progress.GetValueOrDefault(id)?.RemoveAll(step => step.Step is NoteStep.ImprovingTranscript or NoteStep.FindingSpeakers);
                    Changed?.Invoke();
                }
                else
                {
                    var megabytes = (total / 1_000_000.0).ToString("F1", CultureInfo.InvariantCulture);
                    Log.Write($"⬆️ Recording uploaded: {megabytes} MB");
                    Set(NoteStep.UploadingRecording, id, StepState.Done, $"{megabytes} MB");
                }
            }
            cancel.ThrowIfCancellationRequested();
            if (Find(id) is null) return;

            RemoteNote started;
            try
            {
                started = await Api.StartNotes(
                    call,
                    new NewNotesBody(
                        title,
                        take,
                        new DateTimeOffset(live.EndedAt).ToUnixTimeMilliseconds(),
                        sides,
                        speaker,
                        meeting is null ? null : new RemoteMeeting(meeting.Title, [.. meeting.Attendees]),
                        Prefs.KeepAudio,
                        Has(NoteStep.WritingSummary, id),
                        language == project.Language ? null : language,
                        serverId));
            }
            catch (CueApiException e)
            {
                Abandon(id, e.Message);
                return;
            }
            if (cancel.IsCancellationRequested || Find(id) is null)
            {
                // Moved to the Trash meanwhile.
                try
                {
                    await Api.DeleteNote(started.Id);
                }
                catch (CueApiException)
                {
                }
                return;
            }
            SetNoteId(started.Id, id);

            var followed = await Follow(id, started.Id, cancel);
            if (Find(id) is null) return;
            if (followed is not { } result)
            {
                Abandon(id, "the account stopped answering");
                return;
            }
            Adopt(result.Note, id, result.Died);
            Finish(id);
        }
        finally
        {
            if (temporary) await Api.EndCall(call);
        }
    }

    /// <summary>
    /// Follows the Workflow's progress events (a dropped stream is picked up again where it left off) until the note is ready; returns the note as the
    /// account has it then (`Died`: the Workflow ended without finishing), or null when the account stopped answering.
    /// </summary>
    private async Task<(RemoteNote Note, bool Died)?> Follow(string id, string noteId, CancellationToken cancel)
    {
        var after = 0;
        var ready = false;
        var died = false;
        var progressed = false;

        // Reads the events after the last one seen, to the end of the stream.
        async Task Pull() =>
            await Api.FollowNoteEvents(
                noteId,
                after,
                note =>
                {
                    after = Math.Max(after, note.Seq);
                    progressed = true;
                    Handle(note, id);
                    if (note.Kind == "note" && (note.State is "ready" or "failed"))
                    {
                        ready = true;
                        died = note.State == "failed";
                    }
                },
                cancel);

        var quiet = 0;
        while (!ready && quiet < 40 && !cancel.IsCancellationRequested && Find(id) is not null)
        {
            progressed = false;
            try
            {
                await Pull();
            }
            catch (CueApiException e) when (e.Kind == CueApiError.Ended)
            {
                break;
            }
            catch (CueApiException)
            {
                // The stream dropped, or the account is out of reach for a moment: look again below.
            }
            if (ready) break;
            try
            {
                var note = await Api.Note(noteId);
                if (note.Status == "ready")
                {
                    // Done while the stream was down: what it missed is replayed so the session log has every line.
                    try
                    {
                        await Pull();
                    }
                    catch (CueApiException)
                    {
                    }
                    return (note, died);
                }
            }
            catch (CueApiException)
            {
            }
            quiet = progressed ? 0 : quiet + 1;
            await Task.Delay(progressed ? 500 : 2000, cancel);
        }
        if (!ready) return null;
        try
        {
            return (await Api.Note(noteId), died);
        }
        catch (CueApiException)
        {
            return null;
        }
    }

    /// <summary>One progress event: the line it stands for goes to the session log, the step it is about to the note's page.</summary>
    private void Handle(NoteProgressEvent note, string id)
    {
        if (note.Line is { } line) Log.Write(line);
        if (note.Kind != "step" || note.Step is not { } step) return;
        Apply(step, note.State, note.Detail, id);
    }

    /// <summary>The Workflow's steps are the page's: the names are suggested as part of writing the summary.</summary>
    private void Apply(string step, string stepState, string? detail, string id)
    {
        switch (step, stepState)
        {
            case ("transcript", "running"):
                Set(NoteStep.ImprovingTranscript, id, StepState.Running);
                break;
            case ("transcript", "done"):
                Set(NoteStep.ImprovingTranscript, id, StepState.Done);
                break;
            case ("transcript", "failed"):
                Set(NoteStep.ImprovingTranscript, id, StepState.Failed, Sentence(detail) + " The live transcript is kept.");
                break;
            case ("speakers", "running"):
                Set(NoteStep.FindingSpeakers, id, StepState.Running);
                break;
            case ("speakers", "done"):
                Set(NoteStep.FindingSpeakers, id, StepState.Done, detail);
                break;
            case ("speakers", "failed"):
                Set(NoteStep.FindingSpeakers, id, StepState.Failed, Sentence(detail) + " The transcript is kept as it was.");
                break;
            case ("names" or "summary", "running"):
                Set(NoteStep.WritingSummary, id, StepState.Running);
                break;
            case ("summary", "done"):
                Set(NoteStep.WritingSummary, id, StepState.Done);
                break;
            case ("summary", "failed"):
                Set(NoteStep.WritingSummary, id, StepState.Failed, Sentence(detail));
                break;
        }
    }

    /// <summary>The note is ready: its steps are settled as the account has them, and its Markdown copy is written from it.</summary>
    private void Adopt(RemoteNote note, string id, bool died)
    {
        foreach (var step in note.Steps.Where(step => step.State is "done" or "failed")) Apply(step.Id, step.State, step.Detail, id);
        // A step the Workflow didn't run (nothing to read again, say) doesn't keep the page waiting; with a Workflow that died, they failed.
        if (progress.GetValueOrDefault(id) is { } steps)
        {
            foreach (var step in steps.Where(step => !step.IsFinished))
            {
                step.State = died ? StepState.Failed : StepState.Done;
                step.Detail = died ? "The notes stopped early. The live transcript is kept." : null;
            }
        }
        Store(note, id);
    }

    /// <summary>Nothing more will come of the notes: the steps that hadn't happened failed, and the live transcript is what the note has.</summary>
    private void Abandon(string id, string why)
    {
        Log.Write($"{SessionLog.Warning} Couldn't make the notes: {why} — the live transcript is kept");
        if (progress.GetValueOrDefault(id) is { } steps)
        {
            foreach (var step in steps.Where(step => !step.IsFinished))
            {
                step.State = StepState.Failed;
                step.Detail = Sentence(why) + " The live transcript is kept.";
            }
        }
        Finish(id);
    }

    private void Finish(string id)
    {
        if (Find(id) is not { } file) return; // moved to the Recycle Bin meanwhile
        NotesReady(id, file.Path, file.Date);
    }

    /// <summary>Records the account's id of a note in its Markdown, so the library and the account know it is one.</summary>
    private void SetNoteId(string noteId, string id)
    {
        if (Find(id) is not { } file) return;
        var text = ReadAll(file.Path);
        if (text.Length == 0) return;
        TryWrite(file.Path, RecordingFile.Setting("note", noteId, text));
        Reload();
    }

    /// <summary>Writes the Markdown copy of a note as the account has it. A new title renames the file and its audio.</summary>
    private bool Store(RemoteNote note, string id)
    {
        if (Find(id) is not { } file) return false;
        var text = ReadAll(file.Path);
        if (text.Length == 0) return false;
        var stamp = RecordingFile.FrontMatter(text).GetValueOrDefault("date") ?? NoteMarkdown.Stamp(note.Started);
        var rendered = NoteMarkdown.Render(
            note,
            Projects.Find(file.ProjectId)?.Name ?? file.ProjectId,
            stamp,
            file.Audio is { } audio ? Path.GetFileName(audio) : null,
            note.Audio.Contains("mixed"),
            text);
        try
        {
            WriteNote(rendered, file, note.Title);
            Reload();
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"{SessionLog.Warning} Couldn't save the note: {e.Message}");
            return false;
        }
    }

    /// <summary>The last step a new note goes through: its working audio is no longer needed, and its steps leave the page unless one of them failed.</summary>
    private void NotesReady(string id, string path, DateTime startedAt)
    {
        // Tests and the session log both wait for "Notes ready".
        Log.Write($"📝 Notes ready: {path}");
        var working = AudioRecorder.WorkingFolder(startedAt);
        if (Directory.Exists(working) && TryDeleteFolder(working)) Log.Write($"🧹 Working audio removed: {working}");
        if (progress.GetValueOrDefault(id)?.Any(step => step.Failed) != true) progress.Remove(id);
        Changed?.Invoke();
        Ready?.Invoke(id);
    }

    private bool Has(NoteStep step, string id) => progress.GetValueOrDefault(id)?.Any(item => item.Step == step) == true;

    private void Set(NoteStep step, string id, StepState to, string? detail = null)
    {
        if (progress.GetValueOrDefault(id)?.FirstOrDefault(item => item.Step == step) is not { } item) return;
        item.State = to;
        item.Detail = detail;
        Changed?.Invoke();
    }

    /// <summary>"The upload broke" → "The upload broke."; system errors end with a full stop of their own.</summary>
    private static string Sentence(string? text)
    {
        var trimmed = (text ?? "").Trim('.', ' ', '\n', '\r');
        return trimmed.Length == 0 ? "It failed." : trimmed + ".";
    }

    /// <summary>0:42, 12:05 or 1:02:03.</summary>
    public static string Clock(double seconds)
    {
        var whole = Math.Max(0, (int)Math.Round(seconds));
        return whole >= 3600
            ? string.Create(CultureInfo.InvariantCulture, $"{whole / 3600}:{whole / 60 % 60:00}:{whole % 60:00}")
            : string.Create(CultureInfo.InvariantCulture, $"{whole / 60}:{whole % 60:00}");
    }

    /// <summary>Writes a note under its title, which may be new: the front matter and the H1 take it, and the note and its audio are renamed after it (unless a file by that name is already there).</summary>
    private static void WriteNote(string text, RecordingFile file, string title)
    {
        var updated = text.Replace($"title: {RecordingFile.Quoted(file.Title)}", $"title: {RecordingFile.Quoted(title)}", StringComparison.Ordinal)
            .Replace($"\n# {file.Title}\n", $"\n# {title}\n", StringComparison.Ordinal);
        var renamed = Path.Combine(Path.GetDirectoryName(file.Path)!, FileName(file.Date, title));
        var rename = !string.Equals(renamed, file.Path, StringComparison.OrdinalIgnoreCase) && !System.IO.File.Exists(renamed);
        // The audio takes the note's new name too.
        if (rename && file.Audio is { } audio)
        {
            var renamedAudio = Path.ChangeExtension(renamed, Path.GetExtension(audio));
            if (!System.IO.File.Exists(renamedAudio))
            {
                try
                {
                    System.IO.File.Move(audio, renamedAudio);
                    updated = updated.Replace(
                        $"\naudio: {RecordingFile.Quoted(Path.GetFileName(audio))}\n",
                        $"\naudio: {RecordingFile.Quoted(Path.GetFileName(renamedAudio))}\n",
                        StringComparison.Ordinal);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
        Storage.WriteAtomically(file.Path, updated);
        if (rename) System.IO.File.Move(file.Path, renamed);
    }

    // MARK: Editing a note

    /// <summary>
    /// Renames a person throughout a note — its transcript, summary, title and participants — and drops the name suggested for them. Calendar facts (the
    /// event, who was invited) stay as they were. The account does it; the Markdown copy follows.
    /// </summary>
    public void Rename(string old, string name, string id)
    {
        // Commas would split the participants, asterisks the transcript's speaker lines.
        var changed = new string(name.Where(c => c is not (',' or '*' or '\n' or '\r')).ToArray()).Trim();
        if (Find(id) is not { } file || changed.Length == 0 || changed == old || IsProcessing(id)) return;
        _ = Edit(file, NotesApi.Rename(old, changed), (old, changed));
    }

    /// <summary>Uses the name suggested for a label.</summary>
    public void ApplySuggestion(string label, string id)
    {
        if (Find(id) is not { } file || !file.Suggestions.TryGetValue(label, out var name) || IsProcessing(id)) return;
        _ = Edit(file, NotesApi.Apply(label), (label, name));
    }

    /// <summary>Leaves a name suggestion unused.</summary>
    public void DismissSuggestion(string label, string id)
    {
        if (Find(id) is { } file) _ = Edit(file, NotesApi.Dismiss(label), null);
    }

    private async Task Edit(RecordingFile file, object patch, (string Old, string New)? renamed)
    {
        if (file.NoteId is not { } noteId)
        {
            Log.Write($"{SessionLog.Warning} “{file.Title}” isn't in your account yet: try again in a moment");
            return;
        }
        try
        {
            var note = await Api.PatchNote(noteId, patch);
            if (!Store(note, file.Id)) return;
            if (renamed is { } names) Log.Write($"✏️ Renamed “{names.Old}” to “{names.New}” in {file.Title}");
        }
        catch (CueApiException e)
        {
            state.Alert(e.Message, "");
        }
    }

    /// <summary>Moves the note and its audio to the Recycle Bin (and the note out of the account); working audio, if it is still being processed, is deleted.</summary>
    public void MoveToTrash(string id)
    {
        if (Find(id) is not { } file) return;
        if (tasks.Remove(id, out var running)) running.Cancel();
        progress.Remove(id);
        TryDeleteFolder(file.WorkingAudio);
        _ = Trash(file);
    }

    private async Task Trash(RecordingFile file)
    {
        if (file.NoteId is { } noteId)
        {
            try
            {
                await Api.DeleteNote(noteId);
            }
            catch (CueApiException e)
            {
                Log.Write($"{SessionLog.Warning} Couldn't delete “{file.Title}” from your account: {e.Message}");
            }
        }
        try
        {
            var items = new List<string> { file.Path };
            if (file.Audio is { } audio) items.Add(audio);
            Shell.MoveToRecycleBin([.. items]);
        }
        catch (IOException e)
        {
            Log.Write($"{SessionLog.Warning} Couldn't move “{file.Title}” to the Recycle Bin: {e.Message}");
        }
        Reload();
    }

    public void CancelAll()
    {
        foreach (var task in tasks.Values) task.Cancel();
        tasks.Clear();
    }

    // MARK: The account's notes

    /// <summary>
    /// After signing in: the notes this PC had before it had an account go up to it once (`📦 Imported …`), and the account's notes the library doesn't
    /// have (from another PC, say) are written to it (`☁️ Restored …`).
    /// </summary>
    public async Task SyncWithAccount()
    {
        if (syncing) return;
        syncing = true;
        try
        {
            Reload();
            List<RemoteNote> remote;
            try
            {
                remote = await Api.ListNotes();
            }
            catch (CueApiException e)
            {
                Log.Write($"{SessionLog.Warning} Couldn't read your notes from your account: {e.Message}");
                return;
            }

            var imported = 0;
            foreach (var file in files.Where(file => file.NoteId is null && !progress.ContainsKey(file.Id)).ToList())
            {
                if (Projects.Find(file.ProjectId) is not { ServerId: not null } project) continue;
                var text = ReadAll(file.Path);
                if (!RecordingFile.FrontMatter(text).TryGetValue("date", out var stamp) || NoteMarkdown.ImportBody(text, project, stamp) is not { } body) continue;
                try
                {
                    var note = await Api.ImportNote(body);
                    if (file.Audio is { } audio && !note.Audio.Contains("mixed"))
                    {
                        try
                        {
                            await Api.PutImportAudio(note.Id, audio);
                        }
                        catch (CueApiException e)
                        {
                            Log.Write($"{SessionLog.Warning} Couldn't upload the audio of “{file.Title}”: {e.Message}");
                        }
                    }
                    TryWrite(file.Path, RecordingFile.Setting("note", note.Id, text));
                    imported++;
                }
                catch (CueApiException e)
                {
                    Log.Write($"{SessionLog.Warning} Couldn't import “{file.Title}”: {e.Message}");
                }
            }
            if (imported > 0) Log.Write($"📦 Imported {imported} note{(imported == 1 ? "" : "s")} from this PC");

            Reload();
            var known = files.Select(file => file.NoteId).OfType<string>().ToHashSet();
            var identities = files.Select(file => file.Id).ToHashSet();
            var restored = 0;
            foreach (var note in remote.Where(note => note.Status == "ready" && !known.Contains(note.Id)))
            {
                if (note.ProjectId is not { } projectId || Projects.Projects.FirstOrDefault(project => project.ServerId == projectId) is not { } project
                    || identities.Contains(RecordingFile.IdOf(project.Id, NoteMarkdown.Stamp(note.Started))))
                    continue;
                var path = Path.Combine(project.NotesFolder, FileName(note.Started, note.Title));
                if (System.IO.File.Exists(path)) continue;
                var text = NoteMarkdown.Render(note, project.Name, NoteMarkdown.Stamp(note.Started), null, note.Audio.Contains("mixed"));
                try
                {
                    Directory.CreateDirectory(project.NotesFolder);
                    Storage.WriteAtomically(path, text);
                    restored++;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    Log.Write($"{SessionLog.Warning} Couldn't restore “{note.Title}”: {e.Message}");
                }
            }
            if (restored > 0) Log.Write($"☁️ Restored {restored} note{(restored == 1 ? "" : "s")} from your account");
            Reload();
        }
        finally
        {
            syncing = false;
        }
    }

    // MARK: Files

    /// <summary>"2026-10-24 14.05 – Title.md": sorts by date in Explorer.</summary>
    private static string FileName(DateTime date, string title)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string(title.Select(c => invalid.Contains(c) ? '-' : c).ToArray());
        if (safe.Length > 80) safe = safe[..80];
        safe = safe.TrimEnd(' ', '.');
        return $"{date.ToLocalTime().ToString("yyyy-MM-dd HH'.'mm", CultureInfo.InvariantCulture)} – {safe}.md";
    }

    private static void TryWrite(string path, string text)
    {
        try
        {
            Storage.WriteAtomically(path, text);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            System.IO.File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static bool TryDeleteFolder(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
