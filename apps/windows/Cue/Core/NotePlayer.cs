using System.Globalization;
using Microsoft.UI.Dispatching;
using Windows.Media.Core;
using Windows.Media.Playback;

namespace Cue;

/// <summary>
/// Plays the audio of the note open in the dashboard; the transcript's timestamps jump in it (the Mac's NotePlayer). The audio is the `.m4a` next to the
/// note, or, for a note the library has no audio of but the account does, the account's `mixed` side, which is fetched (with the token) to a cache
/// folder and played from there. Windows' own media player does the playing, headless; the dashboard draws the transport. UI thread only.
/// </summary>
public sealed class NotePlayer : Observable
{
    public static readonly double[] Rates = [1, 1.5, 2];

    private readonly AppState state;
    private MediaPlayer? player;
    private DispatcherQueueTimer? timer;
    private TaskCompletionSource opened = new();
    private string? path;
    private string? note;
    private string? wantedStream;
    private bool isPlaying;
    private double time;
    private double duration;
    private double rate = 1;
    private bool failed;

    public NotePlayer(AppState state) => this.state = state;

    /// <summary>Raised when what the transport shows changes: the position, the length, playing or paused.</summary>
    public event Action? Changed;

    public bool IsPlaying => isPlaying;
    public double Time => time;
    public double Duration => duration;

    /// <summary>While the slider is dragged, it sets the time rather than following it.</summary>
    public bool Scrubbing { get; set; }

    public double Rate
    {
        get => rate;
        set
        {
            if (!Set(ref rate, value)) return;
            if (player is not null) player.PlaybackSession.PlaybackRate = rate;
        }
    }

    /// <summary>Whether there is audio open (the transport shows only then).</summary>
    public bool HasAudio => path is not null && !failed;

    private MediaPlayer Player()
    {
        if (player is { } existing) return existing;
        var made = new MediaPlayer { AutoPlay = false };
        made.MediaOpened += (_, _) => opened.TrySetResult();
        made.MediaFailed += (_, e) => state.Queue.TryEnqueue(() =>
        {
            failed = true;
            opened.TrySetResult();
            state.Log.Write($"{SessionLog.Warning} Couldn't play the audio: {e.ErrorMessage}");
            Changed?.Invoke();
        });
        player = made;
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        timer = state.Queue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(100);
        timer.IsRepeating = true;
        timer.Tick += (_, _) => Poll();
        timer.Start();
        return made;
    }

    private void Poll()
    {
        if (player is not { } playing || path is null) return;
        var session = playing.PlaybackSession;
        var active = session.PlaybackState is MediaPlaybackState.Playing or MediaPlaybackState.Buffering or MediaPlaybackState.Opening;
        var length = session.NaturalDuration.TotalSeconds;
        var position = session.Position.TotalSeconds;
        var changed = active != isPlaying;
        isPlaying = active;
        if (length > 0 && Math.Abs(length - duration) > 0.05)
        {
            duration = length;
            changed = true;
        }
        if (!Scrubbing && Math.Abs(position - time) > 0.05)
        {
            time = position;
            changed = true;
        }
        if (changed) Changed?.Invoke();
    }

    /// <summary>Opens a note's audio (null stops). A new file for the same note, renamed after its summary, carries on from the same moment.</summary>
    public void Load(string? file, string? noteId)
    {
        if (file == path) return;
        var resume = noteId is not null && noteId == note ? (Time: time, Playing: isPlaying) : ((double Time, bool Playing)?)null;
        player?.Pause();
        path = file;
        note = noteId;
        failed = false;
        opened = new TaskCompletionSource();
        if (file is null)
        {
            if (player is not null) player.Source = null;
            isPlaying = false;
            time = 0;
            duration = 0;
            Changed?.Invoke();
            return;
        }
        var made = Player();
        made.Source = MediaSource.CreateFromUri(new Uri(file));
        made.PlaybackSession.PlaybackRate = rate;
        if (resume is { } again)
        {
            time = again.Time;
            _ = Resume(again.Time, again.Playing);
        }
        else
        {
            time = 0;
            duration = 0;
        }
        Changed?.Invoke();
    }

    private async Task Resume(double seconds, bool play)
    {
        var current = path;
        await WhenOpened();
        if (path != current || player is not { } playing) return;
        playing.PlaybackSession.Position = TimeSpan.FromSeconds(seconds);
        if (play) playing.Play();
    }

    /// <summary>Opens a note's audio from the account (the `mixed` side), for a note whose audio isn't in the library.</summary>
    public async Task Stream(string noteId, string noteKey)
    {
        var cached = Path.Combine(Storage.AppSupport, "cache", "audio", noteId + ".m4a");
        wantedStream = noteId;
        if (cached == path) return;
        if (!File.Exists(cached))
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(cached)!);
                await state.Api.DownloadNoteAudio(noteId, cached);
            }
            catch (Exception e) when (e is CueApiException or IOException or UnauthorizedAccessException)
            {
                state.Log.Write($"{SessionLog.Warning} Couldn't fetch the audio: {e.Message}");
                return;
            }
        }
        // The page moved to another note while the audio came.
        if (wantedStream != noteId) return;
        Load(cached, noteKey);
    }

    /// <summary>The audio fetched from the account is not kept after signing out.</summary>
    public void ForgetStreamed()
    {
        wantedStream = null;
        try
        {
            var folder = Path.Combine(Storage.AppSupport, "cache", "audio");
            if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    public void TogglePlay()
    {
        if (player is not { } playing || path is null) return;
        if (isPlaying)
        {
            playing.Pause();
            return;
        }
        if (duration > 0 && time >= duration - 0.1) Seek(0);
        playing.PlaybackSession.PlaybackRate = rate;
        playing.Play();
    }

    public void Seek(double seconds)
    {
        time = seconds;
        if (player is { } playing) playing.PlaybackSession.Position = TimeSpan.FromSeconds(seconds);
        Changed?.Invoke();
    }

    /// <summary>A timestamp clicked in the transcript: plays from there.</summary>
    public void PlayFrom(double seconds)
    {
        if (player is null || path is null || failed)
        {
            state.Log.Write($"{SessionLog.Warning} No audio to play");
            return;
        }
        _ = PlayFromAsync(seconds);
    }

    private async Task PlayFromAsync(double seconds)
    {
        var file = path;
        await WhenOpened();
        if (player is not { } playing || path != file || file is null) return;
        playing.Pause();
        time = seconds;
        var sought = new TaskCompletionSource();
        void OnSought(MediaPlaybackSession session, object args) => sought.TrySetResult();
        playing.PlaybackSession.SeekCompleted += OnSought;
        playing.PlaybackSession.Position = TimeSpan.FromSeconds(seconds);
        await Task.WhenAny(sought.Task, Task.Delay(TimeSpan.FromSeconds(5)));
        playing.PlaybackSession.SeekCompleted -= OnSought;
        if (path != file) return;
        var position = playing.PlaybackSession.Position.TotalSeconds;
        playing.PlaybackSession.PlaybackRate = rate;
        playing.Play();
        state.Log.Write($"▶︎ Playing {Path.GetFileName(file)} from {RecordingStore.Clock(seconds)} (player at {position.ToString("F1", CultureInfo.InvariantCulture)} s)");
        Changed?.Invoke();
    }

    /// <summary>The media is open (or failed to be): a position set before that would be lost.</summary>
    private async Task WhenOpened() => await Task.WhenAny(opened.Task, Task.Delay(TimeSpan.FromSeconds(10)));
}
