namespace Cue;

/// <summary>The preferences of the live call and its overlay: how answers are made, how big the text is, where the overlay sits.</summary>
public sealed partial class Preferences
{
    private bool? autoAnswer;
    private bool? micQuestions;
    private bool? showTranscript;
    private double? textSize;
    private string? activeProject;
    private bool activeProjectRead;

    /// <summary>Answer the questions Cue notices by itself; off, they are listed for Prepare Answer.</summary>
    public bool AutoAnswer
    {
        get => autoAnswer ??= file.Bool("autoAnswer") ?? true;
        set
        {
            if (AutoAnswer == value) return;
            autoAnswer = value;
            file.Set("autoAnswer", value);
            Raise();
        }
    }

    /// <summary>Also treat questions the microphone picks up (people in the room) as questions.</summary>
    public bool MicQuestions
    {
        get => micQuestions ??= file.Bool("micQuestions") ?? false;
        set
        {
            if (MicQuestions == value) return;
            micQuestions = value;
            file.Set("micQuestions", value);
            Raise();
        }
    }

    public bool ShowTranscript
    {
        get => showTranscript ??= file.Bool("showTranscript") ?? true;
        set
        {
            if (ShowTranscript == value) return;
            showTranscript = value;
            file.Set("showTranscript", value);
            Raise();
        }
    }

    public const double MinTextSize = 11;
    public const double MaxTextSize = 28;

    /// <summary>The overlay's text size in points.</summary>
    public double TextSize
    {
        get => textSize ??= Math.Clamp(file.Number("textSize") ?? 15, MinTextSize, MaxTextSize);
        set
        {
            value = Math.Clamp(value, MinTextSize, MaxTextSize);
            if (TextSize == value) return;
            textSize = value;
            file.Set("textSize", value);
            Raise();
        }
    }

    /// <summary>The name of the project Cue was last bound to.</summary>
    public string? ActiveProject
    {
        get
        {
            if (!activeProjectRead)
            {
                activeProject = file.String("activeProject");
                activeProjectRead = true;
            }
            return activeProject;
        }
        set
        {
            if (ActiveProject == value) return;
            activeProject = value;
            file.Set("activeProject", value);
            Raise();
        }
    }

    /// <summary>Where the overlay was left, "x,y,width,height" in pixels; null before it was moved.</summary>
    public string? OverlayBounds
    {
        get => file.String("overlayBounds");
        set => file.Set("overlayBounds", value);
    }
}
