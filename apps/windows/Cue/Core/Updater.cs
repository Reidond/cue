using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.UI.Dispatching;

namespace Cue;

public enum UpdatePhase
{
    Idle,
    Checking,
    Downloading,

    /// <summary>The new installer is downloaded and checked: it installs when Cue restarts (Restart to Update), quits, or next opens.</summary>
    Ready,
    Failed,
}

/// <summary>
/// Keeps Cue up to date from its GitHub releases (`.github/workflows/release.yml` publishes one for every push to main), as the Mac's `Updater`
/// does, but the way Windows installs: when Cue opens and every 6 hours it reads the latest release, and when that one is newer it downloads
/// `Cue-VERSION-ARCH.msi` and checks it against the size and SHA-256 the release gives. The MSI can't replace the files of a Cue that is
/// running, so it installs when Cue goes: Restart to Update (Settings › General, the notification area), quitting Cue, or the next time Cue
/// opens. A small PowerShell script, out of Cue's way, waits for Cue to be gone, runs Windows Installer (which asks for permission: Cue is
/// installed per machine) and opens Cue again; the next Cue says how it went.
///
/// Only a release build looks (build.ps1 stamps the repository, `CueUpdates`, when CUE_UPDATES is set). Under CUE_HOME nothing is read from
/// GitHub: CUE_UPDATE_URL is the latest release's address instead (a case's stand-in), and CUE_UPDATE_TICK the seconds between checks.
/// </summary>
public sealed class Updater : Observable
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    /// <summary>What GitHub says about a release (`GET /repos/OWNER/NAME/releases/latest`): its tag and its files.</summary>
    private sealed record Release(string TagName, List<Asset> Assets)
    {
        /// <summary>"2.0.18", from the tag "v2.0.18".</summary>
        public string Version => TagName.StartsWith('v') ? TagName[1..] : TagName;
    }

    /// <summary>A file of a release; its digest is "sha256:HEX".</summary>
    private sealed record Asset(string Name, long Size, string? Digest, Uri BrowserDownloadUrl);

    /// <summary>An installer downloaded and checked (`ready.json`), and an installation started (`update.json`, with what it replaces).</summary>
    private sealed record Download(string Version, string Msi, string Sha256);

    private sealed record Installing(string From, string To);

    private readonly AppState state;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private readonly TimeSpan tick = TimeSpan.FromSeconds(double.TryParse(Env.Get("CUE_UPDATE_TICK"), out var seconds) && seconds > 0 ? seconds : 6 * 3600);

    /// <summary>Where the installer is downloaded, the script that installs it and Windows Installer's log: %LOCALAPPDATA%\Cue\Updates, in CUE_HOME's `updates`.</summary>
    private readonly string folder = Storage.IsSandboxed
        ? Path.Combine(Storage.AppSupport, "updates")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cue", "Updates");

    // Kept in a field: a timer only a local variable holds is collected, and stops.
    private DispatcherQueueTimer? timer;
    private UpdatePhase phase;
    private string? next;
    private string? problem;
    private DateTime? checkedAt;
    private Download? ready;

    public Updater(AppState state)
    {
        this.state = state;
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"Cue/{Env.Version}");
        http.DefaultRequestHeaders.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
    }

    /// <summary>This Cue's version.</summary>
    public string Version => Env.Version;

    /// <summary>The latest release's address (GitHub's API); null when this Cue doesn't update itself.</summary>
    public Uri? Feed { get; } = FeedUri();

    public UpdatePhase Phase
    {
        get => phase;
        private set
        {
            if (Set(ref phase, value)) Raise(nameof(Status));
        }
    }

    /// <summary>The version being downloaded, or ready to install.</summary>
    public string? Next => next;

    /// <summary>A line for Settings: where updating is.</summary>
    public string Status => Phase switch
    {
        UpdatePhase.Checking => "Checking for updates…",
        UpdatePhase.Downloading => $"Downloading Cue {next}…",
        UpdatePhase.Ready => $"Cue {next} is ready. It installs when Cue restarts.",
        UpdatePhase.Failed => $"Couldn't update Cue: {problem}",
        _ => checkedAt is { } at ? $"Cue is up to date. Checked at {at:t}." : "Cue looks for updates when it opens.",
    };

    private string ReadyFile => Path.Combine(folder, "ready.json");

    private string InstallingFile => Path.Combine(folder, "update.json");

    private string ResultFile => Path.Combine(folder, "result.txt");

    private string LogFile => Path.Combine(folder, "install.log");

    private static Uri? FeedUri()
    {
        if (Env.Get("CUE_UPDATE_URL") is { } url) return Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri : null;
        if (Storage.IsSandboxed) return null;
        var repository = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "CueUpdates")?.Value;
        return string.IsNullOrEmpty(repository) ? null : new Uri($"https://api.github.com/repos/{repository}/releases/latest");
    }

    /// <summary>
    /// At launch, before any window: says how the last installation went, and installs an update downloaded before that hasn't been yet (Cue
    /// wasn't quit since). True when Cue should exit now for it; it opens again once the update is in.
    /// </summary>
    public bool InstallDownloaded()
    {
        if (Read<Installing>(InstallingFile) is { } installing)
        {
            File.Delete(InstallingFile);
            if (installing.To == Version)
            {
                state.Log.Write($"✅ Cue was updated from {installing.From} to {Version}");
                Forget();
            }
            else if (File.Exists(ResultFile))
            {
                var code = File.ReadAllText(ResultFile).Trim();
                state.Log.Write(code is "1602" or "1223" or "-1"
                    ? $"{SessionLog.Warning} Cue {installing.To} wasn't installed: the installation was cancelled"
                    : $"{SessionLog.Warning} Couldn't install Cue {installing.To}: Windows Installer stopped with code {code} (its log: {LogFile})");
                File.Delete(ResultFile);
                // Not again at once: the next check downloads it afresh, and Restart to Update tries again.
                Forget(keepLog: true);
            }
        }
        if (Feed is null || !state.Preferences.AutomaticUpdates || Read<Download>(ReadyFile) is not { } download) return false;
        if (!IsNewer(download.Version, Version) || !File.Exists(download.Msi) || Sha256Of(download.Msi) != download.Sha256)
        {
            Forget();
            return false;
        }
        ready = download;
        next = download.Version;
        state.Log.Write($"🔄 Installing Cue {download.Version}, downloaded earlier");
        return Install(relaunch: true);
    }

    /// <summary>Looks for a newer Cue now (when automatic updates are on) and every `tick`.</summary>
    public void Start()
    {
        if (Feed is null) return;
        timer = state.Queue.CreateTimer();
        timer.Interval = tick;
        timer.IsRepeating = true;
        timer.Tick += (_, _) =>
        {
            if (state.Preferences.AutomaticUpdates) _ = Check();
        };
        timer.Start();
        if (state.Preferences.AutomaticUpdates) _ = Check();
    }

    /// <summary>Reads the latest release, and downloads it when it is newer than this Cue (Check for Updates, and each automatic look).</summary>
    public async Task Check()
    {
        if (Feed is not { } feed || Phase is UpdatePhase.Checking or UpdatePhase.Downloading or UpdatePhase.Ready) return;
        Phase = UpdatePhase.Checking;
        try
        {
            var release = await Latest(feed);
            checkedAt = DateTime.Now;
            if (!IsNewer(release.Version, Version))
            {
                state.Log.Write($"✅ Cue is up to date ({Version})");
                Phase = UpdatePhase.Idle;
                return;
            }
            next = release.Version;
            Raise(nameof(Next));
            state.Log.Write($"🔄 Downloading Cue {release.Version} (this is {Version})…");
            Phase = UpdatePhase.Downloading;
            ready = await DownloadInstaller(release);
            Storage.WriteAtomically(ReadyFile, JsonSerializer.Serialize(ready, Json));
            Phase = UpdatePhase.Ready;
            state.Log.Write($"✅ Cue {release.Version} is downloaded: it installs when Cue restarts");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or JsonException or InvalidDataException
                                      or UnauthorizedAccessException)
        {
            problem = e is TaskCanceledException ? "GitHub took too long to answer" : e.Message;
            Phase = UpdatePhase.Failed;
            state.Log.Write($"{SessionLog.Warning} Couldn't update Cue: {problem}");
        }
    }

    /// <summary>Restart to Update: Cue quits, the update installs, and Cue opens again.</summary>
    public void Restart()
    {
        if (Phase != UpdatePhase.Ready) return;
        state.Log.Write($"🔄 Restarting Cue to finish the update to {next}");
        if (Install(relaunch: true)) state.Quit();
    }

    /// <summary>Quitting Cue with an update ready (and automatic updates on) installs it; Cue doesn't open again.</summary>
    public void InstallOnQuit()
    {
        if (ready is null || !state.Preferences.AutomaticUpdates) return;
        state.Log.Write($"🔄 Installing Cue {next} as Cue quits");
        Install(relaunch: false);
    }

    /// <summary>
    /// Starts the script that installs the ready MSI once this Cue is gone (and then opens Cue, with `relaunch`). It inherits Cue's environment but
    /// CUE_CONTROL, whose lines were for this Cue, so a case's sandbox stays its sandbox. True when it started.
    /// </summary>
    private bool Install(bool relaunch)
    {
        if (ready is not { } download) return false;
        try
        {
            var script = Path.Combine(folder, "install.ps1");
            File.WriteAllText(script, InstallScript);
            File.Delete(ResultFile);
            Storage.WriteAtomically(InstallingFile, JsonSerializer.Serialize(new Installing(Version, download.Version), Json));
            var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new ProcessStartInfo(powershell) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script })
                start.ArgumentList.Add(argument);
            start.ArgumentList.Add("-CuePid");
            start.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            start.ArgumentList.Add("-Msi");
            start.ArgumentList.Add(download.Msi);
            start.ArgumentList.Add("-Log");
            start.ArgumentList.Add(LogFile);
            start.ArgumentList.Add("-Result");
            start.ArgumentList.Add(ResultFile);
            // A test run's Windows Installer shows nothing; a person sees its progress bar.
            start.ArgumentList.Add("-Quiet");
            start.ArgumentList.Add(Env.Background ? "/qn" : "/passive");
            if (relaunch)
            {
                start.ArgumentList.Add("-Relaunch");
                start.ArgumentList.Add(Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Cue.exe"));
            }
            start.Environment.Remove("CUE_CONTROL");
            Process.Start(start)?.Dispose();
            // Once: quitting next doesn't start it again.
            ready = null;
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            File.Delete(InstallingFile);
            state.Log.Write($"{SessionLog.Warning} Couldn't install Cue {download.Version}: {e.Message}");
            return false;
        }
    }

    /// <summary>The script that installs: waits for Cue to quit, runs Windows Installer on the MSI, notes how it went, and opens Cue again.</summary>
    private const string InstallScript = """
        # Written by Cue (apps/windows/Cue/Core/Updater.cs) for an update: it waits for Cue to quit, installs the new MSI (Windows asks for
        # permission: Cue is installed for everyone on the PC), notes Windows Installer's exit code for the next Cue, and opens Cue again.
        param([int]$CuePid, [string]$Msi, [string]$Log, [string]$Result, [string]$Quiet, [string]$Relaunch)
        try { Wait-Process -Id $CuePid -Timeout 60 -ErrorAction Stop } catch { }
        $arguments = @('/i', "`"$Msi`"", $Quiet, '/norestart', '/l*v', "`"$Log`"")
        try { $code = (Start-Process "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $arguments -Wait -PassThru).ExitCode } catch { $code = -1 }
        Set-Content -Path $Result -Value $code
        if ($Relaunch) { Start-Process -FilePath $Relaunch }
        """;

    private async Task<Release> Latest(Uri feed)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, feed);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidDataException($"GitHub answered {(int)response.StatusCode} for the latest release");
        var release = JsonSerializer.Deserialize<Release>(await response.Content.ReadAsStringAsync(), Json);
        // A record's missing property is null, not an error.
        if (release?.TagName is null || release.Assets is null) throw new InvalidDataException("GitHub's answer about the latest release couldn't be read");
        return release;
    }

    /// <summary>The release's installer for this PC's processor, downloaded and checked against the size and SHA-256 the release gives.</summary>
    private async Task<Download> DownloadInstaller(Release release)
    {
        var arch = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        var name = $"Cue-{release.Version}-{arch}.msi";
        var asset = release.Assets.FirstOrDefault(a => a.Name == name) ?? throw new InvalidDataException($"the release has no {name}");
        if (asset.Digest is not { } digest || !digest.StartsWith("sha256:", StringComparison.Ordinal))
            throw new InvalidDataException($"the release doesn't give {name}'s checksum");
        Forget(keepLog: true);
        Directory.CreateDirectory(folder);
        var msi = Path.Combine(folder, name);
        using (var response = await http.GetAsync(asset.BrowserDownloadUrl, HttpCompletionOption.ResponseHeadersRead))
        {
            if (!response.IsSuccessStatusCode) throw new InvalidDataException($"GitHub answered {(int)response.StatusCode} for {name}");
            await using var file = File.Create(msi);
            await response.Content.CopyToAsync(file);
        }
        var sha256 = await Task.Run(() => Sha256Of(msi));
        if (new FileInfo(msi).Length != asset.Size || $"sha256:{sha256}" != digest.ToLowerInvariant())
        {
            File.Delete(msi);
            throw new InvalidDataException($"the download of {name} doesn't match the release");
        }
        return new Download(release.Version, msi, sha256);
    }

    /// <summary>Removes what an earlier update left (Windows Installer's log of a failed installation stays, for whoever looks into it, until one succeeds).</summary>
    private void Forget(bool keepLog = false)
    {
        ready = null;
        if (!Directory.Exists(folder)) return;
        foreach (var file in Directory.GetFiles(folder))
        {
            if (keepLog && file == LogFile) continue;
            try
            {
                File.Delete(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private static string Sha256Of(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }

    private static T? Read<T>(string path)
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), Json) : default;
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            return default;
        }
    }

    /// <summary>Whether `candidate` is a later version than `current` ("2.0.10" is later than "2.0.9", and "2.0.1" than "2.0").</summary>
    public static bool IsNewer(string candidate, string current) =>
        System.Version.TryParse(candidate, out var a) && (!System.Version.TryParse(current, out var b) || Normalize(a) > Normalize(b));

    private static System.Version Normalize(System.Version v) => new(v.Major, v.Minor, Math.Max(v.Build, 0), Math.Max(v.Revision, 0));
}
