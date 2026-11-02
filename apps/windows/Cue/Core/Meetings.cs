using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Cue;

/// <summary>What Cue does when a call starts (the Mac's `MeetingAction`).</summary>
public enum MeetingAction
{
    Ask,
    Record,
    Nothing,
}

public static class MeetingActions
{
    public static string Title(this MeetingAction action) =>
        action switch
        {
            MeetingAction.Ask => "Ask",
            MeetingAction.Record => "Record automatically",
            _ => "Do nothing",
        };

    /// <summary>The word `settings.json` keeps it under: the Mac's.</summary>
    public static string Key(this MeetingAction action) =>
        action switch
        {
            MeetingAction.Ask => "ask",
            MeetingAction.Record => "record",
            _ => "nothing",
        };

    public static MeetingAction Parse(string? key) =>
        key switch
        {
            "record" => MeetingAction.Record,
            "nothing" => MeetingAction.Nothing,
            _ => MeetingAction.Ask,
        };
}

/// <summary>The video call services Cue recognises by their links.</summary>
public enum CallService
{
    Meet,
    Zoom,
    Teams,
    Webex,
}

public static partial class CallServices
{
    public static string Name(this CallService service) =>
        service switch
        {
            CallService.Meet => "Google Meet",
            CallService.Zoom => "Zoom",
            CallService.Teams => "Microsoft Teams",
            _ => "Webex",
        };

    /// <summary>The call service a link is for, if it is one (a call, not a company's home page).</summary>
    public static CallService? Of(Uri url)
    {
        if (url.Scheme is not ("http" or "https")) return null;
        var host = url.Host.ToLowerInvariant();
        var path = url.AbsolutePath.ToLowerInvariant();
        if (host == "meet.google.com" && path.Length > 1) return CallService.Meet;
        if ((host == "zoom.us" || host.EndsWith(".zoom.us", StringComparison.Ordinal) || host.EndsWith("zoomgov.com", StringComparison.Ordinal))
            && new[] { "/j/", "/my/", "/w/", "/s/", "/wc/" }.Any(prefix => path.StartsWith(prefix, StringComparison.Ordinal)))
            return CallService.Zoom;
        if ((host == "teams.microsoft.com" && path.Contains("meet", StringComparison.Ordinal))
            || (host == "teams.live.com" && path.StartsWith("/meet", StringComparison.Ordinal)))
            return CallService.Teams;
        if (host.EndsWith(".webex.com", StringComparison.Ordinal) && path.Length > 1) return CallService.Webex;
        return null;
    }

    /// <summary>A link: with its scheme, or a call service's own address written without one.</summary>
    [GeneratedRegex(@"https?://[^\s<>""'\)\]]+|(?<![\w/.@-])(?:meet\.google\.com|(?:[\w-]+\.)*zoom\.us|(?:[\w-]+\.)*zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|(?:[\w-]+\.)+webex\.com)/[^\s<>""'\)\]]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Links();

    /// <summary>The first call link in an event's URL, location or notes, in that order.</summary>
    public static (Uri Url, CallService Service)? LinkIn(params string?[] texts)
    {
        foreach (var text in texts)
        {
            if (string.IsNullOrEmpty(text)) continue;
            foreach (Match match in Links().Matches(text))
            {
                var link = match.Value.TrimEnd('.', ',', ';', ':', '!', '?');
                if (!link.StartsWith("http", StringComparison.OrdinalIgnoreCase)) link = "https://" + link;
                if (Uri.TryCreate(link, UriKind.Absolute, out var url) && Of(url) is { } service) return (url, service);
            }
        }
        return null;
    }
}

/// <summary>A calendar event with a call link, today or tomorrow.</summary>
/// <param name="Id">One occurrence.</param>
/// <param name="Series">The same for every occurrence of a recurring event, so its project is remembered for the series.</param>
/// <param name="Calendar">The calendar's id (its name, for the test file).</param>
/// <param name="Attendees">Everyone invited, by name (or address when the calendar has no name).</param>
public sealed record CalendarEvent(
    string Id,
    string Series,
    string Title,
    DateTimeOffset Start,
    DateTimeOffset End,
    string Calendar,
    IReadOnlyList<string> Attendees,
    Uri Link,
    CallService Service,
    bool Recurring)
{
    /// <summary>From five minutes before the start until the end.</summary>
    public bool InProgress(DateTimeOffset at) => Start.AddMinutes(-5) <= at && at <= End;
}

/// <summary>An app people take calls in. Browsers count only during a calendar call; the others on their own too.</summary>
/// <param name="Programs">File names of its programs, which Windows' microphone consent store lists apps by.</param>
/// <param name="Packages">Prefixes of the package family names of its Store version.</param>
public sealed record CallApp(string Name, string[] Programs, string[] Packages, bool IsBrowser, CallService? Service = null)
{
    public string CallName => $"{Name} call";

    public static readonly IReadOnlyList<CallApp> All =
    [
        new("Google Chrome", ["chrome.exe"], [], true),
        new("Microsoft Edge", ["msedge.exe"], [], true),
        new("Firefox", ["firefox.exe"], [], true),
        new("Brave", ["brave.exe"], [], true),
        new("Arc", ["arc.exe"], ["TheBrowserCompany.Arc"], true),
        new("Opera", ["opera.exe"], [], true),
        new("Zoom", ["zoom.exe"], ["Zoom."], false, CallService.Zoom),
        new("Microsoft Teams", ["ms-teams.exe", "teams.exe"], ["MSTeams_", "MicrosoftTeams_"], false, CallService.Teams),
        new("Webex", ["webex.exe", "atmgr.exe", "ciscocollabhost.exe", "webexhost.exe"], ["CiscoSystemsInc.Webex", "Cisco.Webex"], false, CallService.Webex),
        new("Slack", ["slack.exe"], ["91750D7E.Slack"], false),
    ];

    /// <summary>Whether an entry of the consent store (a program's path with `#` for `\`, or a package family name) or of CUE_MIC_APPS is this app.</summary>
    public bool Is(string entry)
    {
        var program = Path.GetFileName(entry.Replace('#', '\\').Trim()).ToLowerInvariant();
        return Programs.Contains(program) || Packages.Any(prefix => entry.Trim().StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Call apps using the microphone right now, in the order of <see cref="All"/>.</summary>
    public static IReadOnlyList<CallApp> UsingMicrophone()
    {
        var users = MicrophoneUsers();
        return [.. All.Where(app => users.Any(app.Is))];
    }

    private const string ConsentStore = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    /// <summary>
    /// What is using a microphone right now, from Windows' consent store: every app that opened one has a key, with the time it started (`LastUsedTimeStart`)
    /// and, once it has stopped, the time it did (`LastUsedTimeStop`): zero while it is still using it. Apps of the Store (packages) are keys of their own,
    /// the others (the programs one installs) are under `NonPackaged`, their path with `#` for `\`. CUE_MIC_APPS=file stands in for it in tests: one entry
    /// per line, a program's file name or path or a package family name, read again on every call.
    /// </summary>
    private static IReadOnlyList<string> MicrophoneUsers()
    {
        if (Env.Get("CUE_MIC_APPS") is { } path)
        {
            try
            {
                return [.. File.ReadAllLines(path).Select(line => line.Trim()).Where(line => line.Length > 0)];
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return [];
            }
        }
        var users = new List<string>();
        try
        {
            using var store = Registry.CurrentUser.OpenSubKey(ConsentStore);
            if (store is null) return users;
            foreach (var name in store.GetSubKeyNames())
            {
                using var app = store.OpenSubKey(name);
                if (app is null) continue;
                if (name == "NonPackaged")
                {
                    foreach (var program in app.GetSubKeyNames())
                    {
                        using var key = app.OpenSubKey(program);
                        if (InUse(key)) users.Add(program);
                    }
                }
                else if (InUse(app))
                {
                    users.Add(name);
                }
            }
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
        }
        return users;
    }

    private static bool InUse(RegistryKey? key) => key is not null && key.GetValue("LastUsedTimeStart") is long start && start > 0 && key.GetValue("LastUsedTimeStop") is long stop && stop == 0;
}

/// <summary>The few lines of a time that the pages show.</summary>
internal static class Times
{
    public static string Clock(DateTimeOffset time) => time.ToLocalTime().ToString("t", CultureInfo.CurrentCulture);
}
