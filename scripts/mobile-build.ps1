#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — G1 one-command mobile build, Windows half.

.DESCRIPTION
    The PowerShell twin of `scripts/mobile-build.sh`. One command, one app (or
    both), four stages:

        flutter pub get -> flutter analyze -> flutter test -> flutter build apk --debug

    and with -Release, two more:

        flutter build apk --release -> flutter build appbundle --release

    FAIL-FAST, AND THAT IS WHY THIS FILE EXISTS SEPARATELY FROM CI.
    `.github/workflows/build-apk.yml` is deliberately DIAGNOSTIC — it runs
    every stage even after one fails, so one CI round trip reports everything
    that is wrong. That is right for CI and wrong for a developer's terminal,
    where the only useful output once a stage fails is that stage's failure, in
    full. So this script STOPS at the first failing stage and prints:

      * the exact command it ran, copy-pasteable, with every --dart-define
      * the working directory it ran in
      * the absolute path of the log file holding the complete output
      * the process exit code, and the log's last 40 lines

    NOTHING IS EVER MASKED. A missing `flutter` is a hard stop in PREFLIGHT,
    not a skipped stage. No stage's exit code is discarded anywhere.

    --dart-define=API_BASE_URL IS MANDATORY (audit MA-004): without it the APK
    installs and can talk to nothing. The default is READ FROM THE REPOSITORY
    (AppConfig.debugDefaultApiBaseUrl), never hardcoded here. Override with
    -ApiBaseUrl.

    ENABLE_PUSH defaults per app to whether that app actually has a
    google-services.json, so an artifact built without Firebase is HONESTLY
    labelled rather than silently shipping a push path that cannot work.

.PARAMETER App
    child | parent | both (default both).

.PARAMETER Release
    Also build `apk --release` and `appbundle --release`.

.PARAMETER ApiBaseUrl
    Overrides the repository-derived API_BASE_URL.

.PARAMETER EnablePush
    Overrides the per-app ENABLE_PUSH default ('true' or 'false').

.PARAMETER SkipTests
    Skip `flutter test`. A deliberate reduction in confidence, reported as such.

.PARAMETER LogDir
    Where stage logs are written. Defaults to build-logs\<timestamp>.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\mobile-build.ps1 -App child

.EXAMPLE
    .\scripts\mobile-build.ps1 -App both -Release

.NOTES
    STATUS: NOT TESTED. This file has never been executed — the authoring
    environment has no PowerShell (`pwsh` and `powershell` are both absent) and
    no Flutter SDK. Its bash twin, `scripts/mobile-build.sh`, HAS been executed:
    its BLOCKED preflight, its first-failing-stage stop and its artifact
    reporting were all exercised and are recorded in the Phase G ship report.
    This file mirrors that script's behaviour, but the first run on a real
    Windows machine is the first measurement of THIS file.
#>

[CmdletBinding()]
param(
    [ValidateSet('child', 'parent', 'both')]
    [string] $App = 'both',
    [switch] $Release,
    [string] $ApiBaseUrl,
    [ValidateSet('true', 'false')]
    [string] $EnablePush,
    [switch] $SkipTests,
    [string] $LogDir,
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
}
function Write-Info([string]$Text) { Write-Host "  $Text" }
function Write-Good([string]$Text) { Write-Host "  [ OK ] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }

# ===========================================================================
# PIN PARSING — same sources/patterns as Get-RepoPins in setup-windows-dev.ps1
# ===========================================================================

function Get-FirstMatch {
    param([string]$Path, [string]$Pattern, [int]$Group = 1)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $m = [regex]::Match($text, $Pattern)
    if (-not $m.Success) { return $null }
    return $m.Groups[$Group].Value.Trim()
}

function Get-BuildPins {
    param([string]$Root)
    $wf = Join-Path $Root '.github\workflows\build-apk.yml'
    if (-not (Test-Path -LiteralPath $wf)) {
        throw "Cannot find .github/workflows/build-apk.yml under '$Root'. Pass -RepoRoot."
    }
    $pins = [ordered]@{}
    $pins.Flutter    = Get-FirstMatch $wf 'FLUTTER_VERSION:\s*"?([0-9.]+)"?'
    if (-not $pins.Flutter) { throw "FLUTTER_VERSION not found in $wf." }

    $parentGr  = Join-Path $Root 'apps\parent-app\android\app\build.gradle'
    $settings  = Join-Path $Root 'apps\parent-app\android\settings.gradle'
    $config    = Join-Path $Root 'apps\parent-app\lib\core\config\app_config.dart'
    $pins.Agp        = Get-FirstMatch $settings 'id\s+"com\.android\.application"\s+version\s+"([^"]+)"'
    $pins.CompileSdk = Get-FirstMatch $parentGr '(?m)^\s*compileSdk\s+(\d+)\s*$'
    $pins.DebugApiUrl = Get-FirstMatch $config "debugDefaultApiBaseUrl\s*=\s*'([^']+)'"
    return $pins
}

# ===========================================================================
# STAGE RUNNER
# ===========================================================================

function Stop-Stage {
    param(
        [string] $AppName, [string] $Stage, [string] $Command,
        [string] $WorkDir, [string] $LogFile, [int] $Code
    )
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  STOPPED — stage FAILED: $Stage ($AppName)" -ForegroundColor Red
    Write-Host ('=' * 78) -ForegroundColor Red
    Write-Host "  failing command : $Command"
    Write-Host "  working dir     : $WorkDir"
    Write-Host "  exit code       : $Code"
    if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
        Write-Host "  full output     : $LogFile"
        Write-Host ''
        Write-Host '  last 40 lines of that log:' -ForegroundColor DarkGray
        Get-Content -LiteralPath $LogFile -Tail 40 | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Host '  full output     : (no log file was produced — the command did not start)'
    }
    Write-Host ''
    Write-Host '  No later stage was run: this script stops at the first failure by design.'
    Write-Host "  Nothing was masked, and no artifact was produced for $AppName."
    Write-Host ''
    exit 1
}

# Runs one stage. Streams AND captures output, then STOPS THE WHOLE SCRIPT on a
# non-zero exit. The exit code is never discarded.
function Invoke-Stage {
    param(
        [string]   $AppName,
        [string]   $Stage,
        [string]   $WorkDir,
        [string]   $LogFile,
        [string[]] $CmdArgs
    )
    $printable = "flutter $($CmdArgs -join ' ')"
    Write-Host ''
    Write-Host "  --- $AppName : $Stage ---" -ForegroundColor Cyan
    Write-Host "  > $printable" -ForegroundColor DarkGray

    $logParent = Split-Path -Parent $LogFile
    if ($logParent -and -not (Test-Path -LiteralPath $logParent)) {
        New-Item -ItemType Directory -Force -Path $logParent | Out-Null
    }

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkDir
    try {
        $output = & flutter @CmdArgs 2>&1 | ForEach-Object {
            $line = $_.ToString()
            Write-Host "    $line"
            $line
        }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } finally {
        Pop-Location
        $ErrorActionPreference = $prev
    }
    $output | Set-Content -LiteralPath $LogFile -Encoding UTF8

    if ($code -ne 0) {
        Stop-Stage -AppName $AppName -Stage $Stage -Command $printable `
                   -WorkDir $WorkDir -LogFile $LogFile -Code $code
    }
    Write-Good "$Stage OK  (log: $LogFile)"
}

# ===========================================================================
# START
# ===========================================================================

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

Write-Head 'ABNY / «ابني» — mobile build'

$pins = Get-BuildPins -Root $RepoRoot

if (-not $ApiBaseUrl) {
    $ApiBaseUrl = $pins.DebugApiUrl
    $apiOrigin = 'AppConfig.debugDefaultApiBaseUrl (read from the repository)'
    if (-not $ApiBaseUrl) {
        Write-Host '  mobile-build: could not read debugDefaultApiBaseUrl from' -ForegroundColor Red
        Write-Host '                apps\parent-app\lib\core\config\app_config.dart, and -ApiBaseUrl was not given.' -ForegroundColor Red
        Write-Host '                Refusing to build: an APK without --dart-define=API_BASE_URL installs and' -ForegroundColor Red
        Write-Host '                can talk to nothing (audit MA-004).' -ForegroundColor Red
        exit 2
    }
} else {
    $apiOrigin = '-ApiBaseUrl'
}

$appDirs = switch ($App) {
    'child'  { @('child-app') }
    'parent' { @('parent-app') }
    'both'   { @('parent-app', 'child-app') }
}

if (-not $LogDir) {
    $LogDir = Join-Path $RepoRoot ("build-logs\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$modeText = if ($Release) { 'debug + RELEASE (apk + appbundle)' } else { 'debug only' }
Write-Info "repository   : $RepoRoot"
Write-Info "apps         : $($appDirs -join ' ')"
Write-Info "mode         : $modeText"
Write-Info "API_BASE_URL : $ApiBaseUrl   [$apiOrigin]"
Write-Info "logs         : $LogDir"
Write-Info "Flutter pin  : $($pins.Flutter) (from .github\workflows\build-apk.yml)"

# ---- PREFLIGHT: a missing toolchain is a HARD STOP ------------------------
Write-Head 'PREFLIGHT'

if (Get-Command flutter -ErrorAction SilentlyContinue) {
    $first = (& flutter --version 2>&1 | Out-String) -split "`n" | Select-Object -First 1
    $m = [regex]::Match($first, '^Flutter\s+([0-9][0-9.]*)')
    if ($m.Success -and $m.Groups[1].Value -eq $pins.Flutter) {
        Write-Good "flutter $($m.Groups[1].Value) (matches the repository pin)"
    } elseif ($m.Success) {
        Write-Warn "flutter $($m.Groups[1].Value) on PATH, but this repository pins $($pins.Flutter)."
        Write-Warn "Flutter 3.27+ defaults compileSdk to 35 and AGP $($pins.Agp) refuses anything above $($pins.CompileSdk)."
        Write-Warn 'Continuing, because you may have a good reason — but a failure below may be the version, not the code.'
    } else {
        Write-Warn "flutter is on PATH but 'flutter --version' could not be parsed. Continuing."
    }
} else {
    Write-Host ''
    Write-Host "  [BLOCKED] flutter is not installed (no 'flutter' on PATH)." -ForegroundColor Red
    Write-Host '            Nothing below can run: pub get, analyze, test and build are all flutter.'
    Write-Host '            This is reported as a BLOCKED PREFLIGHT rather than a skipped stage,'
    Write-Host '            because a build script that "succeeds" without a compiler is worse than'
    Write-Host '            one that fails.'
    Write-Host ''
    Write-Host "            Fix: powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1"
    Write-Host "                 (installs Flutter $($pins.Flutter), the JDK and the Android SDK this repo pins)"
    Write-Host '            Then diagnose everything else at once with:'
    Write-Host '                 powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1'
    Write-Host ''
    Write-Host '  PREFLIGHT BLOCKED — no stage was attempted, no artifact was produced.' -ForegroundColor Red
    Write-Host ''
    exit 1
}

# ---- STAGES ---------------------------------------------------------------
$artifacts = New-Object System.Collections.ArrayList

foreach ($appName in $appDirs) {
    $appDir = Join-Path $RepoRoot "apps\$appName"
    if (-not (Test-Path -LiteralPath $appDir)) {
        Write-Host "  mobile-build: apps\$appName does not exist under $RepoRoot." -ForegroundColor Red
        exit 2
    }

    if ($EnablePush) {
        $appPush = $EnablePush
        $pushOrigin = '-EnablePush'
    } elseif (Test-Path -LiteralPath (Join-Path $appDir 'android\app\google-services.json')) {
        $appPush = 'true'
        $pushOrigin = 'google-services.json is present'
    } else {
        $appPush = 'false'
        $pushOrigin = 'google-services.json is ABSENT — this artifact has no push, and says so'
    }

    Write-Head $appName
    Write-Info "ENABLE_PUSH  : $appPush   [$pushOrigin]"

    $defines = @("--dart-define=API_BASE_URL=$ApiBaseUrl", "--dart-define=ENABLE_PUSH=$appPush")

    Invoke-Stage -AppName $appName -Stage 'pub get' -WorkDir $appDir `
        -LogFile (Join-Path $LogDir "$appName-01-pub-get.log") -CmdArgs @('pub', 'get')

    Invoke-Stage -AppName $appName -Stage 'analyze' -WorkDir $appDir `
        -LogFile (Join-Path $LogDir "$appName-02-analyze.log") -CmdArgs @('analyze')

    if ($SkipTests) {
        Write-Warn 'test SKIPPED by -SkipTests. This is a deliberate reduction in confidence, not a pass.'
    } else {
        Invoke-Stage -AppName $appName -Stage 'test' -WorkDir $appDir `
            -LogFile (Join-Path $LogDir "$appName-03-test.log") -CmdArgs @('test')
    }

    Invoke-Stage -AppName $appName -Stage 'build apk --debug' -WorkDir $appDir `
        -LogFile (Join-Path $LogDir "$appName-04-apk-debug.log") `
        -CmdArgs (@('build', 'apk', '--debug') + $defines)
    [void]$artifacts.Add([pscustomobject]@{
        App = $appName; Kind = 'debug APK'
        Path = Join-Path $appDir 'build\app\outputs\flutter-apk\app-debug.apk'
    })

    if ($Release) {
        Invoke-Stage -AppName $appName -Stage 'build apk --release' -WorkDir $appDir `
            -LogFile (Join-Path $LogDir "$appName-05-apk-release.log") `
            -CmdArgs (@('build', 'apk', '--release') + $defines)
        [void]$artifacts.Add([pscustomobject]@{
            App = $appName; Kind = 'release APK'
            Path = Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'
        })

        Invoke-Stage -AppName $appName -Stage 'build appbundle --release' -WorkDir $appDir `
            -LogFile (Join-Path $LogDir "$appName-06-aab-release.log") `
            -CmdArgs (@('build', 'appbundle', '--release') + $defines)
        [void]$artifacts.Add([pscustomobject]@{
            App = $appName; Kind = 'release AAB'
            Path = Join-Path $appDir 'build\app\outputs\bundle\release\app-release.aab'
        })
    }
}

# ---- ARTIFACTS ------------------------------------------------------------
Write-Head 'ARTIFACTS'
foreach ($a in $artifacts) {
    if (Test-Path -LiteralPath $a.Path) {
        $sizeMb = [math]::Round((Get-Item -LiteralPath $a.Path).Length / 1MB, 1)
        Write-Host ("  [ OK ] {0}  {1,-12} {2}  ({3} MB)" -f $a.App, $a.Kind, $a.Path, $sizeMb) -ForegroundColor Green
    } else {
        Write-Host ("  [MISSING] {0}  {1,-12} {2}" -f $a.App, $a.Kind, $a.Path) -ForegroundColor Red
        Write-Host '           The stage reported success but the file is not there. Treat this as a failure:'
        Write-Host "           check the build log in $LogDir."
    }
}

Write-Host ''
Write-Host "  logs: $LogDir"
if ($Release) {
    Write-Host '  Release artifacts are SIGNED ONLY IF android\key.properties resolved a real keystore.' -ForegroundColor Yellow
    Write-Host '  Verify before uploading:  python3 scripts\verify_release_signing.py'
}
Write-Host ''
Write-Host '  ALL STAGES PASSED.' -ForegroundColor Green
Write-Host ''
exit 0
