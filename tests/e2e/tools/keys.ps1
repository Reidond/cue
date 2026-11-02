# Presses a chord on the keyboard as a person would (SendInput), for the system-wide shortcuts: the keys go to whichever window has the focus, and Windows
# looks for a registered hot key first. Modifiers are held in the order given, then the key, then all let go.
#
#   powershell -File keys.ps1 win alt enter
#   powershell -File keys.ps1 type hello      (the letters and digits one after another)
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Keys)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CueKeys
{
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static void Press(ushort vk, bool up)
    {
        var input = new INPUT { type = 1 };
        input.ki.vk = vk;
        input.ki.flags = (up ? 2u : 0u) | (IsExtended(vk) ? 1u : 0u);
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    static bool IsExtended(ushort vk) { return vk == 0x5B || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28; }
}
'@

$codes = @{ win = 0x5B; alt = 0x12; ctrl = 0x11; shift = 0x10; enter = 0x0D; left = 0x25; up = 0x26; right = 0x27; down = 0x28; pageup = 0x21; pagedown = 0x22; plus = 0xBB; minus = 0xBD }
$vks = if ($Keys[0] -eq 'type') { @() } else { $Keys | ForEach-Object { if ($codes.ContainsKey($_)) { [uint16]$codes[$_] } else { [uint16][char]$_.ToUpper() } } }
if ($Keys[0] -eq 'type') {
    foreach ($character in ($Keys[1..($Keys.Count - 1)] -join ' ').ToCharArray()) {
        $vk = if ($character -eq ' ') { [uint16]0x20 } else { [uint16][char]"$character".ToUpper() }
        [CueKeys]::Press($vk, $false); Start-Sleep -Milliseconds 30
        [CueKeys]::Press($vk, $true); Start-Sleep -Milliseconds 30
    }
    return
}
foreach ($vk in $vks) { [CueKeys]::Press($vk, $false); Start-Sleep -Milliseconds 40 }
[array]::Reverse($vks)
foreach ($vk in $vks) { [CueKeys]::Press($vk, $true); Start-Sleep -Milliseconds 40 }
