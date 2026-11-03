using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Cue;

/// <summary>
/// Testing aid behind CUE_SNAPSHOT: PNGs of Cue's windows, every 2 s, for cases to read and agents to look at: the dashboard to `…-dashboard.png`
/// (Settings is a page of it). Each is the window as Windows composes it (title bar, Mica and all), in the system's appearance or CUE_APPEARANCE's,
/// and it is taken whether or not other windows cover it.
///
/// CUE_SNAPSHOT_METHOD=xaml draws each window's content with XAML itself (<see cref="RenderTargetBitmap"/>) instead, over the solid colour its material
/// falls back to (no Mica or acrylic, no caption buttons): a window kept behind others can come out of PrintWindow with text from a stale glyph cache,
/// and XAML's own drawing never does.
/// </summary>
public sealed class Snapshots
{
    private readonly SessionLog log;
    private readonly string path;
    private readonly List<(string Name, Func<IntPtr> Handle, string File, Func<UIElement?> Content, string Backdrop)> targets = [];
    private readonly bool xaml = Env.Get("CUE_SNAPSHOT_METHOD") == "xaml";
    private readonly Dictionary<string, string> taken = [];
    private readonly Dictionary<string, int> busy = [];
    private readonly DispatcherQueueTimer timer;
    private readonly DispatcherQueue queue;
    private int running;

    public Snapshots(AppState state, string path)
    {
        log = state.Log;
        queue = state.Queue;
        this.path = path;
        var dark = Application.Current.RequestedTheme == ApplicationTheme.Dark;
        log.Write(xaml
            ? $"📸 Snapshots: XAML's own drawing (RenderTargetBitmap), in the {(dark ? "dark" : "light")} appearance — the backdrop's solid colour for its material"
            : $"📸 Snapshots: window capture (PrintWindow), in the {(dark ? "dark" : "light")} appearance");
        // Kept in a field: a timer only a local variable holds is collected, and stops.
        timer = state.Queue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(2);
        timer.IsRepeating = true;
        timer.Tick += (_, _) => Take();
        timer.Start();
    }

    /// <summary>
    /// A window to snapshot, to `suffix` next to the CUE_SNAPSHOT file (`-dashboard.png`); `content` is its XAML and `backdrop` the theme brush its
    /// material falls back to, for CUE_SNAPSHOT_METHOD=xaml.
    /// </summary>
    public void Add(string name, Func<IntPtr> handle, string suffix, Func<UIElement?> content, string backdrop) =>
        targets.Add((name, handle, path.Replace(".png", suffix, StringComparison.OrdinalIgnoreCase), content, backdrop));

    /// <summary>
    /// The windows' handles are read here, on the UI thread; the pictures are taken on another one, so that <c>PrintWindow</c>, which asks the window's own
    /// thread for its content, never holds the UI up.
    /// </summary>
    private void Take()
    {
        if (Interlocked.Exchange(ref running, 1) == 1) return;
        if (xaml)
        {
            _ = Draw();
            return;
        }
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

    /// <summary>CUE_SNAPSHOT_METHOD=xaml: each window's content drawn by XAML on the UI thread, then written as a PNG on another one.</summary>
    private async Task Draw()
    {
        try
        {
            foreach (var (name, hwnd, file, content, backdrop) in targets)
            {
                await Ui();
                var handle = hwnd();
                if (handle == IntPtr.Zero || !Native.IsWindowVisible(handle) || Native.IsIconic(handle)) continue;
                if (content() is not FrameworkElement root || root.XamlRoot is null || root.ActualWidth <= 0 || root.ActualHeight <= 0) continue;
                var under = Application.Current.Resources[backdrop] switch
                {
                    AcrylicBrush acrylic => acrylic.FallbackColor,
                    SolidColorBrush solid => solid.Color,
                    _ => Microsoft.UI.Colors.White,
                };
                string how;
                try
                {
                    var bitmap = new RenderTargetBitmap();
                    await bitmap.RenderAsync(root);
                    // A WinRT operation may finish on another thread: the bitmap is read on the UI thread, as XAML wants.
                    await Ui();
                    var buffer = await bitmap.GetPixelsAsync();
                    await Ui();
                    var (width, height, pixels) = (bitmap.PixelWidth, bitmap.PixelHeight, buffer.ToArray());
                    how = await Task.Run(() => Save(pixels, width, height, under, file)) ?? "couldn't write it: the file is in use";
                }
                catch (Exception e)
                {
                    // Whatever XAML says, the next round tries again (an exception here would end the program).
                    how = $"couldn't draw it: {e.GetType().Name} 0x{e.HResult:X8} {e.Message}".TrimEnd();
                }
                await Ui();
                if (how != taken.GetValueOrDefault(name, "ok")) log.Write($"📸 {name}: {how}");
                taken[name] = how;
            }
        }
        finally
        {
            Volatile.Write(ref running, 0);
        }
    }

    /// <summary>Back on the UI thread: what follows the await runs there (at once when it is there already).</summary>
    private Task Ui()
    {
        if (queue.HasThreadAccess) return Task.CompletedTask;
        var there = new TaskCompletionSource();
        if (!queue.TryEnqueue(() => there.SetResult())) there.SetCanceled();
        return there.Task;
    }

    /// <summary>Premultiplied BGRA over an opaque colour, as a PNG; "ok", or null when the file was busy.</summary>
    private static string? Save(byte[] pixels, int width, int height, Windows.UI.Color under, string file)
    {
        if (width <= 0 || height <= 0) return "empty window";
        for (var i = 0; i + 3 < pixels.Length; i += 4)
        {
            var rest = 255 - pixels[i + 3];
            pixels[i] = (byte)(pixels[i] + under.B * rest / 255);
            pixels[i + 1] = (byte)(pixels[i + 1] + under.G * rest / 255);
            pixels[i + 2] = (byte)(pixels[i + 2] + under.R * rest / 255);
            pixels[i + 3] = 255;
        }
        try
        {
            using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
            var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (var row = 0; row < height; row++) Marshal.Copy(pixels, row * width * 4, data.Scan0 + row * data.Stride, width * 4);
            }
            finally
            {
                bitmap.UnlockBits(data);
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
