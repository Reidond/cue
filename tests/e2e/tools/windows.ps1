# What a person sees of a program's windows right now, the Windows twin of windows.swift: for the process with this ID, as JSON.
#
#   powershell -File windows.ps1 PID
#
#   foreground  whether one of its windows has the keyboard focus
#   windows     its top-level windows, front to back: title, size, whether they are shown, and whether Windows gives them a taskbar button
#               (no button: a tool window) or lets a click activate them (no-activate windows don't); `inFront` is how many other visible windows lie in front of it;
#               `topmost` (above all normal windows), `affinity` (SetWindowDisplayAffinity: 0 drawn normally, 0x11 hidden from capture) and its place on screen
param([Parameter(Mandatory = $true)][int]$ProcessId)

# Pixels as Windows has them, not as a program that knows nothing of the screen's scale would be told.
Add-Type -Name Dpi -Namespace Cue -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cue.Dpi]::SetProcessDPIAware()

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CueWindows
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<IntPtr> All()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, _) => { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
    public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
    public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
    public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowTextW(h, s, 256); return s.ToString(); }
    public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
    public static long ExStyle(IntPtr h) { return GetWindowLongPtr(h, -20).ToInt64(); }
    public static uint Affinity(IntPtr h) { uint a; GetWindowDisplayAffinity(h, out a); return a; }
}
'@

$foreground = [CueWindows]::GetForegroundWindow()
$all = [CueWindows]::All()
$mine = @()
for ($i = 0; $i -lt $all.Count; $i++) {
    $h = $all[$i]
    if ([CueWindows]::Owner($h) -ne $ProcessId -or -not [CueWindows]::Visible($h)) { continue }
    $title = [CueWindows]::Title($h)
    $r = [CueWindows]::Rect($h)
    $ex = [CueWindows]::ExStyle($h)
    if ($r.Right - $r.Left -lt 20) { continue }
    $front = 0
    for ($j = 0; $j -lt $i; $j++) {
        $other = $all[$j]
        if ([CueWindows]::Visible($other) -and ([CueWindows]::Rect($other).Right - [CueWindows]::Rect($other).Left) -gt 100) { $front++ }
    }
    # Windows owns hidden helper windows of every program; a window of ours that is visible and big is one a person could see.
    $mine += [pscustomobject]@{
        title = $title
        width = $r.Right - $r.Left
        height = $r.Bottom - $r.Top
        toolWindow = [bool]($ex -band 0x80)
        noActivate = [bool]($ex -band 0x08000000)
        # Above every normal window (WS_EX_TOPMOST), and hidden from screenshots and screen sharing (WDA_EXCLUDEFROMCAPTURE is 0x11, WDA_NONE 0).
        topmost = [bool]($ex -band 0x8)
        affinity = [int][CueWindows]::Affinity($h)
        left = $r.Left
        top = $r.Top
        # Visible windows in front of it, of any program (EnumWindows lists front to back), apart from the desktop's own.
        inFront = $front
    }
}
[pscustomobject]@{
    foreground = ([CueWindows]::Owner($foreground) -eq $ProcessId)
    windows = @($mine)
} | ConvertTo-Json -Depth 4 -Compress
