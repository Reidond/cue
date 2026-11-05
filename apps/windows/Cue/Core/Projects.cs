using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Cue;

/// <summary>
/// One talk or series of calls. It lives in the Cue account (its settings and its materials); the folder in the library holds what stays on
/// this PC until the notes move too: `project.json`, which ties the folder to the account's project, and the notes.
/// </summary>
public sealed record Project
{
    public string Name { get; init; } = "";

    /// <summary>The person's own words about the talk; empty: the brief's.</summary>
    public string Occasion { get; init; } = "";

    /// <summary>The language Cue last heard in the project's calls: never chosen, the account says.</summary>
    public string Language { get; init; } = DefaultLanguage;

    /// <summary>The person's own names and terms that speech recognition should spell right; empty: the brief's.</summary>
    public string Vocabulary { get; init; } = "";

    /// <summary>What Cue wrote from the materials (the account's; not kept in `project.json`).</summary>
    public ProjectBrief Brief { get; init; } = ProjectBrief.None;

    public DateTimeOffset Created { get; init; } = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    public DateTimeOffset? LastUsed { get; init; }

    /// <summary>The project in the account (the Cue API); null for one that is only on this PC so far.</summary>
    public string? ServerId { get; init; }

    /// <summary>The project's folder; its name is the project's identity here (notes and calendar assignments point at it).</summary>
    public string Folder { get; init; } = "";

    /// <summary>The files of the project, as the account holds them.</summary>
    public IReadOnlyList<Material> Materials { get; init; } = [];

    public string Id => Path.GetFileName(Folder);

    /// <summary>Files that were copied here before projects moved to the account; they go up with the project at the first sign-in.</summary>
    public string MaterialsFolder => Path.Combine(Folder, "Materials");

    public string NotesFolder => Path.Combine(Folder, "Notes");

    /// <summary>The language of the PC, as a code (two or three letters), until the account says what Cue heard; English when it is not one.</summary>
    public static string DefaultLanguage { get; } =
        Regex.IsMatch(CultureInfo.CurrentUICulture.TwoLetterISOLanguageName, "^[a-z]{2,3}$") ? CultureInfo.CurrentUICulture.TwoLetterISOLanguageName : "en";
}

/// <summary>A prepared question and its answer: written in a material, or one of the likely questions Cue answered from the materials.</summary>
/// <param name="ByCue">Prepared by Cue from the materials, not written in them.</param>
public sealed record PreparedAnswer(string Q, string A, string? Who, string Source, bool ByCue = false);

/// <summary>One file of a project, as the Cue API read it.</summary>
public sealed record MaterialDocument(string Name, string Summary, string? Error);

/// <summary>
/// What the account read from a project's files, for the project's page: its prepared answers (the files' own first, then the ones Cue wrote from
/// them) and how much Claude reads for each question.
/// (The Call Durable Object builds the prompt and matches questions to the prepared answers on the server.)
/// </summary>
public sealed class KnowledgeBase
{
    public IReadOnlyList<MaterialDocument> Documents { get; }
    public IReadOnlyList<PreparedAnswer> Prepared { get; }

    /// <summary>Null from a backend from before it said.</summary>
    public ProjectReading? Reading { get; }

    public KnowledgeBase(IReadOnlyList<MaterialDocument> documents, IReadOnlyList<PreparedAnswer> prepared, ProjectReading? reading = null)
    {
        Documents = documents;
        Prepared = prepared;
        Reading = reading;
    }

    /// <summary>"~2k tokens · 3 prepared answers", or for materials too long to read whole "~263k tokens, ~6k read per question · 3 prepared answers".</summary>
    public string Summary
    {
        get
        {
            static string Size(int tokens) => tokens >= 1000 ? $"{tokens / 1000}k" : tokens.ToString(CultureInfo.CurrentCulture);
            var answers = $"{Prepared.Count} prepared answers";
            return Reading switch
            {
                null => answers,
                { Passages: true } => $"~{Size(Reading.TotalTokens)} tokens, ~{Size(Reading.Tokens)} read per question · {answers}",
                _ => $"~{Size(Reading.Tokens)} tokens · {answers}",
            };
        }
    }
}

/// <summary>`project.json`: the Mac's file, key for key (the dates as `2026-10-20T10:00:00Z`).</summary>
internal sealed class ProjectFile
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private const string DateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'";

    [JsonPropertyName("created")] public string? Created { get; set; }
    [JsonPropertyName("language")] public string? Language { get; set; }
    [JsonPropertyName("lastUsed")] public string? LastUsed { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("namesAndTerms")] public string? NamesAndTerms { get; set; }
    [JsonPropertyName("occasion")] public string? Occasion { get; set; }
    [JsonPropertyName("serverID")] public string? ServerId { get; set; }

    public static string Path(string folder) => System.IO.Path.Combine(folder, "project.json");

    public static ProjectFile Of(Project project) =>
        new()
        {
            Created = project.Created.UtcDateTime.ToString(DateFormat, CultureInfo.InvariantCulture),
            Language = project.Language,
            LastUsed = project.LastUsed?.UtcDateTime.ToString(DateFormat, CultureInfo.InvariantCulture),
            Name = project.Name,
            NamesAndTerms = project.Vocabulary,
            Occasion = project.Occasion,
            ServerId = project.ServerId,
        };

    public string ToJson() => JsonSerializer.Serialize(this, Options);

    /// <summary>The project in a folder: one without `project.json` (or with one that can't be read) is named after its folder.</summary>
    public static Project Load(string folder)
    {
        ProjectFile? file = null;
        try
        {
            file = JsonSerializer.Deserialize<ProjectFile>(File.ReadAllText(Path(folder)), Options);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
        }
        static DateTimeOffset? Date(string? text) =>
            DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date : null;
        var name = file?.Name is { } named && !string.IsNullOrWhiteSpace(named) ? named : System.IO.Path.GetFileName(folder);
        var project = new Project
        {
            Name = name,
            Occasion = file?.Occasion ?? "",
            Language = file?.Language ?? Project.DefaultLanguage,
            Vocabulary = file?.NamesAndTerms ?? "",
            LastUsed = Date(file?.LastUsed),
            ServerId = file?.ServerId,
            Folder = folder,
        };
        return Date(file?.Created) is { } created ? project with { Created = created } : project;
    }
}
