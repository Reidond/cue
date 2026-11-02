using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Cue;

/// <summary>What Cue asks of Windows' shell: the Recycle Bin, Explorer, and the order Explorer sorts names in.</summary>
internal static class Shell
{
    private const uint FoDelete = 3;
    private const ushort FofSilent = 0x4;
    private const ushort FofNoConfirmation = 0x10;
    private const ushort FofAllowUndo = 0x40;
    private const ushort FofNoErrorUi = 0x400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileOperation
    {
        public IntPtr Hwnd;
        public uint Function;
        [MarshalAs(UnmanagedType.LPWStr)] public string From;
        [MarshalAs(UnmanagedType.LPWStr)] public string? To;
        public ushort Flags;
        [MarshalAs(UnmanagedType.Bool)] public bool AnyOperationsAborted;
        public IntPtr NameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string? ProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperationW(ref FileOperation operation);

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    private static extern int StrCmpLogicalW(string a, string b);

    /// <summary>Moves a folder, everything in it, to the Recycle Bin (the shell wants the path double-null-terminated).</summary>
    public static void MoveToRecycleBin(string folder)
    {
        var operation = new FileOperation
        {
            Function = FoDelete,
            From = folder + "\0",
            Flags = FofAllowUndo | FofNoConfirmation | FofNoErrorUi | FofSilent,
        };
        var code = SHFileOperationW(ref operation);
        if (code != 0 || operation.AnyOperationsAborted || Directory.Exists(folder))
            throw new IOException($"Couldn't move “{Path.GetFileName(folder)}” to the Recycle Bin" + (code != 0 ? $" (error 0x{code:X})." : "."));
    }

    public static void ShowInExplorer(string folder)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true })?.Dispose();
        }
        catch (Win32Exception)
        {
        }
    }

    /// <summary>Names in the order Explorer sorts them: "Talk 2" before "Talk 10", case ignored.</summary>
    public static int NaturalCompare(string a, string b) => StrCmpLogicalW(a, b);
}
