using Microsoft.UI.Dispatching;

namespace Cue;

/// <summary>
/// Testing aid: CUE_CONTROL=FILE. Each line appended to the file does what a click would (AGENTS.md › Test hooks in the app): the commands are
/// registered by name, here for the foundation and by each slice for its own, as `Register("new", …)`. Commands run one after another, so one
/// that waits for the account finishes before the next line. Until someone is signed in only the commands registered with
/// `needsSignIn: false` do anything; any other logs `⚠︎ Sign in to Cue first (NAME ignored)`.
/// </summary>
public sealed class ControlCommands
{
    private sealed record Command(Func<string, Task> Run, bool NeedsSignIn);

    private readonly AppState state;
    private readonly Dictionary<string, Command> commands = [];
    private DispatcherQueueTimer? timer;
    private int linesDone;
    private Task queue = Task.CompletedTask;

    public ControlCommands(AppState state)
    {
        this.state = state;
        Register("signin", argument => state.Api.SignIn(argument.Length > 0 ? argument : null), needsSignIn: false);
        Register("signout", _ => state.Api.SignOut(), needsSignIn: false);
        Register("settings", argument =>
        {
            state.Dashboard.ShowSettings(Enum.TryParse<SettingsTab>(argument, ignoreCase: true, out var tab) ? tab : null);
            state.OpenDashboard();
            return Task.CompletedTask;
        }, needsSignIn: false);
        Register("page", argument =>
        {
            state.OpenDashboard();
            state.Dashboard.ShowPage(argument);
            return Task.CompletedTask;
        }, needsSignIn: false);
        // Check Now and Restart to Update in Settings › General.
        Register("update", argument =>
        {
            if (argument == "restart")
            {
                state.Updates.Restart();
                return Task.CompletedTask;
            }
            return state.Updates.Check();
        }, needsSignIn: false);
        Register("quit", _ =>
        {
            state.Quit();
            return Task.CompletedTask;
        }, needsSignIn: false);
    }

    /// <summary>Adds a command; the argument is the rest of the line after its name.</summary>
    public void Register(string name, Func<string, Task> run, bool needsSignIn = true) => commands[name] = new Command(run, needsSignIn);

    /// <summary>Starts reading CUE_CONTROL, if it is set.</summary>
    public void StartFromEnvironment()
    {
        if (Env.Get("CUE_CONTROL") is not { } path) return;
        // Kept in a field: a timer only a local variable holds is collected, and stops (the commands then go unread).
        timer = state.Queue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(500);
        timer.IsRepeating = true;
        timer.Tick += (_, _) => Read(path);
        timer.Start();
    }

    private void Read(string path)
    {
        string text;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            text = reader.ReadToEnd();
        }
        catch (IOException)
        {
            return;
        }
        // Only whole lines: the case may be in the middle of writing the last one.
        var complete = text[..(text.LastIndexOf('\n') + 1)];
        var lines = complete.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).ToArray();
        foreach (var line in lines.Skip(linesDone)) Enqueue(line);
        linesDone = Math.Max(linesDone, lines.Length);
    }

    private void Enqueue(string line)
    {
        var previous = queue;
        queue = Run(previous, line);
    }

    private async Task Run(Task previous, string line)
    {
        await previous;
        var parts = line.Split(' ', 2);
        var name = parts[0];
        var argument = parts.Length > 1 ? parts[1] : "";
        var known = commands.GetValueOrDefault(name);
        if (!state.Api.IsSignedIn && !(known is { NeedsSignIn: false }))
        {
            state.Log.Write($"{SessionLog.Warning} Sign in to Cue first ({name} ignored)");
            return;
        }
        if (known is null) return;
        try
        {
            await known.Run(argument);
        }
        catch (Exception e)
        {
            state.Log.Write($"{SessionLog.Warning} {name} failed: {e.Message}");
        }
    }
}
