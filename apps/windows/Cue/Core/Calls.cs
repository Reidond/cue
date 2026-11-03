using System.Text.Json;

namespace Cue;

/// <summary>Which of the two audio sources a line, a frame or a meter is about: your microphone, or what the PC plays (the call).</summary>
public enum Side
{
    Me,
    Others,
}

public static class Sides
{
    /// <summary>What the transcript calls them.</summary>
    public static string Label(this Side side) => side == Side.Me ? "You" : "Call";

    public static Side? Parse(string? channel) =>
        channel switch
        {
            "me" => Side.Me,
            "others" => Side.Others,
            _ => null,
        };
}

/// <summary>A call as `POST /v1/calls` made it (packages/contract: calls.ts). The shapes in this file follow the contract by hand.</summary>
/// <param name="StartedAt">Milliseconds since the epoch.</param>
public sealed record CallInfo(string CallId, string ProjectId, double StartedAt);

/// <summary>One event of the live socket. Every type uses some of these fields (see `CallEvent` in the contract); the rest stay null.</summary>
public sealed class CallEvent
{
    public string Type { get; init; } = "";
    public int Seq { get; init; }
    public string? CallId { get; init; }
    public bool? Resumed { get; init; }
    public string? Part { get; init; }
    public string? State { get; init; }
    public string? Detail { get; init; }
    public string? Channel { get; init; }
    public bool? Active { get; init; }
    public int? Speaker { get; init; }
    public string? Text { get; init; }
    public double? Start { get; init; }
    public double? End { get; init; }
    public string? Id { get; init; }
    public string? Exchange { get; init; }
    public int? Index { get; init; }
    public int? Of { get; init; }
    public string? Opener { get; init; }
    public bool? Requested { get; init; }
    public bool? Forced { get; init; }
    public string? QuestionId { get; init; }
    public string? Question { get; init; }
    public string? Answer { get; init; }
    public string? Who { get; init; }
    public string? Source { get; init; }
    public double? Score { get; init; }
    public string? Error { get; init; }
    public string? Code { get; init; }
    public string? Message { get; init; }
    public bool? Fatal { get; init; }
    public int? Lines { get; init; }

    /// <summary>A `language` event's: the code (en, uk, …) and its name in English ("Ukrainian").</summary>
    public string? Language { get; init; }

    public string? Name { get; init; }

    /// <summary>A `question` event's, with two languages chosen: the other one, and the question in it.</summary>
    public QuestionTranslation? Translation { get; init; }

    /// <summary>The audio source the event is about.</summary>
    public Side? Lane => Sides.Parse(Channel);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static CallEvent? Parse(string text)
    {
        try
        {
            return JsonSerializer.Deserialize<CallEvent>(text, Json);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// With two languages chosen, what a question says of the other one (contract: `QuestionTranslation`): its code and English name, and the question
/// in it (null for a question typed or forced). The answer then follows each line with its translation on a line that starts with "» ".
/// </summary>
public sealed record QuestionTranslation(string Language, string Name, string? Text);

/// <summary>One line of an answer, and its translation when the answer comes in two languages (not there yet while it streams in).</summary>
public sealed record AnswerRow(string Text, string? Translation)
{
    /// <summary>
    /// An answer's lines as rows: a line that starts with "» " is the translation of the row above it. Empty lines are left out; a line still
    /// streaming in is there as far as it has come.
    /// </summary>
    public static IReadOnlyList<AnswerRow> Of(string text)
    {
        var rows = new List<AnswerRow>();
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim(' ', '\t', '\r');
            if (line.Length == 0) continue;
            if (line.StartsWith('»'))
            {
                var translation = line[1..].Trim();
                if (rows.Count > 0 && rows[^1].Translation is null && translation.Length > 0) rows[^1] = rows[^1] with { Translation = translation };
                continue;
            }
            rows.Add(new AnswerRow(line, null));
        }
        return rows;
    }
}

/// <summary>A finished line of the live transcript.</summary>
/// <param name="Time">When the speaker stopped.</param>
public sealed record Utterance(Side Side, string Text, DateTime Started, DateTime Time);

/// <summary>What was asked in one go: one question or several, each answered on its own and shown together.</summary>
public sealed class Exchange
{
    public Guid Id { get; } = Guid.NewGuid();

    /// <summary>The server's name for the questions asked in one go (what `prepare` says).</summary>
    public required string ServerId { get; init; }

    public List<Answer> Answers { get; } = [];

    /// <summary>Noticed with Auto off: the questions wait for Prepare Answer.</summary>
    public bool Waiting => Answers.Any(answer => !answer.Requested);

    public bool IsNotAQuestion => Answers.All(answer => answer.IsNotAQuestion);
}

public sealed class Answer
{
    private static readonly char[] Space = [' ', '\t'];

    public Guid Id { get; } = Guid.NewGuid();

    /// <summary>The server's id of the question: the events of its answer name it.</summary>
    public required string QuestionId { get; init; }

    public required string Question { get; init; }

    /// <summary>Its place among the questions asked in one go, and how many there were.</summary>
    public int Part { get; set; }

    public int Parts { get; set; } = 1;
    public DateTime AskedAt { get; set; } = DateTime.Now;

    /// <summary>Shown the instant the question lands, before Claude says anything.</summary>
    public string? Opener { get; init; }

    /// <summary>The prepared answer that matches, once the server has found it.</summary>
    public PreparedAnswer? Prepared { get; set; }

    public double PreparedScore { get; set; }

    /// <summary>Being answered (a question noticed with Auto off isn't, until Prepare Answer).</summary>
    public bool Requested { get; set; } = true;

    public string Text { get; set; } = "";
    public DateTime? FirstTokenAt { get; set; }
    public bool Done { get; set; }
    public string? Error { get; set; }

    /// <summary>Claude's "—": nothing to answer (even when it explains why after the dash).</summary>
    public bool IsNotAQuestion => Done && Text.Trim().StartsWith('—');

    /// <summary>The first words of a real answer have come (not "—").</summary>
    public bool IsUnderWay
    {
        get
        {
            var said = Text.Trim();
            return !said.StartsWith('—') && said.Any(c => !"—- \n".Contains(c));
        }
    }

    /// <summary>Claude's first line, once it is complete.</summary>
    public string? FirstLine
    {
        get
        {
            var newline = Text.IndexOf('\n');
            if (newline >= 0) return Text[..newline].Trim(Space);
            return Done && Text.Length > 0 ? Text.Trim() : null;
        }
    }

    /// <summary>What to say right now: Claude's first line when ready, the instant opener until then.</summary>
    public string? SayNow => FirstLine ?? Opener;

    /// <summary>With two languages chosen: the other one (the question in it, when it was heard); null with one or none.</summary>
    public QuestionTranslation? Translation { get; init; }

    /// <summary>What Claude said, line by line, each with its translation ("» " lines) when the answer comes in two languages.</summary>
    public IReadOnlyList<AnswerRow> Rows => AnswerRow.Of(Text);

    /// <summary>The first line's translation, once it has come.</summary>
    public string? FirstTranslation => FirstLine is null ? null : Rows.FirstOrDefault()?.Translation;

    /// <summary>The lines after the first, with their translations.</summary>
    public IReadOnlyList<AnswerRow> Rest => FirstLine is null ? [] : [.. Rows.Skip(1)];
}

/// <summary>How one part of the live path is doing (the microphone, the call audio, speech recognition, Claude).</summary>
public sealed record ServiceStatus(bool Ok = false, string Detail = "Starting…", bool Working = false)
{
    /// <summary>Before a call exists: nothing is running yet, and that is not a problem.</summary>
    public static readonly ServiceStatus Idle = new(false, "Starts when you start listening", true);
}

/// <summary>The question judge, as the server reports it.</summary>
public enum JudgeState
{
    Starting,
    Ready,
    Unavailable,
}

public enum StatusKind
{
    Ready,
    Working,
    Problem,
}
