using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Cue;

/// <summary>Cue for Windows: a WinUI 3 app that signs in to the Cue backend. The foundation of the port; the later slices' features plug into <see cref="AppState"/> and <see cref="MainWindow"/>.</summary>
public partial class App : Application
{
    private MainWindow? window;

    // Held here: what only a local variable holds is collected, and its timer stops.
    private Snapshots? snapshots;
    private OverlayWindow? overlay;
    private LiveSurfaces? surfaces;

    public static AppState State { get; private set; } = null!;

    public App()
    {
        Env.ApplyLocale();
        // Testing aid: CUE_APPEARANCE=light|dark instead of the system's. It can only be set before anything is built.
        if (Env.Get("CUE_APPEARANCE") is { } look) RequestedTheme = look == "dark" ? ApplicationTheme.Dark : ApplicationTheme.Light;
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            e.Handled = true;
            Crash(e.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Crash(e.ExceptionObject as Exception);
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        State = new AppState(DispatcherQueue.GetForCurrentThread());
        if (!SingleInstance.TryBecomeFirst(() => State.Queue.TryEnqueue(() => State.OpenDashboard())))
        {
            Exit();
            return;
        }
        if (Env.Background) Native.OptOutOfThrottling();
        window = new MainWindow(State);
        overlay = new OverlayWindow(State);
        State.Start();
        window.Present();
        // The icon in the notification area and the system-wide shortcuts: not in a test run (CUE_BACKGROUND), which must not take keys from whoever uses the PC.
        if (!Env.Background || Env.Surfaces) surfaces = new LiveSurfaces(State);
        if (Env.Get("CUE_SHOW_SETTINGS") == "1") State.Dashboard.ShowSettings();
        if (Env.Get("CUE_SNAPSHOT") is { } path)
        {
            snapshots = new Snapshots(State, path);
            var main = window;
            snapshots.Add("Dashboard", () => main.Handle, "-dashboard.png");
            var floating = overlay;
            snapshots.Add("Overlay", () => floating.Handle, ".png");
        }
    }

    /// <summary>What Windows would have shown as "Cue stopped working": into the session log and stderr, and Cue goes on.</summary>
    private static void Crash(Exception? error)
    {
        var text = error?.ToString() ?? "unknown error";
        Console.Error.WriteLine(text);
        try
        {
            File.AppendAllText(Path.Combine(Storage.AppSupport, "crash.log"), $"{DateTime.Now:O} {text}\n");
            State?.Log.Write($"{SessionLog.Warning} Unexpected error: {error?.Message ?? text}");
        }
        catch (IOException)
        {
        }
    }
}
