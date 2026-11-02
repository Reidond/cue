using Microsoft.UI.Dispatching;

namespace Cue;

/// <summary>The pages of the dashboard's navigation. Later slices add theirs (Notes) here and in <see cref="MainWindow"/>.</summary>
public enum DashboardPage
{
    Home,
    Upcoming,

    /// <summary>A project's page (<see cref="DashboardModel.ProjectId"/>, <see cref="DashboardModel.Section"/>).</summary>
    Project,
    Settings,
}

public enum SettingsTab
{
    General,
    Account,
}

/// <summary>The pages of a project, picked in the bar under its name.</summary>
public enum ProjectTab
{
    Overview,
    Answers,
    Notes,
}

/// <summary>Where the dashboard is, so the app (and a case's `page` and `settings`) can open it on a page.</summary>
public sealed class DashboardModel : Observable
{
    private DashboardPage page = DashboardPage.Home;
    private SettingsTab tab = SettingsTab.General;
    private string? projectId;
    private ProjectTab section = ProjectTab.Overview;

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

    /// <summary>The project the project page shows (its folder name, <see cref="Project.Id"/>).</summary>
    public string? ProjectId
    {
        get => projectId;
        set => Set(ref projectId, value);
    }

    /// <summary>Which page of the project: its overview, its prepared answers, its notes.</summary>
    public ProjectTab Section
    {
        get => section;
        set => Set(ref section, value);
    }

    /// <summary>The project on screen: null unless the dashboard is on a project's page.</summary>
    public string? CurrentProjectId => Page == DashboardPage.Project ? ProjectId : null;

    /// <summary>How `page NAME` finds a page: each slice adds one for its own (a project's pages, Notes). It says whether it knew the name.</summary>
    public List<Func<string, bool>> PageResolvers { get; } = [];

    public DashboardModel() => PageResolvers.Add(name =>
    {
        if (!Enum.TryParse<DashboardPage>(name, ignoreCase: true, out var found) || found is not (DashboardPage.Home or DashboardPage.Upcoming)) return false;
        Page = found;
        return true;
    });

    public bool ShowPage(string name) => PageResolvers.Any(resolve => resolve(name));

    public void OpenProject(string id, ProjectTab to = ProjectTab.Overview)
    {
        ProjectId = id;
        Section = to;
        Page = DashboardPage.Project;
    }

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

    /// <summary>The person's projects, and the one Cue answers from (<see cref="ProjectStore.Active"/>): loaded after signing in, see <see cref="CueApi.OnSignedIn"/>.</summary>
    public ProjectStore Projects { get; }

    private string? planLimit;

    public AppState(DispatcherQueue queue)
    {
        Queue = queue;
        Api = new CueApi(Log);
        Control = new ControlCommands(this);
        Projects = new ProjectStore(Api, Log, Preferences);
        // The projects are the account's: once someone is signed in they are loaded (and the ones found in the library imported), and one is chosen.
        Api.OnSignedIn = async () =>
        {
            try
            {
                await Projects.SyncWithAccount();
                await Projects.ChooseActive();
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // The library can't be read or written (say, Documents is on a drive that is gone): signing in still works.
                Log.Write($"{SessionLog.Warning} Couldn't load your projects: {e.Message}");
            }
        };
        Api.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName != nameof(CueApi.Phase) || Api.Phase != Phase.SignedOut) return;
            Projects.Clear();
            if (Dashboard.Page == DashboardPage.Project) Dashboard.Page = DashboardPage.Home;
        };
        ProjectCommands.Register(this);
        // After the projects: it follows the one Cue answers from.
        Live = new LiveModel(this);
    }

    /// <summary>The dashboard's window, for the pickers Windows shows over it (set by <see cref="MainWindow"/>).</summary>
    public IntPtr WindowHandle { get; set; }

    /// <summary>Renames a project (in the account, and its folder here); the dashboard follows if it shows the project.</summary>
    public async Task<Project> RenameProject(Project project, string name)
    {
        var renamed = await Projects.Rename(project, name);
        if (Dashboard.ProjectId == project.Id) Dashboard.ProjectId = renamed.Id;
        return renamed;
    }

    /// <summary>Deletes a project from the account and moves its folder to the Recycle Bin; the dashboard leaves its page.</summary>
    public async Task DeleteProject(Project project)
    {
        await Projects.Delete(project);
        if (Dashboard.CurrentProjectId == project.Id) Dashboard.Page = DashboardPage.Home;
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
