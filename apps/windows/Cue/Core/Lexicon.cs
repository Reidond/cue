using System.Text.Json;

namespace Cue;

/// <summary>
/// The few words of a language the overlay needs to set an answer: what its "numbers" and "source" lines start with. The data is the Mac's
/// `Resources/lexicons/CODE.json` (the build copies them next to Cue.exe); the server keeps the rest of each language's data.
/// </summary>
public sealed record Lexicon(string NumbersLabel, string SourceLabel)
{
    public static readonly Lexicon English = new("Numbers", "Source");

    private static readonly Dictionary<string, Lexicon> Cache = [];

    public static Lexicon Load(string? code)
    {
        if (string.IsNullOrEmpty(code)) return English;
        if (Cache.TryGetValue(code, out var cached)) return cached;
        Lexicon loaded = English;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Resources", "lexicons", $"{code}.json")));
            var root = document.RootElement;
            loaded = new Lexicon(
                root.TryGetProperty("numbersLabel", out var numbers) ? numbers.GetString() ?? English.NumbersLabel : English.NumbersLabel,
                root.TryGetProperty("sourceLabel", out var source) ? source.GetString() ?? English.SourceLabel : English.SourceLabel);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // Unknown languages still get English labels.
        }
        Cache[code] = loaded;
        return loaded;
    }
}
