using Microsoft.UI.Dispatching;

namespace Cue;

/// <summary>The pages of the dashboard's navigation. Later slices add theirs (a project's pages, Notes) here and in <see cref="MainWindow"/>.</summary>
public enum DashboardPage
{
    Home,
    Upcoming,
    Settings,
}

public enum SettingsTab
{
    General,
    Account,
}

/// <summary>Where the dashboard is, so the app (and a case's `page` and `settings`) can open it on a page.</summary>
public sealed class DashboardModel : Observable
{
    private DashboardPage page = DashboardPage.Home;
    private SettingsTab tab = SettingsTab.General;

    public DashboardPage Page
    {
        get => page;
        set => Set(ref page, value);
    }

    public SettingsTab Tab
    {
        get => tab;
        set => Set(ref tab, value);
    }

    /// <summary>How `page NAME` finds a page: each slice adds one for its own (a project's pages, Notes). It says whether it knew the name.</summary>
    public List<Func<string, bool>> PageResolvers { get; } = [];

    public DashboardModel() => PageResolvers.Add(name =>
    {
        if (!Enum.TryParse<DashboardPage>(name, ignoreCase: true, out var found) || found == DashboardPage.Settings) return false;
        Page = found;
        return true;
    });

    public bool ShowPage(string name) => PageResolvers.Any(resolve => resolve(name));

    public void ShowSettings(SettingsTab? tab = null)
    {
        if (tab is { } picked) Tab = picked;
        Page = DashboardPage.Settings;
    }
}

/// <summary>
/// Everything the windows and the features share: the session log, the settings, the Cue API client and who is signed in, where the dashboard
/// is, and what the plan allows. One of it, made at launch (<see cref="App"/>); a slice's features hang their state off it.
/// </summary>
public sealed class AppState : Observable
{
    public SessionLog Log { get; } = new();
    public Preferences Preferences { get; } = new();
    public CueApi Api { get; }
    public DashboardModel Dashboard { get; } = new();
    public ControlCommands Control { get; }
    public DispatcherQueue Queue { get; }

    /// <summary>The live call: listening, the overlay's lists, the reading rules.</summary>
    public LiveModel Live { get; }

    private string? planLimit;

    public AppState(DispatcherQueue queue)
    {
        Queue = queue;
        Api = new CueApi(Log);
        Control = new ControlCommands(this);
        Live = new LiveModel(this);
    }

    /// <summary>Set while the month's allowance is spent: the sentence the backend worded (`limit_reached`). Nothing is answered meanwhile.</summary>
    public string? PlanLimit
    {
        get => planLimit;
        private set => Set(ref planLimit, value);
    }

    /// <summary>Show the dashboard (set by <see cref="MainWindow"/>).</summary>
    public Action OpenDashboard { get; set; } = () => { };

    /// <summary>Show an alert: it goes to the session log (`⚠︎ …`); outside a test run (CUE_BACKGROUND) the dashboard also puts it in a dialog.</summary>
    public Action<string, string> ShowAlert { get; set; } = (_, _) => { };

    public void Start()
    {
        Log.Write("🤖 Claude: Cue plan");
        Log.Write("🗣 Speech recognition: Cue plan");
        Api.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(CueApi.Me)) UsageChanged(Api.Me);
        };
        // Before the account is restored: the live call watches for it to be signed in.
        Live.Start();
        Api.Start(Queue);
        Control.StartFromEnvironment();
    }

    public void Quit()
    {
        Live.Shutdown();
        Microsoft.UI.Xaml.Application.Current.Exit();
    }

    /// <summary>An alert for the person, and a line in the session log.</summary>
    public void Alert(string title, string message)
    {
        Log.Write($"{SessionLog.Warning} {title}" + (message.Length == 0 ? "" : $": {message}"));
        if (!Env.Background) ShowAlert(title, message);
    }

    // MARK: The plan's limit

    /// <summary>The month's allowance is spent: an alert once per time it runs out (`⚠︎ Cue plan limit reached: …` in the session log), and the
    /// dashboard says so.</summary>
    internal void ReachedLimit(string message)
    {
        if (PlanLimit is not null) return;
        PlanLimit = message;
        Alert("Cue plan limit reached", message);
    }

    /// <summary>An answer arrived, so the allowance has room again (a raised limit, a new month).</summary>
    internal void ClearPlanLimit()
    {
        if (PlanLimit is null) return;
        PlanLimit = null;
        Log.Write("🔓 Cue plan has room again");
    }

    /// <summary>What `/v1/me` says about the allowance: it ran out between calls, or it has room again (a new month, a raised limit).</summary>
    private void UsageChanged(CueMe? me)
    {
        if (me is null)
        {
            PlanLimit = null;
        }
        else if (me.Usage.LimitReached)
        {
            ReachedLimit(me.LimitMessage);
        }
        else if (PlanLimit is not null)
        {
            PlanLimit = null;
            Log.Write("🔓 Cue plan has room again");
        }
    }
}
