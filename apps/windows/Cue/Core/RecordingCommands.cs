namespace Cue;

/// <summary>
/// The `CUE_CONTROL` commands of the notes (the Mac's, line for line): `record` (the overlay's record button, or Stop Recording in its timer's menu),
/// `timestamp HH:MM:SS` (a timestamp in the open note's transcript: plays its audio from there), and for the open note `rename NAME | NEW` (a speaker's
/// name clicked and renamed), `apply LABEL` and `dismiss LABEL` (Apply or ✕ on a name suggestion). The open note is the dashboard's
/// (<see cref="DashboardModel.NoteId"/>).
/// </summary>
internal static class RecordingCommands
{
    public static void Register(AppState state)
    {
        var control = state.Control;

        control.Register("record", _ =>
        {
            state.Live.ToggleRecording(RecordingTrigger.Overlay);
            return Task.CompletedTask;
        });

        control.Register("timestamp", argument =>
        {
            if (Seconds(argument) is { } seconds) state.Player.PlayFrom(seconds);
            return Task.CompletedTask;
        });

        control.Register("rename", argument =>
        {
            var sides = argument.Split(" | ");
            if (sides.Length == 2 && state.Dashboard.NoteId is { } note) state.Recordings.Rename(sides[0], sides[1], note);
            return Task.CompletedTask;
        });

        control.Register("apply", argument =>
        {
            if (state.Dashboard.NoteId is { } note) state.Recordings.ApplySuggestion(argument, note);
            return Task.CompletedTask;
        });

        control.Register("dismiss", argument =>
        {
            if (state.Dashboard.NoteId is { } note) state.Recordings.DismissSuggestion(argument, note);
            return Task.CompletedTask;
        });
    }

    /// <summary>A transcript timestamp in seconds: "00:01:05" or "1:05" → 65.</summary>
    public static double? Seconds(string time)
    {
        var parts = time.Split(':');
        if (parts.Length is < 2 or > 3) return null;
        double total = 0;
        foreach (var part in parts)
        {
            if (!double.TryParse(part, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number)) return null;
            total = total * 60 + number;
        }
        return total;
    }
}
