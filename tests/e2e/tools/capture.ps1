# Takes a picture of a part of the screen, as a screenshot tool or a screen share would see it (Graphics.CopyFromScreen: a window hidden from capture is not in it).
#
#   powershell -File capture.ps1 LEFT TOP WIDTH HEIGHT OUT.png
param(
    [Parameter(Mandatory = $true)][int]$Left,
    [Parameter(Mandatory = $true)][int]$Top,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing

# Pixels as Windows has them, not as a program that knows nothing of the screen's scale would be told.
Add-Type -Name Dpi -Namespace Cue -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cue.Dpi]::SetProcessDPIAware()
$bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($Left, $Top, 0, 0, $bitmap.Size)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
