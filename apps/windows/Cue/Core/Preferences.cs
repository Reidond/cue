using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cue;

/// <summary>
/// Cue's settings: one JSON file, `Application Support/Cue/settings.json` (the Mac keeps them in a defaults domain). A case writes a key with
/// `cue.defaults(key, value)`, which edits the same file; Cue reads it at launch.
/// </summary>
public sealed class SettingsFile
{
    private readonly string path = Path.Combine(Storage.AppSupport, "settings.json");
    private JsonObject values;

    public SettingsFile()
    {
        try
        {
            values = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? [];
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            values = [];
        }
    }

    public string? String(string key) => values[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    public bool? Bool(string key) => values[key] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;

    public double? Number(string key) => values[key] is JsonValue value && value.TryGetValue<double>(out var number) ? number : null;

    public void Set(string key, JsonNode? value)
    {
        values[key] = value;
        Storage.WriteAtomically(path, values.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}

/// <summary>Global preferences, persisted in settings.json; everything about a talk lives in its project (a later slice).</summary>
public sealed partial class Preferences : Observable
{
    private readonly SettingsFile file = new();
    private string speakerName;
    private string? activeProject;

    public Preferences()
    {
        speakerName = file.String("speakerName") ?? Environment.UserName;
        activeProject = file.String("activeProject");
    }

    /// <summary>Folder name of the project Cue was last bound to.</summary>
    public string? ActiveProject
    {
        get => activeProject;
        set
        {
            if (Set(ref activeProject, value)) file.Set("activeProject", value);
        }
    }

    /// <summary>What notes and answers call the person who uses Cue.</summary>
    public string SpeakerName
    {
        get => speakerName;
        set
        {
            if (Set(ref speakerName, value)) file.Set("speakerName", value);
        }
    }
}
