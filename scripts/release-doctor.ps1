#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — G19 release doctor, Windows half. Read-only.

.DESCRIPTION
    The PowerShell twin of `scripts/release-doctor.sh`, row for row. Answers
    one question — "can this machine produce the release artifact, and if not,
    what exactly do I type next?" — and answers it without building,
    downloading, installing or modifying anything.

    Each row prints PASS / WARN / BLOCKED plus, when it is not PASS, one
    ACTIONABLE line: a command to run or a file to create. Never
    "check your environment".

      PASS    met, measured, and the measured value matches the pin.
      WARN    a real gap that still permits a build attempt, or a mismatch
              whose consequence is degraded rather than absent function.
      BLOCKED the build cannot start, or can only produce a false green.
              Any BLOCKED row makes this script exit 1.

    EVERY EXPECTED VALUE IS READ OUT OF THIS REPOSITORY AT RUN TIME by
    `Get-RepoPins` below, which parses the same files with the same patterns
    as `Get-RepoPins` in scripts/setup-windows-dev.ps1 — the reference
    implementation, and the reason no version is typed from memory here:

      Flutter SDK      .github/workflows/build-apk.yml   env.FLUTTER_VERSION
      JDK major        .github/workflows/build-apk.yml   env.JAVA_VERSION
      Gradle           apps/*/android/gradle/wrapper/gradle-wrapper.properties
      AGP / Kotlin     apps/*/android/settings.gradle
      compileSdk / targetSdk / minSdk / applicationId
                       apps/*/android/app/build.gradle
      Dart constraint  apps/*/pubspec.yaml               environment.sdk

    The two apps are parsed independently and COMPARED; a disagreement on a
    shared toolchain pin is a hard stop, not a pick-one.

    build-tools is NOT declared by either app. It is DERIVED as
    "<compileSdk>.0.0" and the derivation is printed so it can be challenged.

.PARAMETER Profile
    release (default) grades readiness for a SIGNED store artifact, so signing
    material and Firebase configuration are graded as blocking.
    debug grades readiness for `flutter build apk --debug`, where those two are
    WARN instead.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of the folder holding this script.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1

.EXAMPLE
    .\scripts\release-doctor.ps1 -Profile debug

.NOTES
    STATUS: NOT TESTED. This file has never been executed. The authoring
    environment has no PowerShell at all (`pwsh`, `powershell` both absent),
    in addition to having no Flutter, no Dart and no Android SDK. Its bash
    twin, `scripts/release-doctor.sh`, HAS been executed and its BLOCKED
    output is recorded in the Phase G ship report; this file mirrors that
    script's logic row for row, but the first run on a real Windows machine is
    the first measurement of THIS file.
#>

[CmdletBinding()]
param(
    [ValidateSet('release', 'debug')]
    [string] $Profile = 'release',
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ===========================================================================
# OUTPUT
# ===========================================================================

$script:NPass = 0
$script:NWarn = 0
$script:NBlocked = 0
$script:Rows = New-Object System.Collections.ArrayList

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
}

function Add-Row {
    param(
        [ValidateSet('PASS', 'WARN', 'BLOCKED')][string] $Status,
        [string] $Check,
        [string] $Measured,
        [string] $Action
    )
    switch ($Status) {
        'PASS'    { $label = '  PASS '; $colour = 'Green';  $script:NPass++ }
        'WARN'    { $label = '  WARN '; $colour = 'Yellow'; $script:NWarn++ }
        'BLOCKED' { $label = 'BLOCKED'; $colour = 'Red';    $script:NBlocked++ }
    }
    [void]$script:Rows.Add([pscustomobject]@{ Status = $Status; Check = $Check; Measured = $Measured })
    Write-Host ("[{0}] " -f $label) -ForegroundColor $colour -NoNewline
    Write-Host ("{0,-26} {1}" -f $Check, $Measured)
    if ($Action -and $Status -ne 'PASS') {
        Write-Host ("           -> " + $Action) -ForegroundColor DarkGray
    }
}

function Stop-Hard([string]$Message) {
    Write-Host ''
    Write-Host "  release-doctor FATAL: $Message" -ForegroundColor Red
    Write-Host ''
    exit 2
}

# ===========================================================================
# PIN PARSING — same sources, same patterns as setup-windows-dev.ps1
# ===========================================================================

function Get-FirstMatch {
    param([string]$Path, [string]$Pattern, [int]$Group = 1)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $m = [regex]::Match($text, $Pattern)
    if (-not $m.Success) { return $null }
    return $m.Groups[$Group].Value.Trim()
}

function Get-RepoPins {
    param([string]$Root)

    $wf = Join-Path $Root '.github\workflows\build-apk.yml'
    if (-not (Test-Path -LiteralPath $wf)) {
        Stop-Hard "Cannot find .github/workflows/build-apk.yml under '$Root'. Pass -RepoRoot."
    }

    $pins = [ordered]@{}
    $pins.Flutter   = Get-FirstMatch $wf 'FLUTTER_VERSION:\s*"?([0-9.]+)"?'
    $pins.JavaMajor = Get-FirstMatch $wf 'JAVA_VERSION:\s*"?(\d+)"?'
    if (-not $pins.Flutter)   { Stop-Hard "FLUTTER_VERSION not found in $wf." }
    if (-not $pins.JavaMajor) { Stop-Hard "JAVA_VERSION not found in $wf." }

    $perApp = @{}
    foreach ($app in @('parent-app', 'child-app')) {
        $a = Join-Path $Root "apps\$app"
        if (-not (Test-Path -LiteralPath $a)) { Stop-Hard "Missing apps\$app under '$Root'." }

        $wrapper  = Join-Path $a 'android\gradle\wrapper\gradle-wrapper.properties'
        $settings = Join-Path $a 'android\settings.gradle'
        $appGr    = Join-Path $a 'android\app\build.gradle'
        $pubspec  = Join-Path $a 'pubspec.yaml'

        $perApp[$app] = [ordered]@{
            Gradle        = Get-FirstMatch $wrapper 'gradle-([0-9.]+)-(?:bin|all)\.zip'
            Agp           = Get-FirstMatch $settings 'id\s+"com\.android\.application"\s+version\s+"([^"]+)"'
            Kotlin        = Get-FirstMatch $settings 'id\s+"org\.jetbrains\.kotlin\.android"\s+version\s+"([^"]+)"'
            CompileSdk    = Get-FirstMatch $appGr '(?m)^\s*compileSdk\s+(\d+)\s*$'
            TargetSdk     = Get-FirstMatch $appGr '(?m)^\s*targetSdk\s+(\d+)\s*$'
            MinSdk        = Get-FirstMatch $appGr '(?m)^\s*minSdk\s+(\d+)\s*$'
            ApplicationId = Get-FirstMatch $appGr 'applicationId\s+"([^"]+)"'
            DartSdk       = Get-FirstMatch $pubspec '(?ms)^environment:.*?\bsdk:\s*"([^"]+)"'
        }

        foreach ($k in @('Gradle', 'Agp', 'Kotlin', 'CompileSdk', 'TargetSdk', 'MinSdk')) {
            if (-not $perApp[$app][$k]) {
                Stop-Hard "Could not read '$k' for $app. The Gradle files moved; fix this script rather than guessing a value."
            }
        }
    }

    foreach ($k in @('Gradle', 'Agp', 'Kotlin', 'CompileSdk', 'TargetSdk', 'MinSdk')) {
        $p = $perApp['parent-app'][$k]
        $c = $perApp['child-app'][$k]
        if ($p -ne $c) {
            Stop-Hard ("apps/parent-app and apps/child-app disagree on ${k}: '$p' vs '$c'. " +
                       "One toolchain cannot satisfy both. Reconcile the Gradle files first.")
        }
        $pins[$k] = $p
    }
    $pins.ParentApplicationId = $perApp['parent-app'].ApplicationId
    $pins.ChildApplicationId  = $perApp['child-app'].ApplicationId
    $pins.DartSdk             = $perApp['parent-app'].DartSdk
    $pins.BuildTools          = "$($pins.CompileSdk).0.0"
    return $pins
}

# ===========================================================================
# SMALL UTILITIES
# ===========================================================================

function Test-Have([string]$Exe) {
    return [bool](Get-Command $Exe -ErrorAction SilentlyContinue)
}

function Get-ExeOutput {
    param([string]$Exe, [string[]]$CmdArgs)
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $out = & $Exe @CmdArgs 2>&1 | Out-String
        $ErrorActionPreference = $prev
        return $out
    } catch {
        return ''
    }
}

# Returns $true when $Got satisfies a Dart-style constraint ">=3.3.0 <4.0.0",
# $false when it does not, and $null when the constraint shape is not
# understood — in which case the caller ABSTAINS rather than claiming a pass.
function Test-SemverConstraint {
    param([string]$Got, [string]$Constraint)
    $lo = [regex]::Match($Constraint, '>=\s*([0-9]+\.[0-9]+\.[0-9]+)')
    $hi = [regex]::Match($Constraint, '<\s*([0-9]+\.[0-9]+\.[0-9]+)')
    if (-not $lo.Success) { return $null }
    try {
        $g = [version]$Got
        if ($g -lt [version]$lo.Groups[1].Value) { return $false }
        if ($hi.Success -and $g -ge [version]$hi.Groups[1].Value) { return $false }
        return $true
    } catch {
        return $null
    }
}

# ===========================================================================
# START
# ===========================================================================

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

Write-Head 'ABNY / «ابني» — release doctor'

$pins = Get-RepoPins -Root $RepoRoot

Write-Host "  repository : $RepoRoot"
Write-Host "  profile    : $Profile"
Write-Host "  pins read from the repository (never hardcoded here):"
Write-Host ("    Flutter {0} | JDK {1} | Gradle {2} | AGP {3} | Kotlin {4}" -f `
    $pins.Flutter, $pins.JavaMajor, $pins.Gradle, $pins.Agp, $pins.Kotlin)
Write-Host ("    compileSdk {0} | targetSdk {1} | minSdk {2} | Dart `"{3}`"" -f `
    $pins.CompileSdk, $pins.TargetSdk, $pins.MinSdk, $pins.DartSdk)
Write-Host ("    build-tools {0} (DERIVED from compileSdk — not declared by either app)" -f $pins.BuildTools)
Write-Host ''

# ---- 1. Flutter -----------------------------------------------------------
if (Test-Have 'flutter') {
    $raw = (Get-ExeOutput 'flutter' @('--version')) -split "`n" | Select-Object -First 1
    $m = [regex]::Match($raw, '^Flutter\s+([0-9][0-9.]*)')
    if (-not $m.Success) {
        Add-Row WARN 'Flutter version' "on PATH, version unparseable: $($raw.Trim())" `
            "Run 'flutter --version' by hand; this repository needs exactly $($pins.Flutter)."
    } elseif ($m.Groups[1].Value -eq $pins.Flutter) {
        Add-Row PASS 'Flutter version' "$($m.Groups[1].Value) (matches the pin)" ''
    } else {
        Add-Row BLOCKED 'Flutter version' "$($m.Groups[1].Value), repository pins $($pins.Flutter)" `
            ("Run 'flutter version $($pins.Flutter)' (or use fvm). Flutter 3.27+ defaults compileSdk to 35 and " +
             "AGP $($pins.Agp) refuses anything above $($pins.CompileSdk), so a build on the wrong SDK proves nothing about the pinned one.")
    }
} else {
    Add-Row BLOCKED 'Flutter version' "not installed (no 'flutter' on PATH)" `
        "Run 'powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1' — it installs Flutter $($pins.Flutter), JDK $($pins.JavaMajor) and the Android SDK this repository pins, then builds both apps."
}

# ---- 2. Dart --------------------------------------------------------------
if (Test-Have 'dart') {
    $raw = Get-ExeOutput 'dart' @('--version')
    $m = [regex]::Match($raw, 'version:\s*([0-9]+\.[0-9]+\.[0-9]+)')
    if (-not $m.Success) {
        Add-Row WARN 'Dart version' 'on PATH, version unparseable' `
            "Run 'dart --version'; the repository's constraint is `"$($pins.DartSdk)`"."
    } else {
        $got = $m.Groups[1].Value
        $sat = Test-SemverConstraint -Got $got -Constraint $pins.DartSdk
        if ($sat -eq $true) {
            Add-Row PASS 'Dart version' "$got (satisfies `"$($pins.DartSdk)`")" ''
        } elseif ($sat -eq $false) {
            Add-Row BLOCKED 'Dart version' "$got violates `"$($pins.DartSdk)`"" `
                "pubspec.yaml's environment.sdk is the constraint; 'flutter pub get' will refuse. Use the Dart bundled with Flutter $($pins.Flutter) rather than a standalone SDK."
        } else {
            Add-Row WARN 'Dart version' "$got, constraint `"$($pins.DartSdk)`" not machine-comparable" `
                'Compare by hand — this script abstains rather than claim a pass it cannot prove.'
        }
    }
} else {
    Add-Row BLOCKED 'Dart version' "not installed (no 'dart' on PATH)" `
        "Dart ships INSIDE Flutter — installing Flutter $($pins.Flutter) provides it at <flutter>\bin\dart.bat. Do not install a standalone Dart SDK; it can drift from the Flutter pin."
}

# ---- 3. Java --------------------------------------------------------------
if (Test-Have 'java') {
    $raw = Get-ExeOutput 'java' @('-version')
    $m = [regex]::Match($raw, 'version "([0-9]+)')
    if (-not $m.Success) {
        Add-Row WARN 'Java version' 'on PATH, version unparseable' `
            "Run 'java -version'; this repository needs JDK $($pins.JavaMajor)."
    } elseif ($m.Groups[1].Value -eq $pins.JavaMajor) {
        Add-Row PASS 'Java version' "JDK $($m.Groups[1].Value) (matches the pin)" ''
    } else {
        $javaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { '<unset>' }
        Add-Row BLOCKED 'Java version' "JDK $($m.Groups[1].Value), repository needs JDK $($pins.JavaMajor)" `
            ("gradle-wrapper.properties pins Gradle $($pins.Gradle), which only learned to RUN on JDK 21 in 8.5 — " +
             "on the wrong JDK the Android build dies with 'Unsupported class file major version' before compiling anything. " +
             "Install Temurin $($pins.JavaMajor) and set JAVA_HOME to it (current JAVA_HOME=$javaHome).")
    }
} else {
    Add-Row BLOCKED 'Java version' "not installed (no 'java' on PATH)" `
        "Install Temurin JDK $($pins.JavaMajor) and set JAVA_HOME. AGP $($pins.Agp) will not run without it."
}

# ---- 4. Android SDK / platform / build-tools ------------------------------
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $null }

if ($sdkRoot -and (Test-Path -LiteralPath $sdkRoot)) {
    Add-Row PASS 'Android SDK root' $sdkRoot ''

    $platformDir = Join-Path $sdkRoot "platforms\android-$($pins.CompileSdk)"
    if (Test-Path -LiteralPath $platformDir) {
        Add-Row PASS 'Android platform' "android-$($pins.CompileSdk) present" ''
    } else {
        $present = ''
        $platformsRoot = Join-Path $sdkRoot 'platforms'
        if (Test-Path -LiteralPath $platformsRoot) {
            $present = ((Get-ChildItem -LiteralPath $platformsRoot -Directory -ErrorAction SilentlyContinue).Name -join ' ')
        }
        if (-not $present) { $present = 'none' }
        Add-Row BLOCKED 'Android platform' "android-$($pins.CompileSdk) missing (present: $present)" `
            "Run: sdkmanager `"platforms;android-$($pins.CompileSdk)`". compileSdk $($pins.CompileSdk) comes from apps\*\android\app\build.gradle."
    }

    $btDir = Join-Path $sdkRoot "build-tools\$($pins.BuildTools)"
    if (Test-Path -LiteralPath $btDir) {
        Add-Row PASS 'Android build-tools' "$($pins.BuildTools) present (derived from compileSdk)" ''
    } else {
        $presentBt = ''
        $btRoot = Join-Path $sdkRoot 'build-tools'
        if (Test-Path -LiteralPath $btRoot) {
            $presentBt = ((Get-ChildItem -LiteralPath $btRoot -Directory -ErrorAction SilentlyContinue).Name -join ' ')
        }
        if ($presentBt) {
            Add-Row WARN 'Android build-tools' "$($pins.BuildTools) absent (present: $presentBt)" `
                ("Neither app declares buildToolsVersion, so AGP $($pins.Agp) picks its own default and one of the above may well satisfy it. " +
                 "Run 'sdkmanager `"build-tools;$($pins.BuildTools)`"' to match the derivation exactly.")
        } else {
            Add-Row BLOCKED 'Android build-tools' 'none installed' `
                "Run: sdkmanager `"build-tools;$($pins.BuildTools)`" (derived as compileSdk.0.0 — no buildToolsVersion is declared by either app)."
        }
    }
} else {
    Add-Row BLOCKED 'Android SDK root' 'ANDROID_HOME and ANDROID_SDK_ROOT are both unset or point nowhere' `
        "scripts\setup-windows-dev.ps1 installs the cmdline-tools, accepts the licences and installs platforms;android-$($pins.CompileSdk) and build-tools;$($pins.BuildTools) for you. Needs dl.google.com reachable."
    Add-Row BLOCKED 'Android platform'    "cannot check android-$($pins.CompileSdk) — no SDK root" 'Resolve the Android SDK root row first.'
    Add-Row BLOCKED 'Android build-tools' "cannot check $($pins.BuildTools) — no SDK root"          'Resolve the Android SDK root row first.'
}

# ---- 5. Gradle — the WRAPPER is the contract ------------------------------
$wrapperOk = $true
foreach ($app in @('parent-app', 'child-app')) {
    $jar = Join-Path $RepoRoot "apps\$app\android\gradle\wrapper\gradle-wrapper.jar"
    if (-not (Test-Path -LiteralPath $jar)) { $wrapperOk = $false }
}

$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $HOME '.gradle' }
$distCache = Join-Path $gradleHome 'wrapper\dists'
$distCached = $false
if (Test-Path -LiteralPath $distCache) {
    $distCached = [bool](Get-ChildItem -LiteralPath $distCache -Directory -Filter "gradle-$($pins.Gradle)-*" -ErrorAction SilentlyContinue)
}

if (-not $wrapperOk) {
    Add-Row BLOCKED 'Gradle wrapper' 'gradle-wrapper.jar missing in at least one app' `
        "Restore it from git ('git checkout -- apps/*/android/gradle/wrapper/'). Never regenerate it with a Gradle other than the pinned $($pins.Gradle)."
} elseif ($distCached) {
    Add-Row PASS "Gradle $($pins.Gradle)" 'wrapper present and distribution cached' ''
} else {
    $sysGradle = $null
    if (Test-Have 'gradle') {
        $gm = [regex]::Match((Get-ExeOutput 'gradle' @('--version')), 'Gradle\s+([0-9.]+)')
        if ($gm.Success) { $sysGradle = $gm.Groups[1].Value }
    }
    if ($sysGradle -and $sysGradle -ne $pins.Gradle) {
        Add-Row BLOCKED "Gradle $($pins.Gradle)" "distribution not cached; 'gradle' on PATH is $sysGradle" `
            ("The first .\gradlew run downloads gradle-$($pins.Gradle)-bin.zip from services.gradle.org — reachability required. " +
             "Do NOT substitute the $sysGradle on PATH: the wrapper pin is what AGP $($pins.Agp) was validated against.")
    } else {
        Add-Row BLOCKED "Gradle $($pins.Gradle)" "distribution not cached under $distCache" `
            "Run '.\gradlew --version' inside apps\<app>\android once with services.gradle.org reachable; the wrapper then caches gradle-$($pins.Gradle) for every later build."
    }
}

# ---- 6. git status --------------------------------------------------------
if (Test-Have 'git') {
    $inRepo = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'rev-parse', '--git-dir'))
    if ($LASTEXITCODE -eq 0 -and $inRepo -notmatch 'fatal') {
        $branch = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'branch', '--show-current')).Trim()
        $porcelain = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'status', '--porcelain')).Trim()
        $dirty = if ($porcelain) { ($porcelain -split "`n").Count } else { 0 }
        if ($dirty -eq 0) {
            Add-Row PASS 'git status' "clean on '$branch'" ''
        } else {
            Add-Row WARN 'git status' "$dirty uncommitted path(s) on '$branch'" `
                "A store artifact should be reproducible from a commit. Run 'git status --short', then commit or stash before building a release."
        }
    } else {
        Add-Row WARN 'git status' 'not a git working tree' 'Build from a checkout, so the artifact can be traced to a commit.'
    }
} else {
    Add-Row WARN 'git status' "git not on PATH" 'Install Git for Windows so the artifact can be traced to a commit.'
}

# ---- 7. pubspec.lock -----------------------------------------------------
foreach ($app in @('parent-app', 'child-app')) {
    $lock = Join-Path $RepoRoot "apps\$app\pubspec.lock"
    if (Test-Path -LiteralPath $lock) {
        $pkgCount = ([regex]::Matches((Get-Content -LiteralPath $lock -Raw), '(?m)^  [a-z0-9_]+:$')).Count
        Add-Row PASS "pubspec.lock ($app)" "present, $pkgCount packages" ''
    } else {
        Add-Row BLOCKED "pubspec.lock ($app)" 'absent' `
            ("Run 'flutter pub get' in apps\$app (needs pub.dev reachable). Until this file exists and is committed, " +
             'two builds of the same commit can resolve DIFFERENT dependency versions, so no artifact is reproducible.')
    }
}

# ---- 8. Firebase configuration -------------------------------------------
foreach ($app in @('parent-app', 'child-app')) {
    $gs = Join-Path $RepoRoot "apps\$app\android\app\google-services.json"
    $expectId = if ($app -eq 'parent-app') { $pins.ParentApplicationId } else { $pins.ChildApplicationId }
    if (Test-Path -LiteralPath $gs) {
        if ((Get-Content -LiteralPath $gs -Raw) -match [regex]::Escape($expectId)) {
            Add-Row PASS "Firebase config ($app)" "google-services.json present for $expectId" ''
        } else {
            Add-Row BLOCKED "Firebase config ($app)" "google-services.json does NOT mention $expectId" `
                "This file belongs to a different Android app. FCM registration will fail at runtime with a mismatched sender. Re-download it for applicationId $expectId."
        }
    } elseif ($Profile -eq 'release') {
        Add-Row BLOCKED "Firebase config ($app)" 'google-services.json absent' `
            ("See docs\release\FIREBASE_SETUP.md: create the Firebase Android app for $expectId and place google-services.json at apps\$app\android\app\. " +
             'The build SUCCEEDS without it (abny.firebase=auto only warns) but the artifact has no push notifications at all — ' +
             'a store release in that state ships an invisible notification engine.')
    } else {
        Add-Row WARN "Firebase config ($app)" 'google-services.json absent (debug profile)' `
            'Debug builds proceed: abny.firebase=auto only warns, and PushRegistrationService catches the init failure. No push notification can be delivered by this artifact.'
    }
}

$firebaseOptions = Join-Path $RepoRoot 'apps\parent-app\lib\firebase_options.dart'
if (Test-Path -LiteralPath $firebaseOptions) {
    Add-Row PASS 'firebase_options.dart' 'present (parent-app)' ''
} elseif ($Profile -eq 'release') {
    Add-Row BLOCKED 'firebase_options.dart' 'absent (parent-app)' `
        "Only 'flutterfire configure' can generate it, against a real Firebase project. Without it Firebase.initializeApp() throws, PushRegistrationService returns early, and no FCM token is ever registered."
} else {
    Add-Row WARN 'firebase_options.dart' 'absent (parent-app)' `
        "Debug builds proceed; push stays unavailable. Generate with 'flutterfire configure' when a Firebase project exists."
}

# ---- 9. Signing configuration --------------------------------------------
foreach ($app in @('parent-app', 'child-app')) {
    $keyProps = Join-Path $RepoRoot "apps\$app\android\key.properties"
    if (Test-Path -LiteralPath $keyProps) {
        $text = Get-Content -LiteralPath $keyProps -Raw
        $missing = @()
        foreach ($k in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
            if ($text -notmatch "(?m)^\s*$k\s*=") { $missing += $k }
        }
        if ($missing.Count -gt 0) {
            Add-Row BLOCKED "Signing ($app)" "key.properties present but missing: $($missing -join ' ')" `
                "app\build.gradle fails the release build unless all four of storeFile, storePassword, keyAlias, keyPassword are set. Add them to apps\$app\android\key.properties."
        } else {
            $storeRel = [regex]::Match($text, '(?m)^\s*storeFile\s*=\s*(.+)$').Groups[1].Value.Trim()
            $storeAbs = Join-Path (Join-Path $RepoRoot "apps\$app\android") $storeRel
            if ((Test-Path -LiteralPath $storeRel) -or (Test-Path -LiteralPath $storeAbs)) {
                Add-Row PASS "Signing ($app)" 'key.properties complete, keystore found' ''
            } else {
                Add-Row BLOCKED "Signing ($app)" "keystore not found at '$storeRel'" `
                    "storeFile resolves relative to apps\$app\android\. Place the .jks there or correct the path; the release build refuses to fall back to the debug key (verified by scripts\verify_release_signing.py)."
            }
        }
    } elseif ($Profile -eq 'release') {
        Add-Row BLOCKED "Signing ($app)" 'android\key.properties absent' `
            ("No release keystore = no store artifact. Create it ('keytool -genkeypair -v -keystore abny-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias abny'), " +
             "place it under apps\$app\android\, and write the four properties into apps\$app\android\key.properties (git-ignored). Debug builds are unaffected.")
    } else {
        Add-Row WARN "Signing ($app)" 'android\key.properties absent (debug profile)' `
            'Debug builds use the debug key and are unaffected. A release build will refuse.'
    }
}

# ---- 10. Package IDs -----------------------------------------------------
if ($pins.ParentApplicationId -eq $pins.ChildApplicationId) {
    Add-Row BLOCKED 'Package IDs' "both apps declare $($pins.ParentApplicationId)" `
        'Two apps cannot share an applicationId — the second install replaces the first. Fix apps\*\android\app\build.gradle.'
} else {
    Add-Row PASS 'Package IDs' "parent=$($pins.ParentApplicationId) child=$($pins.ChildApplicationId)" ''
}

# ---- 11. Required permissions -------------------------------------------
foreach ($app in @('parent-app', 'child-app')) {
    $manifest = Join-Path $RepoRoot "apps\$app\android\app\src\main\AndroidManifest.xml"
    if (-not (Test-Path -LiteralPath $manifest)) {
        Add-Row BLOCKED "Permissions ($app)" 'AndroidManifest.xml not found' `
            "Expected at apps\$app\android\app\src\main\AndroidManifest.xml."
        continue
    }
    $text = Get-Content -LiteralPath $manifest -Raw
    $permCount = ([regex]::Matches($text, '<uses-permission\s')).Count
    $hasInternet = $text -match 'android\.permission\.INTERNET'
    $hasPostNotif = $text -match 'android\.permission\.POST_NOTIFICATIONS'
    if ($hasInternet -and $hasPostNotif) {
        Add-Row PASS "Permissions ($app)" "$permCount declared, incl. INTERNET + POST_NOTIFICATIONS" ''
    } else {
        $missing = @()
        if (-not $hasInternet)  { $missing += 'INTERNET' }
        if (-not $hasPostNotif) { $missing += 'POST_NOTIFICATIONS' }
        Add-Row BLOCKED "Permissions ($app)" "$permCount declared, missing: $($missing -join ' ')" `
            "Add the <uses-permission> element(s) to $manifest. Without INTERNET the app reaches no backend; without POST_NOTIFICATIONS nothing this app posts is visible on Android 13+."
    }
}

# A DECLARED notification permission that is never REQUESTED is the exact
# defect G18 fixed, and it is invisible to every other check in this file.
$notifChecker = Join-Path $PSScriptRoot 'verify_notification_permission.py'
if ((Test-Path -LiteralPath $notifChecker) -and (Test-Have 'python3')) {
    $null = Get-ExeOutput 'python3' @($notifChecker)
    if ($LASTEXITCODE -eq 0) {
        Add-Row PASS 'POST_NOTIFICATIONS request' 'every declaring app also requests it at runtime' ''
    } else {
        Add-Row BLOCKED 'POST_NOTIFICATIONS request' 'declared but never requested in at least one app' `
            "Run 'python3 scripts\verify_notification_permission.py' for the per-app detail. On Android 13+ an unrequested POST_NOTIFICATIONS means notifications silently never appear."
    }
} elseif (-not (Test-Path -LiteralPath $notifChecker)) {
    Add-Row WARN 'POST_NOTIFICATIONS request' 'checker scripts\verify_notification_permission.py not found' `
        'Restore it: it is the only check that catches a permission declared in the manifest but never requested at runtime.'
} else {
    Add-Row WARN 'POST_NOTIFICATIONS request' 'python3 not available to run the checker' `
        "Install Python 3, then run 'python3 scripts\verify_notification_permission.py'."
}

# ===========================================================================
# VERDICT
# ===========================================================================
Write-Head 'VERDICT'
Write-Host ("  PASS {0}   WARN {1}   BLOCKED {2}" -f $script:NPass, $script:NWarn, $script:NBlocked)
Write-Host ''

if ($script:NBlocked -gt 0) {
    Write-Host "  BLOCKED — this machine cannot produce a trustworthy $Profile artifact yet." -ForegroundColor Red
    Write-Host '  The blocking rows, in the order worth fixing:'
    foreach ($r in $script:Rows) {
        if ($r.Status -eq 'BLOCKED') { Write-Host ("    - {0}: {1}" -f $r.Check, $r.Measured) }
    }
    Write-Host ''
    Write-Host '  Nothing was installed, downloaded or modified by this run.'
    exit 1
}

if ($script:NWarn -gt 0) {
    Write-Host "  PASS WITH WARNINGS — a $Profile build can be attempted; the WARN rows above are real gaps." -ForegroundColor Yellow
} else {
    Write-Host "  PASS — every checked requirement for a $Profile artifact is met." -ForegroundColor Green
}
exit 0
