namespace Cue;

/// <summary>A language a person can read Cue in: its code, its name in English and its name in itself (packages/contract: `LANGUAGES`).</summary>
public sealed record Language(string Code, string Name, string Native);

/// <summary>
/// The languages a person reads Cue in (Settings › General › Languages): none, one, or two, kept in the account (`GET /v1/me` `languages`,
/// `PUT /v1/me/languages`). With two, every answer and every note comes in both: the language spoken in the call, and the other one beside it.
/// </summary>
public static class Languages
{
    /// <summary>The ones the backend knows, in the contract's order.</summary>
    public static readonly IReadOnlyList<Language> All =
    [
        new("en", "English", "English"),
        new("uk", "Ukrainian", "Українська"),
        new("pl", "Polish", "Polski"),
        new("de", "German", "Deutsch"),
        new("fr", "French", "Français"),
        new("es", "Spanish", "Español"),
        new("it", "Italian", "Italiano"),
        new("pt", "Portuguese", "Português"),
        new("nl", "Dutch", "Nederlands"),
        new("cs", "Czech", "Čeština"),
    ];

    /// <summary>As the pickers list them: by their own names, as a person looks for their language.</summary>
    public static IReadOnlyList<Language> ByNativeName { get; } = [.. All.OrderBy(language => language.Native, StringComparer.InvariantCultureIgnoreCase)];

    /// <summary>"uk" or "uk-UA" → Ukrainian; null for one Cue doesn't list.</summary>
    public static Language? Find(string? code)
    {
        if (string.IsNullOrEmpty(code)) return null;
        var main = code.Split('-')[0].ToLowerInvariant();
        return All.FirstOrDefault(language => language.Code == main);
    }

    /// <summary>"Ukrainian": its name in English (the code when Cue doesn't list it).</summary>
    public static string NameOf(string code) => Find(code)?.Name ?? code;

    /// <summary>"Українська": its name in itself.</summary>
    public static string NativeOf(string code) => Find(code)?.Native ?? code;

    /// <summary>What the session log says of a choice: "English, Ukrainian", "English", or that there is none.</summary>
    public static string Describe(IReadOnlyList<string> codes) =>
        codes.Count == 0 ? "none — Cue follows the language it hears" : string.Join(", ", codes.Select(NameOf));
}

/// <summary>How an answer in two languages is laid out on the overlay (Settings › General › Languages › Answers; `answerLayout`).</summary>
public enum AnswerLayout
{
    /// <summary>Each line, and its translation under it, smaller.</summary>
    Subtitles,

    /// <summary>Side by side: a column per language, the lines aligned across them (Subtitles where the overlay is too narrow).</summary>
    Mirror,

    /// <summary>The answer as with one language, then all the translations in one compact paragraph.</summary>
    Focus,
}

/// <summary>How a note in two languages is laid out on its page (Settings › General › Languages › Notes; `noteLayout`).</summary>
public enum NoteLayout
{
    /// <summary>A switch between the two languages above the note.</summary>
    Switch,

    /// <summary>One after another: the summary, the translated summary, the transcript with each line's translation.</summary>
    Both,
}

/// <summary>
/// The `CUE_CONTROL` commands of the languages (signed in, as the rest): `languages en uk` (the Languages pickers set to these codes, in order;
/// `languages` alone clears them), `answer-layout subtitles|mirror|focus` and `note-layout switch|both` (the Answers and Notes pickers), and
/// `note-language CODE` (the language switch above the open note).
/// </summary>
internal static class LanguageCommands
{
    public static void Register(AppState state)
    {
        var control = state.Control;
        control.Register("languages", argument => state.Api.SetLanguages(argument.Split(' ', StringSplitOptions.RemoveEmptyEntries)));
        control.Register("answer-layout", argument =>
        {
            if (Preferences.ParseAnswerLayout(argument.Trim()) is { } layout) state.Preferences.AnswerLayout = layout;
            return Task.CompletedTask;
        });
        control.Register("note-layout", argument =>
        {
            if (Preferences.ParseNoteLayout(argument.Trim()) is { } layout) state.Preferences.NoteLayout = layout;
            return Task.CompletedTask;
        });
        control.Register("note-language", argument =>
        {
            state.Dashboard.NoteLanguage = argument.Trim().Length == 0 ? null : argument.Trim().ToLowerInvariant();
            return Task.CompletedTask;
        });
    }
}
