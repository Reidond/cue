using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cue;

// The Cue API's projects and materials (packages/contract: projects.ts). The shapes follow it by hand, as the Mac's ProjectsAPI.swift does.

/// <summary>A project as the account holds it. Times are milliseconds since the epoch.</summary>
public sealed record RemoteProject(
    string Id,
    string Name,
    string Occasion,
    string Language,
    string NamesAndTerms,
    double CreatedAt,
    double? LastUsedAt);

/// <summary>A file in a project, and what the server read from it.</summary>
/// <param name="Error">Why its text couldn't be read; null when it was.</param>
/// <param name="Summary">"1,204 words · 3 prepared answers".</param>
public sealed record Material(string Id, string Name, long Size, string? Error, string Summary, int PreparedCount)
{
    /// <summary>What the server reads: the formats of `MATERIAL_EXTENSIONS` (packages/contract).</summary>
    public static readonly IReadOnlySet<string> SupportedExtensions = new HashSet<string>
    {
        "md", "markdown", "txt", "pptx",
        "pdf", "docx", "xlsx", "xls", "xlsm", "xlsb", "et", "ods", "odt", "csv", "html", "xml", "numbers",
    };

    public static bool IsSupported(string path) => SupportedExtensions.Contains(Path.GetExtension(path).TrimStart('.').ToLowerInvariant());
}

/// <summary>A material with the text the server extracted from it.</summary>
public sealed record RemoteMaterialText(string Name, string? Error, string Summary, string Text);

public sealed record RemotePreparedAnswer(string Question, string Answer, string? Who, string Source, string MaterialId);

/// <summary>Fields of a new project; the times are for a project moved in from this PC.</summary>
public sealed record ProjectFields(
    string Name,
    string? Occasion = null,
    string? Language = null,
    string? NamesAndTerms = null,
    double? CreatedAt = null,
    double? LastUsedAt = null);

/// <summary>Fields of a project to change; a null one stays as it is on the server (and the API refuses any it doesn't know, `createdAt` too).</summary>
public sealed record ProjectChanges(
    string? Name = null,
    string? Occasion = null,
    string? Language = null,
    string? NamesAndTerms = null,
    double? LastUsedAt = null);

public static class ProjectsApi
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    private static T Decode<T>(byte[] data)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(data, Json) ?? throw new JsonException("empty");
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }

    private sealed record ProjectList(List<RemoteProject> Projects);

    private sealed record MaterialList(List<Material> Materials);

    private sealed record AnswerList(List<RemotePreparedAnswer> Answers);

    public static async Task<List<RemoteProject>> ListProjects(this CueApi api) =>
        Decode<ProjectList>(await api.Get("v1/projects")).Projects;

    public static async Task<RemoteProject> CreateProject(this CueApi api, ProjectFields fields) =>
        Decode<RemoteProject>(await api.Request("POST", "v1/projects", json: JsonSerializer.SerializeToUtf8Bytes(fields, Json)));

    public static async Task<RemoteProject> UpdateProject(this CueApi api, string id, ProjectChanges changes) =>
        Decode<RemoteProject>(await api.Request("PATCH", $"v1/projects/{id}", json: JsonSerializer.SerializeToUtf8Bytes(changes, Json)));

    public static async Task DeleteProject(this CueApi api, string id) => await api.Request("DELETE", $"v1/projects/{id}");

    public static async Task<List<Material>> Materials(this CueApi api, string project) =>
        Decode<MaterialList>(await api.Get($"v1/projects/{project}/materials")).Materials;

    public static async Task<RemoteMaterialText> MaterialText(this CueApi api, string id, string project) =>
        Decode<RemoteMaterialText>(await api.Get($"v1/projects/{project}/materials/{id}"));

    public static async Task<List<RemotePreparedAnswer>> PreparedAnswers(this CueApi api, string project) =>
        Decode<AnswerList>(await api.Get($"v1/projects/{project}/prepared-answers")).Answers;

    /// <summary>Sends a file to a project; the server stores it and reads its text before it answers.</summary>
    public static async Task<Material> UploadMaterial(this CueApi api, string file, string project)
    {
        var type = MimeTypes.GetValueOrDefault(Path.GetExtension(file).TrimStart('.').ToLowerInvariant(), "application/octet-stream");
        var data = await api.Request(
            "POST",
            $"v1/projects/{project}/materials",
            query: new Dictionary<string, string> { ["name"] = Path.GetFileName(file) },
            file: file,
            contentType: type,
            timeout: TimeSpan.FromMinutes(5));
        return Decode<Material>(data);
    }

    public static async Task DeleteMaterial(this CueApi api, string id, string project) =>
        await api.Request("DELETE", $"v1/projects/{project}/materials/{id}");

    private static readonly Dictionary<string, string> MimeTypes = new()
    {
        ["pdf"] = "application/pdf",
        ["docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ["pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ["xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ["md"] = "text/markdown",
        ["markdown"] = "text/markdown",
        ["txt"] = "text/plain",
        ["csv"] = "text/csv",
        ["html"] = "text/html",
    };
}
