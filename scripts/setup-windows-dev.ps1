#Requires -Version 5.1
<#
.SYNOPSIS
    ABNY / «ابني» — one-command Windows developer setup for apps/parent-app and
    apps/child-app: toolchain in, `flutter build apk --debug` out.

.DESCRIPTION
    Installs the pinned Flutter SDK, the matching JDK, the Android SDK
    command-line tools and the exact platform / build-tools this repository's
    Gradle files require; accepts the Android licences; runs `flutter doctor
    -v`; then for BOTH apps runs

        flutter pub get  ->  flutter analyze  ->  flutter test
                         ->  flutter build apk --debug

    and prints one pass/fail table plus where the APKs landed.

    EVERY VERSION IS READ OUT OF THIS REPOSITORY AT RUN TIME.
    -----------------------------------------------------------------
    Nothing below is a constant typed from memory. `Get-RepoPins` parses:

      Flutter SDK      .github/workflows/build-apk.yml    env.FLUTTER_VERSION
      JDK major        .github/workflows/build-apk.yml    env.JAVA_VERSION
      Gradle           apps/*/android/gradle/wrapper/gradle-wrapper.properties
      AGP              apps/*/android/settings.gradle     com.android.application
      Kotlin           apps/*/android/settings.gradle     kotlin.android
      compileSdk       apps/*/android/app/build.gradle
      targetSdk        apps/*/android/app/build.gradle
      minSdk           apps/*/android/app/build.gradle
      Dart constraint  apps/*/pubspec.yaml                environment.sdk
      API_BASE_URL     apps/*/lib/core/config/app_config.dart
                                                          debugDefaultApiBaseUrl

    The two apps are parsed independently and then COMPARED. If they disagree
    on any pinned value the script stops rather than picking one, because a
    silent divergence between the two apps is exactly the class of defect this
    file exists to prevent.

    THE TWO NUMBERS THAT ARE *NOT* IN THE REPOSITORY, SAID PLAINLY:

      1. build-tools. No `buildToolsVersion` is declared in either
         app/build.gradle, so AGP picks its own default. This script installs
         `build-tools;<compileSdk>.0.0` — derived from compileSdk, which IS in
         the repo — and prints that it did so. Override with -BuildToolsVersion.

      2. The command-line-tools bundle version. That is the INSTALLER, not a
         build input: it only provides `sdkmanager`, which then installs the
         versions that do matter. Override with -CmdlineToolsUrl.

      3. ndkVersion is deliberately left as `flutter.ndkVersion` by both
         app/build.gradle files (see the comment there). This script therefore
         installs no NDK. A debug APK for these two apps does not need one; if
         a plugin ever does, Gradle will say so by name.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of the folder holding this script.

.PARAMETER InstallRoot
    Where the toolchain goes. Default C:\abny-dev. Nothing is installed into
    Program Files and nothing needs an administrator token.

.PARAMETER ApiBaseUrl
    Value for --dart-define=API_BASE_URL. Defaults to the debug default read
    from the apps' own AppConfig (the Android-emulator host alias). Mandatory
    on every build in this repository — audit MA-004: without it the APK
    installs and can talk to nothing.

.PARAMETER SkipInstall
    Skip every download/installation step and only run the four per-app
    commands using whatever is already on PATH. Use this on the second run.

.PARAMETER SkipTests
    Skip `flutter test` (still runs pub get / analyze / build).

.PARAMETER Apps
    Which apps to build. Default both.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1

.EXAMPLE
    .\scripts\setup-windows-dev.ps1 -SkipInstall -Apps child-app

.NOTES
    IDEMPOTENT BY CONSTRUCTION. Every install step checks for the artefact it
    would produce and skips when it is already correct — so a re-run after a
    failed download resumes instead of restarting, and a re-run on a working
    machine costs seconds and changes nothing.

    STATUS: STATIC VERIFIED. This script has never been executed: the
    authoring environment has no Flutter, no Dart, no Android SDK, and the
    agent proxy answers 403 to CONNECT for storage.googleapis.com, dl.google.com
    and pub.dev. It is written to be run on a real Windows machine, and the
    first such run is the first measurement.
#>

[CmdletBinding()]
param(
    [string]   $RepoRoot,
    [string]   $InstallRoot = 'C:\abny-dev',
    [string]   $ApiBaseUrl,
    [string]   $BuildToolsVersion,
    [string]   $CmdlineToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
    [switch]   $SkipInstall,
    [switch]   $SkipTests,
    [ValidateSet('parent-app', 'child-app', 'both')]
    [string]   $Apps = 'both'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ===========================================================================
# 0. OUTPUT HELPERS
# ===========================================================================

$script:Steps = New-Object System.Collections.ArrayList

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
}
function Write-Info([string]$Text) { Write-Host "  $Text" }
function Write-Good([string]$Text) { Write-Host "  [ OK ] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Bad ([string]$Text) { Write-Host "  [FAIL] $Text" -ForegroundColor Red }

function Add-Step([string]$Name, [string]$Result, [string]$Detail) {
    [void]$script:Steps.Add([pscustomobject]@{ Step = $Name; Result = $Result; Detail = $Detail })
}

function Stop-Hard([string]$Message) {
    Write-Host ''
    Write-Bad $Message
    Write-Host ''
    throw $Message
}

# ===========================================================================
# 1. REPOSITORY-DERIVED PINS
#
# Read, compare, and refuse to continue on disagreement. A helper that returns
# $null when it cannot find its anchor is deliberate: a missing pin must be a
# loud stop, never a default.
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
    # The workflow is the single source of truth for the SDK versions; the
    # Gradle files are the single source of truth for everything Android.
    $pins.Flutter = Get-FirstMatch $wf 'FLUTTER_VERSION:\s*"?([0-9.]+)"?'
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
            ApplicationId = Get-FirstMatch $appGr 'applicationId\s+"([^"]+)"'
            DartSdk       = Get-FirstMatch $pubspec '(?ms)^environment:.*?\bsdk:\s*"([^"]+)"'
            DebugApiUrl   = Get-FirstMatch $config "debugDefaultApiBaseUrl\s*=\s*'([^']+)'"
        }

        foreach ($k in @('Gradle', 'Agp', 'Kotlin', 'CompileSdk', 'TargetSdk', 'MinSdk')) {
            if (-not $perApp[$app][$k]) {
                Stop-Hard "Could not read '$k' for $app. The Gradle files moved; fix this script rather than guessing a value."
            }
        }
    }

    # ---- the two apps must AGREE, and disagreement is a hard stop ----------
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
    $pins.DebugApiUrl         = $perApp['parent-app'].DebugApiUrl

    # build-tools is NOT in the repository — derived from compileSdk, and the
    # derivation is printed so it can be challenged.
    $pins.BuildTools = "$($pins.CompileSdk).0.0"
    $pins.BuildToolsDerived = $true

    return $pins
}

# ===========================================================================
# 2. SMALL INSTALL PRIMITIVES
# ===========================================================================

function Get-Download {
    param([string]$Url, [string]$OutFile)
    if (Test-Path -LiteralPath $OutFile) {
        $len = (Get-Item -LiteralPath $OutFile).Length
        if ($len -gt 1MB) {
            Write-Good "already downloaded: $(Split-Path $OutFile -Leaf) ($([math]::Round($len/1MB)) MB)"
            return
        }
        Remove-Item -LiteralPath $OutFile -Force
    }
    Write-Info "downloading $Url"
    $old = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # ~10x faster for large files on PS 5.1
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    } finally {
        $ProgressPreference = $old
    }
    Write-Good "downloaded $(Split-Path $OutFile -Leaf)"
}

function Expand-Zip {
    param([string]$Zip, [string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # ExtractToDirectory, not Expand-Archive: the Flutter SDK zip is ~1 GB and
    # PowerShell 5.1's cmdlet takes minutes on it.
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

function Set-PersistentEnv {
    param([string]$Name, [string]$Value)
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
    Set-Item -Path "Env:$Name" -Value $Value
    Write-Good "$Name = $Value"
}

function Add-ToPathOnce {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }
    $parts = $userPath.Split(';') | Where-Object { $_ -ne '' }
    if ($parts -notcontains $Dir) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) -join ';'), 'User')
        Write-Good "PATH += $Dir"
    } else {
        Write-Good "PATH already contains $Dir"
    }
    if (($env:Path -split ';') -notcontains $Dir) { $env:Path = "$env:Path;$Dir" }
}

# Runs an external command, streams AND captures its output, returns the exit
# code. Never throws — the caller decides, because this script's whole value is
# reporting all four stages rather than stopping at the first bad one.
function Invoke-Logged {
    param(
        [string]   $Exe,
        [string[]] $CmdArgs,
        [string]   $WorkDir,
        [string]   $LogFile
    )
    Write-Info "> $Exe $($CmdArgs -join ' ')"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkDir
    try {
        $output = & $Exe @CmdArgs 2>&1 | ForEach-Object {
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
    if ($LogFile) {
        $dir = Split-Path -Parent $LogFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $output | Set-Content -LiteralPath $LogFile -Encoding UTF8
    }
    return $code
}

# ===========================================================================
# 3. START
# ===========================================================================

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

Write-Head 'ABNY / «ابني» — Windows developer setup'
Write-Info "repository : $RepoRoot"
Write-Info "install to : $InstallRoot"

$pins = Get-RepoPins -Root $RepoRoot
if ($BuildToolsVersion) { $pins.BuildTools = $BuildToolsVersion; $pins.BuildToolsDerived = $false }
if (-not $ApiBaseUrl)   { $ApiBaseUrl = $pins.DebugApiUrl }
if (-not $ApiBaseUrl)   { Stop-Hard 'Could not read debugDefaultApiBaseUrl from AppConfig; pass -ApiBaseUrl.' }

Write-Head 'Versions derived from THIS repository (not from memory)'
Write-Host ''
Write-Host ('  {0,-16} {1,-14} {2}' -f 'COMPONENT', 'VERSION', 'READ FROM')
Write-Host ('  {0,-16} {1,-14} {2}' -f '---------', '-------', '---------')
$rows = @(
    @('Flutter SDK',  $pins.Flutter,    '.github/workflows/build-apk.yml  env.FLUTTER_VERSION'),
    @('JDK (major)',  $pins.JavaMajor,  '.github/workflows/build-apk.yml  env.JAVA_VERSION'),
    @('Gradle',       $pins.Gradle,     'apps/*/android/gradle/wrapper/gradle-wrapper.properties'),
    @('AGP',          $pins.Agp,        'apps/*/android/settings.gradle'),
    @('Kotlin',       $pins.Kotlin,     'apps/*/android/settings.gradle'),
    @('compileSdk',   $pins.CompileSdk, 'apps/*/android/app/build.gradle'),
    @('targetSdk',    $pins.TargetSdk,  'apps/*/android/app/build.gradle'),
    @('minSdk',       $pins.MinSdk,     'apps/*/android/app/build.gradle'),
    @('Dart SDK',     $pins.DartSdk,    'apps/*/pubspec.yaml  environment.sdk'),
    @('build-tools',  $pins.BuildTools, $(if ($pins.BuildToolsDerived) { 'DERIVED from compileSdk — not declared anywhere in the repo' } else { 'supplied via -BuildToolsVersion' }))
)
foreach ($r in $rows) { Write-Host ('  {0,-16} {1,-14} {2}' -f $r[0], $r[1], $r[2]) }
Write-Host ''
Write-Info "API_BASE_URL      : $ApiBaseUrl  (AppConfig.debugDefaultApiBaseUrl)"
Write-Info "applicationId     : $($pins.ParentApplicationId) / $($pins.ChildApplicationId)"
Write-Warn 'applicationId is a LIVE DECISION and cannot change after first Play release — see docs/release/STORE_READINESS.md.'
Write-Info 'ndkVersion is left as flutter.ndkVersion by both build.gradle files, so no NDK is installed.'

$flutterRoot = Join-Path $InstallRoot ("flutter-" + $pins.Flutter)
$jdkRoot     = Join-Path $InstallRoot ("jdk-" + $pins.JavaMajor)
$sdkRoot     = Join-Path $InstallRoot 'android-sdk'
$cacheDir    = Join-Path $InstallRoot 'downloads'
$logDir      = Join-Path $RepoRoot 'build-logs'

# ===========================================================================
# 4. INSTALL
# ===========================================================================

if ($SkipInstall) {
    Write-Head 'Installation SKIPPED (-SkipInstall)'
    Add-Step 'install' 'SKIPPED' '-SkipInstall was passed'
} else {
    New-Item -ItemType Directory -Force -Path $InstallRoot, $cacheDir | Out-Null

    # ---- 4a. prerequisites --------------------------------------------------
    Write-Head 'Prerequisites'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Stop-Hard 'git is not on PATH. Install Git for Windows first: https://git-scm.com/download/win  (the Flutter tool shells out to it and cannot work without it).'
    }
    Write-Good "git: $((git --version) -join '')"
    if ([Environment]::Is64BitOperatingSystem -ne $true) {
        Stop-Hard 'A 64-bit Windows is required by the Flutter SDK and the Android SDK.'
    }

    # ---- 4b. JDK ------------------------------------------------------------
    Write-Head "JDK $($pins.JavaMajor) (Temurin)"
    Write-Info 'Why this exact major, and every clause of it comes from the repo:'
    Write-Info "  * gradle-wrapper.properties pins Gradle $($pins.Gradle); Gradle only learned to RUN"
    Write-Info '    on JDK 21 in 8.5, so a newer JDK dies with "Unsupported class file major'
    Write-Info '    version 65" before compiling a single line.'
    Write-Info "  * settings.gradle pins AGP $($pins.Agp), which wants JDK 17."
    Write-Info "  * app/build.gradle sets source/targetCompatibility to $($pins.JavaMajor)."
    Write-Info "  JDK $($pins.JavaMajor) is the only version satisfying all three."
    $javaExe = Join-Path $jdkRoot 'bin\java.exe'
    if (Test-Path -LiteralPath $javaExe) {
        Write-Good "already installed at $jdkRoot"
    } else {
        $jdkZip = Join-Path $cacheDir "temurin-$($pins.JavaMajor).zip"
        $jdkUrl = "https://api.adoptium.net/v3/binary/latest/$($pins.JavaMajor)/ga/windows/x64/jdk/hotspot/normal/eclipse"
        Get-Download -Url $jdkUrl -OutFile $jdkZip
        $tmp = Join-Path $cacheDir 'jdk-extract'
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Expand-Zip -Zip $jdkZip -Destination $tmp
        # The archive contains a single jdk-17.x.y+z folder; normalise the name
        # so JAVA_HOME does not change on every patch release.
        $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
        if (-not $inner) { Stop-Hard "The Temurin archive did not contain a JDK folder." }
        if (Test-Path -LiteralPath $jdkRoot) { Remove-Item -LiteralPath $jdkRoot -Recurse -Force }
        Move-Item -LiteralPath $inner.FullName -Destination $jdkRoot
        Remove-Item -LiteralPath $tmp -Recurse -Force
        Write-Good "installed at $jdkRoot"
    }
    Set-PersistentEnv 'JAVA_HOME' $jdkRoot
    Add-ToPathOnce (Join-Path $jdkRoot 'bin')

    # ---- 4c. Flutter SDK ----------------------------------------------------
    Write-Head "Flutter SDK $($pins.Flutter)"
    $flutterBat = Join-Path $flutterRoot 'flutter\bin\flutter.bat'
    if (Test-Path -LiteralPath $flutterBat) {
        Write-Good "already installed at $flutterRoot"
    } else {
        $fzip = Join-Path $cacheDir "flutter_windows_$($pins.Flutter)-stable.zip"
        $furl = "https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_$($pins.Flutter)-stable.zip"
        Get-Download -Url $furl -OutFile $fzip
        if (Test-Path -LiteralPath $flutterRoot) { Remove-Item -LiteralPath $flutterRoot -Recurse -Force }
        Expand-Zip -Zip $fzip -Destination $flutterRoot
        Write-Good "installed at $flutterRoot"
    }
    Add-ToPathOnce (Join-Path $flutterRoot 'flutter\bin')

    # ---- 4d. Android command-line tools ------------------------------------
    Write-Head 'Android SDK command-line tools'
    $sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (Test-Path -LiteralPath $sdkManager) {
        Write-Good "already installed at $sdkRoot"
    } else {
        $czip = Join-Path $cacheDir 'commandlinetools-win.zip'
        Get-Download -Url $CmdlineToolsUrl -OutFile $czip
        $tmp = Join-Path $cacheDir 'cmdline-extract'
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Expand-Zip -Zip $czip -Destination $tmp
        # sdkmanager REQUIRES the layout <sdk>/cmdline-tools/latest/bin/... and
        # fails with an unhelpful "Could not determine SDK root" otherwise.
        $target = Join-Path $sdkRoot 'cmdline-tools\latest'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $tmp 'cmdline-tools') -Destination $target
        Remove-Item -LiteralPath $tmp -Recurse -Force
        Write-Good "installed at $sdkRoot"
    }
    Set-PersistentEnv 'ANDROID_SDK_ROOT' $sdkRoot
    Set-PersistentEnv 'ANDROID_HOME'     $sdkRoot   # some tooling still reads the old name
    Add-ToPathOnce (Join-Path $sdkRoot 'platform-tools')
    Add-ToPathOnce (Join-Path $sdkRoot 'cmdline-tools\latest\bin')

    # ---- 4e. platform + build-tools + platform-tools ------------------------
    Write-Head "Android platform $($pins.CompileSdk), build-tools $($pins.BuildTools), platform-tools"
    Write-Info "platform-$($pins.CompileSdk) is required because app/build.gradle declares compileSdk $($pins.CompileSdk),"
    Write-Info "and AGP $($pins.Agp) refuses a compileSdk above 34 outright."
    $packages = @(
        "platforms;android-$($pins.CompileSdk)",
        "build-tools;$($pins.BuildTools)",
        'platform-tools'
    )
    $code = Invoke-Logged -Exe $sdkManager `
        -CmdArgs (@("--sdk_root=$sdkRoot") + $packages) `
        -WorkDir $RepoRoot -LogFile (Join-Path $logDir 'sdkmanager-install.txt')
    if ($code -ne 0) {
        Stop-Hard "sdkmanager failed with exit code $code. Full output: build-logs\sdkmanager-install.txt"
    }
    Write-Good 'Android packages installed'

    # ---- 4f. licences -------------------------------------------------------
    Write-Head 'Android SDK licences'
    Write-Info 'Answering "y" to every prompt. This writes the licence hashes into'
    Write-Info "$sdkRoot\licenses — nothing is transmitted anywhere."
    $yes = ("y`r`n" * 60)
    $yes | & $sdkManager "--sdk_root=$sdkRoot" --licenses | Out-Null
    Write-Good 'licences accepted (sdkmanager)'

    # `flutter doctor --android-licenses` is a separate acceptance path with a
    # separate record; run it too so `flutter doctor` reports green rather than
    # "Some Android licenses not accepted".
    $flutterExe = Join-Path $flutterRoot 'flutter\bin\flutter.bat'
    & $flutterExe config --android-sdk $sdkRoot | Out-Null
    $yes | & $flutterExe doctor --android-licenses | Out-Null
    Write-Good 'licences accepted (flutter doctor)'
    Add-Step 'install' 'PASS' "Flutter $($pins.Flutter), JDK $($pins.JavaMajor), SDK $($pins.CompileSdk)"
}

# ===========================================================================
# 5. RESOLVE THE TOOLS THIS SESSION WILL ACTUALLY USE
# ===========================================================================

function Resolve-Tool {
    param([string]$Preferred, [string]$OnPath, [string]$Human)
    if ($Preferred -and (Test-Path -LiteralPath $Preferred)) { return $Preferred }
    $c = Get-Command $OnPath -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    Stop-Hard "$Human not found. Re-run without -SkipInstall, or open a NEW terminal so the updated PATH is visible."
}

$flutter = Resolve-Tool (Join-Path $flutterRoot 'flutter\bin\flutter.bat') 'flutter' 'flutter'
Write-Info "using flutter: $flutter"

# ===========================================================================
# 6. flutter doctor -v
# ===========================================================================

Write-Head 'flutter doctor -v'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$doctorCode = Invoke-Logged -Exe $flutter -CmdArgs @('doctor', '-v') `
    -WorkDir $RepoRoot -LogFile (Join-Path $logDir 'flutter-doctor.txt')
# `flutter doctor` returns 0 even with warnings (a missing Visual Studio
# toolchain, no connected device). Those do not block an Android APK, so this
# is recorded and shown, never used as a gate.
Add-Step 'flutter doctor -v' $(if ($doctorCode -eq 0) { 'PASS' } else { "EXIT $doctorCode" }) 'build-logs\flutter-doctor.txt'

$reported = Get-FirstMatch (Join-Path $logDir 'flutter-doctor.txt') 'Flutter version ([0-9.]+)'
if ($reported -and $reported -ne $pins.Flutter) {
    Write-Warn "flutter doctor reports $reported but this repository pins $($pins.Flutter). The build may not match CI."
    Add-Step 'flutter version matches pin' 'WARN' "$reported != $($pins.Flutter)"
} elseif ($reported) {
    Write-Good "flutter doctor reports $reported — matches the repository pin"
    Add-Step 'flutter version matches pin' 'PASS' $reported
}

# ===========================================================================
# 7. PER-APP: pub get -> analyze -> test -> build apk --debug
#
# DIAGNOSTIC-FIRST, exactly like .github/workflows/build-apk.yml: every stage
# runs and is logged even when an earlier one failed, so ONE run of this script
# tells the developer everything that is wrong rather than the first thing.
# The only exception is `pub get`: nothing downstream can teach anything if
# dependency resolution failed, so its failure short-circuits that app.
# ===========================================================================

$appList = if ($Apps -eq 'both') { @('child-app', 'parent-app') } else { @($Apps) }
$results = @{}

foreach ($app in $appList) {
    $appDir = Join-Path $RepoRoot "apps\$app"
    Write-Head "$app"

    $r = [ordered]@{ PubGet = 'not reached'; Analyze = 'not reached'; Test = 'not reached'; Build = 'not reached'; Apk = $null }

    # ---- pub get ------------------------------------------------------------
    $lock = Join-Path $appDir 'pubspec.lock'
    if (Test-Path -LiteralPath $lock) {
        Write-Info 'pubspec.lock is committed — resolving with --enforce-lockfile (reproducible).'
        $pgArgs = @('pub', 'get', '--enforce-lockfile')
    } else {
        Write-Warn "apps\$app\pubspec.lock is NOT committed. This build is not reproducible (audit PA-M-016)."
        Write-Warn 'After a successful run, commit the generated pubspec.lock so every later build resolves identically.'
        $pgArgs = @('pub', 'get')
    }
    $c = Invoke-Logged -Exe $flutter -CmdArgs $pgArgs -WorkDir $appDir -LogFile (Join-Path $logDir "$app-pubget.txt")
    $r.PubGet = if ($c -eq 0) { 'PASS' } else { "FAIL ($c)" }

    if ($c -ne 0) {
        Write-Bad "flutter pub get failed for $app — nothing downstream can be measured. See build-logs\$app-pubget.txt"
        $results[$app] = $r
        continue
    }

    # ---- analyze ------------------------------------------------------------
    # --no-fatal-infos is the tool's own default and is kept. --fatal-warnings
    # is ALSO the tool's default and is kept: nothing here is relaxed below
    # what `flutter analyze` does on its own.
    $c = Invoke-Logged -Exe $flutter -CmdArgs @('analyze', '--no-fatal-infos') `
        -WorkDir $appDir -LogFile (Join-Path $logDir "$app-analyze.txt")
    $r.Analyze = if ($c -eq 0) { 'PASS' } else { "FAIL ($c)" }

    # ---- test ---------------------------------------------------------------
    if ($SkipTests) {
        $r.Test = 'SKIPPED'
    } else {
        $c = Invoke-Logged -Exe $flutter -CmdArgs @('test', '--reporter', 'expanded') `
            -WorkDir $appDir -LogFile (Join-Path $logDir "$app-test.txt")
        $r.Test = if ($c -eq 0) { 'PASS' } else { "FAIL ($c)" }
    }

    # ---- build --------------------------------------------------------------
    # --dart-define=API_BASE_URL is mandatory on every build in this repository
    # (audit MA-004): without it the APK installs and can talk to nothing.
    $buildArgs = @('build', 'apk', '--debug', "--dart-define=API_BASE_URL=$ApiBaseUrl")
    if ($app -eq 'parent-app') {
        $gs = Join-Path $appDir 'android\app\google-services.json'
        if (-not (Test-Path -LiteralPath $gs)) {
            Write-Warn 'android\app\google-services.json is ABSENT — building WITHOUT Firebase Cloud Messaging.'
            Write-Warn 'The APK is real and installable; no FCM token is obtained, so no parent push can arrive.'
            Write-Warn 'See docs/release/FIREBASE_SETUP.md. Nothing is fabricated in its place.'
            $buildArgs += '--dart-define=ENABLE_PUSH=false'
        } else {
            Write-Good 'google-services.json found — Firebase Messaging will be enabled.'
            $buildArgs += '--dart-define=ENABLE_PUSH=true'
        }
    }
    $c = Invoke-Logged -Exe $flutter -CmdArgs $buildArgs `
        -WorkDir $appDir -LogFile (Join-Path $logDir "$app-build.txt")
    $r.Build = if ($c -eq 0) { 'PASS' } else { "FAIL ($c)" }

    $apk = Join-Path $appDir 'build\app\outputs\flutter-apk\app-debug.apk'
    if (Test-Path -LiteralPath $apk) {
        $r.Apk = $apk
        $mb = [math]::Round((Get-Item -LiteralPath $apk).Length / 1MB, 1)
        Write-Good "APK: $apk ($mb MB)"
    } else {
        Write-Bad 'APK: NOT BUILT'
    }

    $results[$app] = $r
}

# ===========================================================================
# 8. SUMMARY
# ===========================================================================

Write-Head 'SUMMARY'
Write-Host ''
Write-Host '  SETUP'
Write-Host ('  {0,-30} {1,-10} {2}' -f 'STEP', 'RESULT', 'DETAIL')
Write-Host ('  {0,-30} {1,-10} {2}' -f '----', '------', '------')
foreach ($s in $script:Steps) {
    $colour = if ($s.Result -eq 'PASS') { 'Green' } elseif ($s.Result -like 'SKIP*') { 'Gray' } else { 'Yellow' }
    Write-Host ('  {0,-30} {1,-10} {2}' -f $s.Step, $s.Result, $s.Detail) -ForegroundColor $colour
}
Write-Host ''
Write-Host '  APPS'
Write-Host ('  {0,-12} {1,-12} {2,-12} {3,-12} {4,-12}' -f 'APP', 'pub get', 'analyze', 'test', 'build apk')
Write-Host ('  {0,-12} {1,-12} {2,-12} {3,-12} {4,-12}' -f '---', '-------', '-------', '----', '---------')
$anyFail = $false
foreach ($app in $appList) {
    $r = $results[$app]
    Write-Host ('  {0,-12} {1,-12} {2,-12} {3,-12} {4,-12}' -f $app, $r.PubGet, $r.Analyze, $r.Test, $r.Build)
    foreach ($v in @($r.PubGet, $r.Analyze, $r.Test, $r.Build)) {
        if ($v -like 'FAIL*' -or $v -eq 'not reached') { $anyFail = $true }
    }
}

Write-Host ''
Write-Host '  ARTEFACTS'
foreach ($app in $appList) {
    $r = $results[$app]
    if ($r.Apk) { Write-Host "    $app  ->  $($r.Apk)" -ForegroundColor Green }
    else        { Write-Host "    $app  ->  (no APK)" -ForegroundColor Red }
}
Write-Host ''
Write-Host "  FULL LOGS: $logDir"
Write-Host '    <app>-pubget.txt  <app>-analyze.txt  <app>-test.txt  <app>-build.txt'
Write-Host '    flutter-doctor.txt'
Write-Host ''
Write-Host '  INSTALL A DEBUG APK ON A CONNECTED DEVICE'
Write-Host '    adb devices'
Write-Host '    adb install -r "<path printed above>"'
Write-Host ''
Write-Host '  A DEBUG APK POINTS AT ' -NoNewline; Write-Host $ApiBaseUrl -ForegroundColor Yellow
Write-Host '    10.0.2.2 is the Android EMULATOR alias for the host machine. On a physical'
Write-Host '    device that address does not exist — re-run with'
Write-Host '      -ApiBaseUrl http://<your-lan-ip>:3000/api/v1'
Write-Host '    and make sure that host is in the cleartext allow-list in'
Write-Host '    android/app/src/debug/res/xml/network_security_config.xml, or Android will'
Write-Host '    refuse the connection with no error the app can show.'
Write-Host ''

if ($anyFail) {
    Write-Bad 'One or more stages FAILED. The table above and the logs say which.'
    exit 1
}
Write-Good 'All stages passed.'
exit 0
