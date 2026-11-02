using System.Text.Json;

namespace Cue;

/// <summary>Why a call to the Cue API didn't work.</summary>
public enum CueApiError
{
    /// <summary>The identity provider vouched for the person, but they aren't on the list.</summary>
    NotInvited,

    /// <summary>They gave up on the sign-in.</summary>
    Cancelled,

    /// <summary>The session is over (refresh token revoked or expired, user disabled): sign in again.</summary>
    Ended,

    /// <summary>The month's allowance is spent (`limit_reached`, 402): the message is the sentence the backend worded.</summary>
    LimitReached,

    /// <summary>Too many requests too quickly (`rate_limited`, 429).</summary>
    RateLimited,

    /// <summary>The owner has paused the plan (`plan_paused`, 503).</summary>
    PlanPaused,

    /// <summary>The API said no.</summary>
    Server,

    /// <summary>The API couldn't be reached.</summary>
    Network,
}

/// <summary>An error of the Cue API: its message is what to tell the person, as the backend worded it where it did.</summary>
public sealed class CueApiException : Exception
{
    public CueApiError Kind { get; }

    /// <summary>The backend's error code (`{error: {code}}`), when it sent one.</summary>
    public string? Code { get; }

    /// <summary>Whether the same request may succeed if sent again later (`{error: {retryable}}`).</summary>
    public bool Retryable { get; }

    /// <summary>For <see cref="CueApiError.NotInvited"/>: whose email it was.</summary>
    public string? Email { get; }

    public CueApiException(CueApiError kind, string message, string? code = null, bool retryable = false, string? email = null)
        : base(message)
    {
        Kind = kind;
        Code = code;
        Retryable = retryable;
        Email = email;
    }

    public static CueApiException NotInvited(string? email) =>
        new(
            CueApiError.NotInvited,
            $"{email ?? "That account"} hasn't been invited to Cue yet. Cue is invite-only: ask whoever runs it to invite that email address, or sign in with another account.",
            "not_invited",
            email: email);

    public static CueApiException Network(string why) => new(CueApiError.Network, $"Couldn't reach Cue: {why}", retryable: true);

    public static CueApiException Server(string why) => new(CueApiError.Server, why);
}

/// <summary>The body of every error the Cue API sends: `{error: {code, message, retryable}}`.</summary>
public sealed record ApiErrorBody(string? Code, string? Message, bool Retryable)
{
    public static ApiErrorBody? In(byte[] data)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            if (document.RootElement.ValueKind != JsonValueKind.Object || !document.RootElement.TryGetProperty("error", out var error)
                || error.ValueKind != JsonValueKind.Object)
                return null;
            string? Text(string name) => error.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            return new ApiErrorBody(Text("code"), Text("message"), error.TryGetProperty("retryable", out var retry) && retry.ValueKind == JsonValueKind.True);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
