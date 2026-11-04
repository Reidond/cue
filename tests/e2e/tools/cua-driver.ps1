# Installs Cua Driver (github.com/trycua/cua) in the Cue Windows VM, for `node tests/e2e/remote.ts windows cua …`: it reads the windows and
# UI Automation trees of the apps there and clicks and types into them without taking the VM's pointer or focus. tests/e2e/remote.ts runs
# this elevated, as the VM's own user, after apps\windows\scripts\setup.ps1: Cua Driver is in that user's %LOCALAPPDATA%\Programs\Cua, and
# the Scheduled Task cua-driver-serve keeps its daemon running in their desktop session (registering it is what needs the elevation).
#
# The installer is the release's, checked here by its SHA-256 (it checks the release's archive against the release's SHA256SUMS and the
# executables' signatures itself); telemetry and update checks are off.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '0.38.0'
$tag = "cua-driver-rs-v$version"
$driver = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin\cua-driver.exe'

# Its settings, before anything runs it.
$folder = Join-Path $env:USERPROFILE '.cua-driver'
$null = New-Item -ItemType Directory -Force -Path $folder
$file = Join-Path $folder 'config.json'
$config = if (Test-Path -LiteralPath $file) { Get-Content -Raw -LiteralPath $file | ConvertFrom-Json } else { [pscustomobject]@{} }
foreach ($key in 'telemetry_enabled', 'update_check_enabled') { $config | Add-Member -Force -NotePropertyName $key -NotePropertyValue $false }
# UTF-8 without a byte order mark, which the driver's JSON reader refuses.
[IO.File]::WriteAllText($file, ($config | ConvertTo-Json))

$installed = if (Test-Path -LiteralPath $driver) { & $driver --version } else { '' }
if ("$installed" -notmatch [regex]::Escape($version)) {
    Write-Output "Installing Cua Driver $version…"
    $work = Join-Path ([IO.Path]::GetTempPath()) ('cua-driver-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $work
    try {
        $files = @(
            @{ Name = 'install.ps1'; Sha = '31ff35434433d511457bac9638d568a7151a517bc613f478c29d52670a307727'
                Url = "https://github.com/trycua/cua/releases/download/$tag/install.ps1" },
            # Its helpers beside it, where it looks first (else it fetches the newest from cua.ai).
            @{ Name = '_install-common.psm1'; Sha = '99f34a84ceab04d4b488b1db4d71536c7a7ac7e645ac2ec295b4fd85244085b6'
                Url = "https://raw.githubusercontent.com/trycua/cua/$tag/libs/cua-driver/scripts/_install-common.psm1" }
        )
        foreach ($download in $files) {
            $path = Join-Path $work $download.Name
            Invoke-WebRequest -UseBasicParsing -Uri $download.Url -OutFile $path
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -ne $download.Sha) { throw "$($download.Url) isn't the file expected" }
        }
        $env:CUA_DRIVER_RS_VERSION = $version
        $env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
        & (Join-Path $work 'install.ps1')
        if (-not (Test-Path -LiteralPath $driver)) { throw "Cua Driver's installer didn't install $driver" }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# What the driver writes to stderr is no error of this script (Windows PowerShell stops at it under 'Stop').
$ErrorActionPreference = 'Continue'
& $driver autostart enable
if ($LASTEXITCODE -ne 0) { throw "cua-driver autostart enable failed ($LASTEXITCODE)" }
& $driver autostart kick
for ($i = 0; $i -lt 10; $i++) {
    & $driver status *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
}
& $driver --version
& $driver status
exit $LASTEXITCODE
