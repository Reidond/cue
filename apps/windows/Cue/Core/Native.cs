using System.Runtime.InteropServices;

namespace Cue;

/// <summary>The few Win32 calls Cue makes itself: windows kept out of the way (CUE_BACKGROUND), a window's picture (CUE_SNAPSHOT).</summary>
internal static class Native
{
    private const int GwlExStyle = -20;
    private const nint WsExToolWindow = 0x80;
    private const nint WsExNoActivate = 0x08000000;
    private static readonly IntPtr HwndBottom = new(1);
    private const uint SwpNoSize = 0x1;
    private const uint SwpNoMove = 0x2;
    private const uint SwpNoActivate = 0x10;
    private const uint SwpFrameChanged = 0x20;
    private const int ProcessPowerThrottling = 4;

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PowerThrottlingState
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern nint SetWindowLongPtr(IntPtr hwnd, int index, nint value);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool SetProcessInformation(IntPtr process, int information, ref PowerThrottlingState state, uint size);

    /// <summary>
    /// CUE_BACKGROUND: the window gets no taskbar button and never takes the focus, and sits behind every other window (in front of the desktop
    /// only), where a snapshot still captures it. Set before it is shown.
    /// </summary>
    public static void KeepBehind(IntPtr hwnd)
    {
        SetWindowLongPtr(hwnd, GwlExStyle, GetWindowLongPtr(hwnd, GwlExStyle) | WsExToolWindow | WsExNoActivate);
        SendToBottom(hwnd);
    }

    public static void SendToBottom(IntPtr hwnd) =>
        SetWindowPos(hwnd, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate | SwpFrameChanged);

    /// <summary>
    /// CUE_BACKGROUND: Windows throttles the timers of a program whose windows are all covered; a test run's timers must keep their pace
    /// (the Mac's App Nap, <c>beginActivity</c>).
    /// </summary>
    public static void OptOutOfThrottling()
    {
        var state = new PowerThrottlingState { Version = 1, ControlMask = 1, StateMask = 0 };
        SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, ref state, (uint)Marshal.SizeOf<PowerThrottlingState>());
    }
}
