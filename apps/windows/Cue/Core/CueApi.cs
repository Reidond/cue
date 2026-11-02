using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Web;
using Microsoft.UI.Dispatching;

namespace Cue;

public enum Phase
{
    Restoring,
    SignedOut,
    SigningIn,
    SignedIn,
}

/// <summary>
/// The Cue API's client, and who is signed in: an OAuth 2.1 public client (Authorization Code with PKCE, through the system's browser and a
/// loopback redirect), the refresh token in Windows Credential Manager, the access token (a JWT, 15 minutes) kept in memory and refreshed
/// silently. Cue works only while someone is signed in (<see cref="IsSignedIn"/>): everything else in the app waits for it. Used from the UI
/// thread only; the later slices' features call <see cref="Request"/> (and <see cref="Bearer"/>) for everything they send.
/// </summary>
public sealed partial class CueApi : Observable
{
    /// <summary>The backend: CUE_API_URL points the app at another one (end-to-end cases run their own); otherwise the production address
    /// that scripts/build.ps1 stamps from apps/api/production-url.txt (a build without it talks to `cf dev`).</summary>
    public static Uri BaseUrl { get; } = new((Env.Get("CUE_API_URL") ?? Env.StampedApiUrl).TrimEnd('/') + "/");

    private const string ClientId = "cue-windows";

    /// <summary>The API's identifier in OAuth (RFC 8707 `resource`; the access token's `aud`). Never fetched.</summary>
    private const string Audience = "https://api.cue.test";

    private const string Account = "cueRefreshToken";

    private readonly SessionLog log;
    private readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>CUE_WEB_AUTH=headless follows the authorize URL with HttpClient (cookies and all) instead of opening the browser.</summary>
    private readonly bool headless = Env.Get("CUE_WEB_AUTH") == "headless";

    /// <summary>How often the account is read again (seconds): usage, and whether the account is still allowed. CUE_ME_TICK shortens it in tests.</summary>
    private readonly TimeSpan tick = TimeSpan.FromSeconds(double.TryParse(Env.Get("CUE_ME_TICK"), out var seconds) && seconds > 0 ? seconds : 300);

    private string? accessToken;
    private DateTimeOffset refreshAt = DateTimeOffset.MinValue;
    private Task<string>? refreshing;
    private CancellationTokenSource? signInCancel;
    private DispatcherQueueTimer? timer;
    private Phase phase = Phase.SignedOut;
    private CueMe? me;
    private string? problem;

    public CueApi(SessionLog log) => this.log = log;

    public Phase Phase
    {
        get => phase;
        private set => Set(ref phase, value);
    }

    /// <summary>The signed-in account, its plan and usage; null while signed out.</summary>
    public CueMe? Me
    {
        get => me;
        private set => Set(ref me, value);
    }

    /// <summary>What went wrong the last time, for the sign-in screen: "not invited" is said plainly.</summary>
    public string? Problem
    {
        get => problem;
        private set => Set(ref problem, value);
    }

    public bool IsSignedIn => Phase == Phase.SignedIn;

    /// <summary>Runs once the account is known and before Cue counts as signed in: loads what the account holds, so everything that waits
    /// for a sign-in finds it there.</summary>
    public Func<Task>? OnSignedIn { get; set; }

    /// <summary>At launch: a saved refresh token signs in again without anyone noticing; without one, the sign-in screen.</summary>
    public void Start(DispatcherQueue queue)
    {
        timer = queue.CreateTimer();
        timer.Interval = tick;
        timer.IsRepeating = true;
        timer.Tick += async (_, _) =>
        {
            if (IsSignedIn) await RefreshMe();
            else if (Phase == Phase.SignedOut && SecretStore.Get(Account) is not null) await Restore();
        };
        timer.Start();
        if (SecretStore.Get(Account) is not null)
        {
            Phase = Phase.Restoring;
            _ = Restore();
        }
    }

    // MARK: Signing in and out

    /// <summary>Sign in: the browser for Google or GitHub (Cue's own page offers both), then the code for tokens. `provider` picks the button the
    /// headless sign-in presses (`google` by default).</summary>
    public async Task SignIn(string? provider = null)
    {
        if (Phase is Phase.SigningIn or Phase.SignedIn) return;
        Phase = Phase.SigningIn;
        Problem = null;
        using var cancel = new CancellationTokenSource();
        signInCancel = cancel;
        try
        {
            var verifier = Random(32);
            var state = Random(12);
            using var receiver = LoopbackReceiver.Start();
            var returned = await Authorize(AuthorizeUrl(verifier, state, receiver.RedirectUri), receiver, state, provider ?? "google", cancel.Token);
            var code = CodeIn(returned, state);
            Store(await TokenRequest(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["redirect_uri"] = receiver.RedirectUri,
                ["code_verifier"] = verifier,
            }));
            await LoadMe();
            await BecameSignedIn();
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            Phase = Phase.SignedOut;
        }
        catch (CueApiException e) when (e.Kind == CueApiError.NotInvited)
        {
            Phase = Phase.SignedOut;
            Problem = e.Message;
            log.Write($"{SessionLog.Warning} Not invited: {e.Email ?? "unknown email"}");
        }
        catch (Exception e)
        {
            SecretStore.Remove(Account);
            Phase = Phase.SignedOut;
            Problem = e.Message;
            log.Write($"{SessionLog.Warning} Couldn't sign in to Cue: {e.Message}");
        }
        finally
        {
            signInCancel = null;
        }
    }

    /// <summary>They gave up waiting for the browser.</summary>
    public void CancelSignIn() => signInCancel?.Cancel();

    /// <summary>Sign Out: the backend revokes the refresh token, then it's gone from Credential Manager.</summary>
    public async Task SignOut()
    {
        if (SecretStore.Get(Account) is { } token)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(BaseUrl, "api/auth/oauth2/revoke"))
                {
                    Content = new FormUrlEncodedContent(
                        new Dictionary<string, string> { ["client_id"] = ClientId, ["token"] = token, ["token_type_hint"] = "refresh_token" }),
                };
                (await http.SendAsync(request, timeout.Token)).Dispose();
            }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException)
            {
                // Offline: the token is forgotten here all the same, and expires by itself.
            }
        }
        Reset();
        log.Write("🔑 Signed out of Cue");
    }

    /// <summary>The session is over for a reason that isn't the person's doing: say why, and go to the sign-in screen.</summary>
    private void EndSession(string why)
    {
        if (Phase == Phase.SignedOut && SecretStore.Get(Account) is null) return;
        log.Write($"{SessionLog.Warning} Your Cue session ended: {why}");
        Reset();
        Problem = why;
        log.Write("🔑 Signed out of Cue");
    }

    private void Reset()
    {
        SecretStore.Remove(Account);
        accessToken = null;
        refreshAt = DateTimeOffset.MinValue;
        Me = null;
        lastMe = [];
        Problem = null;
        Phase = Phase.SignedOut;
    }

    private async Task BecameSignedIn()
    {
        if (OnSignedIn is { } hook) await hook();
        Phase = Phase.SignedIn;
        log.Write($"🔑 Signed in to Cue as {Me?.Account.Email ?? "unknown"}");
    }

    /// <summary>Signing in again from the refresh token the last run left in Credential Manager.</summary>
    private async Task Restore()
    {
        Phase = Phase.Restoring;
        try
        {
            await ValidAccessToken();
            await LoadMe();
            await BecameSignedIn();
        }
        catch (CueApiException e) when (e.Kind == CueApiError.Ended)
        {
            EndSession(e.Message);
        }
        catch (Exception e)
        {
            // Offline, say: the token stays, and the next check tries again.
            Phase = Phase.SignedOut;
            Problem = e.Message;
        }
    }

    // MARK: Account

    /// <summary>Reads `/v1/me` again (usage, plan); a session that has ended since is signed out.</summary>
    public async Task RefreshMe()
    {
        try
        {
            await LoadMe();
        }
        catch (CueApiException e) when (e.Kind == CueApiError.Ended)
        {
            EndSession(e.Message);
        }
        catch (Exception)
        {
            // Offline: keep what was shown.
        }
    }

    private byte[] lastMe = [];

    private async Task LoadMe()
    {
        var data = await Get("v1/me");
        // What the account says changes rarely: the UI is told when it does, not on every read.
        if (Me is not null && data.AsSpan().SequenceEqual(lastMe)) return;
        try
        {
            Me = JsonSerializer.Deserialize<CueMe>(data, Json) ?? throw new JsonException("empty");
            lastMe = data;
        }
        catch (JsonException e)
        {
            throw CueApiException.Server($"Cue answered something unexpected: {e.Message}");
        }
    }

    // MARK: Requests

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>`GET path` with the access token, refreshed when it's about to run out or was refused.</summary>
    public Task<byte[]> Get(string path) => Request("GET", path);

    /// <summary>
    /// `method path` with the access token (refreshed when it's about to run out or was refused). `json` is the request's body; `file` is sent as
    /// the body instead, streamed from disk, with `contentType` (the Cue API takes a material that way); `body` is raw bytes, sent the same way (a
    /// part of a recording's upload). Errors are <see cref="CueApiException"/>s: `limit_reached`, `rate_limited` and `plan_paused` have their own kinds.
    /// </summary>
    public async Task<byte[]> Request(
        string method,
        string path,
        IReadOnlyDictionary<string, string>? query = null,
        byte[]? json = null,
        string? file = null,
        byte[]? body = null,
        string? contentType = null,
        TimeSpan? timeout = null,
        CancellationToken cancel = default)
    {
        var token = await ValidAccessToken();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var builder = new UriBuilder(new Uri(BaseUrl, path));
            if (query is { Count: > 0 })
                builder.Query = string.Join('&', query.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                    .Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
            using var request = new HttpRequestMessage(new HttpMethod(method), builder.Uri);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.TryAddWithoutValidation("Cue-Version", $"windows/{Env.Version}");
            Stream? stream = null;
            try
            {
                if (json is not null)
                {
                    request.Content = new ByteArrayContent(json);
                    request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                }
                else if (file is not null)
                {
                    stream = File.OpenRead(file);
                    request.Content = new StreamContent(stream);
                }
                else if (body is not null)
                {
                    request.Content = new ByteArrayContent(body);
                }
                if (contentType is not null && request.Content is not null)
                    request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
                var (data, status) = await Send(request, timeout ?? TimeSpan.FromSeconds(60), cancel);
                if (status == 401 && attempt == 0)
                {
                    token = await RefreshAccessToken();
                    continue;
                }
                var error = ApiErrorBody.In(data);
                if (status == 401)
                    throw new CueApiException(CueApiError.Ended, error?.Message ?? "Your session has ended. Sign in to Cue again.", error?.Code);
                if (status == 402 && error?.Code == "limit_reached")
                    throw new CueApiException(CueApiError.LimitReached, error.Message ?? "You've reached your Cue plan's limit for this month.", error.Code);
                if (status == 429)
                    throw new CueApiException(
                        CueApiError.RateLimited, error?.Message ?? "Too many requests too quickly. Wait a moment and try again.", error?.Code ?? "rate_limited", true);
                if (status == 503 && error?.Code == "plan_paused")
                    throw new CueApiException(CueApiError.PlanPaused, error.Message ?? "Cue is paused at the moment. Try again later.", error.Code, error.Retryable);
                if (status is < 200 or >= 300)
                    throw new CueApiException(CueApiError.Server, error?.Message ?? $"Cue answered {status}.", error?.Code, error?.Retryable ?? false);
                return data;
            }
            finally
            {
                stream?.Dispose();
            }
        }
        throw CueApiException.Server("Cue didn't accept the sign-in.");
    }

    /// <summary>An access token for what <see cref="Request"/> doesn't send (the live socket, the notes' event stream, a note's audio): still good, or refreshed first.</summary>
    public Task<string> Bearer(bool refreshing = false) => refreshing ? RefreshAccessToken() : ValidAccessToken();

    private Task<string> ValidAccessToken() =>
        accessToken is { } token && DateTimeOffset.UtcNow < refreshAt ? Task.FromResult(token) : RefreshAccessToken();

    /// <summary>One refresh at a time: refresh tokens rotate, and using one twice ends the session.</summary>
    private async Task<string> RefreshAccessToken()
    {
        if (refreshing is { } running) return await running;
        if (SecretStore.Get(Account) is not { } token) throw new CueApiException(CueApiError.Ended, "You're signed out.");
        var task = Refresh(token);
        refreshing = task;
        try
        {
            return await task;
        }
        finally
        {
            refreshing = null;
        }
    }

    private async Task<string> Refresh(string token)
    {
        Store(await TokenRequest(new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["refresh_token"] = token }));
        if (IsSignedIn) log.Write("🔑 Cue access refreshed");
        return accessToken ?? "";
    }

    private sealed record Tokens(string AccessToken, string? RefreshToken, double? ExpiresIn);

    private void Store(Tokens tokens)
    {
        accessToken = tokens.AccessToken;
        // Refresh a little before it runs out (a quarter of its life, at most 30 s).
        var life = tokens.ExpiresIn ?? 900;
        refreshAt = DateTimeOffset.UtcNow.AddSeconds(life - Math.Min(30, life / 4));
        if (tokens.RefreshToken is { } refresh) SecretStore.Set(refresh, Account, "Cue - Account");
    }

    /// <summary>The token endpoint. `invalid_grant` means the grant is over; anything else the server didn't like is its message.</summary>
    private async Task<Tokens> TokenRequest(Dictionary<string, string> parameters)
    {
        parameters["client_id"] = ClientId;
        parameters["resource"] = Audience;
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(BaseUrl, "api/auth/oauth2/token"))
        {
            Content = new FormUrlEncodedContent(parameters),
        };
        var (data, status) = await Send(request, TimeSpan.FromSeconds(60), default);
        JsonElement? body = null;
        try
        {
            body = JsonDocument.Parse(data).RootElement.Clone();
        }
        catch (JsonException)
        {
        }
        string? Text(string name) =>
            body is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        if (status != 200)
        {
            if (Text("error") == "invalid_grant") throw new CueApiException(CueApiError.Ended, "Your session has ended. Sign in to Cue again.");
            throw CueApiException.Server(Text("error_description") ?? $"Cue didn't accept the sign-in ({status}).");
        }
        if (Text("access_token") is not { } access) throw CueApiException.Server("Cue answered something unexpected: no access token.");
        double? life = body is { ValueKind: JsonValueKind.Object } json && json.TryGetProperty("expires_in", out var seconds) && seconds.TryGetDouble(out var value)
            ? value
            : null;
        return new Tokens(access, Text("refresh_token"), life);
    }

    private async Task<(byte[] Data, int Status)> Send(HttpRequestMessage request, TimeSpan timeout, CancellationToken cancel)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        limit.CancelAfter(timeout);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, limit.Token);
            return (await response.Content.ReadAsByteArrayAsync(limit.Token), (int)response.StatusCode);
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
        {
            throw CueApiException.Network(e is OperationCanceledException ? "the request timed out." : e.Message);
        }
    }

    // MARK: The browser part

    /// <summary>Base64 without padding, with `-` and `_`: what PKCE and OAuth state use.</summary>
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static string Random(int count) => Base64Url(RandomNumberGenerator.GetBytes(count));

    private static Uri AuthorizeUrl(string verifier, string state, string redirectUri)
    {
        var query = new (string Key, string Value)[]
        {
            ("response_type", "code"),
            ("client_id", ClientId),
            ("redirect_uri", redirectUri),
            ("scope", "openid profile email offline_access"),
            ("state", state),
            ("code_challenge", Base64Url(SHA256.HashData(Encoding.UTF8.GetBytes(verifier)))),
            ("code_challenge_method", "S256"),
            ("resource", Audience),
        };
        return new Uri(BaseUrl, "api/auth/oauth2/authorize?" + string.Join('&', query.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}")));
    }

    /// <summary>The URL the sign-in ended at: the redirect back to the app (with a code, or with `not_invited`), or the invite-only page.</summary>
    private async Task<Uri> Authorize(Uri url, LoopbackReceiver receiver, string state, string provider, CancellationToken cancel)
    {
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        waiting.CancelAfter(TimeSpan.FromMinutes(10));
        var callback = receiver.WaitForCallback(state, waiting.Token);
        try
        {
            if (headless)
            {
                var landed = await AuthorizeHeadless(url, receiver, provider, cancel);
                // The browser would have been sent to the redirect: Cue's own listener answers it too, as it does for a person.
                if (landed.AbsolutePath != LoopbackReceiver.Path) return landed;
                using var plain = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
                (await plain.GetAsync(landed, cancel)).Dispose();
            }
            else
            {
                try
                {
                    Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true })?.Dispose();
                }
                catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
                {
                    throw CueApiException.Server($"Couldn't open your browser for the sign-in: {e.Message}");
                }
            }
            return await callback;
        }
        catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
        {
            throw CueApiException.Server("Sign-in took too long. Try again.");
        }
        finally
        {
            await waiting.CancelAsync();
            try
            {
                await callback;
            }
            catch (Exception)
            {
                // Nobody was waiting for it any more.
            }
        }
    }

    /// <summary>
    /// CUE_WEB_AUTH=headless: what the browser does, by hand: follow the redirects (with cookies), press the provider's button on the sign-in
    /// page, and stop at the redirect back to the app, or at the invite-only page.
    /// </summary>
    private async Task<Uri> AuthorizeHeadless(Uri start, LoopbackReceiver receiver, string provider, CancellationToken cancel)
    {
        using var browser = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = true, CookieContainer = new CookieContainer() })
        {
            Timeout = TimeSpan.FromSeconds(60),
        };
        var url = start;
        for (var hop = 0; hop < 12; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            // What a browser says, so the authorization endpoint answers with a redirect instead of JSON.
            request.Headers.TryAddWithoutValidation("Sec-Fetch-Mode", "navigate");
            request.Headers.TryAddWithoutValidation("Accept", "text/html");
            using var response = await SendBrowser(browser, request, cancel);
            Uri? next = response.Headers.Location is { } location ? new Uri(url, location) : null;
            var text = next is null ? await response.Content.ReadAsStringAsync(cancel) : "";
            if (next is null && response.Content.Headers.ContentType?.MediaType == "application/json")
            {
                try
                {
                    var json = JsonDocument.Parse(text).RootElement;
                    if (json.TryGetProperty("redirect", out var redirect) && redirect.ValueKind == JsonValueKind.True
                        && json.TryGetProperty("url", out var link) && link.GetString() is { } target)
                        next = new Uri(BaseUrl, target);
                }
                catch (JsonException)
                {
                }
            }
            if (next is not null)
            {
                if (next.AbsoluteUri.StartsWith(receiver.RedirectUri, StringComparison.Ordinal)) return next;
                if (next.AbsolutePath is "/invite-only" or "/sign-in-failed" && next.Host == BaseUrl.Host) return next;
                url = next;
                continue;
            }
            // The sign-in page: press the provider's button.
            var button = url.AbsolutePath == "/login" && response.StatusCode == HttpStatusCode.OK
                ? Regex.Match(text, $"href=\"(/login/{Regex.Escape(provider)}\\?[^\"]*)\"")
                : null;
            if (button is not { Success: true }) break;
            url = new Uri(BaseUrl, WebUtility.HtmlDecode(button.Groups[1].Value));
        }
        throw CueApiException.Server("The sign-in didn't end at the app.");
    }

    private static async Task<HttpResponseMessage> SendBrowser(HttpClient browser, HttpRequestMessage request, CancellationToken cancel)
    {
        try
        {
            return await browser.SendAsync(request, cancel);
        }
        catch (HttpRequestException e)
        {
            throw CueApiException.Network(e.Message);
        }
    }

    /// <summary>The code in the redirect back to the app; or the reason there is none.</summary>
    private static string CodeIn(Uri url, string state)
    {
        var items = HttpUtility.ParseQueryString(url.Query);
        if (url.AbsolutePath == "/invite-only" || items["error_description"] == "not_invited") throw CueApiException.NotInvited(items["email"]);
        var disabled = items["error_description"] == "account_disabled" || Regex.IsMatch(items["error"] ?? "", "ban|disabled", RegexOptions.IgnoreCase);
        if (disabled) throw CueApiException.Server("This account has been disabled. Ask whoever runs Cue about it.");
        if (url.AbsolutePath == "/sign-in-failed") throw CueApiException.Server("Something went wrong signing you in. Try again.");
        if (items["error"] is { } error) throw CueApiException.Server(items["error_description"] ?? error);
        if (items["state"] != state || items["code"] is not { } code) throw CueApiException.Server("The sign-in came back without a code.");
        return code;
    }
}
