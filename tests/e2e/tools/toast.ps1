# Clicks a button of a Windows notification (a toast) as a hand would: UI Automation cannot see the shell's toast window, so this looks at the corner of the
# screen where Windows puts it, reads the words there with Windows' own OCR (Windows.Media.Ocr), and moves the pointer to the lowest one that is the button's
# name (the title of a prompt may say the same word, higher up) and clicks it. Prints "ok", or "missing" when no such word is on screen (the banner is
# there for about five seconds, so a case asks again every second).
#
#   powershell -File toast.ps1 BUTTON
param([Parameter(Mandatory = $true)][string]$Button)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime

# Pixels as Windows has them, not as a program that knows nothing of the screen's scale would be told.
Add-Type -Name Dpi -Namespace Cue -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cue.Dpi]::SetProcessDPIAware()
Add-Type -Name Pointer -Namespace Cue -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Wait-Operation($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $null = $task.Wait(-1)
    return $task.Result
}

# The corner above the taskbar, on the primary screen, where a banner appears.
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$width = [Math]::Min(640, $screen.Width)
$height = [Math]::Min(480, $screen.Height)
$left = $screen.Right - $width
$top = $screen.Bottom - $height
$picture = Join-Path ([System.IO.Path]::GetTempPath()) ("cue-toast-$PID.png")
try {
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
    $graphics.Dispose()
    $bitmap.Save($picture, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()

    $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($picture)) ([Windows.Storage.StorageFile])
    $stream = Wait-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $image = Wait-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) { throw 'Windows has no OCR language installed.' }
    $result = Wait-Operation ($engine.RecognizeAsync($image)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()

    # Quotes (straight and curly, as code points: this file is read in the system's code page), question mark, full stop and comma.
    $punctuation = [char[]](0x201C, 0x201D, 0x22, 0x3F, 0x2E, 0x2C)
    $found = $null
    foreach ($line in $result.Lines) {
        foreach ($word in $line.Words) {
            if ($word.Text.Trim($punctuation) -ne $Button) { continue }
            if ($null -eq $found -or $word.BoundingRect.Y -gt $found.BoundingRect.Y) { $found = $word }
        }
    }
    if ($null -eq $found) { 'missing'; return }
    $box = $found.BoundingRect
    [void][Cue.Pointer]::SetCursorPos([int]($left + $box.X + $box.Width / 2), [int]($top + $box.Y + $box.Height / 2))
    Start-Sleep -Milliseconds 200
    [Cue.Pointer]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Cue.Pointer]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    'ok'
}
finally {
    Remove-Item $picture -ErrorAction SilentlyContinue
}
