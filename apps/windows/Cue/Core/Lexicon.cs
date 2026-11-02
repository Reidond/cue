using System.Text.Json;

namespace Cue;

/// <summary>
/// The few words of a language the overlay needs to set an answer (what its "numbers" and "source" lines start with) and a note needs to label its
/// transcript (who the call side is, and the transcript's heading). The data is the Mac's
/// `Resources/lexicons/CODE.json` (the build copies them next to Cue.exe); the server keeps the rest of each language's data.
/// </summary>
public sealed record Lexicon(string NumbersLabel, string SourceLabel, string Participant, string NumberedParticipant, string TranscriptHeading)
{
    public static readonly Lexicon English = new("Numbers", "Source", "Participant", "Participant {0}", "Transcript");

    /// <summary>"Participant 2": the call side's second voice.</summary>
    public string NumberedParticipantLabel(int number) => string.Format(System.Globalization.CultureInfo.InvariantCulture, NumberedParticipant, number);

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
            string Text(string name, string fallback) => root.TryGetProperty(name, out var value) ? value.GetString() ?? fallback : fallback;
            loaded = new Lexicon(
                Text("numbersLabel", English.NumbersLabel),
                Text("sourceLabel", English.SourceLabel),
                Text("participantLabel", English.Participant),
                // The Mac's data has "%d" where the number goes.
                Text("numberedParticipantLabel", "Participant %d").Replace("%d", "{0}", StringComparison.Ordinal),
                Text("transcriptHeading", English.TranscriptHeading));
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // Unknown languages still get English labels.
        }
        Cache[code] = loaded;
        return loaded;
    }
}
