using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cue;

// The Cue API's projects and materials (packages/contract: projects.ts). The shapes follow it by hand, as the Mac's ProjectsAPI.swift does.

/// <summary>A project as the account holds it. Times are milliseconds since the epoch.</summary>
/// <param name="Occasion">The person's own words about the talk; empty: the brief's are used.</param>
/// <param name="Language">The language Cue last heard in the project's calls (detected, never set).</param>
/// <param name="NamesAndTerms">The person's own names and terms; empty: the brief's are used.</param>
/// <param name="Brief">What Cue wrote from the materials (null from a server before briefs).</param>
public sealed record RemoteProject(
    string Id,
    string Name,
    string Occasion,
    string Language,
    string NamesAndTerms,
    ProjectBrief? Brief,
    double CreatedAt,
    double? LastUsedAt);

/// <summary>
/// What Cue wrote from a project's materials: the occasion, the names and terms, answers to the likely questions. Written again (after a few seconds of
/// quiet) whenever a file is added or removed.
/// </summary>
/// <param name="State">`none` (no materials, or none read yet), `working` (Cue is reading them), `ready` or `failed` (see <paramref name="Error"/>).</param>
/// <param name="Error">Why it couldn't be written, for people.</param>
/// <param name="NamesAndTerms">One per line.</param>
/// <param name="AnswerCount">The questions Cue prepared answers to.</param>
/// <param name="UpdatedAt">Milliseconds since the epoch.</param>
public sealed record ProjectBrief(
    string State = "none",
    string? Error = null,
    string Occasion = "",
    string NamesAndTerms = "",
    int AnswerCount = 0,
    double? UpdatedAt = null)
{
    public static readonly ProjectBrief None = new();

    public bool Working => State == "working";
    public bool Ready => State == "ready";
    public bool Failed => State == "failed";

    /// <summary>The names and terms, one by one.</summary>
    public IReadOnlyList<string> Terms => NamesAndTerms.Split('\n', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>"1 answer", "3 answers": how the session log and the overview count them.</summary>
    public string AnswersText => AnswerCount == 1 ? "1 answer" : $"{AnswerCount} answers";

    /// <summary>"1 name or term", "2 names and terms".</summary>
    public string TermsText => Terms.Count == 1 ? "1 name or term" : $"{Terms.Count} names and terms";
}

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

/// <param name="From">`materials`: written in the file; `cue`: prepared by Cue from the materials.</param>
public sealed record RemotePreparedAnswer(string Question, string Answer, string? Who, string Source, string MaterialId, string? From);

/// <summary>Fields of a new project; the times are for a project moved in from this PC.</summary>
public sealed record ProjectFields(
    string Name,
    string? Occasion = null,
    string? NamesAndTerms = null,
    double? CreatedAt = null,
    double? LastUsedAt = null);

/// <summary>Fields of a project to change; a null one stays as it is on the server (and the API refuses any it doesn't know, `createdAt` too).</summary>
public sealed record ProjectChanges(
    string? Name = null,
    string? Occasion = null,
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

    public static async Task<RemoteProject> Project(this CueApi api, string id) => Decode<RemoteProject>(await api.Get($"v1/projects/{id}"));

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

    /// <summary>Asks the account to write the project's brief again (it does by itself when a file is added or removed): the brief, now working.</summary>
    public static async Task<ProjectBrief> BriefAgain(this CueApi api, string project) =>
        Decode<ProjectBrief>(await api.Request("POST", $"v1/projects/{project}/brief"));

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

public sealed partial class CueApi
{
    /// <summary>
    /// Follows the project's brief while the account writes it (server-sent events): `onBrief` gets it at once and again whenever it changes, until the server
    /// ends the stream, once it is no longer `working`. False when the server has no such stream (one from before it, during a deploy): the caller reads the
    /// project again now and then instead.
    /// </summary>
    public async Task<bool> FollowBriefEvents(string project, Action<ProjectBrief> onBrief, CancellationToken cancel = default)
    {
        var token = await Bearer();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            limit.CancelAfter(TimeSpan.FromMinutes(10));
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(BaseUrl, $"v1/projects/{project}/brief/events"));
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("Cue-Version", $"windows/{Env.Version}");
            request.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token);
                var status = (int)response.StatusCode;
                if (status == 401 && attempt == 0)
                {
                    token = await Bearer(refreshing: true);
                    continue;
                }
                if (status == 404) return false;
                if (status != 200)
                {
                    var error = ApiErrorBody.In(await response.Content.ReadAsByteArrayAsync(limit.Token));
                    if (status == 401) throw new CueApiException(CueApiError.Ended, error?.Message ?? "Your session has ended. Sign in to Cue again.", error?.Code);
                    throw CueApiException.Server(error?.Message ?? $"Cue answered {status}.");
                }
                // An event's name comes before its data; `ping` only keeps the connection open.
                var name = "message";
                using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(limit.Token));
                while (await reader.ReadLineAsync(limit.Token) is { } line)
                {
                    if (line.StartsWith("event:", StringComparison.Ordinal))
                    {
                        name = line[6..].Trim();
                        continue;
                    }
                    if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                    var named = name;
                    name = "message";
                    if (named != "brief") continue;
                    ProjectBrief? brief;
                    try
                    {
                        brief = JsonSerializer.Deserialize<ProjectBrief>(line[5..], EventJson);
                    }
                    catch (JsonException)
                    {
                        continue;
                    }
                    if (brief is not null) onBrief(brief);
                }
                return true;
            }
            catch (Exception e) when (e is HttpRequestException or IOException or OperationCanceledException && !cancel.IsCancellationRequested)
            {
                throw CueApiException.Network(e is OperationCanceledException ? "the stream timed out." : e.Message);
            }
        }
        throw CueApiException.Server("Cue didn't accept the sign-in.");
    }
}
