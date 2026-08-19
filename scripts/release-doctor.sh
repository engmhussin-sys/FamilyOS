#!/usr/bin/env bash
# ===========================================================================
# release-doctor.sh — G19. "Can this machine actually produce the release
# artifact, and if not, what exactly do I type next?"
#
# WHAT IT IS
# One read-only diagnostic pass over the toolchain and the repository. It
# builds nothing, downloads nothing, installs nothing and changes nothing.
# Every row prints PASS / WARN / BLOCKED and, when the row is not PASS, one
# ACTIONABLE line — a command to run or a file to create, never "check your
# environment".
#
# WHERE THE EXPECTED VALUES COME FROM
# All of them from the repository, at run time, via scripts/lib/repo-pins.sh
# (the bash half of `Get-RepoPins` in scripts/setup-windows-dev.ps1). No
# version in this file is typed from memory. If a pin moves in the Gradle
# files or the workflow, this script's expectations move with it — which is
# the only way a doctor stays honest over time.
#
# PASS    the requirement is met, measured, and the measured value matches
#         what the repository pins.
# WARN    a real gap that does not stop the build being attempted, or a
#         mismatch whose consequence is degraded (not absent) function.
# BLOCKED the build cannot start, or can only produce a false green. Any
#         BLOCKED row makes the script exit 1.
#
# PROFILES
#   --profile release  (default) judges readiness for a SIGNED store artifact,
#                      so signing material and Firebase config are graded.
#   --profile debug    judges readiness for `flutter build apk --debug` only,
#                      where missing signing/Firebase is a WARN, not a block.
#
# WHAT THIS FILE GOT WRONG UNTIL NOW, AND WHY EACH ONE MATTERED
# `scripts/release-doctor.ps1` was corrected first and this file is now brought
# back to parity with it, row for row. Three of the corrections are defects
# this file carried, not cosmetics:
#
#   * SIGNING. It checked `android/key.properties` — Flutter's template name.
#     Both apps' `android/app/build.gradle` read
#     `rootProject.file("signing.properties")`, both `android/.gitignore`s
#     ignore `signing.properties`, and `.github/workflows/build-apk.yml` writes
#     `android/signing.properties`. So the doctor could PASS a machine whose
#     release build then stops in the gradle task-graph guard with
#     "signing.properties is MISSING" — a doctor passing something the build
#     fails on, which is the one defect a doctor must not have. It also treated
#     `key=` with an empty value as present, which the gradle does not.
#   * FIREBASE. It demanded google-services.json from BOTH apps and BLOCKED a
#     release on the child app's absent one. apps/child-app declares no
#     firebase_core / firebase_messaging, its settings.gradle carries no
#     google-services plugin and its app/build.gradle never applies one, so no
#     child build has ever read that file. The requirement is now DERIVED per
#     app from those three files, so the day child-app gains firebase_messaging
#     it appears here with no edit to this script.
#   * MISSING ROWS. The app VERSION (app/build.gradle refuses to package a
#     release on a fallback versionCode, and pubspec.yaml is the single source
#     of both halves) and the DEEP-LINK SCHEME (the one client/server contract
#     no other row here sees) had no rows at all.
#
# WHY THERE IS NO `set -e`, DELIBERATELY. This script's whole job is to keep
# probing a broken machine and report EVERY blocking row in one pass; `-e`
# would make the first failing probe the last thing it ever said. What `-e`
# would otherwise have caught is handled directly instead: `set -u` is on, every
# environment variable is read through `${VAR:-}`, every option that takes a
# value is checked BEFORE `shift 2` (a bare `--repo` used to `shift 2` past the
# end, which fails, leaves `$#` unchanged and spins forever), and every command
# substitution whose emptiness would poison a later `[ ... -eq ... ]` is
# defaulted at the point of use.
#
# STATUS OF THIS FILE: EXECUTED, but not since these corrections — the rows
# below are STATIC VERIFIED against the files they name (both app/build.gradle,
# both signing.properties.example, both android/.gitignore, both pubspec.yaml,
# both AndroidManifest.xml, the backend's notification-destination.ts and
# .github/workflows/build-apk.yml) and `bash -n` clean. This environment has no
# Flutter, no Dart, no Android SDK and no PowerShell, so no row that reports on
# a toolchain has been observed reporting PASS.
#
# Usage:
#   scripts/release-doctor.sh [--profile release|debug] [--repo <path>] [--quiet]
# ===========================================================================

set -uo pipefail

PROFILE="release"
QUIET="no"
REPO_ROOT=""

# An option that takes a value must HAVE one. Without this, `--repo` with
# nothing after it reached `shift 2` with one argument left; `shift` fails,
# `$#` does not change, and the loop spins forever on the same argument.
need_value() {
  if [ "$#" -lt 2 ]; then
    echo "release-doctor: $1 requires a value." >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      need_value "$@"
      PROFILE="$2"
      case "$PROFILE" in
        release|debug) ;;
        *) echo "release-doctor: --profile must be 'release' or 'debug'." >&2; exit 2 ;;
      esac
      shift 2 ;;
    --repo)   need_value "$@"; REPO_ROOT="$2"; shift 2 ;;
    --quiet)  QUIET="yes"; shift ;;
    # 2,78p is this file's header block, which grew when the three corrections
    # above were written down; a stale range silently truncates --help.
    -h|--help) sed -n '2,78p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release-doctor: unknown argument '$1'. Try --help." >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$REPO_ROOT" ]; then REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"; fi

# shellcheck source=lib/repo-pins.sh
if ! . "$SCRIPT_DIR/lib/repo-pins.sh"; then
  echo "release-doctor: cannot source scripts/lib/repo-pins.sh" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_DIM=""
fi

N_PASS=0; N_WARN=0; N_BLOCKED=0
ROWS=""

head_line() {
  [ "$QUIET" = "yes" ] && return 0
  printf '\n%s%s%s\n' "$C_CYN" "=============================================================================" "$C_RESET"
  printf '%s  %s%s\n' "$C_CYN" "$1" "$C_RESET"
  printf '%s%s%s\n' "$C_CYN" "=============================================================================" "$C_RESET"
}

# row <status> <check> <measured> <action>
row() {
  local status="$1" check="$2" measured="$3" action="$4" colour label
  case "$status" in
    PASS)    colour="$C_GRN"; label="  PASS "; N_PASS=$((N_PASS + 1)) ;;
    WARN)    colour="$C_YEL"; label="  WARN "; N_WARN=$((N_WARN + 1)) ;;
    BLOCKED) colour="$C_RED"; label="BLOCKED"; N_BLOCKED=$((N_BLOCKED + 1)) ;;
    # A typo'd status left `colour` and `label` UNSET, and under `set -u` the
    # printf below then killed the whole run — the doctor dying of its own
    # formatting rather than reporting the machine. It is now a loud row that
    # still counts as blocking, because a row nobody can grade is not a pass.
    *)       colour="$C_RED"; label="BLOCKED"; N_BLOCKED=$((N_BLOCKED + 1))
             measured="release-doctor BUG: unknown row status '$status' — $measured" ;;
  esac
  ROWS="${ROWS}${status}|${check}|${measured}
"
  printf '%s[%s]%s %-26s %s\n' "$colour" "$label" "$C_RESET" "$check" "$measured"
  if [ -n "$action" ] && [ "$status" != "PASS" ]; then
    printf '           %s-> %s%s\n' "$C_DIM" "$action" "$C_RESET"
  fi
}

# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# Compares a measured semver against a Dart-style constraint ">=3.3.0 <4.0.0".
# Returns 0 when it satisfies, 1 when it does not, 2 when the constraint shape
# is not one this function understands (the caller then abstains rather than
# claiming a pass).
semver_in_constraint() {
  local got="$1" constraint="$2"
  local lower upper
  lower="$(printf '%s' "$constraint" | sed -nE 's/.*>=[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  upper="$(printf '%s' "$constraint" | sed -nE 's/.*<[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  [ -n "$lower" ] || return 2
  ver_ge "$got" "$lower" || return 1
  if [ -n "$upper" ]; then ver_ge "$got" "$upper" && return 1; fi
  return 0
}

# ver_ge A B -> 0 when A >= B, numeric per component.
ver_ge() {
  local a="$1" b="$2"
  [ "$a" = "$b" ] && return 0
  local highest
  highest="$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)"
  [ "$highest" = "$a" ]
}

# Does this app ACTUALLY use Firebase? Derived from what the app declares, in
# the same three files and the same order as `Test-AppUsesFirebase` in
# release-doctor.ps1:
#   pubspec.yaml               firebase_core / firebase_messaging
#   android/settings.gradle    com.google.gms.google-services (plugins block)
#   android/app/build.gradle   apply plugin: "com.google.gms.google-services"
#
# THE ROW THIS REPLACES DEMANDED google-services.json FROM BOTH APPS and
# blocked a release on the child app's absent one. Nothing in the child build
# has ever read that file: it declares no firebase dependency, no plugin and no
# apply. Deriving it means the requirement appears by itself on the day an app
# gains the dependency, and disappears by itself if one drops it — neither
# answer is written down here.
uses_firebase() {
  local app="$1"
  local pubspec="$REPO_ROOT/apps/$app/pubspec.yaml"
  local settings="$REPO_ROOT/apps/$app/android/settings.gradle"
  local appgr="$REPO_ROOT/apps/$app/android/app/build.gradle"
  if [ -f "$pubspec" ] && grep -qE '^[[:space:]]*(firebase_core|firebase_messaging)[[:space:]]*:' "$pubspec"; then
    return 0
  fi
  if [ -f "$settings" ] && grep -q 'com\.google\.gms\.google-services' "$settings"; then
    return 0
  fi
  if [ -f "$appgr" ] && grep -qE '^[[:space:]]*apply[[:space:]]+plugin:[[:space:]]*"com\.google\.gms\.google-services"' "$appgr"; then
    return 0
  fi
  return 1
}

# The keystore filename and alias for an app's ACTION LINES, taken from the
# COMMITTED template (android/signing.properties.example) rather than invented
# here, so this script never names key material it made up.
#
# The fallbacks cover both "the template is gone" and "the template is there
# but its storeFile/keyAlias line was edited away": a keytool command with an
# empty -keystore would be worse than no command at all.
#
# 4096-bit RSA and PKCS12 are the template's own terms — PKCS12 because JKS is
# a proprietary format keytool itself warns about on every use, and 4096
# because an upload key signs every future update of the app and cannot be
# rotated without Google Play's key-reset process.
keytool_command_for() {
  local app="$1" short example keystore key_alias
  short="${app%-app}"
  example="$REPO_ROOT/apps/$app/android/signing.properties.example"
  keystore="$(first_match "$example" '^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*(.+)$')"
  key_alias="$(first_match "$example" '^[[:space:]]*keyAlias[[:space:]]*=[[:space:]]*(.+)$')"
  [ -n "$keystore" ] || keystore="abny-$short-upload.jks"
  [ -n "$key_alias" ] || key_alias="abny-$short-upload"
  printf 'keytool -genkeypair -v -keystore %s -alias %s -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12' \
    "$keystore" "$key_alias"
}

head_line 'ABNY / «ابني» — release doctor'

if ! read_pins "$REPO_ROOT"; then
  echo "release-doctor: could not derive the repository's own pins; refusing to grade anything against guessed values." >&2
  exit 2
fi

if [ "$QUIET" != "yes" ]; then
  printf '  repository : %s\n' "$REPO_ROOT"
  printf '  profile    : %s\n' "$PROFILE"
  printf '  pins read from the repository (never hardcoded here):\n'
  printf '    Flutter %s | JDK %s | Gradle %s | AGP %s | Kotlin %s\n' \
    "$PIN_FLUTTER" "$PIN_JAVA_MAJOR" "$PIN_GRADLE" "$PIN_AGP" "$PIN_KOTLIN"
  printf '    compileSdk %s | targetSdk %s | minSdk %s | Dart "%s"\n' \
    "$PIN_COMPILE_SDK" "$PIN_TARGET_SDK" "$PIN_MIN_SDK" "$PIN_DART_SDK"
  printf '    build-tools %s (DERIVED from compileSdk — not declared by either app)\n' "$PIN_BUILD_TOOLS"
  printf '\n'
fi

# ===========================================================================
# 1. Flutter
# ===========================================================================
if have flutter; then
  FLUTTER_RAW="$(flutter --version 2>/dev/null | head -n 1)"
  GOT_FLUTTER="$(printf '%s' "$FLUTTER_RAW" | sed -nE 's/^Flutter[[:space:]]+([0-9][0-9.]*).*/\1/p')"
  if [ -z "$GOT_FLUTTER" ]; then
    row WARN "Flutter version" "on PATH, version unparseable: ${FLUTTER_RAW:-<empty>}" \
      "Run 'flutter --version' by hand; this repository needs exactly $PIN_FLUTTER."
  elif [ "$GOT_FLUTTER" = "$PIN_FLUTTER" ]; then
    row PASS "Flutter version" "$GOT_FLUTTER (matches the pin)" ""
  else
    row BLOCKED "Flutter version" "$GOT_FLUTTER, repository pins $PIN_FLUTTER" \
      "Run 'flutter version $PIN_FLUTTER' (or use fvm). Flutter 3.27+ defaults compileSdk to 35 and AGP $PIN_AGP refuses anything above $PIN_COMPILE_SDK, so a build on the wrong SDK proves nothing about the pinned one."
  fi
else
  row BLOCKED "Flutter version" "not installed (no 'flutter' on PATH)" \
    "Install Flutter $PIN_FLUTTER: on Windows run 'powershell -ExecutionPolicy Bypass -File scripts/setup-windows-dev.ps1'; on Linux/macOS 'git clone -b $PIN_FLUTTER --depth 1 https://github.com/flutter/flutter.git \$HOME/flutter && export PATH=\$PATH:\$HOME/flutter/bin'. Needs storage.googleapis.com reachable."
fi

# ===========================================================================
# 2. Dart
# ===========================================================================
if have dart; then
  GOT_DART="$(dart --version 2>&1 | sed -nE 's/.*version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  if [ -z "$GOT_DART" ]; then
    row WARN "Dart version" "on PATH, version unparseable" \
      "Run 'dart --version'; the repository's constraint is \"$PIN_DART_SDK\"."
  else
    semver_in_constraint "$GOT_DART" "$PIN_DART_SDK"; sat=$?
    if [ "$sat" -eq 0 ]; then
      row PASS "Dart version" "$GOT_DART (satisfies \"$PIN_DART_SDK\")" ""
    elif [ "$sat" -eq 1 ]; then
      row BLOCKED "Dart version" "$GOT_DART violates \"$PIN_DART_SDK\"" \
        "pubspec.yaml's environment.sdk is the constraint; 'flutter pub get' will refuse. Install the Dart bundled with Flutter $PIN_FLUTTER instead of a standalone SDK."
    else
      row WARN "Dart version" "$GOT_DART, constraint \"$PIN_DART_SDK\" not machine-comparable" \
        "Compare by hand — this script abstains rather than claim a pass it cannot prove."
    fi
  fi
else
  row BLOCKED "Dart version" "not installed (no 'dart' on PATH)" \
    "Dart ships INSIDE Flutter — installing Flutter $PIN_FLUTTER (row above) provides it at <flutter>/bin/dart. Do not install a standalone Dart SDK; it can drift from the Flutter pin."
fi

# ===========================================================================
# 3. Java
# ===========================================================================
if have java; then
  GOT_JAVA_MAJOR="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+)(\.[0-9]+)*.*".*/\1/p' | head -n 1)"
  if [ -z "$GOT_JAVA_MAJOR" ]; then
    row WARN "Java version" "on PATH, version unparseable" "Run 'java -version'; this repository needs JDK $PIN_JAVA_MAJOR."
  elif [ "$GOT_JAVA_MAJOR" = "$PIN_JAVA_MAJOR" ]; then
    row PASS "Java version" "JDK $GOT_JAVA_MAJOR (matches the pin)" ""
  else
    row BLOCKED "Java version" "JDK $GOT_JAVA_MAJOR, repository needs JDK $PIN_JAVA_MAJOR" \
      "gradle-wrapper.properties pins Gradle $PIN_GRADLE, which only learned to RUN on JDK 21 in 8.5 — on JDK $GOT_JAVA_MAJOR the Android build dies with 'Unsupported class file major version' before compiling anything. Install Temurin $PIN_JAVA_MAJOR and set JAVA_HOME to it (current JAVA_HOME=${JAVA_HOME:-<unset>})."
  fi
else
  row BLOCKED "Java version" "not installed (no 'java' on PATH)" \
    "Install Temurin JDK $PIN_JAVA_MAJOR and set JAVA_HOME. Android Gradle Plugin $PIN_AGP will not run without it."
fi

# ===========================================================================
# 4. Android SDK, platforms, build-tools
# ===========================================================================
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -n "$SDK_ROOT" ] && [ -d "$SDK_ROOT" ]; then
  row PASS "Android SDK root" "$SDK_ROOT" ""

  PLATFORM_DIR="$SDK_ROOT/platforms/android-$PIN_COMPILE_SDK"
  if [ -d "$PLATFORM_DIR" ]; then
    row PASS "Android platform" "android-$PIN_COMPILE_SDK present" ""
  else
    INSTALLED_PLATFORMS="$(ls "$SDK_ROOT/platforms" 2>/dev/null | tr '\n' ' ')"
    row BLOCKED "Android platform" "android-$PIN_COMPILE_SDK missing (present: ${INSTALLED_PLATFORMS:-none})" \
      "Run: sdkmanager \"platforms;android-$PIN_COMPILE_SDK\". compileSdk $PIN_COMPILE_SDK comes from apps/*/android/app/build.gradle."
  fi

  BT_DIR="$SDK_ROOT/build-tools/$PIN_BUILD_TOOLS"
  if [ -d "$BT_DIR" ]; then
    row PASS "Android build-tools" "$PIN_BUILD_TOOLS present (derived from compileSdk)" ""
  else
    INSTALLED_BT="$(ls "$SDK_ROOT/build-tools" 2>/dev/null | tr '\n' ' ')"
    if [ -n "$INSTALLED_BT" ]; then
      row WARN "Android build-tools" "$PIN_BUILD_TOOLS absent (present: $INSTALLED_BT)" \
        "Neither app declares buildToolsVersion, so AGP $PIN_AGP picks its own default and one of the above may well satisfy it. Run 'sdkmanager \"build-tools;$PIN_BUILD_TOOLS\"' to match the derivation exactly."
    else
      row BLOCKED "Android build-tools" "none installed" \
        "Run: sdkmanager \"build-tools;$PIN_BUILD_TOOLS\" (derived as compileSdk.0.0 — no buildToolsVersion is declared by either app)."
    fi
  fi
else
  row BLOCKED "Android SDK root" "ANDROID_HOME and ANDROID_SDK_ROOT are both unset or point nowhere" \
    "Install the Android cmdline-tools, then: export ANDROID_HOME=\$HOME/Android/sdk; sdkmanager --licenses; sdkmanager \"platform-tools\" \"platforms;android-$PIN_COMPILE_SDK\" \"build-tools;$PIN_BUILD_TOOLS\". Needs dl.google.com reachable."
  row BLOCKED "Android platform" "cannot check android-$PIN_COMPILE_SDK — no SDK root" \
    "Resolve the Android SDK root row first."
  row BLOCKED "Android build-tools" "cannot check $PIN_BUILD_TOOLS — no SDK root" \
    "Resolve the Android SDK root row first."
fi

# ===========================================================================
# 5. Gradle — the WRAPPER is the contract, not whatever is on PATH
# ===========================================================================
WRAPPER_OK="yes"
for app in $PIN_APPS; do
  [ -f "$REPO_ROOT/apps/$app/android/gradle/wrapper/gradle-wrapper.jar" ] || WRAPPER_OK="no"
done

# `$HOME` is read through a default too: it is genuinely unset in some CI
# containers, and under `set -u` a bare `$HOME` here killed the whole run four
# rows before the ones an operator most needs to read.
GRADLE_DIST_CACHE="${GRADLE_USER_HOME:-${HOME:-}/.gradle}/wrapper/dists"
DIST_CACHED="no"
if [ -d "$GRADLE_DIST_CACHE" ]; then
  if ls -d "$GRADLE_DIST_CACHE"/gradle-"$PIN_GRADLE"-* >/dev/null 2>&1; then DIST_CACHED="yes"; fi
fi

if [ "$WRAPPER_OK" = "no" ]; then
  row BLOCKED "Gradle wrapper" "gradle-wrapper.jar missing in at least one app" \
    "Restore it from git ('git checkout -- apps/*/android/gradle/wrapper/'). Never regenerate it with a different Gradle than the pinned $PIN_GRADLE."
elif [ "$DIST_CACHED" = "yes" ]; then
  row PASS "Gradle $PIN_GRADLE" "wrapper present and distribution cached" ""
else
  SYS_GRADLE=""
  have gradle && SYS_GRADLE="$(gradle --version 2>/dev/null | sed -nE 's/^Gradle[[:space:]]+([0-9.]+).*/\1/p' | head -n 1)"
  if [ -n "$SYS_GRADLE" ] && [ "$SYS_GRADLE" != "$PIN_GRADLE" ]; then
    row BLOCKED "Gradle $PIN_GRADLE" "distribution not cached; 'gradle' on PATH is $SYS_GRADLE" \
      "The first ./gradlew run downloads gradle-$PIN_GRADLE-bin.zip from services.gradle.org — reachability required. Do NOT substitute the $SYS_GRADLE on PATH: the wrapper pin is what AGP $PIN_AGP was validated against."
  else
    row BLOCKED "Gradle $PIN_GRADLE" "distribution not cached under $GRADLE_DIST_CACHE" \
      "Run './gradlew --version' inside apps/<app>/android once with services.gradle.org reachable; the wrapper then caches gradle-$PIN_GRADLE for every later build."
  fi
fi

# ===========================================================================
# 6. git status
# ===========================================================================
if have git && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)"
  # Defaulted at the point of use: a failed `git status` inside the pipeline
  # yields an EMPTY string, and `[ "" -eq 0 ]` is a shell error, not a false.
  DIRTY_COUNT="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  DIRTY_COUNT="${DIRTY_COUNT:-0}"
  if [ "$DIRTY_COUNT" -eq 0 ]; then
    row PASS "git status" "clean on '$BRANCH'" ""
  else
    row WARN "git status" "$DIRTY_COUNT uncommitted path(s) on '$BRANCH'" \
      "A store artifact should be reproducible from a commit. Run 'git status --short', then commit or stash before building a release."
  fi
else
  row WARN "git status" "not a git working tree" \
    "Build from a checkout, so the artifact can be traced to a commit."
fi

# ===========================================================================
# 7. pubspec.lock
# ===========================================================================
for app in $PIN_APPS; do
  LOCK="$REPO_ROOT/apps/$app/pubspec.lock"
  if [ -f "$LOCK" ]; then
    PKG_COUNT="$(sed -nE 's/^  ([a-z0-9_]+):$/\1/p' "$LOCK" | wc -l | tr -d ' ')"
    row PASS "pubspec.lock ($app)" "present, $PKG_COUNT packages" ""
  else
    row BLOCKED "pubspec.lock ($app)" "absent" \
      "Run 'flutter pub get' in apps/$app (needs pub.dev reachable). Until this file exists and is committed, two builds of the same commit can resolve DIFFERENT dependency versions, so no artifact is reproducible."
  fi
done

# ===========================================================================
# 8. Firebase configuration
# ===========================================================================
# GRADED PER APP, FROM WHAT THE APP ACTUALLY DECLARES — see `uses_firebase`.
# This row used to demand the file from BOTH apps and BLOCK a release on the
# child app's absent one: a requirement the repository does not have, invented
# by the one script whose job is to name the real ones.
for app in $PIN_APPS; do
  GS="$REPO_ROOT/apps/$app/android/app/google-services.json"
  # Initialised before the case, so an app added to PIN_APPS without a branch
  # here cannot read an UNSET variable under `set -u` and take the whole run
  # down with it. The empty value is then reported rather than compared.
  EXPECT_ID=""
  case "$app" in
    parent-app) EXPECT_ID="$PIN_PARENT_APP_ID" ;;
    child-app)  EXPECT_ID="$PIN_CHILD_APP_ID" ;;
  esac
  if [ -z "$EXPECT_ID" ]; then
    row BLOCKED "Firebase config ($app)" "no applicationId known for this app" \
      "scripts/lib/repo-pins.sh exports one PIN_*_APP_ID per app and this script maps them by name; '$app' has no branch. Add it there rather than comparing against an empty string."
    continue
  fi

  if ! uses_firebase "$app"; then
    if [ -f "$GS" ]; then
      row WARN "Firebase config ($app)" "google-services.json present but NOTHING READS IT" \
        "apps/$app declares no firebase_core/firebase_messaging in pubspec.yaml, its android/settings.gradle does not carry com.google.gms.google-services and app/build.gradle never applies it, so this file is inert. Either add the Firebase dependencies (this row will then require the file) or delete it, so it does not read as configured push."
    else
      row PASS "Firebase config ($app)" "not required — this app declares no Firebase dependency" ""
    fi
    continue
  fi

  if [ -f "$GS" ]; then
    if grep -q "$EXPECT_ID" "$GS" 2>/dev/null; then
      row PASS "Firebase config ($app)" "google-services.json present for $EXPECT_ID" ""
    else
      row BLOCKED "Firebase config ($app)" "google-services.json does NOT mention $EXPECT_ID" \
        "This file belongs to a different Android app. FCM registration will fail at runtime with a mismatched sender. Re-download it for applicationId $EXPECT_ID."
    fi
  elif [ "$PROFILE" = "release" ]; then
    row BLOCKED "Firebase config ($app)" "google-services.json absent" \
      "OPERATOR MUST SUPPLY. Create the Firebase Android app for applicationId $EXPECT_ID, download google-services.json and place it at apps/$app/android/app/google-services.json (CI reads it from the GOOGLE_SERVICES_JSON secret instead). Nothing in this repository can generate it. The build SUCCEEDS without it — the default -Pabny.firebase=auto only warns — so a release in that state ships an artifact whose every push notification silently never arrives. See docs/release/FIREBASE_SETUP.md."
  else
    row WARN "Firebase config ($app)" "google-services.json absent (debug profile)" \
      "Debug builds proceed: abny.firebase=auto only warns, and PushRegistrationService catches the init failure. No push notification can be delivered by this artifact."
  fi
done

FIREBASE_OPTIONS="$REPO_ROOT/apps/parent-app/lib/firebase_options.dart"
if [ -f "$FIREBASE_OPTIONS" ]; then
  row PASS "firebase_options.dart" "present (parent-app)" ""
elif [ "$PROFILE" = "release" ]; then
  row BLOCKED "firebase_options.dart" "absent (parent-app)" \
    "Only 'flutterfire configure' can generate it, against a real Firebase project. Without it Firebase.initializeApp() throws, PushRegistrationService returns early, and no FCM token is ever registered."
else
  row WARN "firebase_options.dart" "absent (parent-app)" \
    "Debug builds proceed; push stays unavailable. Generate with 'flutterfire configure' when a Firebase project exists."
fi

# ===========================================================================
# 9. Signing configuration
#
# THE FILE THE GRADLE ACTUALLY READS IS `signing.properties`, NOT
# `key.properties`. This section checked the latter — Flutter's template name —
# while both apps' android/app/build.gradle read
# `rootProject.file("signing.properties")`, both android/.gitignore files
# ignore `signing.properties` (committing `signing.properties.example` by
# negation), and .github/workflows/build-apk.yml writes
# `android/signing.properties` before its release build. The doctor could
# therefore PASS an operator who had created key.properties, and their release
# build would stop in the task-graph guard with "signing.properties is
# MISSING": the doctor passing something the build fails on.
#
# The four KEY NAMES are the same in both files, so the parsing is unchanged;
# the filename, the action lines and the keytool invocation moved.
# ===========================================================================
for app in $PIN_APPS; do
  ANDROID_DIR="$REPO_ROOT/apps/$app/android"
  SIGNPROPS="$ANDROID_DIR/signing.properties"
  SIGNEXAMPLE="$ANDROID_DIR/signing.properties.example"
  KEYTOOL_CMD="$(keytool_command_for "$app")"

  # The template is the operator's instructions and the source of the keystore
  # name and alias above. Its absence does not block a build, but it is why the
  # action lines can name a file instead of inventing one.
  if [ ! -f "$SIGNEXAMPLE" ]; then
    row WARN "Signing template ($app)" "android/signing.properties.example is missing" \
      "It is the committed template and holds the full keytool invocation. Restore it: git checkout -- apps/$app/android/signing.properties.example"
  fi

  if [ -f "$SIGNPROPS" ]; then
    MISSING_KEYS=""
    for k in storeFile storePassword keyAlias keyPassword; do
      # `=\s*\S` and not `=`: the gradle treats a present-but-EMPTY value as
      # missing, so this must too, or the doctor passes a file the task-graph
      # guard rejects — the same class of defect as the filename above.
      grep -qE "^[[:space:]]*$k[[:space:]]*=[[:space:]]*[^[:space:]]" "$SIGNPROPS" \
        || MISSING_KEYS="$MISSING_KEYS $k"
    done
    if [ -n "$MISSING_KEYS" ]; then
      row BLOCKED "Signing ($app)" "signing.properties present but missing/empty:$MISSING_KEYS" \
        "apps/$app/android/app/build.gradle stops every release task unless all four of storeFile, storePassword, keyAlias, keyPassword are set AND non-empty. A partial signing config is not signed 'less', it is not signed. Fill them in apps/$app/android/signing.properties — see signing.properties.example."
    else
      STORE_REL="$(sed -nE 's/^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*(.+)$/\1/p' "$SIGNPROPS" | head -n 1 | tr -d '\r')"
      STORE_ABS="$ANDROID_DIR/$STORE_REL"
      RESOLVED=""
      if [ -f "$STORE_ABS" ]; then RESOLVED="$STORE_ABS"; elif [ -f "$STORE_REL" ]; then RESOLVED="$STORE_REL"; fi
      if [ -z "$RESOLVED" ]; then
        row BLOCKED "Signing ($app)" "keystore not found at '$STORE_REL'" \
          "storeFile is resolved RELATIVE TO apps/$app/android/ by app/build.gradle. Place the .jks there, use an absolute path, or generate one: cd apps/$app/android && $KEYTOOL_CMD"
      else
        # L3, mirrored from app/build.gradle. The gradle refuses a release whose
        # keystore looks like the debug one; a doctor that passed it would send
        # the operator into a build that stops ten minutes later. THIS IS THE
        # ROW THAT PROVES A RELEASE CANNOT FALL BACK TO A DEBUG KEY: the gradle
        # refuses it, and this refuses it earlier and by name.
        LEAF="$(basename "$RESOLVED" | tr '[:upper:]' '[:lower:]')"
        NORM="$(printf '%s' "$RESOLVED" | tr '[:upper:]' '[:lower:]')"
        case "$LEAF:$NORM" in
          debug.keystore:*|debug.jks:*|*:*/.android/debug*)
            row BLOCKED "Signing ($app)" "storeFile points at what looks like a DEBUG keystore: $RESOLVED" \
              "app/build.gradle's L3 identity assertion fails this build by name. The debug key is a well-known machine-local throwaway; an artifact signed with it can never be uploaded to Play and never updated. Generate a real upload key: cd apps/$app/android && $KEYTOOL_CMD" ;;
          *)
            row PASS "Signing ($app)" "signing.properties complete, keystore $LEAF found" "" ;;
        esac
      fi
    fi
  elif [ "$PROFILE" = "release" ]; then
    row BLOCKED "Signing ($app)" "android/signing.properties absent" \
      "OPERATOR MUST SUPPLY. No release keystore = no store artifact, and app/build.gradle will NOT fall back to the debug key — it stops the release task with a named message. Do exactly this: cd apps/$app/android && $KEYTOOL_CMD && cp signing.properties.example signing.properties, then fill storeFile / storePassword / keyAlias / keyPassword. Both signing.properties and *.jks are gitignored (apps/$app/android/.gitignore) — never commit either. Debug builds are unaffected."
  else
    row WARN "Signing ($app)" "android/signing.properties absent (debug profile)" \
      "Debug builds use the debug key and are unaffected. A release build stops in the task-graph guard rather than falling back to it."
  fi

  # A signing file that is NOT ignored is key material one `git add` away from
  # the history. The gitignore is committed, so this is checkable statically.
  GITIGNORE="$ANDROID_DIR/.gitignore"
  if [ -f "$GITIGNORE" ]; then
    UNIGNORED=""
    grep -qE '^[[:space:]]*signing\.properties[[:space:]]*$' "$GITIGNORE" || UNIGNORED="$UNIGNORED signing.properties"
    grep -qE '^[[:space:]]*\*\.jks[[:space:]]*$' "$GITIGNORE" || UNIGNORED="$UNIGNORED *.jks"
    if [ -n "$UNIGNORED" ]; then
      row BLOCKED "Signing gitignore ($app)" "not ignored:$UNIGNORED" \
        "apps/$app/android/.gitignore must ignore signing.properties and *.jks (and keep !signing.properties.example). Key material one 'git add' from the history is key material already lost."
    else
      row PASS "Signing gitignore ($app)" "signing.properties and *.jks are gitignored" ""
    fi
  else
    row BLOCKED "Signing gitignore ($app)" "apps/$app/android/.gitignore is missing" \
      "Without it the keystore and its three passwords are committable by accident. Restore it: git checkout -- apps/$app/android/.gitignore"
  fi
done

# ===========================================================================
# 9b. The version the release AAB will carry
#
# app/build.gradle REFUSES to package a release on a fallback version, and the
# single source of both halves is pubspec.yaml's `version: <name>+<code>` line
# (flutter build copies it into android/local.properties). A pubspec with no
# `+<code>` builds debug happily and stops the release — a build failure this
# doctor can predict from a committed file, so it should.
# ===========================================================================
for app in $PIN_APPS; do
  PUBSPEC="$REPO_ROOT/apps/$app/pubspec.yaml"
  APP_VERSION="$(first_match "$PUBSPEC" '^version:[[:space:]]*([^[:space:]]+)[[:space:]]*$')"
  if [ -z "$APP_VERSION" ]; then
    row BLOCKED "App version ($app)" "pubspec.yaml declares no version:" \
      "Add 'version: <name>+<code>' to apps/$app/pubspec.yaml. app/build.gradle stops any release task on a fallback version, because Play accepts versionCode 1 exactly once and then blocks every later upload."
  elif ! printf '%s' "$APP_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$'; then
    row BLOCKED "App version ($app)" "pubspec version '$APP_VERSION' has no +<versionCode>" \
      "app/build.gradle's release guard refuses a FALLBACK versionCode. Write it as '<name>+<code>', e.g. '0.1.0+1'. CI overrides the CODE half per upload via ORG_GRADLE_PROJECT_abnyVersionCode."
  else
    row PASS "App version ($app)" "$APP_VERSION (versionName+versionCode, single source)" ""
  fi
done

# ===========================================================================
# 9c. The deep-link scheme, in both manifests
#
# The scheme is READ FROM THE SERVER'S REGISTRY, never typed here: the backend
# is authoritative for `abny://<surface>` and both clients route on what it
# emits. If the two ever disagree, every notification tap in the product lands
# nowhere and no other row in this file would see it.
# ===========================================================================
DEST_REGISTRY="$REPO_ROOT/apps/backend/src/modules/notifications/domain/engine/notification-destination.ts"
DEEP_LINK_SCHEME="$(first_match "$DEST_REGISTRY" "DEEP_LINK_SCHEME[[:space:]]*=[[:space:]]*'([a-z][a-z0-9+.-]*)'")"
if [ -z "$DEEP_LINK_SCHEME" ]; then
  row WARN "Deep-link scheme" "could not read DEEP_LINK_SCHEME from the notification registry" \
    "Expected at apps/backend/src/modules/notifications/domain/engine/notification-destination.ts. Fix this check rather than guessing the scheme."
else
  for app in $PIN_APPS; do
    MANIFEST="$REPO_ROOT/apps/$app/android/app/src/main/AndroidManifest.xml"
    [ -f "$MANIFEST" ] || continue
    if grep -qE "android:scheme[[:space:]]*=[[:space:]]*\"$DEEP_LINK_SCHEME\"" "$MANIFEST"; then
      row PASS "Deep-link scheme ($app)" "$DEEP_LINK_SCHEME:// declared in an intent-filter" ""
    else
      # WARN and not BLOCKED, and the distinction is the whole point of the
      # grading scale: nothing about the BUILD depends on this, and the in-app
      # notification tap works without it (the link travels on the FCM data
      # payload and is routed in Dart). What is missing is the OS-LEVEL
      # registration — a link tapped in a browser, a message or an e-mail
      # resolves to no app on the device.
      row WARN "Deep-link scheme ($app)" "no <data android:scheme=\"$DEEP_LINK_SCHEME\"> intent-filter" \
        "apps/$app/android/app/src/main/AndroidManifest.xml declares no intent-filter for $DEEP_LINK_SCHEME://, so the OS cannot resolve such a link to this app. In-app notification taps are UNAFFECTED, which is why this is WARN. Run 'python3 scripts/verify_notification_permission.py' for the full end-to-end check (filter categories, the launcher filter, and the Dart cold-start handler)."
    fi
  done
fi

# ===========================================================================
# 10. Package IDs
# ===========================================================================
if [ "$PIN_PARENT_APP_ID" = "$PIN_CHILD_APP_ID" ]; then
  row BLOCKED "Package IDs" "both apps declare $PIN_PARENT_APP_ID" \
    "Two apps cannot share an applicationId — the second install replaces the first. Fix apps/*/android/app/build.gradle."
else
  row PASS "Package IDs" "parent=$PIN_PARENT_APP_ID child=$PIN_CHILD_APP_ID" ""
fi

# ===========================================================================
# 11. Required permissions
# ===========================================================================
for app in $PIN_APPS; do
  MANIFEST="$REPO_ROOT/apps/$app/android/app/src/main/AndroidManifest.xml"
  if [ ! -f "$MANIFEST" ]; then
    row BLOCKED "Permissions ($app)" "AndroidManifest.xml not found" \
      "Expected at apps/$app/android/app/src/main/AndroidManifest.xml."
    continue
  fi
  PERM_COUNT="$(grep -cE '<uses-permission[[:space:]]' "$MANIFEST" 2>/dev/null | tr -d ' ')"
  if grep -q 'android.permission.INTERNET' "$MANIFEST" && \
     grep -q 'android.permission.POST_NOTIFICATIONS' "$MANIFEST"; then
    row PASS "Permissions ($app)" "$PERM_COUNT declared, incl. INTERNET + POST_NOTIFICATIONS" ""
  else
    MISSING=""
    grep -q 'android.permission.INTERNET' "$MANIFEST" || MISSING="$MISSING INTERNET"
    grep -q 'android.permission.POST_NOTIFICATIONS' "$MANIFEST" || MISSING="$MISSING POST_NOTIFICATIONS"
    row BLOCKED "Permissions ($app)" "$PERM_COUNT declared, missing:$MISSING" \
      "Add the <uses-permission> element(s) to $MANIFEST. Without INTERNET the app reaches no backend; without POST_NOTIFICATIONS nothing this app posts is visible on Android 13+."
  fi
done

# A DECLARED notification permission that is never REQUESTED is the exact
# defect G18 fixed, and it is invisible to every other check in this file —
# so the dedicated checker is consulted here rather than re-implemented.
NOTIF_CHECKER="$SCRIPT_DIR/verify_notification_permission.py"
if [ -f "$NOTIF_CHECKER" ] && have python3; then
  if NOTIF_OUT="$(python3 "$NOTIF_CHECKER" 2>&1)"; then
    row PASS "POST_NOTIFICATIONS request" "every declaring app also requests it at runtime" ""
  else
    row BLOCKED "POST_NOTIFICATIONS request" "declared but never requested in at least one app" \
      "Run 'python3 scripts/verify_notification_permission.py' for the per-app detail. On Android 13+ an unrequested POST_NOTIFICATIONS means notifications silently never appear."
  fi
elif [ ! -f "$NOTIF_CHECKER" ]; then
  row WARN "POST_NOTIFICATIONS request" "checker scripts/verify_notification_permission.py not found" \
    "Restore it: it is the only check that catches a permission declared in the manifest but never requested at runtime."
else
  row WARN "POST_NOTIFICATIONS request" "python3 not available to run the checker" \
    "Install python3, then run 'python3 scripts/verify_notification_permission.py'."
fi

# ===========================================================================
# verdict
# ===========================================================================
head_line 'VERDICT'
printf '  PASS %s   WARN %s   BLOCKED %s\n\n' "$N_PASS" "$N_WARN" "$N_BLOCKED"

if [ "$N_BLOCKED" -gt 0 ]; then
  printf '  %sBLOCKED — this machine cannot produce a trustworthy %s artifact yet.%s\n' "$C_RED" "$PROFILE" "$C_RESET"
  printf '  The blocking rows, in the order worth fixing:\n'
  printf '%s' "$ROWS" | awk -F'|' '$1 == "BLOCKED" { printf "    - %s: %s\n", $2, $3 }'
  printf '\n  Nothing was installed, downloaded or modified by this run.\n'
  exit 1
fi

if [ "$N_WARN" -gt 0 ]; then
  printf '  %sPASS WITH WARNINGS — a %s build can be attempted; the WARN rows above are real gaps.%s\n' \
    "$C_YEL" "$PROFILE" "$C_RESET"
else
  printf '  %sPASS — every checked requirement for a %s artifact is met.%s\n' "$C_GRN" "$PROFILE" "$C_RESET"
fi
exit 0
