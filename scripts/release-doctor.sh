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
# STATUS OF THIS FILE: EXECUTED. Unlike the mobile artifacts it inspects,
# this script has actually been run — in an environment with no Flutter, no
# Dart, no Android SDK and a proxy that refuses pub.dev / dl.google.com — and
# its BLOCKED output there is the proof it reports the truth rather than a
# hopeful green. See docs/../PHASE-G-Ship-Report.md.
#
# Usage:
#   scripts/release-doctor.sh [--profile release|debug] [--repo <path>] [--quiet]
# ===========================================================================

set -uo pipefail

PROFILE="release"
QUIET="no"
REPO_ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      case "$PROFILE" in
        release|debug) ;;
        *) echo "release-doctor: --profile must be 'release' or 'debug'." >&2; exit 2 ;;
      esac
      shift 2 ;;
    --repo)   REPO_ROOT="${2:-}"; shift 2 ;;
    --quiet)  QUIET="yes"; shift ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

GRADLE_DIST_CACHE="${GRADLE_USER_HOME:-$HOME/.gradle}/wrapper/dists"
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
  DIRTY_COUNT="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
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
for app in $PIN_APPS; do
  GS="$REPO_ROOT/apps/$app/android/app/google-services.json"
  case "$app" in
    parent-app) EXPECT_ID="$PIN_PARENT_APP_ID" ;;
    child-app)  EXPECT_ID="$PIN_CHILD_APP_ID" ;;
  esac
  if [ -f "$GS" ]; then
    if grep -q "$EXPECT_ID" "$GS" 2>/dev/null; then
      row PASS "Firebase config ($app)" "google-services.json present for $EXPECT_ID" ""
    else
      row BLOCKED "Firebase config ($app)" "google-services.json does NOT mention $EXPECT_ID" \
        "This file belongs to a different Android app. FCM registration will fail at runtime with a mismatched sender. Re-download it for applicationId $EXPECT_ID."
    fi
  elif [ "$PROFILE" = "release" ]; then
    row BLOCKED "Firebase config ($app)" "google-services.json absent" \
      "See docs/release/FIREBASE_SETUP.md: create the Firebase Android app for $EXPECT_ID and place google-services.json at apps/$app/android/app/. The build SUCCEEDS without it (abny.firebase=auto only warns) but the artifact has no push notifications at all — a store release in that state ships an invisible notification engine."
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
# ===========================================================================
for app in $PIN_APPS; do
  KEYPROPS="$REPO_ROOT/apps/$app/android/key.properties"
  if [ -f "$KEYPROPS" ]; then
    MISSING_KEYS=""
    for k in storeFile storePassword keyAlias keyPassword; do
      grep -qE "^[[:space:]]*$k[[:space:]]*=" "$KEYPROPS" || MISSING_KEYS="$MISSING_KEYS $k"
    done
    if [ -n "$MISSING_KEYS" ]; then
      row BLOCKED "Signing ($app)" "key.properties present but missing:$MISSING_KEYS" \
        "app/build.gradle fails the release build unless all four of storeFile, storePassword, keyAlias, keyPassword are set. Add them to apps/$app/android/key.properties."
    else
      STORE_REL="$(sed -nE 's/^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*(.+)$/\1/p' "$KEYPROPS" | head -n 1 | tr -d '\r')"
      STORE_ABS="$REPO_ROOT/apps/$app/android/$STORE_REL"
      if [ -f "$STORE_REL" ] || [ -f "$STORE_ABS" ]; then
        row PASS "Signing ($app)" "key.properties complete, keystore found" ""
      else
        row BLOCKED "Signing ($app)" "keystore not found at '$STORE_REL'" \
          "storeFile resolves relative to apps/$app/android/. Place the .jks there or correct the path; the release build refuses to fall back to the debug key (verified by scripts/verify_release_signing.py)."
      fi
    fi
  elif [ "$PROFILE" = "release" ]; then
    row BLOCKED "Signing ($app)" "android/key.properties absent" \
      "No release keystore = no store artifact. Create the keystore ('keytool -genkeypair -v -keystore abny-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias abny'), place it under apps/$app/android/, and write the four properties into apps/$app/android/key.properties (git-ignored). Debug builds are unaffected."
  else
    row WARN "Signing ($app)" "android/key.properties absent (debug profile)" \
      "Debug builds use the debug key and are unaffected. A release build will refuse."
  fi
done

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
