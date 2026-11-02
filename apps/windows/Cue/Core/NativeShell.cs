using System.Runtime.InteropServices;

namespace Cue;

/// <summary>The Win32 calls of the live call's surfaces: the overlay's window styles, its place above other windows and its hiding from capture, and the window that receives the hot keys and the tray icon's messages.</summary>
internal static class NativeShell
{
    public const int GwlExStyle = -20;
    public const nint WsExTopmost = 0x8;
    public const nint WsExToolWindow = 0x80;
    public const nint WsExNoActivate = 0x08000000;

    public static readonly IntPtr HwndTopmost = new(-1);
    public static readonly IntPtr HwndBottom = new(1);
    public static readonly IntPtr HwndMessage = new(-3);

    public const uint SwpNoSize = 0x1;
    public const uint SwpNoMove = 0x2;
    public const uint SwpNoActivate = 0x10;

    /// <summary>`SetWindowDisplayAffinity`: the window is drawn normally.</summary>
    public const uint WdaNone = 0x0;

    /// <summary>The window shows black in captures and shares (Windows 10 before 2004).</summary>
    public const uint WdaMonitor = 0x1;

    /// <summary>The window is not in captures and shares at all: what is behind it shows (Windows 10 2004 and later).</summary>
    public const uint WdaExcludeFromCapture = 0x11;

    public const uint WmNclButtonDown = 0xA1;
    public const nint HtCaption = 2;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern nint SetWindowLongPtr(IntPtr hwnd, int index, nint value);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    public static extern nint SendMessage(IntPtr hwnd, uint message, nint wparam, nint lparam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public static void SetExStyle(IntPtr hwnd, nint style, bool on)
    {
        var current = GetWindowLongPtr(hwnd, GwlExStyle);
        SetWindowLongPtr(hwnd, GwlExStyle, on ? current | style : current & ~style);
    }

    /// <summary>Above every other window (over a full-screen slide show too), or back among them, without taking the focus.</summary>
    public static void SetTopmost(IntPtr hwnd, bool topmost) =>
        SetWindowPos(hwnd, topmost ? HwndTopmost : new IntPtr(-2), 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);

    /// <summary>Under every other window (CUE_BACKGROUND), without taking the focus.</summary>
    public static void SetBottom(IntPtr hwnd) => SetWindowPos(hwnd, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);

    /// <summary>Rounded corners, as Windows 11's own windows have (a borderless window has none by itself).</summary>
    public static void RoundCorners(IntPtr hwnd)
    {
        var round = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int)); // DWMWA_WINDOW_CORNER_PREFERENCE
    }

    /// <summary>Hides the window from screen sharing, screenshots and recordings (CUE_ALLOW_CAPTURE shows it); true when Windows took it.</summary>
    public static bool ExcludeFromCapture(IntPtr hwnd) => SetWindowDisplayAffinity(hwnd, WdaExcludeFromCapture) || SetWindowDisplayAffinity(hwnd, WdaMonitor);
}

/// <summary>
/// A message-only window on the UI thread: Windows posts the hot keys (`WM_HOTKEY`) and the tray icon's mouse messages to it, and the thread's message loop
/// (the one WinUI runs) delivers them.
/// </summary>
internal sealed class MessageWindow : IDisposable
{
    private delegate IntPtr WindowProcedure(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass
    {
        public uint Size;
        public uint Style;
        public IntPtr Procedure;
        public int ClassExtra;
        public int WindowExtra;
        public IntPtr Instance;
        public IntPtr Icon;
        public IntPtr Cursor;
        public IntPtr Background;
        public string? MenuName;
        public string ClassName;
        public IntPtr SmallIcon;
    }

    private const uint WmHotKey = 0x312;
    private const string ClassName = "CueMessageWindow";

    /// <summary>The message the tray icon's mouse events arrive as.</summary>
    public const uint TrayMessage = 0x8000 + 1; // WM_APP + 1

    // Held for the life of the process: Windows calls the delegate's function pointer.
    private static readonly WindowProcedure Procedure = Dispatch;
    private static readonly Dictionary<IntPtr, MessageWindow> Windows = [];
    private static readonly uint TaskbarCreatedMessage = RegisterWindowMessageW("TaskbarCreated");
    private static bool registered;

    public IntPtr Handle { get; }

    /// <summary>A registered hot key was pressed (its ID).</summary>
    public event Action<int>? HotKey;

    /// <summary>The mouse did something to the tray icon (the mouse message, e.g. WM_RBUTTONUP).</summary>
    public event Action<uint>? Tray;

    /// <summary>Explorer restarted: the tray icon has to be added again.</summary>
    public event Action? TaskbarCreated;

    public MessageWindow()
    {
        if (!registered)
        {
            var window = new WindowClass
            {
                Size = (uint)Marshal.SizeOf<WindowClass>(),
                Procedure = Marshal.GetFunctionPointerForDelegate(Procedure),
                Instance = GetModuleHandleW(null),
                ClassName = ClassName,
            };
            RegisterClassExW(ref window);
            registered = true;
        }
        Handle = CreateWindowExW(0, ClassName, "Cue", 0, 0, 0, 0, 0, NativeShell.HwndMessage, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        Windows[Handle] = this;
    }

    private static IntPtr Dispatch(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam)
    {
        if (Windows.TryGetValue(hwnd, out var window))
        {
            if (message == WmHotKey) window.HotKey?.Invoke((int)wparam);
            else if (message == TrayMessage) window.Tray?.Invoke((uint)((long)lparam & 0xFFFF));
            else if (message == TaskbarCreatedMessage) window.TaskbarCreated?.Invoke();
        }
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }

    public bool RegisterHotKey(int id, uint modifiers, uint key) => RegisterHotKey(Handle, id, modifiers | 0x4000 /* MOD_NOREPEAT */, key);

    public void UnregisterHotKey(int id) => UnregisterHotKey(Handle, id);

    public void Dispose()
    {
        Windows.Remove(Handle);
        DestroyWindow(Handle);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern ushort RegisterClassExW(ref WindowClass window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowExW(
        int exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessageW(string name);

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string? name);
}
