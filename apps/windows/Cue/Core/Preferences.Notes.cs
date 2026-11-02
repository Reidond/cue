namespace Cue;

/// <summary>The preferences of the notes: whether a call gets a summary, and whether its audio is kept next to it.</summary>
public sealed partial class Preferences
{
    private bool? summarizeRecordings;
    private bool? keepAudio;

    /// <summary>Write a summary of each call (and a title for it).</summary>
    public bool SummarizeRecordings
    {
        get => summarizeRecordings ??= file.Bool("summarizeRecordings") ?? true;
        set
        {
            if (SummarizeRecordings == value) return;
            summarizeRecordings = value;
            file.Set("summarizeRecordings", value);
            Raise();
        }
    }

    /// <summary>Keep the call's audio next to its notes.</summary>
    public bool KeepAudio
    {
        get => keepAudio ??= file.Bool("keepAudio") ?? true;
        set
        {
            if (KeepAudio == value) return;
            keepAudio = value;
            file.Set("keepAudio", value);
            Raise();
        }
    }
}
