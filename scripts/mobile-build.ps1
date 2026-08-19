#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — G1 one-command mobile build, Windows half.

.DESCRIPTION
    The PowerShell twin of `scripts/mobile-build.sh`. One command, one app (or
    both), four stages:

        flutter pub get -> flutter analyze -> flutter test -> flutter build apk --debug

    and with -Release, a PREFLIGHT and two more stages:

        RELEASE PREFLIGHT (signing.properties + keystore + Firebase, per app)
          -> flutter build apk --release -> flutter build appbundle --release

    The release preflight runs BEFORE the first `flutter pub get`, because
    every one of its blockers is readable from a committed file and none of
    them should cost the operator a fifteen-minute build to discover.

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

.PARAMETER AllowReleaseWithoutPush
    Downgrade the RELEASE PREFLIGHT's missing-google-services.json blocker to a
    warning, for the one legitimate case: a release-signed QA sideload build on
    a machine that has the keystore but no Firebase project yet. It does not
    make push work; it makes the absence explicit and consented-to. The signing
    blockers are NOT downgradable — a release build without a key produces
    nothing at all.

.PARAMETER LogDir
    Where stage logs are written. Defaults to build-logs\<timestamp>.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\mobile-build.ps1 -App child

.EXAMPLE
    .\scripts\mobile-build.ps1 -App both -Release

.NOTES
    STATUS: STATIC VERIFIED, NOT BUILD VERIFIED, NEVER EXECUTED.

    This file has never been run — the authoring environment has no PowerShell
    (`pwsh` and `powershell` are both absent) and no Flutter SDK. Every path,
    filename and property name in it has been checked BY READING against
    apps/*/android/app/build.gradle, apps/*/android/signing.properties.example,
    apps/*/android/.gitignore, apps/*/pubspec.yaml and
    .github/workflows/build-apk.yml. That is STATIC VERIFIED; it is not a run,
    and nothing here may be described as BUILD VERIFIED until a Windows machine
    produces an artifact.

    ITS BASH TWIN IS NOW BEHIND. `scripts/mobile-build.sh` HAS been executed
    (its BLOCKED preflight and first-failing-stage stop are recorded in the
    Phase G ship report). It does NOT have the RELEASE PREFLIGHT added here and
    it still names `key.properties` in its closing note; whoever owns the .sh
    needs the same two corrections.
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
    [switch] $AllowReleaseWithoutPush,
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
    # Pre-set so the read below cannot hit `Set-StrictMode -Version Latest`'s
    # "variable is not set" on a session where no native command has run yet
    # (`$LASTEXITCODE` is an automatic variable that does not exist until one
    # has). The invocation on the next line always overwrites it.
    $global:LASTEXITCODE = 0
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

# ---- RELEASE PREFLIGHT: fail HERE, not fifteen minutes into Gradle --------
#
# WHY THIS BLOCK EXISTS. Without it, `-Release` ran `flutter pub get`,
# `flutter analyze`, `flutter test` and a full debug APK build — several
# minutes each — and only then reached `flutter build apk --release`, where
# app/build.gradle's task-graph guard stopped everything with "signing.properties
# is MISSING". The information was available before the first stage started,
# from two committed files. A build script that spends fifteen minutes to tell
# you something it could have said immediately is not fail-fast.
#
# AND THE FIREBASE HALF IS WORSE, because it does NOT stop the build. The
# gradle default is `-Pabny.firebase=auto`, which WARNS and continues when
# google-services.json is absent, so `-Release` on the parent app currently
# produces a perfectly valid, perfectly signed AAB whose every push
# notification silently never arrives. `.github/workflows/build-apk.yml` treats
# exactly that state as an error for the parent app's release job
# ("RELEASE BUILD REQUESTED FOR THE PARENT APP WITHOUT FIREBASE"); this script
# now agrees with CI instead of shipping the false green.
#
# NOTHING HERE IS FABRICATED AND NOTHING IS DEFAULTED: each branch names the
# exact file, the exact directory, and the exact command that produces it.
if ($Release) {
    Write-Head 'RELEASE PREFLIGHT'
    $releaseBlockers = New-Object System.Collections.ArrayList

    foreach ($appName in $appDirs) {
        $androidDir  = Join-Path $RepoRoot "apps\$appName\android"
        $signProps   = Join-Path $androidDir 'signing.properties'
        $signExample = Join-Path $androidDir 'signing.properties.example'

        # The keystore filename and alias come from the COMMITTED TEMPLATE, so
        # this script never invents key material or a name for it.
        $exampleKeystore = Get-FirstMatch $signExample '(?m)^\s*storeFile\s*=\s*(.+)$'
        $exampleAlias    = Get-FirstMatch $signExample '(?m)^\s*keyAlias\s*=\s*(.+)$'
        $shortName = $appName -replace '-app$', ''
        if (-not $exampleKeystore) { $exampleKeystore = "abny-$shortName-upload.jks" }
        if (-not $exampleAlias)    { $exampleAlias    = "abny-$shortName-upload" }
        $keytoolCmd = ("keytool -genkeypair -v -keystore $exampleKeystore -alias $exampleAlias " +
                       '-keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12')

        if (-not (Test-Path -LiteralPath $signProps)) {
            [void]$releaseBlockers.Add(
                "$appName : android\signing.properties is MISSING.`n" +
                "            app\build.gradle stops every release task rather than falling back to the debug key.`n" +
                "            Fix, in apps\$appName\android\ :`n" +
                "              $keytoolCmd`n" +
                "              copy signing.properties.example signing.properties`n" +
                "            then fill storeFile / storePassword / keyAlias / keyPassword.`n" +
                "            Both signing.properties and *.jks are gitignored — never commit either.")
        } else {
            $text = Get-Content -LiteralPath $signProps -Raw
            $missing = @()
            foreach ($k in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
                if ($text -notmatch "(?m)^\s*$k\s*=\s*\S") { $missing += $k }
            }
            if ($missing.Count -gt 0) {
                [void]$releaseBlockers.Add(
                    "$appName : android\signing.properties is INCOMPLETE — missing or empty: $($missing -join ', ').`n" +
                    "            All four are required. A partial signing config is not signed 'less', it is not signed.")
            } else {
                $storeRel = [regex]::Match($text, '(?m)^\s*storeFile\s*=\s*(.+)$').Groups[1].Value.Trim()
                $storeAbs = Join-Path $androidDir $storeRel
                if (-not ((Test-Path -LiteralPath $storeAbs) -or (Test-Path -LiteralPath $storeRel))) {
                    [void]$releaseBlockers.Add(
                        "$appName : the keystore named by signing.properties does not exist: '$storeRel'.`n" +
                        "            storeFile is resolved relative to apps\$appName\android\. Generate it there with:`n" +
                        "              $keytoolCmd")
                } else {
                    Write-Good "$appName : signing.properties complete, keystore present"
                }
            }
        }

        # Firebase, required only of the app that actually declares it.
        $pubspecText  = ''
        $pubspecPath  = Join-Path $RepoRoot "apps\$appName\pubspec.yaml"
        if (Test-Path -LiteralPath $pubspecPath) { $pubspecText = Get-Content -LiteralPath $pubspecPath -Raw }
        $usesFirebase = $pubspecText -match '(?m)^\s*(firebase_messaging|firebase_core)\s*:'
        $gs = Join-Path $RepoRoot "apps\$appName\android\app\google-services.json"
        $appId = Get-FirstMatch (Join-Path $androidDir 'app\build.gradle') 'applicationId\s+"([^"]+)"'
        if (-not $usesFirebase) {
            Write-Info "$appName : declares no Firebase dependency — google-services.json is not required."
        } elseif (Test-Path -LiteralPath $gs) {
            Write-Good "$appName : google-services.json present"
        } else {
            [void]$releaseBlockers.Add(
                "$appName : android\app\google-services.json is MISSING, and this app DEPENDS on firebase_messaging.`n" +
                "            THE BUILD WOULD SUCCEED ANYWAY — the gradle default -Pabny.firebase=auto only warns — and`n" +
                "            produce a signed AAB in which every push notification silently never arrives.`n" +
                "            Only you can supply it: create the Firebase Android app for applicationId`n" +
                "              $appId`n" +
                "            download google-services.json and place it at`n" +
                "              apps\$appName\android\app\google-services.json`n" +
                "            See docs\release\FIREBASE_SETUP.md. Nothing in this repository can generate it, and a`n" +
                "            placeholder is worse than an absence: it builds and then fails silently at runtime.`n" +
                "            To build a release WITHOUT push on purpose, say so: -AllowReleaseWithoutPush.")
        }
    }

    if ($AllowReleaseWithoutPush) {
        $kept = @($releaseBlockers | Where-Object { $_ -notmatch 'google-services\.json is MISSING' })
        $dropped = $releaseBlockers.Count - $kept.Count
        if ($dropped -gt 0) {
            Write-Warn "-AllowReleaseWithoutPush: $dropped Firebase blocker(s) DOWNGRADED by explicit request."
            Write-Warn 'The artifact this run produces has NO push notifications. Do not upload it to a store.'
        }
        $releaseBlockers = $kept
    }

    if ($releaseBlockers.Count -gt 0) {
        Write-Host ''
        Write-Host ('=' * 78) -ForegroundColor Red
        Write-Host '  RELEASE PREFLIGHT BLOCKED' -ForegroundColor Red
        Write-Host ('=' * 78) -ForegroundColor Red
        foreach ($b in $releaseBlockers) { Write-Host "  [BLOCKED] $b" -ForegroundColor Red; Write-Host '' }
        Write-Host '  No stage was run and no artifact was produced. Every line above names a file'
        Write-Host '  you must create; none of them has a default this script is willing to invent.'
        Write-Host ''
        Write-Host '  Diagnose the whole machine at once with:'
        Write-Host '      powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1'
        Write-Host ''
        Write-Host '  Or build the debug artifact, which needs none of this:'
        Write-Host "      .\scripts\mobile-build.ps1 -App $App"
        Write-Host ''
        exit 1
    }
    Write-Good 'release preflight passed — every precondition the release build needs is in place.'
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
    # `key.properties` was the name here and it is not the file the gradle
    # reads: app/build.gradle reads `rootProject.file("signing.properties")`,
    # and android/.gitignore ignores that name. The RELEASE PREFLIGHT above
    # already proved it resolved a real keystore, so this line now says what
    # is true rather than what a template once called it.
    Write-Host '  Release artifacts were signed from apps\<app>\android\signing.properties (checked in PREFLIGHT).' -ForegroundColor Yellow
    Write-Host '  Verify the signature before uploading:  python3 scripts\verify_release_signing.py'
}
Write-Host ''
Write-Host '  ALL STAGES PASSED.' -ForegroundColor Green
Write-Host ''
exit 0
