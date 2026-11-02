using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Cue;

/// <summary>
/// Testing aid behind CUE_SNAPSHOT: PNGs of Cue's windows, every 2 s, for cases to read and agents to look at: the dashboard to `…-dashboard.png`
/// (Settings is a page of it). Each is the window as Windows composes it (title bar, Mica and all), in the system's appearance or CUE_APPEARANCE's,
/// and it is taken whether or not other windows cover it.
/// </summary>
public sealed class Snapshots
{
    private readonly SessionLog log;
    private readonly string path;
    private readonly List<(string Name, Func<IntPtr> Handle, string File)> targets = [];
    private readonly Dictionary<string, string> taken = [];
    private readonly Dictionary<string, int> busy = [];
    private readonly DispatcherQueueTimer timer;
    private int running;

    public Snapshots(AppState state, string path)
    {
        log = state.Log;
        this.path = path;
        var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
        log.Write($"📸 Snapshots: window capture (PrintWindow), in the {(dark ? "dark" : "light")} appearance");
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        timer = state.Queue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(2);
        timer.IsRepeating = true;
        timer.Tick += (_, _) => Take();
        timer.Start();
    }

    /// <summary>A window to snapshot, to `suffix` next to the CUE_SNAPSHOT file (`-dashboard.png`).</summary>
    public void Add(string name, Func<IntPtr> handle, string suffix) =>
        targets.Add((name, handle, path.Replace(".png", suffix, StringComparison.OrdinalIgnoreCase)));

    /// <summary>
    /// The windows' handles are read here, on the UI thread; the pictures are taken on another one, so that <c>PrintWindow</c>, which asks the window's own
    /// thread for its content, never holds the UI up.
    /// </summary>
    private void Take()
    {
        if (Interlocked.Exchange(ref running, 1) == 1) return;
        var windows = targets.Select(target => (target.Name, Handle: target.Handle(), target.File)).ToArray();
        _ = Task.Run(() =>
        {
            try
            {
                Capture(windows);
            }
            finally
            {
                Volatile.Write(ref running, 0);
            }
        });
    }

    private void Capture((string Name, IntPtr Handle, string File)[] windows)
    {
        foreach (var (name, hwnd, file) in windows)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) continue;
            var how = Capture(hwnd, file);
            // A reader of the previous picture holds the file for a moment: the next round writes it; if it goes on, say so.
            if (how is null)
            {
                busy[name] = busy.GetValueOrDefault(name) + 1;
                if (busy[name] < 4) continue;
                how = "couldn't write it: the file is in use";
            }
            else
            {
                busy[name] = 0;
            }
            if (how != taken.GetValueOrDefault(name, "ok")) log.Write($"📸 {name}: {how}");
            taken[name] = how;
        }
    }

    /// <summary>"ok", or why not; null when the file was busy.</summary>
    private static string? Capture(IntPtr hwnd, string file)
    {
        try
        {
            if (!Native.GetWindowRect(hwnd, out var rect)) return "no window rectangle";
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return "empty window";
            using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var hdc = graphics.GetHdc();
                try
                {
                    // PW_RENDERFULLCONTENT: the DirectComposition content of a WinUI window, not only its frame.
                    if (!Native.PrintWindow(hwnd, hdc, 2)) return "PrintWindow failed";
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
            }
            var temp = $"{file}.tmp";
            bitmap.Save(temp, ImageFormat.Png);
            File.Move(temp, file, overwrite: true);
            return "ok";
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        catch (ExternalException e)
        {
            return $"couldn't take it: {e.Message}";
        }
    }
}
