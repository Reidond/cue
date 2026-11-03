namespace Cue;

/// <summary>
/// How two languages are laid out, on this PC (the languages themselves are the account's, see <see cref="Languages"/>): the overlay's answers
/// (`answerLayout`: subtitles, mirror or focus) and a note's page (`noteLayout`: switch or both). Settings shows them once two languages are chosen.
/// </summary>
public sealed partial class Preferences
{
    private AnswerLayout? answerLayout;
    private NoteLayout? noteLayout;

    public AnswerLayout AnswerLayout
    {
        get => answerLayout ??= ParseAnswerLayout(file.String("answerLayout")) ?? AnswerLayout.Subtitles;
        set
        {
            if (AnswerLayout == value) return;
            answerLayout = value;
            file.Set("answerLayout", Key(value));
            Raise();
        }
    }

    public NoteLayout NoteLayout
    {
        get => noteLayout ??= ParseNoteLayout(file.String("noteLayout")) ?? NoteLayout.Switch;
        set
        {
            if (NoteLayout == value) return;
            noteLayout = value;
            file.Set("noteLayout", value == NoteLayout.Both ? "both" : "switch");
            Raise();
        }
    }

    /// <summary>The settings file's word for a layout.</summary>
    public static string Key(AnswerLayout layout) =>
        layout switch
        {
            AnswerLayout.Mirror => "mirror",
            AnswerLayout.Focus => "focus",
            _ => "subtitles",
        };

    public static AnswerLayout? ParseAnswerLayout(string? key) =>
        key switch
        {
            "subtitles" => AnswerLayout.Subtitles,
            "mirror" => AnswerLayout.Mirror,
            "focus" => AnswerLayout.Focus,
            _ => null,
        };

    public static NoteLayout? ParseNoteLayout(string? key) =>
        key switch
        {
            "switch" => NoteLayout.Switch,
            "both" => NoteLayout.Both,
            _ => null,
        };
}
