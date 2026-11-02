using System.Text.Json;

namespace Cue;

/// <summary>A project of the account, as far as a live call needs it (packages/contract: projects.ts).</summary>
public sealed record ProjectInfo(string Id, string Name, string Language, int MaterialCount, double? LastUsedAt);

/// <summary>
/// The one small place where the live call finds the account's projects (`/v1/projects`), by name. The projects slice has its own store with pages
/// for them; once the two meet, Start Cue moves onto a project's page and this goes by what that store holds.
/// </summary>
public static class ProjectLookup
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private sealed record Listing(List<ProjectInfo> Projects);

    public static async Task<IReadOnlyList<ProjectInfo>> List(CueApi api)
    {
        var data = await api.Get("v1/projects");
        try
        {
            return JsonSerializer.Deserialize<Listing>(data, Json)?.Projects ?? [];
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }

    /// <summary>The project with that name (the case of the letters does not matter); null when there is none.</summary>
    public static async Task<ProjectInfo?> Find(CueApi api, string name) =>
        (await List(api)).FirstOrDefault(project => string.Equals(project.Name, name, StringComparison.CurrentCultureIgnoreCase));

    /// <summary>Marks the project as the one used last, so the next launch opens on it. Best effort.</summary>
    public static async Task Touch(CueApi api, string id)
    {
        try
        {
            await api.Request("PATCH", $"v1/projects/{id}", json: JsonSerializer.SerializeToUtf8Bytes(new { lastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
        }
        catch (CueApiException)
        {
        }
    }

    /// <summary>Makes a project of that name.</summary>
    public static async Task<ProjectInfo> Create(CueApi api, string name)
    {
        var data = await api.Request("POST", "v1/projects", json: JsonSerializer.SerializeToUtf8Bytes(new { name }));
        try
        {
            return JsonSerializer.Deserialize<ProjectInfo>(data, Json) ?? throw new JsonException("empty");
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }
}
