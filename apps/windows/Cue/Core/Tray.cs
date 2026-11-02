using System.Drawing;
using System.Runtime.InteropServices;

namespace Cue;

/// <summary>
/// The icon in the notification area (the Mac's menu bar item): Start or Stop Cue, Show or Hide, Answer Now, Restart Live Call, the dashboard, Settings and
/// Quit, in a native menu. It turns red while a call is recorded (<see cref="Recording"/>; the recordings slice sets it).
/// </summary>
internal sealed class Tray : IDisposable
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size;
        public IntPtr Window;
        public uint Id;
        public uint Flags;
        public uint CallbackMessage;
        public IntPtr Icon;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string Tip;

        public uint State;
        public uint StateMask;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string Info;

        public uint Version;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string InfoTitle;

        public uint InfoFlags;
        public Guid ItemGuid;
        public IntPtr BalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    private const uint Add = 0, Modify = 1, Delete = 2;
    private const uint FlagMessage = 1, FlagIcon = 2, FlagTip = 4;
    private const uint WmLButtonUp = 0x202, WmRButtonUp = 0x205;

    private enum Item
    {
        Cue = 1,
        Overlay,
        Answer,
        Restart,
        Dashboard,
        Settings,
        Quit,
    }

    private readonly MessageWindow window;
    private readonly AppState state;
    private readonly Icon normal;
    private Icon? red;
    private bool recording;

    public Tray(MessageWindow window, AppState state)
    {
        this.window = window;
        this.state = state;
        normal = new Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"), SystemInformationIconSize);
        window.Tray += OnMouse;
        window.TaskbarCreated += () => Notify(Add);
        Notify(Add);
    }

    private static Size SystemInformationIconSize => new(GetSystemMetrics(49), GetSystemMetrics(50)); // SM_CXSMICON, SM_CYSMICON

    /// <summary>The icon is red while a call is recorded, even with the overlay hidden.</summary>
    public bool Recording
    {
        get => recording;
        set
        {
            if (recording == value) return;
            recording = value;
            Notify(Modify);
        }
    }

    private Icon Current => recording ? red ??= WithRedDot(normal) : normal;

    private static Icon WithRedDot(Icon icon)
    {
        using var bitmap = icon.ToBitmap();
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var dot = Math.Max(bitmap.Width / 2, 6);
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            graphics.FillEllipse(Brushes.Red, bitmap.Width - dot, bitmap.Height - dot, dot - 1, dot - 1);
        }
        var handle = bitmap.GetHicon();
        using var made = Icon.FromHandle(handle);
        var copy = (Icon)made.Clone();
        DestroyIcon(handle);
        return copy;
    }

    private void Notify(uint command)
    {
        var data = new NotifyIconData
        {
            Size = (uint)Marshal.SizeOf<NotifyIconData>(),
            Window = window.Handle,
            Id = 1,
            Flags = FlagMessage | FlagIcon | FlagTip,
            CallbackMessage = MessageWindow.TrayMessage,
            Icon = Current.Handle,
            Tip = recording ? "Cue — recording" : "Cue",
            Info = "",
            InfoTitle = "",
        };
        Shell_NotifyIconW(command, ref data);
    }

    private void OnMouse(uint message)
    {
        if (message is WmLButtonUp or WmRButtonUp) ShowMenu();
    }

    private void ShowMenu()
    {
        var menu = CreatePopupMenu();
        try
        {
            var live = state.Live;
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Cue, live.CueRunning ? "Stop Cue" : "Start Cue");
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Overlay, "Show or Hide Cue\tWin+Alt+H");
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Answer, "Answer Now\tWin+Alt+Enter");
            // The recordings slice adds Start Recording / Stop Recording here.
            AppendMenuW(menu, 0x800, UIntPtr.Zero, null);
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Dashboard, "Open Dashboard");
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Settings, "Settings");
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Restart, "Restart Live Call");
            AppendMenuW(menu, 0x800, UIntPtr.Zero, null);
            AppendMenuW(menu, 0, (UIntPtr)(uint)Item.Quit, "Quit Cue");
            GetCursorPos(out var at);
            // The menu closes when the click goes elsewhere only if its owner is the foreground window.
            SetForegroundWindow(window.Handle);
            var chosen = (Item)TrackPopupMenuEx(menu, 0x0100 /* TPM_RETURNCMD */ | 0x0002 /* TPM_RIGHTBUTTON */ | 0x0020 /* TPM_BOTTOMALIGN */, at.X, at.Y, window.Handle, IntPtr.Zero);
            PostMessageW(window.Handle, 0, IntPtr.Zero, IntPtr.Zero);
            switch (chosen)
            {
                case Item.Cue:
                    live.ToggleCue();
                    break;
                case Item.Overlay:
                    live.ToggleOverlay();
                    break;
                case Item.Answer:
                    live.AnswerNow();
                    break;
                case Item.Restart:
                    live.RestartCall();
                    break;
                case Item.Dashboard:
                    state.OpenDashboard();
                    break;
                case Item.Settings:
                    state.Dashboard.ShowSettings();
                    state.OpenDashboard();
                    break;
                case Item.Quit:
                    state.Quit();
                    break;
            }
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    public void Dispose()
    {
        Notify(Delete);
        normal.Dispose();
        red?.Dispose();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Shell_NotifyIconW(uint message, ref NotifyIconData data);

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr id, string? text);

    [DllImport("user32.dll")]
    private static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr window, IntPtr parameters);

    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
}
