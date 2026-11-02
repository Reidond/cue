namespace Cue;

/// <summary>
/// What the live call puts outside Cue's own windows: the icon in the notification area and the system-wide shortcuts, both on one hidden window. Under
/// CUE_BACKGROUND (a test run) there are neither, as on the Mac, so a run never takes keys from whoever is using the PC; CUE_SURFACES=1 has them anyway
/// for the case about them.
/// </summary>
internal sealed class LiveSurfaces : IDisposable
{
    private readonly MessageWindow window = new();
    private readonly Tray tray;
    private readonly HotKeys keys;

    /// <summary>Cue has an icon in the notification area: closing the dashboard only hides it, and Cue goes on from there.</summary>
    public static bool HasTray { get; private set; }

    /// <summary>The icon is red while a call is recorded, even with the overlay hidden.</summary>
    public Tray Icon => tray;

    public LiveSurfaces(AppState state)
    {
        tray = new Tray(window, state);
        HasTray = true;
        keys = new HotKeys(window, state.Log);
        var live = state.Live;
        var preferences = state.Preferences;
        // The icon is red while a call is recorded, even with the overlay hidden.
        live.Recorder.PropertyChanged += (_, _) => tray.Recording = live.Recorder.IsRecording;
        // Win+Alt+KEY (virtual-key codes): Enter, H, A, C (record: not R, which is the Game Bar's), Page Up and Page Down, + and -. (Windows keeps Win+Alt
        // with the arrows.)
        keys.Register("Answer Now", 0x0D, live.AnswerNow);
        keys.Register("Show or Hide Cue", 0x48, live.ToggleOverlay);
        keys.Register("Auto answers", 0x41, () => preferences.AutoAnswer = !preferences.AutoAnswer);
        keys.Register("Start or Stop Recording", 0x43, () => live.ToggleRecording(RecordingTrigger.HotKey));
        keys.Register("the previous question", 0x21, () => live.Step(-1));
        keys.Register("the next question", 0x22, () => live.Step(1));
        keys.Register("larger text", 0xBB, () => preferences.TextSize += 1);
        keys.Register("smaller text", 0xBD, () => preferences.TextSize -= 1);
    }

    public void Dispose()
    {
        HasTray = false;
        keys.Dispose();
        tray.Dispose();
        window.Dispose();
    }
}
