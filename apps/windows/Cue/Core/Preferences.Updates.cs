namespace Cue;

/// <summary>The preference of updates: whether Cue looks for a new version by itself and installs it (<see cref="Updater"/>).</summary>
public sealed partial class Preferences
{
    private bool? automaticUpdates;

    /// <summary>Look for a new Cue when it opens and every few hours, download it, and install it when Cue restarts, quits or next opens.</summary>
    public bool AutomaticUpdates
    {
        get => automaticUpdates ??= file.Bool("automaticUpdates") ?? true;
        set
        {
            if (AutomaticUpdates == value) return;
            automaticUpdates = value;
            file.Set("automaticUpdates", value);
            Raise();
        }
    }
}
