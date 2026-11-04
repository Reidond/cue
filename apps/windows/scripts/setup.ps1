# Installs what building Cue for Windows and running its end-to-end cases needs, on a fresh Windows 11 (the Cue Windows VM):
# git, the .NET 10 SDK, Node.js 26 and pnpm. Whatever is there already is kept. Run it from an elevated PowerShell (winget installs
# these machine-wide); `-Install` also runs `pnpm install` for the repository (the cases need the backend's packages).
#
#   powershell -ExecutionPolicy Bypass -File apps\windows\scripts\setup.ps1 [-Install] [-Backend]
#
#   -Backend  only what the backend's own cases need (`run.ts --no-app`): git, Node.js and pnpm, without the .NET SDK and the OCR language
#
# On Windows 11 for Arm the SDK is the native one, but Node.js is the x64 build on purpose: the backend's `cf dev` runs workerd and
# Vite+'s native packages, which exist for x64 only, and pnpm installs the packages that match the Node.js that runs it. Windows
# runs x64 programs on Arm, so the cases work there (slower to start).
[CmdletBinding()]
param([switch]$Install, [switch]$Backend)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$pnpmVersion = ($package.packageManager -replace '^pnpm@', '')
$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'

# What an installer added to the machine's or the user's Path joins this process's, in front: replacing the Path would lose the Node.js that CI's
# setup-node put there (the x64 one on Arm) for whatever the image has of its own.
function Update-Path {
    $have = $env:Path -split ';'
    $added = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' |
        Where-Object { $_ -and ($have -notcontains $_) }
    $env:Path = (@($added) + $have) -join ';'
}

function Test-Tool([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Install-Package([string]$id, [string[]]$extra = @()) {
    # A fresh Windows (a new VM) has App Installer, winget's package, but registers it for the account only later, from the Store.
    if (-not (Test-Tool winget)) {
        Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction SilentlyContinue
        $apps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
        if (($env:Path -split ';') -notcontains $apps) { $env:Path = "$env:Path;$apps" }
    }
    if (-not (Test-Tool winget)) { throw "winget is missing, and $id is not installed: install App Installer from the Microsoft Store, or git, .NET 10, Node.js 26 (x64) and pnpm by hand." }
    Write-Host "Installing $id..."
    & winget install --id $id --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity @extra
    # 0x8A15002B: already installed and nothing newer.
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget could not install $id (exit $LASTEXITCODE)" }
    Update-Path
}

if (-not (Test-Tool git)) { Install-Package 'Git.Git' }

if (-not $Backend) {
    $sdk = if (Test-Tool dotnet) { (& dotnet --list-sdks | Where-Object { $_ -match '^10\.' }) } else { $null }
    if (-not $sdk) { Install-Package 'Microsoft.DotNet.SDK.10' }
}

$nodeOk = $false
if (Test-Tool node) {
    $nodeOk = [int]((& node --version) -replace '^v(\d+)\..*', '$1') -ge 26
    # On Arm an arm64 Node.js would install packages without workerd and Vite+'s native parts.
    if ($nodeOk -and $arm -and ((& node -p 'process.arch') -ne 'x64')) { $nodeOk = $false }
}
if (-not $nodeOk) { Install-Package 'OpenJS.NodeJS.LTS' @('--architecture', 'x64') }

# workerd and Vite+'s native packages are x64 programs: on Arm they need the x64 Visual C++ runtime, which Windows for Arm doesn't carry.
if ($arm -and ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue).Installed -ne 1)) {
    Install-Package 'Microsoft.VCRedist.2015+.x64'
}

if (-not (Test-Tool pnpm) -or ((& pnpm --version) -ne $pnpmVersion)) {
    Write-Host "Installing pnpm $pnpmVersion..."
    & npm install --global "pnpm@$pnpmVersion"
    if ($LASTEXITCODE -ne 0) { throw 'npm could not install pnpm' }
    Update-Path
}

# The cases read the app's snapshots with Windows' own OCR (tests/e2e/tools/ocr.ps1), which needs the English recognizer; a Windows without it (a Server
# image, say) can't add it, and those cases skip.
if (-not $Backend) {
    try {
        if ((Get-WindowsCapability -Online -Name 'Language.OCR~~~en-US*' -ErrorAction Stop | Select-Object -First 1).State -ne 'Installed') {
            Write-Host 'Installing the English OCR language...'
            $null = Add-WindowsCapability -Online -Name 'Language.OCR~~~en-US~0.0.1.0' -ErrorAction Stop
        }
    } catch {
        Write-Warning "No English OCR language: the cases that read snapshots will skip ($($_.Exception.Message))"
    }
}

Write-Host ''
Write-Host "git    $(& git --version)"
if (-not $Backend) { Write-Host "dotnet $(& dotnet --version) ($($env:PROCESSOR_ARCHITECTURE))" }
Write-Host "node   $(& node --version) ($(& node -p 'process.arch'))"
Write-Host "pnpm   $(& pnpm --version)"

if ($Install) {
    Push-Location $root
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
    } finally { Pop-Location }
}
