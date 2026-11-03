# Builds Cue for Windows, as apps/mac/scripts/build.sh builds Cue.app: the one entry point for you, the end-to-end suite, CI and the release workflow.
# It publishes the app (WinUI 3, unpackaged, with the .NET and Windows App SDK runtimes next to it) to <Output>\<arch>\Cue.exe, and with -Msi also makes
# the installer <Output>\Cue-<version>-<arch>.msi. Warnings fail the build.
#
#   powershell -ExecutionPolicy Bypass -File apps\windows\scripts\build.ps1 [-Arch x64|arm64] [-Version 2.0.1] [-Msi] [-Quick] [-Output DIR]
#
#   -Arch     the processor the app is for; this PC's by default (an x64 PC builds arm64 as well, and the other way round)
#   -Version  MAJOR.MINOR.PATCH for the app and the installer; release.yml passes the Mac's version and the patch from the tags, else
#             CFBundleShortVersionString of apps/mac/Resources/Info.plist with patch 0
#   -Msi      also build the installer (WiX, through `dotnet build`)
#   -Quick    with -Msi, an installer for a test and not for shipping: its files are stored, not compressed, and it is not validated
#             (a few seconds, not a minute; about 250 MB, not 70)
#   -Output   where the build goes: apps\windows\build by default
#
# CUE_UPDATES=OWNER/NAME (release.yml sets it) makes a release build: Cue updates itself from that repository's GitHub releases.
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')][string]$Arch,
    [string]$Version,
    [switch]$Msi,
    [switch]$Quick,
    [string]$Output
)

$ErrorActionPreference = 'Stop'
$windows = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repository = (Resolve-Path (Join-Path $windows '..\..')).Path
if (-not $Output) { $Output = Join-Path $windows 'build' }
$Output = [System.IO.Path]::GetFullPath($Output)

if (-not $Arch) {
    # The processor's own architecture (12 is Arm64), which an emulated PowerShell doesn't see.
    $Arch = if ((Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture -eq 12) { 'arm64' } else { 'x64' }
}

if (-not $Version) {
    $plist = Get-Content (Join-Path $repository 'apps\mac\Resources\Info.plist') -Raw
    if ($plist -notmatch '(?s)<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>') { throw 'No CFBundleShortVersionString in Info.plist' }
    $Version = "$($Matches[1]).0"
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "The version must be MAJOR.MINOR.PATCH: $Version" }

# The backend's address is kept in one place, apps/api/production-url.txt; CUE_API_URL still overrides it at run time.
$apiUrl = (Get-Content (Join-Path $repository 'apps\api\production-url.txt') -Raw).Trim()

function Invoke-DotNet {
    & dotnet @args
    if ($LASTEXITCODE -ne 0) { throw "dotnet $($args[0]) failed (exit $LASTEXITCODE)" }
}

$app = Join-Path $Output $Arch
$clock = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "Publishing Cue $Version for $Arch..."
# TreatWarningsAsErrors is on in Cue.csproj: new code must build warning-free.
$stamps = @("-p:Version=$Version", "-p:CueApiUrl=$apiUrl")
if ($env:CUE_UPDATES) { $stamps += "-p:CueUpdates=$env:CUE_UPDATES" }
Invoke-DotNet publish (Join-Path $windows 'Cue\Cue.csproj') -c Release -r "win-$Arch" --self-contained `
    @stamps "-p:PublishDir=$app" '-p:DebugType=None' '-p:DebugSymbols=false' -nologo '-v:minimal'
Write-Host ("Built $app\Cue.exe in {0:N0} s" -f $clock.Elapsed.TotalSeconds)

if ($Msi) {
    $clock.Restart()
    Write-Host "Building the installer..."
    # Always from scratch: the installer's inputs are the published files, which MSBuild's up-to-date check doesn't follow.
    $wix = @("-p:Platform=$Arch", "-p:CueVersion=$Version", "-p:AppDir=$app", "-p:OutDir=$Output")
    if ($Quick) { $wix += '-p:CueCompression=none', '-p:SuppressValidation=true' }
    Invoke-DotNet build (Join-Path $windows 'Installer\Installer.wixproj') -c Release @wix --no-incremental -nologo '-v:minimal'
    Get-ChildItem $Output -Filter '*.wixpdb' | Remove-Item -Force
    Write-Host ("Built $Output\Cue-$Version-$Arch.msi in {0:N0} s" -f $clock.Elapsed.TotalSeconds)
}
