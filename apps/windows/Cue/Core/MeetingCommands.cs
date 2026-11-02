namespace Cue;

/// <summary>
/// The `CUE_CONTROL` commands of the calls (the Mac's, line for line): `assign EVENT | PROJECT` (an Upcoming call's project picker, by the event's title; the
/// project by name, else as given) and `notification record|dismiss` (Record / Not Now on the latest prompt).
/// </summary>
internal static class MeetingCommands
{
    public static void Register(AppState state)
    {
        var control = state.Control;

        control.Register("assign", async argument =>
        {
            var sides = argument.Split(" | ");
            if (sides.Length != 2) return;
            // The calendar is read again first: the page may not have seen the call yet.
            await state.Calendar.Refresh(force: true);
            if (state.Calendar.Events.FirstOrDefault(item => item.Title == sides[0]) is { } call)
                state.Calendar.Assign(call, state.Projects.FindByName(sides[1])?.Id ?? sides[1]);
        });

        control.Register("notification", argument =>
        {
            state.Meetings.AnswerLatestPrompt(record: argument == "record");
            return Task.CompletedTask;
        });
    }
}
