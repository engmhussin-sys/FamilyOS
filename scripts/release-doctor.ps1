#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — THE SINGLE BUILD GATE, Windows half. Read-only.

.DESCRIPTION
    The PowerShell twin of `scripts/release-doctor.sh`, check for check, and
    carrying the IDENTICAL policy table, so the two halves cannot disagree
    about what blocks. Answers one question — "can this machine produce the
    artifact, and if not, what exactly do I type next?" — without building,
    downloading, installing or modifying anything.

      PASS     met AND MEASURED. A check may only print PASS when something
               was actually observed to be correct.
      WARN     a real gap that still permits a build attempt, or a requirement
               this run could not measure and refuses to claim.
      BLOCKED  the build cannot start, or can only produce a false green.

    THE CLASSIFICATION IS DATA, NOT SCATTERED `if` BRANCHES. Every check has an
    id in $CheckPolicy below — printed as a table at the top of every run — and
    that table decides whether a failure is BLOCKED (required) or WARN
    (advisory). `Add-FailRow <id> ...` is the only way a failure is graded.

    THE TERMINAL LINE. If any check is BLOCKED, the LAST LINE this script
    prints is the unindented literal token meaning "do not ship", and the exit
    code is 1. It is printed in exactly one place.

    NO FALSE POSITIVES — THE RULE THIS FILE IS BUILT AROUND. A check that
    "passes" because a command was missing, an environment variable was unset,
    a file was unreadable or a regex found nothing is a FALSE PASS, and worse
    than no check. This repository already shipped one: an earlier doctor
    checked `android\key.properties` while both apps' android/app/build.gradle
    read `signing.properties`, so it was green on a machine whose release build
    then stopped in the Gradle task-graph guard. Under
    `Set-StrictMode -Version Latest` there is a second flavour of the same
    defect — reading an unset variable THROWS instead of reporting — and every
    such read here goes through a guarded accessor.

    EVERY EXPECTED VALUE IS READ OUT OF THIS REPOSITORY AT RUN TIME by
    `Get-RepoPins` below, which parses the same files with the same patterns as
    `Get-RepoPins` in scripts/setup-windows-dev.ps1 and `read_pins` in
    scripts/lib/repo-pins.sh:

      Flutter SDK      .github/workflows/build-apk.yml   env.FLUTTER_VERSION
      JDK major        .github/workflows/build-apk.yml   env.JAVA_VERSION
      Gradle           apps/*/android/gradle/wrapper/gradle-wrapper.properties
      AGP / Kotlin     apps/*/android/settings.gradle
      compileSdk / targetSdk / minSdk / namespace / applicationId
                       apps/*/android/app/build.gradle
      Dart constraint  apps/*/pubspec.yaml               environment.sdk
      App version      apps/*/pubspec.yaml               version: <name>+<code>
      Debug API URL    apps/*/lib/core/config/app_config.dart
      Signing shape    apps/*/android/signing.properties.example
      Firebase need    apps/*/pubspec.yaml + settings.gradle + app/build.gradle
      Deep-link scheme apps/backend/src/modules/notifications/domain/engine/
                       notification-destination.ts       DEEP_LINK_SCHEME

    The two apps are parsed independently and COMPARED; a disagreement on a
    shared toolchain pin is a hard stop, not a pick-one.

    build-tools is NOT declared by either app. It is DERIVED as
    "<compileSdk>.0.0" and the derivation is printed so it can be challenged.

    IT MUST COVER EVERY PRECONDITION `scripts\mobile-build.ps1` DEPENDS ON:
    `flutter pub get` (pub.dev), `flutter analyze`, `flutter test`,
    `flutter build apk --debug` (JDK + Android SDK + Gradle wrapper + platform
    + build-tools) and, with -Release, the signing material, the Firebase
    config of the app that declares it, and an https API_BASE_URL supplied
    through RELEASE_API_BASE_URL / -ApiBaseUrl. If the build would fail on
    something this doctor passed, that is the defect to close.

.PARAMETER Profile
    release (default) grades readiness for a SIGNED store artifact, so signing
    material, Firebase configuration, the lockfiles and the release API URL are
    graded as required.
    debug grades readiness for `flutter build apk --debug` — WHICH NEEDS NO
    KEYSTORE AND NO FIREBASE — so those are advisory in that profile.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of the folder holding this script.

.PARAMETER NoNetwork
    Skip the two outbound probes (pub.dev, services.gradle.org) and grade them
    NOT VERIFIED / WARN. It does NOT turn them into a PASS.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1

.EXAMPLE
    .\scripts\release-doctor.ps1 -Profile debug

.NOTES
    STATUS: STATIC VERIFIED / CODE REVIEWED. NEVER EXECUTED. NOT BUILD VERIFIED.

    The authoring environment has no PowerShell at all (`pwsh` and `powershell`
    are both absent), no Flutter, no Dart, no Android SDK and no adb. Every
    claim here was checked BY READING against the files named above — both
    pubspec.yaml, both android/app/build.gradle, both android/build.gradle,
    both settings.gradle, both gradle-wrapper.properties, both
    AndroidManifest.xml, both android/.gitignore, both
    signing.properties.example, both app_config.dart, apps/backend/.env.example
    and .github/workflows/build-apk.yml. That is STATIC VERIFIED; it is not a
    run, and no row that reports on a toolchain has ever been observed printing
    PASS.

    Its bash twin HAS been executed in the authoring container and its policy
    table, its row set and its terminal verdict token are identical to this
    file's by construction.
#>

[CmdletBinding()]
param(
    [ValidateSet('release', 'debug')]
    [string] $Profile = 'release',
    [string] $RepoRoot,
    [switch] $NoNetwork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ===========================================================================
# THE CHECK POLICY TABLE — the whole classification, in one place, and byte
# for byte the same set of ids and policies as CHECK_POLICY in
# scripts/release-doctor.sh.
#
#   required          a failure is BLOCKED in every profile.
#   release-required  BLOCKED under -Profile release, WARN under -Profile
#                     debug, because the DEBUG APK genuinely does not need it.
#   advisory          WARN in every profile. A WARN NEVER BLOCKS.
#
# The `*-unverifiable` ids are the honest half of the no-false-positives rule:
# they cover "this machine cannot run the checker", which is neither a pass nor
# a proof of failure. They print WARN with the words NOT VERIFIED, never PASS.
# ===========================================================================
$script:CheckPolicy = @(
    @{ Id = 'flutter';               Policy = 'required';         What = 'Flutter SDK on PATH and equal to the pinned version' }
    @{ Id = 'dart';                  Policy = 'required';         What = 'Dart SDK on PATH and inside pubspec environment.sdk' }
    @{ Id = 'java';                  Policy = 'required';         What = 'JDK on PATH and equal to the pinned major version' }
    @{ Id = 'java-home';             Policy = 'required';         What = 'JAVA_HOME set and pointing at a JDK that contains bin/java' }
    @{ Id = 'android-sdk';           Policy = 'required';         What = 'ANDROID_HOME or ANDROID_SDK_ROOT set and a real SDK root' }
    @{ Id = 'android-platform';      Policy = 'required';         What = 'platforms;android-<compileSdk> installed' }
    @{ Id = 'android-buildtools';    Policy = 'required';         What = 'at least one build-tools package installed' }
    @{ Id = 'buildtools-exact';      Policy = 'advisory';         What = 'build-tools <compileSdk>.0.0 exactly (none is declared)' }
    @{ Id = 'adb';                   Policy = 'advisory';         What = 'adb on PATH - needed to INSTALL an APK, not to BUILD one' }
    @{ Id = 'gradle-wrapper';        Policy = 'required';         What = 'gradle-wrapper.jar committed in both apps' }
    @{ Id = 'gradle-dist';           Policy = 'required';         What = 'the pinned Gradle is cached, or services.gradle.org answers' }
    @{ Id = 'gradle-agp-sdk';        Policy = 'required';         What = 'compileSdk is inside this AGP version ceiling' }
    @{ Id = 'sdk-levels';            Policy = 'required';         What = 'minSdk <= targetSdk <= compileSdk' }
    @{ Id = 'pub-access';            Policy = 'required';         What = 'pub.dev answers - flutter pub get is mobile-build stage 1' }
    @{ Id = 'pubspec-lock';          Policy = 'release-required'; What = 'pubspec.lock committed for both apps' }
    @{ Id = 'packages';              Policy = 'required';         What = 'every package: import is declared in the owning pubspec' }
    @{ Id = 'packages-unverifiable'; Policy = 'advisory';         What = 'the import checker could not be run on this machine' }
    @{ Id = 'firebase-config';       Policy = 'release-required'; What = 'google-services.json for each app that declares Firebase' }
    @{ Id = 'firebase-options';      Policy = 'release-required'; What = 'apps/parent-app/lib/firebase_options.dart exists' }
    @{ Id = 'signing';               Policy = 'release-required'; What = 'signing.properties complete and naming a real non-debug keystore' }
    @{ Id = 'signing-template';      Policy = 'advisory';         What = 'signing.properties.example present (source of the keytool line)' }
    @{ Id = 'signing-gitignore';     Policy = 'required';         What = 'signing.properties and *.jks are gitignored' }
    @{ Id = 'app-version';           Policy = 'required';         What = 'pubspec version is <name>+<code>' }
    @{ Id = 'package-ids';           Policy = 'required';         What = 'the two apps declare different applicationIds' }
    @{ Id = 'application-ids';       Policy = 'required';         What = 'namespace equals applicationId and is a legal package name' }
    @{ Id = 'api-base-url';          Policy = 'release-required'; What = 'an https API_BASE_URL exists for the release build' }
    @{ Id = 'permissions';           Policy = 'required';         What = 'INTERNET and POST_NOTIFICATIONS declared in both manifests' }
    @{ Id = 'notif-request';         Policy = 'required';         What = 'POST_NOTIFICATIONS is also requested at runtime' }
    @{ Id = 'notif-unverifiable';    Policy = 'advisory';         What = 'the notification checker could not be run on this machine' }
    @{ Id = 'deep-link';             Policy = 'advisory';         What = 'the abny:// intent-filter is present in both manifests' }
    @{ Id = 'git-clean';             Policy = 'advisory';         What = 'the working tree is clean, so the artifact traces to a commit' }
)

# Effective severity of a failure of $Id under the current profile.
# An UNKNOWN id returns 'BLOCKED': a check whose severity is undefined is a bug
# in this script, and a bug is never allowed to become a PASS.
function Get-FailSeverity {
    param([string] $Id)
    $entry = $script:CheckPolicy | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if ($null -eq $entry) { return 'BLOCKED' }
    switch ($entry.Policy) {
        'required'         { return 'BLOCKED' }
        'advisory'         { return 'WARN' }
        'release-required' { if ($Profile -eq 'release') { return 'BLOCKED' } else { return 'WARN' } }
        default            { return 'BLOCKED' }
    }
}

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
    Write-Host ("{0,-28} {1}" -f $Check, $Measured)
    if ($Action -and $Status -ne 'PASS') {
        Write-Host ("           -> " + $Action) -ForegroundColor DarkGray
    }
}

# THE ONLY WAY A FAILURE IS GRADED.
function Add-FailRow {
    param(
        [string] $Id,
        [string] $Check,
        [string] $Measured,
        [string] $Action
    )
    $sev = Get-FailSeverity -Id $Id
    $known = $script:CheckPolicy | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if ($null -eq $known) {
        Add-Row BLOCKED $Check ("release-doctor BUG: no policy row for id '$Id' - " + $Measured) `
            ("Add '$Id' to `$script:CheckPolicy in this file. A check whose severity is undefined cannot be a PASS.")
        return
    }
    Add-Row $sev $Check $Measured $Action
}

function Stop-Hard([string]$Message) {
    Write-Host ''
    Write-Host "  release-doctor FATAL: $Message" -ForegroundColor Red
    Write-Host ''
    exit 2
}

# ===========================================================================
# PIN PARSING — same sources, same patterns as setup-windows-dev.ps1 and
# scripts/lib/repo-pins.sh
# ===========================================================================

function Get-FirstMatch {
    param([string]$Path, [string]$Pattern, [int]$Group = 1)
    if (-not $Path) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    # Get-Content -Raw on a ZERO-BYTE file returns $null, and [regex]::Match
    # against $null throws under $ErrorActionPreference = 'Stop' — the doctor
    # dying of an empty file instead of reporting it.
    if ($null -eq $text) { return $null }
    $m = [regex]::Match($text, $Pattern)
    if (-not $m.Success) { return $null }
    return $m.Groups[$Group].Value.Trim()
}

function Get-FileText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $t = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ($null -eq $t) { return '' }
    return $t
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
        $config   = Join-Path $a 'lib\core\config\app_config.dart'

        $perApp[$app] = [ordered]@{
            Gradle        = Get-FirstMatch $wrapper 'gradle-([0-9.]+)-(?:bin|all)\.zip'
            Agp           = Get-FirstMatch $settings 'id\s+"com\.android\.application"\s+version\s+"([^"]+)"'
            Kotlin        = Get-FirstMatch $settings 'id\s+"org\.jetbrains\.kotlin\.android"\s+version\s+"([^"]+)"'
            CompileSdk    = Get-FirstMatch $appGr '(?m)^\s*compileSdk\s+(\d+)\s*$'
            TargetSdk     = Get-FirstMatch $appGr '(?m)^\s*targetSdk\s+(\d+)\s*$'
            MinSdk        = Get-FirstMatch $appGr '(?m)^\s*minSdk\s+(\d+)\s*$'
            Namespace     = Get-FirstMatch $appGr 'namespace\s+"([^"]+)"'
            ApplicationId = Get-FirstMatch $appGr 'applicationId\s+"([^"]+)"'
            DartSdk       = Get-FirstMatch $pubspec '(?ms)^environment:.*?\bsdk:\s*"([^"]+)"'
            DebugApiUrl   = Get-FirstMatch $config  "debugDefaultApiBaseUrl\s*=\s*'([^']+)'"
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
    $pins.ParentNamespace     = $perApp['parent-app'].Namespace
    $pins.ChildNamespace      = $perApp['child-app'].Namespace
    $pins.DartSdk             = $perApp['parent-app'].DartSdk
    $pins.DebugApiUrl         = $perApp['parent-app'].DebugApiUrl
    $pins.BuildTools          = "$($pins.CompileSdk).0.0"
    return $pins
}

# ===========================================================================
# SMALL UTILITIES
# ===========================================================================

function Test-Have([string]$Exe) {
    return [bool](Get-Command $Exe -ErrorAction SilentlyContinue)
}

# The exit code of the LAST command Get-ExeOutput ran.
#
# A script variable and not `$LASTEXITCODE`, for a reason that bit this file.
# `$LASTEXITCODE` is an AUTOMATIC variable that DOES NOT EXIST until some
# native command has run in the session, and `Set-StrictMode -Version Latest`
# makes reading an unset variable a TERMINATING error under
# `$ErrorActionPreference = 'Stop'`. On the machine this script exists for — a
# fresh Windows box with no flutter, no dart and no java on PATH — none of the
# rows above it would have run a native command, so the first `$LASTEXITCODE`
# read killed the doctor with a PowerShell error instead of printing the
# BLOCKED rows it exists to print. Initialised here; set by every call.
$script:LastExeExit = 0

function Get-ExeOutput {
    param([string]$Exe, [string[]]$CmdArgs)
    $script:LastExeExit = 0
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $out = & $Exe @CmdArgs 2>&1 | Out-String
        if ($null -ne $global:LASTEXITCODE) { $script:LastExeExit = $global:LASTEXITCODE }
        $ErrorActionPreference = $prev
        if ($null -eq $out) { return '' }
        return $out
    } catch {
        $script:LastExeExit = 1
        return ''
    }
}

# Test-HttpProbe: 'ok' answered, 'no' did not answer, 'unverified' not attempted.
# 'unverified' is NEVER turned into a PASS by any caller.
function Test-HttpProbe {
    param([string] $Url)
    if ($NoNetwork) { return 'unverified' }
    try {
        # PowerShell 5.1 on an unpatched Windows still defaults to TLS 1.0,
        # which pub.dev and services.gradle.org both refuse. Without this the
        # probe fails for a reason that has nothing to do with reachability.
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
    } catch {
        # An old .NET without Tls12 in the enum. Not fatal; the request below
        # still gets its own answer.
    }
    try {
        $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15 -Method Head -ErrorAction Stop
        return 'ok'
    } catch {
        # A HEAD that a server refuses is not the same as unreachable, so one
        # GET retry before concluding.
        try {
            $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
            return 'ok'
        } catch {
            return 'no'
        }
    }
}

# Reads an app's own Firebase posture OUT OF THE REPOSITORY instead of assuming
# both apps have one.
#
# WHAT THIS ROW USED TO GET WRONG. It demanded google-services.json for BOTH
# apps and graded a missing one BLOCKED under -Profile release. apps/child-app
# declares no firebase_core and no firebase_messaging in pubspec.yaml, its
# android/settings.gradle does not carry the `com.google.gms.google-services`
# plugin, and its app/build.gradle never applies it — so no build of the child
# app has ever read that file, and blocking a release on it was a manufactured
# requirement in the one script whose whole job is to name real ones.
#
# RETURNS 'yes' / 'no' / 'unknown'. 'unknown' is a SEPARATE answer, and it is
# the fix for a real false pass: when the three files were simply MISSING the
# previous version returned "no Firebase", the requirement was waived, and the
# row printed PASS — a green row produced by three files that were not there.
function Get-AppFirebasePosture {
    param([string]$Root, [string]$App)
    $pubspec  = Join-Path $Root "apps\$App\pubspec.yaml"
    $settings = Join-Path $Root "apps\$App\android\settings.gradle"
    $appGr    = Join-Path $Root "apps\$App\android\app\build.gradle"
    foreach ($p in @($pubspec, $settings, $appGr)) {
        if (-not (Test-Path -LiteralPath $p)) { return 'unknown' }
    }
    # EVERY PATTERN CARRIES A CAPTURE GROUP ON PURPOSE. `Get-FirstMatch`
    # returns `$m.Groups[1].Value`, which on a group-less pattern is the EMPTY
    # STRING even when the pattern matched — so a group-less test here would
    # read as "no Firebase" on an app that has it.
    $dep = Get-FirstMatch $pubspec  '(?m)^\s*(firebase_messaging|firebase_core)\s*:'
    $plg = Get-FirstMatch $settings '(id\s+"com\.google\.gms\.google-services")'
    $apl = Get-FirstMatch $appGr    '(?m)^\s*(apply\s+plugin:\s*"com\.google\.gms\.google-services")'
    if ($dep -or $plg -or $apl) { return 'yes' }
    return 'no'
}

# $true when $Got satisfies a Dart-style constraint ">=3.3.0 <4.0.0", $false
# when it does not, $null when the constraint shape is not understood — and the
# caller then BLOCKS, because an unreadable constraint means the REPOSITORY
# half of the comparison was never measured either.
function Test-SemverConstraint {
    param([string]$Got, [string]$Constraint)
    if (-not $Constraint) { return $null }
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

# The keystore filename and alias for an app's ACTION LINES, taken from the
# COMMITTED template rather than invented here. The fallbacks cover both "the
# template is gone" and "its storeFile/keyAlias line was edited away": a
# keytool command with an empty -keystore is worse than no command at all.
function Get-KeytoolCommand {
    param([string]$Root, [string]$App)
    $example  = Join-Path $Root "apps\$App\android\signing.properties.example"
    $keystore = Get-FirstMatch $example '(?m)^\s*storeFile\s*=\s*(.+)$'
    $alias    = Get-FirstMatch $example '(?m)^\s*keyAlias\s*=\s*(.+)$'
    $short    = $App -replace '-app$', ''
    if (-not $keystore) { $keystore = "abny-$short-upload.jks" }
    if (-not $alias)    { $alias    = "abny-$short-upload" }
    return ("keytool -genkeypair -v -keystore $keystore -alias $alias " +
            '-keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12')
}

# ===========================================================================
# START
# ===========================================================================

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

Write-Head 'ABNY / «ابني» — release doctor (the build gate)'

$pins = Get-RepoPins -Root $RepoRoot
$apps = @('parent-app', 'child-app')

Write-Host "  repository : $RepoRoot"
Write-Host "  profile    : $Profile"
Write-Host "  pins read from the repository (never hardcoded here):"
Write-Host ("    Flutter {0} | JDK {1} | Gradle {2} | AGP {3} | Kotlin {4}" -f `
    $pins.Flutter, $pins.JavaMajor, $pins.Gradle, $pins.Agp, $pins.Kotlin)
$dartShown = if ($pins.DartSdk) { $pins.DartSdk } else { '<unreadable>' }
Write-Host ("    compileSdk {0} | targetSdk {1} | minSdk {2} | Dart `"{3}`"" -f `
    $pins.CompileSdk, $pins.TargetSdk, $pins.MinSdk, $dartShown)
Write-Host ("    build-tools {0} (DERIVED from compileSdk — not declared by either app)" -f $pins.BuildTools)
Write-Host ''
Write-Host ("  CHECK POLICY — what blocks, and what only warns (profile: {0})" -f $Profile)
Write-Host ('  {0,-24} {1,-9} {2}' -f 'CHECK', 'ON FAIL', 'WHAT IT PROVES')
Write-Host ('  {0,-24} {1,-9} {2}' -f '-----', '-------', '---------------')
foreach ($c in $script:CheckPolicy) {
    Write-Host ('  {0,-24} {1,-9} {2}' -f $c.Id, (Get-FailSeverity -Id $c.Id), $c.What)
}
Write-Host ''

# ---- 1. Flutter -----------------------------------------------------------
#
# FAILURE MODES, ALL THREE GRADED: absent, present-but-unmeasurable, and
# present-but-different. None of them is a PASS.
if (Test-Have 'flutter') {
    $raw = ((Get-ExeOutput 'flutter' @('--version')) -split "`n" | Select-Object -First 1)
    if ($null -eq $raw) { $raw = '' }
    $m = [regex]::Match($raw, '^Flutter\s+([0-9][0-9.]*)')
    if (-not $m.Success) {
        Add-FailRow flutter 'Flutter version' "on PATH but UNMEASURABLE: $($raw.Trim())" `
            "Run 'flutter --version' by hand. This repository pins exactly $($pins.Flutter) (.github\workflows\build-apk.yml env.FLUTTER_VERSION). This row will not pass a Flutter it could not measure."
    } elseif ($m.Groups[1].Value -eq $pins.Flutter) {
        Add-Row PASS 'Flutter version' "$($m.Groups[1].Value) (matches the pin)" ''
    } else {
        Add-FailRow flutter 'Flutter version' "$($m.Groups[1].Value), repository pins $($pins.Flutter)" `
            ("Run 'flutter version $($pins.Flutter)' (or use fvm). Flutter 3.27+ defaults compileSdk to 35 and " +
             "AGP $($pins.Agp) refuses anything above $($pins.CompileSdk), so a build on the wrong SDK proves nothing about the pinned one.")
    }
} else {
    Add-FailRow flutter 'Flutter version' "not installed (no 'flutter' on PATH)" `
        "Run 'powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1' — it installs Flutter $($pins.Flutter), JDK $($pins.JavaMajor) and the Android SDK this repository pins."
}

# ---- 2. Dart --------------------------------------------------------------
if (Test-Have 'dart') {
    $raw = Get-ExeOutput 'dart' @('--version')
    $m = [regex]::Match($raw, 'version:\s*([0-9]+\.[0-9]+\.[0-9]+)')
    if (-not $m.Success) {
        Add-FailRow dart 'Dart version' 'on PATH but UNMEASURABLE' `
            "Run 'dart --version'; the repository's constraint is `"$dartShown`" (apps\*\pubspec.yaml environment.sdk)."
    } else {
        $got = $m.Groups[1].Value
        $sat = Test-SemverConstraint -Got $got -Constraint $pins.DartSdk
        if ($sat -eq $true) {
            Add-Row PASS 'Dart version' "$got (satisfies `"$($pins.DartSdk)`")" ''
        } elseif ($sat -eq $false) {
            Add-FailRow dart 'Dart version' "$got violates `"$($pins.DartSdk)`"" `
                "pubspec.yaml's environment.sdk is the constraint; 'flutter pub get' will refuse. Use the Dart bundled with Flutter $($pins.Flutter) rather than a standalone SDK."
        } else {
            # WAS A WARN. An unreadable constraint means nothing was compared.
            Add-FailRow dart 'Dart version' "$got, but the pubspec constraint `"$dartShown`" could not be parsed" `
                'Read apps\parent-app\pubspec.yaml environment.sdk and compare by hand, then fix Get-RepoPins in this file. Nothing was verified by this row.'
        }
    }
} else {
    Add-FailRow dart 'Dart version' "not installed (no 'dart' on PATH)" `
        "Dart ships INSIDE Flutter — installing Flutter $($pins.Flutter) provides it at <flutter>\bin\dart.bat. Do not install a standalone Dart SDK; it can drift from the Flutter pin."
}

# ---- 3. Java, and 3b. JAVA_HOME -------------------------------------------
#
# JAVA_HOME IS ITS OWN ROW because Gradle does not use `java` from PATH when
# JAVA_HOME is set — it uses JAVA_HOME. A machine with JDK 17 on PATH and
# JAVA_HOME pointing at JDK 21 builds with 21 and dies with "Unsupported class
# file major version". The old doctor only ever read PATH.
if (Test-Have 'java') {
    $raw = Get-ExeOutput 'java' @('-version')
    $m = [regex]::Match($raw, 'version "([0-9]+)')
    if (-not $m.Success) {
        Add-FailRow java 'Java version' 'on PATH but UNMEASURABLE' `
            "Run 'java -version'; this repository needs JDK $($pins.JavaMajor) (.github\workflows\build-apk.yml env.JAVA_VERSION)."
    } elseif ($m.Groups[1].Value -eq $pins.JavaMajor) {
        Add-Row PASS 'Java version' "JDK $($m.Groups[1].Value) (matches the pin)" ''
    } else {
        $javaHomeShown = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { '<unset>' }
        Add-FailRow java 'Java version' "JDK $($m.Groups[1].Value), repository needs JDK $($pins.JavaMajor)" `
            ("gradle-wrapper.properties pins Gradle $($pins.Gradle), which only learned to RUN on JDK 21 in 8.5 — " +
             "on the wrong JDK the Android build dies with 'Unsupported class file major version' before compiling anything. " +
             "Install Temurin $($pins.JavaMajor) and set JAVA_HOME to it (current JAVA_HOME=$javaHomeShown).")
    }
} else {
    Add-FailRow java 'Java version' "not installed (no 'java' on PATH)" `
        "Install Temurin JDK $($pins.JavaMajor) and set JAVA_HOME. AGP $($pins.Agp) will not run without it."
}

$jh = $env:JAVA_HOME
if (-not $jh) {
    Add-FailRow java-home 'JAVA_HOME' 'unset' `
        "Gradle prefers JAVA_HOME over PATH, so an unset JAVA_HOME means the JDK the build uses is whatever the launcher finds. Set it to a JDK $($pins.JavaMajor) root — scripts\setup-windows-dev.ps1 does this for you."
} elseif (-not (Test-Path -LiteralPath $jh -PathType Container)) {
    Add-FailRow java-home 'JAVA_HOME' "set to '$jh', which is not a directory" `
        "Point JAVA_HOME at the JDK $($pins.JavaMajor) ROOT (the folder containing bin\ and lib\), not at bin\ and not at a file."
} else {
    $jhJava = Join-Path $jh 'bin\java.exe'
    if (-not (Test-Path -LiteralPath $jhJava)) { $jhJava = Join-Path $jh 'bin\java' }
    if (-not (Test-Path -LiteralPath $jhJava)) {
        Add-FailRow java-home 'JAVA_HOME' "'$jh' contains no bin\java.exe" `
            "JAVA_HOME must be the JDK root. Gradle fails with 'ERROR: JAVA_HOME is set to an invalid directory'."
    } else {
        $jhRaw = Get-ExeOutput $jhJava @('-version')
        $jm = [regex]::Match($jhRaw, 'version "([0-9]+)')
        if (-not $jm.Success) {
            Add-FailRow java-home 'JAVA_HOME' "'$jh' holds a java whose version was not measured — NOT VERIFIED" `
                "Run '& `"`$env:JAVA_HOME\bin\java.exe`" -version' yourself and confirm it reports $($pins.JavaMajor). This row refuses to pass a JDK it did not measure."
        } elseif ($jm.Groups[1].Value -eq $pins.JavaMajor) {
            Add-Row PASS 'JAVA_HOME' "$jh (JDK $($jm.Groups[1].Value))" ''
        } else {
            Add-FailRow java-home 'JAVA_HOME' "'$jh' is JDK $($jm.Groups[1].Value), repository needs JDK $($pins.JavaMajor)" `
                "Gradle uses JAVA_HOME, not PATH. Repoint it at a Temurin $($pins.JavaMajor) root, or Gradle $($pins.Gradle) will refuse to run on it."
        }
    }
}

# ---- 4. Android SDK / platform / build-tools / adb ------------------------
#
# THE SDK ROOT ROW USED TO PASS ON ANY DIRECTORY THAT EXISTED. An empty folder
# named Android\sdk is not an SDK, and passing it sent the operator into a
# Gradle run that fails on a missing platform.
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $null }
$sdkUsable = $false

if ($sdkRoot -and (Test-Path -LiteralPath $sdkRoot -PathType Container)) {
    $looksLikeSdk = $false
    foreach ($d in @('platforms', 'platform-tools', 'cmdline-tools')) {
        if (Test-Path -LiteralPath (Join-Path $sdkRoot $d)) { $looksLikeSdk = $true }
    }
    if ($looksLikeSdk) {
        $sdkUsable = $true
        Add-Row PASS 'Android SDK root' $sdkRoot ''
    } else {
        Add-FailRow android-sdk 'Android SDK root' "'$sdkRoot' exists but holds no platforms\, platform-tools\ or cmdline-tools\" `
            "That is an empty directory, not an SDK. scripts\setup-windows-dev.ps1 installs the cmdline-tools, accepts the licences and installs platforms;android-$($pins.CompileSdk) and build-tools;$($pins.BuildTools)."
    }
} else {
    Add-FailRow android-sdk 'Android SDK root' 'ANDROID_HOME and ANDROID_SDK_ROOT are both unset or point nowhere' `
        "scripts\setup-windows-dev.ps1 installs the cmdline-tools, accepts the licences and installs platforms;android-$($pins.CompileSdk) and build-tools;$($pins.BuildTools) for you. Needs dl.google.com reachable."
}

if ($sdkUsable) {
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
        Add-FailRow android-platform 'Android platform' "android-$($pins.CompileSdk) missing (present: $present)" `
            "Run: sdkmanager `"platforms;android-$($pins.CompileSdk)`". compileSdk $($pins.CompileSdk) is a literal in apps\*\android\app\build.gradle."
    }

    $presentBt = ''
    $btRoot = Join-Path $sdkRoot 'build-tools'
    if (Test-Path -LiteralPath $btRoot) {
        $presentBt = ((Get-ChildItem -LiteralPath $btRoot -Directory -ErrorAction SilentlyContinue).Name -join ' ')
    }
    if (-not $presentBt) {
        Add-FailRow android-buildtools 'Android build-tools' 'none installed' `
            "Run: sdkmanager `"build-tools;$($pins.BuildTools)`". AGP $($pins.Agp) cannot package an APK without a build-tools package (aapt2, d8, zipalign, apksigner all live there)."
    } else {
        Add-Row PASS 'Android build-tools' "installed: $presentBt" ''
        if (Test-Path -LiteralPath (Join-Path $btRoot $pins.BuildTools)) {
            Add-Row PASS 'build-tools exact match' "$($pins.BuildTools) present (derived from compileSdk)" ''
        } else {
            Add-FailRow buildtools-exact 'build-tools exact match' "$($pins.BuildTools) absent (present: $presentBt)" `
                ("Neither app declares buildToolsVersion, so AGP $($pins.Agp) picks its own default and one of the above may well satisfy it. " +
                 "This is WARN, not BLOCKED, for exactly that reason. Run 'sdkmanager `"build-tools;$($pins.BuildTools)`"' to match the derivation exactly.")
        }
    }
} else {
    Add-FailRow android-platform 'Android platform' "cannot check android-$($pins.CompileSdk) — no usable SDK root" 'Resolve the Android SDK root row first.'
    Add-FailRow android-buildtools 'Android build-tools' 'cannot check — no usable SDK root' 'Resolve the Android SDK root row first.'
}

# adb. ADVISORY BY POLICY AND THE REASON IS WRITTEN DOWN: no stage of
# scripts\mobile-build.ps1 invokes adb, so its absence cannot fail a build. It
# is needed for item 17 of MOBILE_BUILD_HANDOFF.md — getting the APK onto a
# phone — and for the golden-device smoke test, which is why it is checked.
if (Test-Have 'adb') {
    $adbRaw = ((Get-ExeOutput 'adb' @('version')) -split "`n" | Select-Object -First 1)
    if (-not $adbRaw) { $adbRaw = 'on PATH' }
    Add-Row PASS 'adb (platform-tools)' $adbRaw.Trim() ''
} else {
    $adbHint = ''
    if ($sdkUsable -and (Test-Path -LiteralPath (Join-Path $sdkRoot 'platform-tools\adb.exe'))) {
        $adbHint = " It IS installed at $sdkRoot\platform-tools\adb.exe but is not on PATH."
    }
    Add-FailRow adb 'adb (platform-tools)' 'not on PATH' `
        ("No build stage uses adb, so this does not block a build — it blocks INSTALLING the artifact on a phone. " +
         "Run 'sdkmanager `"platform-tools`"' and add %ANDROID_HOME%\platform-tools to PATH.$adbHint")
}

# ---- 5. Gradle — the WRAPPER is the contract ------------------------------
$wrapperOk = $true
foreach ($app in $apps) {
    $jar = Join-Path $RepoRoot "apps\$app\android\gradle\wrapper\gradle-wrapper.jar"
    if (-not (Test-Path -LiteralPath $jar)) { $wrapperOk = $false }
}
if ($wrapperOk) {
    Add-Row PASS 'Gradle wrapper' 'gradle-wrapper.jar present in both apps' ''
} else {
    Add-FailRow gradle-wrapper 'Gradle wrapper' 'gradle-wrapper.jar missing in at least one app' `
        "Restore it from git ('git checkout -- apps/*/android/gradle/wrapper/'). Never regenerate it with a Gradle other than the pinned $($pins.Gradle)."
}

$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $HOME '.gradle' }
$distCache = Join-Path $gradleHome 'wrapper\dists'
$distCached = $false
if (Test-Path -LiteralPath $distCache) {
    $distCached = [bool](Get-ChildItem -LiteralPath $distCache -Directory -Filter "gradle-$($pins.Gradle)-*" -ErrorAction SilentlyContinue)
}

if ($distCached) {
    Add-Row PASS "Gradle $($pins.Gradle)" "distribution cached under $distCache" ''
} else {
    # NOT CACHED IS NOT AUTOMATICALLY FATAL: the wrapper downloads it on first
    # use. What IS fatal is not cached AND services.gradle.org unreachable. The
    # old row blocked on "not cached" alone, which was noise on a fresh machine
    # with working networking; it now measures the thing that actually decides.
    $gp = Test-HttpProbe "https://services.gradle.org/distributions/gradle-$($pins.Gradle)-bin.zip"
    $sysNote = ''
    if (Test-Have 'gradle') {
        $gm = [regex]::Match((Get-ExeOutput 'gradle' @('--version')), 'Gradle\s+([0-9.]+)')
        if ($gm.Success -and $gm.Groups[1].Value -ne $pins.Gradle) {
            $sysNote = " Do NOT substitute the Gradle $($gm.Groups[1].Value) on PATH: the wrapper pin is what AGP $($pins.Agp) was validated against."
        }
    }
    if ($gp -eq 'ok') {
        Add-Row WARN "Gradle $($pins.Gradle)" 'not cached, but services.gradle.org answers — the first .\gradlew run will fetch it' `
            "Nothing to do; expect the first build to spend a minute downloading gradle-$($pins.Gradle)-bin.zip.$sysNote"
    } elseif ($gp -eq 'no') {
        Add-FailRow gradle-dist "Gradle $($pins.Gradle)" 'not cached AND services.gradle.org did not answer' `
            ("The wrapper cannot obtain gradle-$($pins.Gradle)-bin.zip, so no Gradle task can run. Restore outbound access to " +
             "services.gradle.org, or seed %GRADLE_USER_HOME%\wrapper\dists from a machine that has it.$sysNote")
    } else {
        Add-Row WARN "Gradle $($pins.Gradle)" 'not cached; reachability of services.gradle.org NOT VERIFIED (-NoNetwork)' `
            "Run '.\gradlew --version' inside apps\<app>\android once. If it downloads, you are fine; if it hangs, that is this row's blocker.$sysNote"
    }
}

# ---- 5b. compileSdk vs AGP, and the three SDK levels ----------------------
#
# THE RULE IS THE REPOSITORY'S OWN, quoted in both apps' android\app\build.gradle:
# "compileSdk 35 requires Android Gradle Plugin 8.6.0 or higher". Nothing here
# is invented; the numbers on both sides are parsed out of the tree.
$compileSdkNum = 0
# THE CHAIN, CHECKED IN BOTH DIRECTIONS.
#
#   compileSdk 35+ needs AGP 8.6.0+   (AGP's own refusal message says so)
#   compileSdk 36+ needs AGP 9.0.0+   (36 is above AGP 8.x's ceiling)
#   AGP 9.x        needs Gradle 9.5.0+ (developer.android.com/build/releases/
#                                       gradle-plugin, read 2026-08-22)
#
# The Gradle half was missing until the 2026-08-22 toolchain bump, and its
# absence is how a repository can pin an AGP its own Gradle wrapper cannot
# load — a failure that surfaces as an opaque plugin-resolution error rather
# than as the sentence above.
$agpOk = $true
$agpFloor = $null
if ([int]::TryParse($pins.CompileSdk, [ref]$compileSdkNum)) {
    if ($compileSdkNum -ge 36) { $agpFloor = '9.0.0' }
    elseif ($compileSdkNum -ge 35) { $agpFloor = '8.6.0' }
}
if ($agpFloor) {
    try { $agpOk = ([version]$pins.Agp -ge [version]$agpFloor) } catch { $agpOk = $false }
}
if ($agpOk) {
    Add-Row PASS 'compileSdk vs AGP' "compileSdk $($pins.CompileSdk) is inside AGP $($pins.Agp)'s ceiling" ''
} else {
    Add-FailRow gradle-agp-sdk 'compileSdk vs AGP' "compileSdk $($pins.CompileSdk) with AGP $($pins.Agp)" `
        ("AGP $($pins.Agp) refuses compileSdk $($pins.CompileSdk) outright — that level needs AGP $agpFloor or higher. " +
         "Either lower compileSdk in apps\*\android\app\build.gradle or raise the AGP version in " +
         "apps\*\android\settings.gradle (which also moves the Gradle wrapper pin). " +
         "apps\*\android\app\build.gradle records the rule and its sources.")
}

# AGP 9 cannot load on a Gradle below 9.5.0. Checked separately from the SDK
# rule above because it is a different requirement with a different fix.
$gradleOk = $true
try {
    if ([version]$pins.Agp -ge [version]'9.0.0') {
        $gradleOk = ([version]$pins.Gradle -ge [version]'9.5.0')
    }
} catch { $gradleOk = $false }
if ($gradleOk) {
    Add-Row PASS 'AGP vs Gradle wrapper' "AGP $($pins.Agp) runs on Gradle $($pins.Gradle)" ''
} else {
    Add-FailRow gradle-agp-sdk 'AGP vs Gradle wrapper' "AGP $($pins.Agp) with Gradle $($pins.Gradle)" `
        ("AGP 9.x states Gradle 9.5.0 as its minimum. Raise distributionUrl in " +
         "apps\*\android\gradle\wrapper\gradle-wrapper.properties, or lower the AGP pin in " +
         "apps\*\android\settings.gradle. Source: developer.android.com/build/releases/gradle-plugin")
}

$minN = 0; $tgtN = 0; $cmpN = 0
$levelsParsed = ([int]::TryParse($pins.MinSdk, [ref]$minN) -and
                 [int]::TryParse($pins.TargetSdk, [ref]$tgtN) -and
                 [int]::TryParse($pins.CompileSdk, [ref]$cmpN))
if ($levelsParsed -and $minN -le $tgtN -and $tgtN -le $cmpN) {
    Add-Row PASS 'SDK levels' "minSdk $minN <= targetSdk $tgtN <= compileSdk $cmpN" ''
} else {
    Add-FailRow sdk-levels 'SDK levels' "minSdk $($pins.MinSdk) / targetSdk $($pins.TargetSdk) / compileSdk $($pins.CompileSdk) are not ordered" `
        'AGP requires minSdk <= targetSdk <= compileSdk. Fix apps\*\android\app\build.gradle; all three are literals there.'
}

# ---- 6. pub.dev — mobile-build stage 1 is `flutter pub get` ---------------
#
# THE PACKAGE PROBED IS READ OUT OF THE PUBSPEC, not typed here, so this row
# cannot go stale against a dependency list that changed.
$probePkg = Get-FirstMatch (Join-Path $RepoRoot 'apps\parent-app\pubspec.yaml') '(?m)^  ([a-z][a-z0-9_]*):\s*\^?[0-9]'
if (-not $probePkg) {
    Add-FailRow pub-access 'pub.dev access' 'could not read a hosted dependency name from apps\parent-app\pubspec.yaml' `
        'This row probes the registry with a package the repository actually declares. Fix the parse rather than probing a name typed from memory.'
} else {
    $pp = Test-HttpProbe "https://pub.dev/api/packages/$probePkg"
    if ($pp -eq 'ok') {
        Add-Row PASS 'pub.dev access' "answered for '$probePkg'" ''
    } elseif ($pp -eq 'no') {
        Add-FailRow pub-access 'pub.dev access' "https://pub.dev/api/packages/$probePkg did NOT answer" `
            ("'flutter pub get' is the first stage of scripts\mobile-build.ps1 and it cannot resolve a single dependency without pub.dev. " +
             'This is the blocker that has held this repository''s mobile build from the start (pub.dev answers 403 from the authoring container). ' +
             'Set PUB_HOSTED_URL to a mirror you control, or run the build from a machine with outbound access.')
    } else {
        Add-Row WARN 'pub.dev access' 'NOT VERIFIED (-NoNetwork)' `
            "Confirm by hand: 'flutter pub get' inside apps\parent-app. This row refuses to PASS a registry it never contacted."
    }
}

# ---- 7. pubspec.lock ------------------------------------------------------
foreach ($app in $apps) {
    $lock = Join-Path $RepoRoot "apps\$app\pubspec.lock"
    if (Test-Path -LiteralPath $lock) {
        $lockText = Get-FileText $lock
        $pkgCount = ([regex]::Matches($lockText, '(?m)^  [a-z0-9_]+:$')).Count
        Add-Row PASS "pubspec.lock ($app)" "present, $pkgCount packages" ''
    } else {
        Add-FailRow pubspec-lock "pubspec.lock ($app)" 'absent' `
            ("Run 'flutter pub get' in apps\$app (needs pub.dev reachable), then COMMIT the generated pubspec.lock. " +
             'Until it exists, two builds of the same commit can resolve DIFFERENT dependency versions, so no artifact is ' +
             'reproducible. A debug APK still builds — which is why this is BLOCKED only under -Profile release.')
    }
}

# ---- 8. Required packages — every `package:` import is declared -----------
#
# DELEGATED, NOT RE-IMPLEMENTED. scripts\verify_dart_imports.py resolves every
# import/export/part directive in both apps and cross-checks each
# `package:<other>/...` against the owning pubspec's dependency list.
$importChecker = Join-Path $PSScriptRoot 'verify_dart_imports.py'
$py = if (Test-Have 'python3') { 'python3' } elseif (Test-Have 'python') { 'python' } else { $null }
if (-not (Test-Path -LiteralPath $importChecker)) {
    Add-FailRow packages-unverifiable 'Required packages' 'checker scripts\verify_dart_imports.py not found — NOT VERIFIED' `
        "Restore it: 'git checkout -- scripts/verify_dart_imports.py'. It is the only check that catches an import of a package no pubspec declares, which fails 'flutter pub get' or 'flutter analyze' minutes later."
} elseif (-not $py) {
    Add-FailRow packages-unverifiable 'Required packages' 'Python 3 not available — NOT VERIFIED' `
        "Install Python 3, then run 'python scripts\verify_dart_imports.py'. This row does not PASS a check it could not run."
} else {
    $null = Get-ExeOutput $py @($importChecker, $RepoRoot)
    if ($script:LastExeExit -eq 0) {
        Add-Row PASS 'Required packages' 'every package: import resolves to a declared dependency' ''
    } else {
        Add-FailRow packages 'Required packages' 'at least one import is unresolved or undeclared' `
            "Run 'python scripts\verify_dart_imports.py' for the per-file detail. An undeclared package: import fails 'flutter analyze' and, if it is a plugin, the Gradle build."
    }
}

# ---- 9. Firebase configuration -------------------------------------------
#
# GRADED PER APP, FROM WHAT THE APP ACTUALLY DECLARES. Only apps\parent-app
# depends on firebase_core / firebase_messaging and only its settings.gradle
# carries the google-services plugin, so only its build ever reads
# google-services.json. THE CHILD APP DOES NOT NEED THAT FILE.
foreach ($app in $apps) {
    $gs = Join-Path $RepoRoot "apps\$app\android\app\google-services.json"
    $expectId = if ($app -eq 'parent-app') { $pins.ParentApplicationId } else { $pins.ChildApplicationId }
    if (-not $expectId) {
        Add-Row BLOCKED "Firebase config ($app)" 'no applicationId known for this app' `
            "Get-RepoPins exports one applicationId per app and this script maps them by name; '$app' has no branch. Add it there rather than comparing against an empty string."
        continue
    }

    $posture = Get-AppFirebasePosture -Root $RepoRoot -App $app
    if ($posture -eq 'unknown') {
        # WAS A SILENT PASS: missing pubspec/settings/build.gradle read as
        # "declares no Firebase", the requirement was waived, and the row went
        # green on three files that were not there.
        Add-Row BLOCKED "Firebase config ($app)" 'cannot decide: pubspec.yaml, android\settings.gradle or android\app\build.gradle is missing' `
            "All three are needed to know whether this app uses Firebase at all. Restore apps\$app from git. This row will not report 'not required' on files it could not read."
        continue
    }

    if ($posture -eq 'no') {
        if (Test-Path -LiteralPath $gs) {
            Add-Row WARN "Firebase config ($app)" 'google-services.json present but NOTHING READS IT' `
                ("apps\$app declares no firebase_core/firebase_messaging in pubspec.yaml, its android\settings.gradle does not carry " +
                 'com.google.gms.google-services and app\build.gradle never applies it, so this file is inert. Either add the Firebase ' +
                 'dependencies (this row will then require the file) or delete it so it does not read as configured push.')
        } else {
            Add-Row PASS "Firebase config ($app)" 'not required — this app declares no Firebase dependency' ''
        }
        continue
    }

    if (Test-Path -LiteralPath $gs) {
        $gsText = Get-FileText $gs
        if ($gsText -match [regex]::Escape($expectId)) {
            Add-Row PASS "Firebase config ($app)" "google-services.json present for $expectId" ''
        } else {
            Add-Row BLOCKED "Firebase config ($app)" "google-services.json does NOT mention $expectId" `
                "This file belongs to a different Android app. FCM registration fails at runtime with a mismatched sender. Re-download it for applicationId $expectId. (BLOCKED in every profile: a wrong file is worse than an absent one.)"
        }
    } else {
        Add-FailRow firebase-config "Firebase config ($app)" 'google-services.json absent' `
            ("OPERATOR MUST SUPPLY — nothing in this repository can generate it and no placeholder was fabricated. Create the Firebase " +
             "Android app for applicationId $expectId, download google-services.json and place it at " +
             "apps\$app\android\app\google-services.json (CI reads it from the GOOGLE_SERVICES_JSON secret instead). " +
             'THE DEBUG APK BUILDS AND RUNS WITHOUT IT — the gradle default -Pabny.firebase=auto only warns — which is why this is ' +
             'WARN under -Profile debug and BLOCKED under -Profile release: a release in that state ships an artifact whose every ' +
             'push notification silently never arrives. See docs\release\FIREBASE_SETUP.md.')
    }
}

$firebaseOptions = Join-Path $RepoRoot 'apps\parent-app\lib\firebase_options.dart'
if (Test-Path -LiteralPath $firebaseOptions) {
    Add-Row PASS 'firebase_options.dart' 'present (parent-app)' ''
} else {
    Add-FailRow firebase-options 'firebase_options.dart' 'absent (parent-app)' `
        ("Only 'flutterfire configure' can generate it, against a real Firebase project. Without it Firebase.initializeApp() throws, " +
         'PushRegistrationService returns early, and no FCM token is ever registered. Debug builds proceed without push, which is why ' +
         'this is WARN under -Profile debug.')
}

# ---- 10. Signing configuration -------------------------------------------
#
# THE FILE THE GRADLE ACTUALLY READS IS `signing.properties`, NOT
# `key.properties`. This section checked the latter — Flutter's template name —
# while both apps' android/app/build.gradle read
# `rootProject.file("signing.properties")`, both android/.gitignore files
# ignore `signing.properties` (and commit `signing.properties.example` by
# negation), and .github/workflows/build-apk.yml writes
# `android/signing.properties`. So the doctor could PASS an operator who had
# created key.properties, and their release build would then stop in the
# task-graph guard with "signing.properties is MISSING" — THE DOCTOR PASSING
# SOMETHING THE BUILD FAILS ON.
foreach ($app in $apps) {
    $androidDir  = Join-Path $RepoRoot "apps\$app\android"
    $signProps   = Join-Path $androidDir 'signing.properties'
    $signExample = Join-Path $androidDir 'signing.properties.example'
    $keytoolCmd  = Get-KeytoolCommand -Root $RepoRoot -App $app

    if (Test-Path -LiteralPath $signExample) {
        Add-Row PASS "Signing template ($app)" 'android\signing.properties.example present' ''
    } else {
        Add-FailRow signing-template "Signing template ($app)" 'android\signing.properties.example is missing' `
            "It is the committed template and holds the full keytool invocation and the keystore name this doctor quotes. Restore it: 'git checkout -- apps/$app/android/signing.properties.example'."
    }

    if (Test-Path -LiteralPath $signProps) {
        $text = Get-FileText $signProps
        $missing = @()
        foreach ($k in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
            # The gradle treats present-but-EMPTY as missing, so this must too —
            # otherwise the doctor passes a file the task-graph guard rejects.
            if ($text -notmatch "(?m)^\s*$k\s*=\s*\S") { $missing += $k }
        }
        if ($missing.Count -gt 0) {
            Add-Row BLOCKED "Signing ($app)" "signing.properties present but missing/empty: $($missing -join ' ')" `
                ("apps\$app\android\app\build.gradle stops any release task unless all four of storeFile, storePassword, keyAlias, " +
                 "keyPassword are set AND non-empty. A partial signing config is not signed 'less', it is not signed. Fill them in " +
                 "apps\$app\android\signing.properties — see signing.properties.example. (BLOCKED in every profile: a half-written key " +
                 'file is a mistake in progress, not a debug-only state.)')
        } else {
            $storeRel = [regex]::Match($text, '(?m)^\s*storeFile\s*=\s*(.+)$').Groups[1].Value.Trim()
            $storeAbs = Join-Path $androidDir $storeRel
            $resolved = $null
            if (Test-Path -LiteralPath $storeAbs)      { $resolved = $storeAbs }
            elseif (Test-Path -LiteralPath $storeRel)  { $resolved = (Resolve-Path -LiteralPath $storeRel).Path }
            if (-not $resolved) {
                Add-Row BLOCKED "Signing ($app)" "keystore not found at '$storeRel'" `
                    ("storeFile is resolved RELATIVE TO apps\$app\android\ by app\build.gradle. Place the .jks there, use an absolute " +
                     "path, or generate one: cd apps\$app\android; $keytoolCmd")
            } else {
                # L3, mirrored from app/build.gradle. The gradle refuses a
                # release whose keystore looks like the debug one; a doctor that
                # passed it would send the operator into a build that stops ten
                # minutes later. THIS IS THE ROW THAT PROVES A RELEASE CANNOT
                # FALL BACK TO A DEBUG KEY.
                $leaf = (Split-Path -Leaf $resolved).ToLower()
                $norm = $resolved.Replace('\', '/').ToLower()
                if ($leaf -eq 'debug.keystore' -or $leaf -eq 'debug.jks' -or $norm -match '/\.android/debug') {
                    Add-Row BLOCKED "Signing ($app)" "storeFile points at what looks like a DEBUG keystore: $resolved" `
                        ("app\build.gradle's L3 identity assertion fails this build by name. The debug key is a well-known machine-local " +
                         "throwaway; an artifact signed with it can never be uploaded to Play and never updated. Generate a real upload key: $keytoolCmd")
                } else {
                    Add-Row PASS "Signing ($app)" "signing.properties complete, keystore $leaf found" ''
                }
            }
        }
    } else {
        Add-FailRow signing "Signing ($app)" 'android\signing.properties absent' `
            ("OPERATOR MUST SUPPLY. No release keystore = no store artifact, and app\build.gradle will NOT fall back to the debug key — " +
             "it stops the release task with a named message. Do exactly this: cd apps\$app\android; $keytoolCmd; " +
             'copy signing.properties.example signing.properties; then fill storeFile / storePassword / keyAlias / keyPassword. ' +
             "signing.properties and *.jks are BOTH gitignored (apps\$app\android\.gitignore) — never commit either. " +
             'THE DEBUG APK NEEDS NONE OF THIS, which is why this row is WARN under -Profile debug.')
    }

    # A signing file that is NOT ignored is key material one `git add` away from
    # the history. The gitignore is committed, so this is checkable statically.
    $gitignore = Join-Path $androidDir '.gitignore'
    if (Test-Path -LiteralPath $gitignore) {
        $gi = Get-FileText $gitignore
        $unignored = @()
        if ($gi -notmatch '(?m)^\s*signing\.properties\s*$') { $unignored += 'signing.properties' }
        if ($gi -notmatch '(?m)^\s*\*\.jks\s*$')             { $unignored += '*.jks' }
        if ($unignored.Count -gt 0) {
            Add-FailRow signing-gitignore "Signing gitignore ($app)" "not ignored: $($unignored -join ' ')" `
                "apps\$app\android\.gitignore must ignore signing.properties and *.jks (and keep !signing.properties.example). Key material one 'git add' from the history is key material already lost."
        } else {
            Add-Row PASS "Signing gitignore ($app)" 'signing.properties and *.jks are gitignored' ''
        }
    } else {
        Add-FailRow signing-gitignore "Signing gitignore ($app)" "apps\$app\android\.gitignore is missing" `
            'Without it the keystore and its three passwords are committable by accident. Restore it from git.'
    }
}

# ---- 11. The version the release AAB will carry ---------------------------
#
# app\build.gradle REFUSES to package a release on a fallback version, and the
# single source of both halves is pubspec.yaml's `version: <name>+<code>` line
# (flutter build copies it into android/local.properties).
foreach ($app in $apps) {
    $pubspec = Join-Path $RepoRoot "apps\$app\pubspec.yaml"
    $version = Get-FirstMatch $pubspec '(?m)^version:\s*(\S+)\s*$'
    if (-not $version) {
        Add-FailRow app-version "App version ($app)" 'pubspec.yaml declares no version:' `
            "Add 'version: <name>+<code>' to apps\$app\pubspec.yaml. app\build.gradle stops any release task on a fallback version, because Play accepts versionCode 1 exactly once and then blocks every later upload."
    } elseif ($version -notmatch '^\d+\.\d+\.\d+\+\d+$') {
        Add-FailRow app-version "App version ($app)" "pubspec version '$version' has no +<versionCode>" `
            "app\build.gradle's release guard refuses a FALLBACK versionCode. Write it as '<name>+<code>', e.g. '0.1.0+1'. CI overrides the CODE half per upload via ORG_GRADLE_PROJECT_abnyVersionCode."
    } else {
        Add-Row PASS "App version ($app)" "$version (versionName+versionCode, single source)" ''
    }
}

# ---- 12. Package IDs and application IDs ---------------------------------
#
# TWO DIFFERENT THINGS, TWO ROWS.
#   package IDs      — the two apps must not claim the same applicationId, or
#                      installing one uninstalls the other.
#   application IDs  — within ONE app, `namespace` and `applicationId` must
#                      agree, and the identity must be a legal, immutable-
#                      after-first-upload package name.
if ($pins.ParentApplicationId -eq $pins.ChildApplicationId) {
    Add-FailRow package-ids 'Package IDs' "both apps declare $($pins.ParentApplicationId)" `
        'Two apps cannot share an applicationId — the second install replaces the first. Fix apps\*\android\app\build.gradle.'
} else {
    Add-Row PASS 'Package IDs' "parent=$($pins.ParentApplicationId) child=$($pins.ChildApplicationId)" ''
}

foreach ($app in $apps) {
    $ns  = if ($app -eq 'parent-app') { $pins.ParentNamespace }     else { $pins.ChildNamespace }
    $aid = if ($app -eq 'parent-app') { $pins.ParentApplicationId } else { $pins.ChildApplicationId }
    if (-not $ns -or -not $aid) {
        $nsShown  = if ($ns)  { $ns }  else { '<not found>' }
        $aidShown = if ($aid) { $aid } else { '<not found>' }
        Add-FailRow application-ids "Application ID ($app)" "namespace='$nsShown' applicationId='$aidShown'" `
            "Both must be declared in apps\$app\android\app\build.gradle. A missing namespace fails AGP $($pins.Agp) outright; a missing applicationId leaves the Play identity to the namespace by accident."
    } elseif ($ns -ne $aid) {
        Add-FailRow application-ids "Application ID ($app)" "namespace '$ns' != applicationId '$aid'" `
            ("They are allowed to differ, but in this repository they do not and nothing is built to handle the split (the Kotlin " +
             "sources, the manifest's .MainActivity and the Firebase registration all follow one name). Reconcile them in " +
             "apps\$app\android\app\build.gradle.")
    } elseif ($aid -notmatch '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$') {
        Add-FailRow application-ids "Application ID ($app)" "'$aid' is not a legal Play package name" `
            "Play requires at least two dot-separated segments, lowercase, starting with a letter, and the name is IMMUTABLE after the first upload. Fix it in apps\$app\android\app\build.gradle before the first upload, never after."
    } else {
        Add-Row PASS "Application ID ($app)" "$aid (namespace and applicationId agree)" ''
    }
}

# ---- 13. Required environment variables for the build itself -------------
#
# JAVA_HOME and ANDROID_HOME already have their own rows above. The remaining
# one is the release API base URL, and it is the only environment variable in
# this repository whose ABSENCE produces a BUILDABLE, SIGNED, CRASHING artifact:
# apps\*\lib\core\config\app_config.dart THROWS StateError at launch in release
# mode unless API_BASE_URL is https, and the repository default
# (AppConfig.debugDefaultApiBaseUrl) is cleartext http.
#
# The variable name is the one .github\workflows\build-apk.yml already uses
# (RELEASE_API_BASE_URL), and scripts\mobile-build.ps1 reads the same name for
# -Release, so this row grades exactly what the build will consume.
$relUrl = $env:RELEASE_API_BASE_URL
$defaultUrlShown = if ($pins.DebugApiUrl) { $pins.DebugApiUrl } else { 'the cleartext debug default' }
if (-not $relUrl) {
    Add-FailRow api-base-url 'RELEASE_API_BASE_URL' 'unset' `
        ("A release build with the repository default ($defaultUrlShown) throws StateError on launch — " +
         'apps\*\lib\core\config\app_config.dart requires https in release mode. Set $env:RELEASE_API_BASE_URL = ' +
         "'https://<host>/api/v1' (the same name .github\workflows\build-apk.yml uses), or pass -ApiBaseUrl to " +
         'scripts\mobile-build.ps1. Debug builds use the http default deliberately, so this is WARN under -Profile debug.')
} elseif ($relUrl -notlike 'https://*') {
    Add-Row BLOCKED 'RELEASE_API_BASE_URL' "'$relUrl' is not https" `
        ('AppConfig.configurationError() rejects any non-https URL in release mode and assertUsableForBuildMode() turns that into a ' +
         'StateError at launch. (BLOCKED in every profile: an explicitly set, wrong value is not a debug convenience.)')
} else {
    Add-Row PASS 'RELEASE_API_BASE_URL' $relUrl ''
}

# ---- 14. Manifest permissions, and the runtime request behind one --------
foreach ($app in $apps) {
    $manifest = Join-Path $RepoRoot "apps\$app\android\app\src\main\AndroidManifest.xml"
    if (-not (Test-Path -LiteralPath $manifest)) {
        Add-FailRow permissions "Permissions ($app)" 'AndroidManifest.xml not found' `
            "Expected at apps\$app\android\app\src\main\AndroidManifest.xml."
        continue
    }
    $text = Get-FileText $manifest
    $permCount = ([regex]::Matches($text, '<uses-permission\s')).Count
    $hasInternet  = $text -match 'android\.permission\.INTERNET'
    $hasPostNotif = $text -match 'android\.permission\.POST_NOTIFICATIONS'
    if ($hasInternet -and $hasPostNotif) {
        Add-Row PASS "Permissions ($app)" "$permCount declared, incl. INTERNET + POST_NOTIFICATIONS" ''
    } else {
        $missing = @()
        if (-not $hasInternet)  { $missing += 'INTERNET' }
        if (-not $hasPostNotif) { $missing += 'POST_NOTIFICATIONS' }
        Add-FailRow permissions "Permissions ($app)" "$permCount declared, missing: $($missing -join ' ')" `
            "Add the <uses-permission> element(s) to $manifest. Without INTERNET the app reaches no backend; without POST_NOTIFICATIONS nothing this app posts is visible on Android 13+."
    }
}

# A DECLARED notification permission that is never REQUESTED is a defect
# invisible to every other check here.
$notifChecker = Join-Path $PSScriptRoot 'verify_notification_permission.py'
if (-not (Test-Path -LiteralPath $notifChecker)) {
    Add-FailRow notif-unverifiable 'POST_NOTIFICATIONS request' 'checker scripts\verify_notification_permission.py not found — NOT VERIFIED' `
        'Restore it: it is the only check that catches a permission declared in the manifest but never requested at runtime.'
} elseif (-not $py) {
    Add-FailRow notif-unverifiable 'POST_NOTIFICATIONS request' 'Python 3 not available — NOT VERIFIED' `
        "Install Python 3, then run 'python scripts\verify_notification_permission.py'. This row does not PASS a check it could not run."
} else {
    $null = Get-ExeOutput $py @($notifChecker)
    if ($script:LastExeExit -eq 0) {
        Add-Row PASS 'POST_NOTIFICATIONS request' 'every declaring app also requests it at runtime' ''
    } else {
        Add-FailRow notif-request 'POST_NOTIFICATIONS request' 'declared but never requested in at least one app' `
            "Run 'python scripts\verify_notification_permission.py' for the per-app detail. On Android 13+ an unrequested POST_NOTIFICATIONS means notifications silently never appear."
    }
}

# ---- 15. The deep-link scheme, in both manifests --------------------------
#
# The scheme is READ FROM THE SERVER'S REGISTRY, never typed here: the backend
# is authoritative for `<scheme>://<surface>` and both clients route on what it
# emits. If the two ever disagree, every notification tap in the product lands
# nowhere and no other check in this file would see it.
$destRegistry = Join-Path $RepoRoot 'apps\backend\src\modules\notifications\domain\engine\notification-destination.ts'
$scheme = Get-FirstMatch $destRegistry "DEEP_LINK_SCHEME\s*=\s*'([a-z][a-z0-9+.-]*)'"
if (-not $scheme) {
    Add-FailRow deep-link 'Deep-link scheme' 'could not read DEEP_LINK_SCHEME from the notification registry — NOT VERIFIED' `
        'Expected at apps\backend\src\modules\notifications\domain\engine\notification-destination.ts. Fix this check rather than guessing the scheme.'
} else {
    foreach ($app in $apps) {
        $manifest = Join-Path $RepoRoot "apps\$app\android\app\src\main\AndroidManifest.xml"
        if (-not (Test-Path -LiteralPath $manifest)) {
            Add-FailRow deep-link "Deep-link scheme ($app)" 'AndroidManifest.xml not found — NOT VERIFIED' `
                "Expected at apps\$app\android\app\src\main\AndroidManifest.xml."
            continue
        }
        $mtext = Get-FileText $manifest
        if ($mtext -match "android:scheme\s*=\s*`"$([regex]::Escape($scheme))`"") {
            Add-Row PASS "Deep-link scheme ($app)" "$scheme:// declared in an intent-filter" ''
        } else {
            # WARN and not BLOCKED, and the distinction is the whole point of
            # the grading scale. Nothing about the BUILD depends on this, and
            # the notification tap the product ships works without it: FCM
            # delivers `data.deepLink` INSIDE the app and the Dart routers parse
            # the string themselves. What is missing is the OS-level
            # registration — a link tapped in a browser, a message or an e-mail
            # resolves to no app on the device.
            Add-FailRow deep-link "Deep-link scheme ($app)" "no <data android:scheme=`"$scheme`"> intent-filter" `
                ("apps\$app\android\app\src\main\AndroidManifest.xml declares no intent-filter for $scheme://, so the OS cannot resolve " +
                 'such a link to this app. In-app notification taps are UNAFFECTED, which is why this is WARN.')
        }
    }
}

# ---- 16. git status — advisory -------------------------------------------
if (Test-Have 'git') {
    $inRepo = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'rev-parse', '--git-dir'))
    if ($script:LastExeExit -eq 0 -and $inRepo -notmatch 'fatal') {
        $branch = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'branch', '--show-current')).Trim()
        if (-not $branch) { $branch = '<detached>' }
        $porcelain = (Get-ExeOutput 'git' @('-C', $RepoRoot, 'status', '--porcelain')).Trim()
        $dirty = if ($porcelain) { ($porcelain -split "`n").Count } else { 0 }
        if ($dirty -eq 0) {
            Add-Row PASS 'git status' "clean on '$branch'" ''
        } else {
            Add-FailRow git-clean 'git status' "$dirty uncommitted path(s) on '$branch'" `
                "A store artifact should be reproducible from a commit. Run 'git status --short', then commit before building a release."
        }
    } else {
        Add-FailRow git-clean 'git status' 'not a git working tree' 'Build from a checkout, so the artifact can be traced to a commit.'
    }
} else {
    Add-FailRow git-clean 'git status' 'git not on PATH' 'Install Git for Windows so the artifact can be traced to a commit.'
}

# ===========================================================================
# VERDICT
#
# THE LAST LINE IS THE GATE. When anything is BLOCKED the final line printed is
# the unindented literal token below and the exit code is 1. It is printed in
# exactly one place. A WARN never reaches it.
# ===========================================================================
Write-Head 'VERDICT'
Write-Host ("  PASS {0}   WARN {1}   BLOCKED {2}" -f $script:NPass, $script:NWarn, $script:NBlocked)
Write-Host ''

if ($script:NBlocked -gt 0) {
    Write-Host "  This machine cannot produce a trustworthy $Profile artifact yet." -ForegroundColor Red
    Write-Host '  The blocking rows, in the order worth fixing:'
    foreach ($r in $script:Rows) {
        if ($r.Status -eq 'BLOCKED') { Write-Host ("    - {0}: {1}" -f $r.Check, $r.Measured) }
    }
    Write-Host ''
    Write-Host '  Nothing was installed, downloaded or modified by this run.'
    if ($script:NWarn -gt 0) {
        Write-Host ("  The {0} WARN row(s) above did NOT contribute to this verdict." -f $script:NWarn)
    }
    Write-Host ''
    Write-Host 'SHIP BLOCKED' -ForegroundColor Red
    exit 1
}

if ($script:NWarn -gt 0) {
    Write-Host ("  {0} WARN row(s) above are real gaps, and none of them blocks: a $Profile build can be attempted." -f $script:NWarn) -ForegroundColor Yellow
} else {
    Write-Host "  Every checked requirement for a $Profile artifact is met on this machine." -ForegroundColor Green
}
Write-Host ''
Write-Host ("SHIP GATE PASSED ({0} profile, {1} checks graded, 0 blocked)" -f $Profile, ($script:NPass + $script:NWarn))
exit 0
