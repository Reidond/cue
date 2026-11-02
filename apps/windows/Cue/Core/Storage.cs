using System.Globalization;
using System.Reflection;

namespace Cue;

/// <summary>The environment Cue was launched in: the test hooks (AGENTS.md › Test hooks in the app) and what the build stamped.</summary>
public static class Env
{
    /// <summary>The variable's value; null when it is unset or empty.</summary>
    public static string? Get(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : null;

    /// <summary>CUE_BACKGROUND=1: stay out of the way of whoever is using the PC (a test run).</summary>
    public static bool Background => Get("CUE_BACKGROUND") == "1";

    /// <summary>The version the build stamped (scripts/build.ps1 -Version), as "2.0.1".</summary>
    public static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version is { } version ? $"{version.Major}.{version.Minor}.{version.Build}" : "dev";

    /// <summary>The address the build stamped (apps/api/production-url.txt), or `cf dev`'s when it was not built by scripts/build.ps1.</summary>
    public static string StampedApiUrl =>
        Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "CueApiUrl")?.Value
        ?? "http://127.0.0.1:5173";

    /// <summary>
    /// CUE_LOCALE=en-US: numbers and dates in this culture instead of Windows' (a test run reads $2.50 and Nov 1 on any PC).
    /// Call it first, before any thread formats anything.
    /// </summary>
    public static void ApplyLocale()
    {
        if (Get("CUE_LOCALE") is not { } tag) return;
        try
        {
            // Windows' own strings (Settings in the navigation pane) in that language too.
            Microsoft.Windows.Globalization.ApplicationLanguages.PrimaryLanguageOverride = tag;
            var culture = CultureInfo.GetCultureInfo(tag);
            CultureInfo.DefaultThreadCurrentCulture = culture;
            CultureInfo.DefaultThreadCurrentUICulture = culture;
            CultureInfo.CurrentCulture = culture;
            CultureInfo.CurrentUICulture = culture;
        }
        catch (Exception e) when (e is CultureNotFoundException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
        }
    }
}

/// <summary>
/// Where Cue keeps its files and settings. CUE_HOME moves all of them into one folder, with the Mac's layout (`Application Support/Cue`,
/// `Documents`), so end-to-end tests never touch the user's real library, settings or notes.
/// </summary>
public static class Storage
{
    /// <summary>CUE_HOME: the sandbox every file goes under; null in normal use.</summary>
    public static string? Home { get; } = Env.Get("CUE_HOME");

    public static bool IsSandboxed => Home is not null;

    /// <summary>Sessions, settings and everything else Cue keeps: `CUE_HOME/Application Support/Cue`, else %APPDATA%\Cue.</summary>
    public static string AppSupport { get; } = Directory
        .CreateDirectory(
            Home is null
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Cue")
                : Path.Combine(Home, "Application Support", "Cue"))
        .FullName;

    /// <summary>The user's Documents folder (the library is its `Cue` folder); `CUE_HOME/Documents` under test.</summary>
    public static string Documents { get; } = Home is null
        ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
        : Path.Combine(Home, "Documents");

    /// <summary>The library: a folder for each project (its `project.json` and its notes), `Documents\Cue`.</summary>
    public static string Library { get; } = Path.Combine(Documents, "Cue");

    /// <summary>Writes a file in one step, so a reader never sees it half written.</summary>
    public static void WriteAtomically(string path, string text)
    {
        var temp = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temp, text);
        File.Move(temp, path, overwrite: true);
    }
}
