# Reads the text of an image with Windows' own OCR (Windows.Media.Ocr), the Windows twin of ocr.swift: one line per line of text, top to bottom.
#
#   powershell -File ocr.ps1 IMAGE.png [LEFT TOP WIDTH HEIGHT]
#
# With an area (in the image's pixels), only the words whose middle is in it: the text of one part of a window, not of all of it.
# The recognizer is English's when Windows has it (Settings > Time & language > Language & region; `setup.ps1` adds it), else the user's own languages'.
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Left = 0,
    [int]$Top = 0,
    [int]$Width = [int]::MaxValue,
    [int]$Height = [int]::MaxValue
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
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

$file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
$stream = Wait-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Wait-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'Windows has no OCR language installed.' }

$result = Wait-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $result.Lines) {
    $words = @($line.Words | Where-Object {
            $x = $_.BoundingRect.X + $_.BoundingRect.Width / 2
            $y = $_.BoundingRect.Y + $_.BoundingRect.Height / 2
            $x -ge $Left -and $x -lt $Left + [double]$Width -and $y -ge $Top -and $y -lt $Top + [double]$Height
        } | ForEach-Object Text)
    if ($words.Count -eq $line.Words.Count) { [Console]::Out.WriteLine($line.Text) }
    elseif ($words.Count -gt 0) { [Console]::Out.WriteLine($words -join ' ') }
}
