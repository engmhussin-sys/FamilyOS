#!/usr/bin/env bash
# ===========================================================================
# release-doctor.sh — THE SINGLE BUILD GATE.
# "Can this machine actually produce the artifact, and if not, what exactly do
# I type next?"
#
# WHAT IT IS
# One read-only diagnostic pass over the toolchain and the repository. It
# builds nothing, downloads nothing, installs nothing and changes nothing.
# Every check prints exactly one of PASS / WARN / BLOCKED and, when it is not
# PASS, one ACTIONABLE line — a command to run or a file to create, never
# "check your environment".
#
#   PASS     the requirement is met AND MEASURED. A check may only print PASS
#            when something was actually observed to be correct.
#   WARN     a real gap that does not stop a build being attempted, or a
#            requirement this run could not measure and refuses to claim.
#   BLOCKED  the build cannot start, or can only produce a false green.
#
# THE CLASSIFICATION IS DATA, NOT SCATTERED `if` BRANCHES. Every check has an
# id in CHECK_POLICY below, and that table — printed at the top of every run —
# decides whether a failure of that check is BLOCKED (required) or WARN
# (advisory). `fail_row <id>` is the only way a failure is graded, so the two
# halves of this doctor (.sh and .ps1) cannot drift: they carry the same table.
#
# THE TERMINAL LINE. If any check is BLOCKED, the LAST LINE this script prints
# is the literal, unindented verdict token that means "do not ship", and the
# exit code is 1. Nothing else in this file prints that token at the start of a
# line, so `release-doctor.sh | tail -1` is a usable gate in a pipeline.
#
# NO FALSE POSITIVES — THE RULE THIS FILE IS BUILT AROUND
# A check that "passes" because a command was missing, an environment variable
# was unset, a file was unreadable or a grep found nothing is a FALSE PASS, and
# a false pass is worse than no check at all. This repository has already
# shipped one: an earlier release-doctor passed `key.properties` while both
# apps' android/app/build.gradle read `signing.properties`, so the doctor was
# green on a machine whose release build then stopped in the Gradle task-graph
# guard. Every branch below was walked for that failure mode. Where a
# requirement genuinely cannot be measured on this machine, the row says
# NOT VERIFIED and grades WARN — it never says PASS.
#
# WHERE THE EXPECTED VALUES COME FROM
# All of them from the repository, at run time, via scripts/lib/repo-pins.sh
# (the bash half of `Get-RepoPins` in scripts/setup-windows-dev.ps1). No
# version in this file is typed from memory. If a pin moves in the Gradle files
# or the workflow, this script's expectations move with it — the only way a
# doctor stays honest over time.
#
# PROFILES
#   --profile release  (default) judges readiness for a SIGNED store artifact,
#                      so signing material, Firebase config, the release API
#                      URL and the lockfiles are graded as required.
#   --profile debug    judges readiness for `flutter build apk --debug` only.
#                      THE DEBUG APK NEEDS NO KEYSTORE AND NO FIREBASE, so
#                      those checks are advisory in this profile — see
#                      MOBILE_BUILD_HANDOFF.md §1.
#
# IT MUST COVER EVERY PRECONDITION `scripts/mobile-build.sh` DEPENDS ON.
# mobile-build runs `flutter pub get` (pub.dev), `flutter analyze`,
# `flutter test`, `flutter build apk --debug` (JDK + Android SDK + Gradle
# wrapper + platform + build-tools) and, with --release, the signing material,
# the Firebase config of the app that declares it, and an https API_BASE_URL
# supplied through RELEASE_API_BASE_URL / --api-base-url. If the build would
# fail on something this doctor passed, that is the defect to close.
#
# WHY THERE IS NO `set -e`, DELIBERATELY. This script's whole job is to keep
# probing a broken machine and report EVERY blocking row in one pass; `-e`
# would make the first failing probe the last thing it ever said. What `-e`
# would otherwise have caught is handled directly: `set -u` is on, every
# environment variable is read through `${VAR:-}`, every option that takes a
# value is checked BEFORE `shift 2`, and every command substitution whose
# emptiness would poison a later `[ ... -eq ... ]` is defaulted at the point of
# use.
#
# STATUS OF THIS FILE: STATIC VERIFIED and `bash -n` clean. The rows below were
# checked BY READING against the files they name — both pubspec.yaml, both
# android/app/build.gradle, both android/build.gradle, both settings.gradle,
# both gradle/wrapper/gradle-wrapper.properties, both AndroidManifest.xml, both
# android/.gitignore, both signing.properties.example, both
# lib/core/config/app_config.dart, apps/backend/.env.example and
# .github/workflows/build-apk.yml. The authoring environment has no Flutter, no
# Dart, no Android SDK, no JDK, no adb and no PowerShell, so NO row that
# reports on a toolchain has ever been observed printing PASS. NOT BUILD
# VERIFIED.
#
# Usage:
#   scripts/release-doctor.sh [--profile release|debug] [--repo <path>]
#                             [--quiet] [--no-network]
# ===========================================================================

set -uo pipefail

PROFILE="release"
QUIET="no"
REPO_ROOT=""
NO_NETWORK="no"

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
    --repo)       need_value "$@"; REPO_ROOT="$2"; shift 2 ;;
    --quiet)      QUIET="yes"; shift ;;
    # Skips the two OUTBOUND probes (pub.dev, services.gradle.org) and grades
    # them NOT VERIFIED / WARN instead. It does NOT turn them into a PASS.
    --no-network) NO_NETWORK="yes"; shift ;;
    -h|--help) sed -n '2,90p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# ===========================================================================
# THE CHECK POLICY TABLE — the whole classification, in one place.
#
#   id | policy | what the check proves
#
#   required          a failure is BLOCKED in every profile.
#   release-required  a failure is BLOCKED under --profile release and WARN
#                     under --profile debug, because the DEBUG APK genuinely
#                     does not need it.
#   advisory          a failure is WARN in every profile. A WARN NEVER BLOCKS.
#
# The `*-unverifiable` ids are deliberate and are the honest half of the
# no-false-positives rule: they cover "this machine cannot run the checker",
# which is neither a pass nor a proof of failure. They print WARN with the
# words NOT VERIFIED. They never print PASS.
# ===========================================================================
CHECK_POLICY='
flutter|required|Flutter SDK on PATH and equal to the pinned version
dart|required|Dart SDK on PATH and inside pubspec environment.sdk
java|required|JDK on PATH and equal to the pinned major version
java-home|required|JAVA_HOME set and pointing at a JDK that contains bin/java
android-sdk|required|ANDROID_HOME or ANDROID_SDK_ROOT set and a real SDK root
android-platform|required|platforms;android-<compileSdk> installed
android-buildtools|required|at least one build-tools package installed
buildtools-exact|advisory|build-tools <compileSdk>.0.0 exactly (none is declared)
adb|advisory|adb on PATH — needed to INSTALL an APK, not to BUILD one
gradle-wrapper|required|gradle-wrapper.jar committed in both apps
gradle-dist|required|the pinned Gradle is cached, or services.gradle.org answers
gradle-agp-sdk|required|compileSdk is inside this AGP version ceiling
sdk-levels|required|minSdk <= targetSdk <= compileSdk
pub-access|required|pub.dev answers — flutter pub get is mobile-build stage 1
pubspec-lock|release-required|pubspec.lock committed for both apps
packages|required|every package: import is declared in the owning pubspec
packages-unverifiable|advisory|the import checker could not be run on this machine
firebase-config|release-required|google-services.json for each app that declares Firebase
firebase-options|release-required|apps/parent-app/lib/firebase_options.dart exists
signing|release-required|signing.properties complete and naming a real non-debug keystore
signing-template|advisory|signing.properties.example present (source of the keytool line)
signing-gitignore|required|signing.properties and *.jks are gitignored
app-version|required|pubspec version is <name>+<code>
package-ids|required|the two apps declare different applicationIds
application-ids|required|namespace equals applicationId and is a legal package name
api-base-url|release-required|an https API_BASE_URL exists for the release build
permissions|required|INTERNET and POST_NOTIFICATIONS declared in both manifests
notif-request|required|POST_NOTIFICATIONS is also requested at runtime
notif-unverifiable|advisory|the notification checker could not be run on this machine
deep-link|advisory|the abny:// intent-filter is present in both manifests
git-clean|advisory|the working tree is clean, so the artifact traces to a commit
'

policy_of() {
  local id="$1" p
  p="$(printf '%s\n' "$CHECK_POLICY" | awk -F'|' -v id="$id" '$1 == id { print $2; exit }')"
  case "$p" in
    required)         printf 'required' ;;
    advisory)         printf 'advisory' ;;
    release-required) if [ "$PROFILE" = "release" ]; then printf 'required'; else printf 'advisory'; fi ;;
    *)                printf 'unknown' ;;
  esac
}

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
  printf '%s[%s]%s %-28s %s\n' "$colour" "$label" "$C_RESET" "$check" "$measured"
  if [ -n "$action" ] && [ "$status" != "PASS" ]; then
    printf '           %s-> %s%s\n' "$C_DIM" "$action" "$C_RESET"
  fi
}

# fail_row <policy-id> <check> <measured> <action>
# THE ONLY WAY A FAILURE IS GRADED. An id with no row in CHECK_POLICY is a bug
# in this script and is graded BLOCKED — an ungradeable check is never a pass.
fail_row() {
  local id="$1"
  case "$(policy_of "$id")" in
    required) row BLOCKED "$2" "$3" "$4" ;;
    advisory) row WARN    "$2" "$3" "$4" ;;
    *)        row BLOCKED "$2" "release-doctor BUG: no CHECK_POLICY row for id '$id' — $3" \
                  "Add '$id' to CHECK_POLICY in this file. A check whose severity is undefined cannot be a PASS." ;;
  esac
}

# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# ver_ge A B -> 0 when A >= B, numeric per component.
ver_ge() {
  local a="$1" b="$2"
  [ "$a" = "$b" ] && return 0
  local highest
  highest="$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)"
  [ "$highest" = "$a" ]
}

# Compares a measured semver against a Dart-style constraint ">=3.3.0 <4.0.0".
# 0 satisfies, 1 violates, 2 the constraint shape is not one this function
# understands — and the caller then BLOCKS rather than claiming a pass, because
# an unreadable constraint means the repository could not be measured at all.
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

# http_probe <url> -> 0 answered, 1 did not answer, 2 no probe tool here.
# `2` is never turned into a PASS by any caller.
http_probe() {
  local url="$1"
  if [ "$NO_NETWORK" = "yes" ]; then return 2; fi
  if have curl; then
    curl -fsS --max-time 15 -o /dev/null "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  if have wget; then
    wget -q -T 15 -O /dev/null "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  if have python3; then
    python3 - "$url" <<'PY' >/dev/null 2>&1 && return 0
import sys, urllib.request
urllib.request.urlopen(sys.argv[1], timeout=15).read(1)
PY
    return 1
  fi
  return 2
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
# gains the dependency, and disappears by itself if one drops it.
#
# EXIT 2 MEANS "COULD NOT DECIDE" and is a separate answer from "no". The
# previous version returned 1 (= no Firebase, requirement waived, row PASS)
# when the three files were simply MISSING — a grep that found nothing became a
# green row. A caller that gets 2 blocks instead.
uses_firebase() {
  local app="$1"
  local pubspec="$REPO_ROOT/apps/$app/pubspec.yaml"
  local settings="$REPO_ROOT/apps/$app/android/settings.gradle"
  local appgr="$REPO_ROOT/apps/$app/android/app/build.gradle"
  if [ ! -f "$pubspec" ] || [ ! -f "$settings" ] || [ ! -f "$appgr" ]; then
    return 2
  fi
  if grep -qE '^[[:space:]]*(firebase_core|firebase_messaging)[[:space:]]*:' "$pubspec"; then return 0; fi
  if grep -q 'com\.google\.gms\.google-services' "$settings"; then return 0; fi
  if grep -qE '^[[:space:]]*apply[[:space:]]+plugin:[[:space:]]*"com\.google\.gms\.google-services"' "$appgr"; then return 0; fi
  return 1
}

# The keystore filename and alias for an app's ACTION LINES, taken from the
# COMMITTED template (android/signing.properties.example) rather than invented
# here, so this script never names key material it made up. The fallbacks cover
# both "the template is gone" and "its storeFile/keyAlias line was edited away":
# a keytool command with an empty -keystore is worse than no command at all.
# 4096-bit RSA and PKCS12 are the template's own terms.
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

head_line 'ABNY / «ابني» — release doctor (the build gate)'

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
    "$PIN_COMPILE_SDK" "$PIN_TARGET_SDK" "$PIN_MIN_SDK" "${PIN_DART_SDK:-<unreadable>}"
  printf '    build-tools %s (DERIVED from compileSdk — not declared by either app)\n' "$PIN_BUILD_TOOLS"
  printf '\n'

  printf '  CHECK POLICY — what blocks, and what only warns (profile: %s)\n' "$PROFILE"
  printf '  %-24s %-9s %s\n' 'CHECK' 'ON FAIL' 'WHAT IT PROVES'
  printf '  %-24s %-9s %s\n' '-----' '-------' '---------------'
  printf '%s\n' "$CHECK_POLICY" | while IFS='|' read -r id pol title; do
    [ -n "${id:-}" ] || continue
    case "$pol" in
      required)         eff="BLOCKED" ;;
      advisory)         eff="WARN" ;;
      release-required) if [ "$PROFILE" = "release" ]; then eff="BLOCKED"; else eff="WARN"; fi ;;
      *)                eff="BUG" ;;
    esac
    printf '  %-24s %-9s %s\n' "$id" "$eff" "$title"
  done
  printf '\n'
fi

# ===========================================================================
# 1. Flutter
#
# FAILURE MODES, ALL THREE GRADED: absent (BLOCKED), present but the version
# string could not be parsed (BLOCKED — a required tool this run could not
# measure is not a pass), present and different from the pin (BLOCKED).
# ===========================================================================
if have flutter; then
  FLUTTER_RAW="$(flutter --version 2>/dev/null | head -n 1)"
  GOT_FLUTTER="$(printf '%s' "$FLUTTER_RAW" | sed -nE 's/^Flutter[[:space:]]+([0-9][0-9.]*).*/\1/p')"
  if [ -z "$GOT_FLUTTER" ]; then
    fail_row flutter "Flutter version" "on PATH but UNMEASURABLE: ${FLUTTER_RAW:-<no output>}" \
      "Run 'flutter --version' by hand. This repository pins exactly $PIN_FLUTTER (.github/workflows/build-apk.yml env.FLUTTER_VERSION). This row will not pass a Flutter it could not measure."
  elif [ "$GOT_FLUTTER" = "$PIN_FLUTTER" ]; then
    row PASS "Flutter version" "$GOT_FLUTTER (matches the pin)" ""
  else
    fail_row flutter "Flutter version" "$GOT_FLUTTER, repository pins $PIN_FLUTTER" \
      "Run 'flutter version $PIN_FLUTTER' (or use fvm). Flutter 3.27+ defaults compileSdk to 35 and AGP $PIN_AGP refuses anything above $PIN_COMPILE_SDK, so a build on the wrong SDK proves nothing about the pinned one."
  fi
else
  fail_row flutter "Flutter version" "not installed (no 'flutter' on PATH)" \
    "Install Flutter $PIN_FLUTTER: on Windows run 'powershell -ExecutionPolicy Bypass -File scripts/setup-windows-dev.ps1'; on Linux/macOS 'git clone -b $PIN_FLUTTER --depth 1 https://github.com/flutter/flutter.git \$HOME/flutter && export PATH=\$PATH:\$HOME/flutter/bin'. Needs storage.googleapis.com reachable."
fi

# ===========================================================================
# 2. Dart
# ===========================================================================
if have dart; then
  GOT_DART="$(dart --version 2>&1 | sed -nE 's/.*version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  if [ -z "$GOT_DART" ]; then
    fail_row dart "Dart version" "on PATH but UNMEASURABLE" \
      "Run 'dart --version'; the repository's constraint is \"${PIN_DART_SDK:-<unreadable>}\" (apps/*/pubspec.yaml environment.sdk)."
  else
    semver_in_constraint "$GOT_DART" "${PIN_DART_SDK:-}"; SAT=$?
    if [ "$SAT" -eq 0 ]; then
      row PASS "Dart version" "$GOT_DART (satisfies \"$PIN_DART_SDK\")" ""
    elif [ "$SAT" -eq 1 ]; then
      fail_row dart "Dart version" "$GOT_DART violates \"$PIN_DART_SDK\"" \
        "pubspec.yaml's environment.sdk is the constraint; 'flutter pub get' will refuse. Use the Dart bundled with Flutter $PIN_FLUTTER instead of a standalone SDK."
    else
      # WAS A WARN. An unreadable constraint means the REPOSITORY half of this
      # comparison could not be measured either, so nothing was checked at all —
      # that is a blocked check, not a soft one.
      fail_row dart "Dart version" "$GOT_DART, but the pubspec constraint \"${PIN_DART_SDK:-<empty>}\" could not be parsed" \
        "Read apps/parent-app/pubspec.yaml's environment.sdk and compare by hand, then fix parse_dart_sdk() in scripts/lib/repo-pins.sh. Nothing was verified by this row."
    fi
  fi
else
  fail_row dart "Dart version" "not installed (no 'dart' on PATH)" \
    "Dart ships INSIDE Flutter — installing Flutter $PIN_FLUTTER (row above) provides it at <flutter>/bin/dart. Do not install a standalone Dart SDK; it can drift from the Flutter pin."
fi

# ===========================================================================
# 3. Java, and 3b. JAVA_HOME
#
# JAVA_HOME IS ITS OWN ROW because Gradle does not use `java` from PATH when
# JAVA_HOME is set — it uses JAVA_HOME. A machine with JDK 17 on PATH and
# JAVA_HOME pointing at a JDK 21 builds with 21 and dies with "Unsupported
# class file major version". The old doctor only ever read PATH.
# ===========================================================================
if have java; then
  GOT_JAVA_MAJOR="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+)(\.[0-9]+)*.*".*/\1/p' | head -n 1)"
  if [ -z "$GOT_JAVA_MAJOR" ]; then
    fail_row java "Java version" "on PATH but UNMEASURABLE" \
      "Run 'java -version'; this repository needs JDK $PIN_JAVA_MAJOR (.github/workflows/build-apk.yml env.JAVA_VERSION)."
  elif [ "$GOT_JAVA_MAJOR" = "$PIN_JAVA_MAJOR" ]; then
    row PASS "Java version" "JDK $GOT_JAVA_MAJOR (matches the pin)" ""
  else
    fail_row java "Java version" "JDK $GOT_JAVA_MAJOR, repository needs JDK $PIN_JAVA_MAJOR" \
      "gradle-wrapper.properties pins Gradle $PIN_GRADLE, which only learned to RUN on JDK 21 in 8.5 — on JDK $GOT_JAVA_MAJOR the Android build dies with 'Unsupported class file major version' before compiling anything. Install Temurin $PIN_JAVA_MAJOR and set JAVA_HOME to it (current JAVA_HOME=${JAVA_HOME:-<unset>})."
  fi
else
  fail_row java "Java version" "not installed (no 'java' on PATH)" \
    "Install Temurin JDK $PIN_JAVA_MAJOR and set JAVA_HOME. Android Gradle Plugin $PIN_AGP will not run without it."
fi

JH="${JAVA_HOME:-}"
if [ -z "$JH" ]; then
  fail_row java-home "JAVA_HOME" "unset" \
    "Gradle prefers JAVA_HOME over PATH, so an unset JAVA_HOME means the JDK the build uses is whatever the launcher finds. Set it to a JDK $PIN_JAVA_MAJOR root — scripts/setup-windows-dev.ps1 does this for you on Windows."
elif [ ! -d "$JH" ]; then
  fail_row java-home "JAVA_HOME" "set to '$JH', which is not a directory" \
    "Point JAVA_HOME at the JDK $PIN_JAVA_MAJOR ROOT (the folder containing bin/ and lib/), not at bin/ and not at a file."
elif [ ! -x "$JH/bin/java" ] && [ ! -f "$JH/bin/java.exe" ]; then
  fail_row java-home "JAVA_HOME" "'$JH' contains no bin/java" \
    "JAVA_HOME must be the JDK root. Gradle will fail with 'ERROR: JAVA_HOME is set to an invalid directory'."
else
  JH_MAJOR=""
  if [ -x "$JH/bin/java" ]; then
    JH_MAJOR="$("$JH/bin/java" -version 2>&1 | sed -nE 's/.*version "([0-9]+)(\.[0-9]+)*.*".*/\1/p' | head -n 1)"
  fi
  if [ -z "$JH_MAJOR" ]; then
    # Windows (java.exe, not executable from this shell) lands here. Not a pass:
    # the directory exists and holds a java, but its version was not measured.
    fail_row java-home "JAVA_HOME" "'$JH' holds a java this shell could not run — NOT VERIFIED" \
      "Run '\"\$JAVA_HOME/bin/java\" -version' yourself and confirm it reports $PIN_JAVA_MAJOR. This row refuses to pass a JDK it did not measure."
  elif [ "$JH_MAJOR" = "$PIN_JAVA_MAJOR" ]; then
    row PASS "JAVA_HOME" "$JH (JDK $JH_MAJOR)" ""
  else
    fail_row java-home "JAVA_HOME" "'$JH' is JDK $JH_MAJOR, repository needs JDK $PIN_JAVA_MAJOR" \
      "Gradle uses JAVA_HOME, not PATH. Repoint it at a Temurin $PIN_JAVA_MAJOR root, or Gradle $PIN_GRADLE will refuse to run on it."
  fi
fi

# ===========================================================================
# 4. Android SDK, platform, build-tools, adb
#
# THE SDK ROOT ROW USED TO PASS ON ANY DIRECTORY THAT EXISTED. An empty folder
# named `Android/sdk` is not an SDK, and passing it sent the operator into a
# Gradle run that fails on a missing platform. It must now contain at least one
# of the three directories a real SDK always has.
# ===========================================================================
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
SDK_USABLE="no"
if [ -n "$SDK_ROOT" ] && [ -d "$SDK_ROOT" ]; then
  if [ -d "$SDK_ROOT/platforms" ] || [ -d "$SDK_ROOT/platform-tools" ] || [ -d "$SDK_ROOT/cmdline-tools" ]; then
    SDK_USABLE="yes"
    row PASS "Android SDK root" "$SDK_ROOT" ""
  else
    fail_row android-sdk "Android SDK root" "'$SDK_ROOT' exists but holds no platforms/, platform-tools/ or cmdline-tools/" \
      "That is an empty directory, not an SDK. Install the cmdline-tools into it, then: sdkmanager --licenses; sdkmanager \"platform-tools\" \"platforms;android-$PIN_COMPILE_SDK\" \"build-tools;$PIN_BUILD_TOOLS\"."
  fi
else
  fail_row android-sdk "Android SDK root" "ANDROID_HOME and ANDROID_SDK_ROOT are both unset or point nowhere" \
    "Install the Android cmdline-tools, then: export ANDROID_HOME=\$HOME/Android/sdk; sdkmanager --licenses; sdkmanager \"platform-tools\" \"platforms;android-$PIN_COMPILE_SDK\" \"build-tools;$PIN_BUILD_TOOLS\". Needs dl.google.com reachable. On Windows scripts/setup-windows-dev.ps1 does all of it."
fi

if [ "$SDK_USABLE" = "yes" ]; then
  if [ -d "$SDK_ROOT/platforms/android-$PIN_COMPILE_SDK" ]; then
    row PASS "Android platform" "android-$PIN_COMPILE_SDK present" ""
  else
    INSTALLED_PLATFORMS="$(ls "$SDK_ROOT/platforms" 2>/dev/null | tr '\n' ' ')"
    fail_row android-platform "Android platform" "android-$PIN_COMPILE_SDK missing (present: ${INSTALLED_PLATFORMS:-none})" \
      "Run: sdkmanager \"platforms;android-$PIN_COMPILE_SDK\". compileSdk $PIN_COMPILE_SDK is a literal in apps/*/android/app/build.gradle."
  fi

  INSTALLED_BT="$(ls "$SDK_ROOT/build-tools" 2>/dev/null | tr '\n' ' ')"
  if [ -z "$INSTALLED_BT" ]; then
    fail_row android-buildtools "Android build-tools" "none installed" \
      "Run: sdkmanager \"build-tools;$PIN_BUILD_TOOLS\". AGP $PIN_AGP cannot package an APK without a build-tools package (aapt2, d8, zipalign, apksigner all live there)."
  else
    row PASS "Android build-tools" "installed: $INSTALLED_BT" ""
    if [ -d "$SDK_ROOT/build-tools/$PIN_BUILD_TOOLS" ]; then
      row PASS "build-tools exact match" "$PIN_BUILD_TOOLS present (derived from compileSdk)" ""
    else
      fail_row buildtools-exact "build-tools exact match" "$PIN_BUILD_TOOLS absent (present: $INSTALLED_BT)" \
        "Neither app declares buildToolsVersion, so AGP $PIN_AGP picks its own default and one of the above may well satisfy it. This is WARN, not BLOCKED, for exactly that reason. Run 'sdkmanager \"build-tools;$PIN_BUILD_TOOLS\"' to match the derivation exactly."
    fi
  fi
else
  fail_row android-platform "Android platform" "cannot check android-$PIN_COMPILE_SDK — no usable SDK root" \
    "Resolve the Android SDK root row first."
  fail_row android-buildtools "Android build-tools" "cannot check — no usable SDK root" \
    "Resolve the Android SDK root row first."
fi

# adb. ADVISORY BY POLICY AND THE REASON IS WRITTEN DOWN: no stage of
# scripts/mobile-build.sh invokes adb, so its absence cannot fail a build. It is
# needed for step 17 of MOBILE_BUILD_HANDOFF.md — getting the APK onto a phone —
# and for the golden-device smoke test, which is why it is checked at all.
if have adb; then
  ADB_RAW="$(adb version 2>/dev/null | head -n 1)"
  row PASS "adb (platform-tools)" "${ADB_RAW:-on PATH}" ""
else
  ADB_HINT=""
  if [ "$SDK_USABLE" = "yes" ] && [ -x "$SDK_ROOT/platform-tools/adb" ]; then
    ADB_HINT=" It IS installed at $SDK_ROOT/platform-tools/adb but is not on PATH."
  fi
  fail_row adb "adb (platform-tools)" "not on PATH" \
    "No build stage uses adb, so this does not block a build — it blocks INSTALLING the artifact on a phone. Run 'sdkmanager \"platform-tools\"' and add \$ANDROID_HOME/platform-tools to PATH.$ADB_HINT"
fi

# ===========================================================================
# 5. Gradle — the WRAPPER is the contract, not whatever is on PATH
# ===========================================================================
WRAPPER_OK="yes"
for app in $PIN_APPS; do
  [ -f "$REPO_ROOT/apps/$app/android/gradle/wrapper/gradle-wrapper.jar" ] || WRAPPER_OK="no"
done

if [ "$WRAPPER_OK" = "yes" ]; then
  row PASS "Gradle wrapper" "gradle-wrapper.jar present in both apps" ""
else
  fail_row gradle-wrapper "Gradle wrapper" "gradle-wrapper.jar missing in at least one app" \
    "Restore it from git ('git checkout -- apps/*/android/gradle/wrapper/'). Never regenerate it with a Gradle other than the pinned $PIN_GRADLE."
fi

# `$HOME` is read through a default too: it is genuinely unset in some CI
# containers, and under `set -u` a bare `$HOME` here killed the whole run.
GRADLE_DIST_CACHE="${GRADLE_USER_HOME:-${HOME:-}/.gradle}/wrapper/dists"
DIST_CACHED="no"
if [ -d "$GRADLE_DIST_CACHE" ]; then
  if ls -d "$GRADLE_DIST_CACHE"/gradle-"$PIN_GRADLE"-* >/dev/null 2>&1; then DIST_CACHED="yes"; fi
fi

if [ "$DIST_CACHED" = "yes" ]; then
  row PASS "Gradle $PIN_GRADLE" "distribution cached under $GRADLE_DIST_CACHE" ""
else
  # NOT CACHED IS NOT AUTOMATICALLY FATAL: the wrapper downloads it on first
  # use. What IS fatal is not cached AND services.gradle.org unreachable. The
  # old row blocked on "not cached" alone, which was noise on a fresh machine
  # with working networking; it now measures the thing that actually decides.
  http_probe "https://services.gradle.org/distributions/gradle-$PIN_GRADLE-bin.zip"; GP=$?
  SYS_GRADLE=""
  have gradle && SYS_GRADLE="$(gradle --version 2>/dev/null | sed -nE 's/^Gradle[[:space:]]+([0-9.]+).*/\1/p' | head -n 1)"
  SYS_NOTE=""
  if [ -n "$SYS_GRADLE" ] && [ "$SYS_GRADLE" != "$PIN_GRADLE" ]; then
    SYS_NOTE=" Do NOT substitute the Gradle $SYS_GRADLE on PATH: the wrapper pin is what AGP $PIN_AGP was validated against."
  fi
  if [ "$GP" -eq 0 ]; then
    row WARN "Gradle $PIN_GRADLE" "not cached, but services.gradle.org answers — the first ./gradlew run will fetch it" \
      "Nothing to do; expect the first build to spend a minute downloading gradle-$PIN_GRADLE-bin.zip.$SYS_NOTE"
  elif [ "$GP" -eq 1 ]; then
    fail_row gradle-dist "Gradle $PIN_GRADLE" "not cached AND services.gradle.org did not answer" \
      "The wrapper cannot obtain gradle-$PIN_GRADLE-bin.zip, so no Gradle task can run. Restore outbound access to services.gradle.org, or seed \$GRADLE_USER_HOME/wrapper/dists from a machine that has it.$SYS_NOTE"
  else
    row WARN "Gradle $PIN_GRADLE" "not cached; reachability of services.gradle.org NOT VERIFIED (no probe tool / --no-network)" \
      "Run './gradlew --version' inside apps/<app>/android once. If it downloads, you are fine; if it hangs, that is this row's blocker.$SYS_NOTE"
  fi
fi

# ===========================================================================
# 5b. compileSdk vs AGP, and the three SDK levels
#
# THE RULE IS THE REPOSITORY'S OWN, quoted in both apps' android/app/build.gradle:
# "compileSdk 35 requires Android Gradle Plugin 8.6.0 or higher". Nothing here
# is invented; the numbers on both sides are parsed out of the tree.
# ===========================================================================
AGP_CEILING_NOTE="apps/*/android/app/build.gradle records the rule: compileSdk 35 requires AGP 8.6.0 or higher."
if [ "$PIN_COMPILE_SDK" -ge 35 ] 2>/dev/null && ! ver_ge "$PIN_AGP" "8.6.0"; then
  fail_row gradle-agp-sdk "compileSdk vs AGP" "compileSdk $PIN_COMPILE_SDK with AGP $PIN_AGP" \
    "AGP $PIN_AGP refuses compileSdk $PIN_COMPILE_SDK outright. Either drop compileSdk back to 34 in apps/*/android/app/build.gradle or raise the AGP version in apps/*/android/settings.gradle to 8.6.0 or higher (which also moves the Gradle pin). $AGP_CEILING_NOTE"
else
  row PASS "compileSdk vs AGP" "compileSdk $PIN_COMPILE_SDK is inside AGP $PIN_AGP's ceiling" ""
fi

if [ "$PIN_MIN_SDK" -le "$PIN_TARGET_SDK" ] 2>/dev/null && [ "$PIN_TARGET_SDK" -le "$PIN_COMPILE_SDK" ] 2>/dev/null; then
  row PASS "SDK levels" "minSdk $PIN_MIN_SDK <= targetSdk $PIN_TARGET_SDK <= compileSdk $PIN_COMPILE_SDK" ""
else
  fail_row sdk-levels "SDK levels" "minSdk $PIN_MIN_SDK / targetSdk $PIN_TARGET_SDK / compileSdk $PIN_COMPILE_SDK are not ordered" \
    "AGP requires minSdk <= targetSdk <= compileSdk. Fix apps/*/android/app/build.gradle; all three are literals there."
fi

# ===========================================================================
# 6. pub.dev — mobile-build stage 1 is `flutter pub get`
#
# THE PACKAGE PROBED IS READ OUT OF THE PUBSPEC, not typed here, so this row
# cannot go stale against a dependency list that changed.
# ===========================================================================
PROBE_PKG="$(sed -nE 's/^  ([a-z][a-z0-9_]*):[[:space:]]*\^?[0-9].*$/\1/p' "$REPO_ROOT/apps/parent-app/pubspec.yaml" 2>/dev/null | head -n 1)"
if [ -z "$PROBE_PKG" ]; then
  fail_row pub-access "pub.dev access" "could not read a hosted dependency name from apps/parent-app/pubspec.yaml" \
    "This row probes the registry with a package the repository actually declares. Fix the parse rather than probing a name typed from memory."
else
  http_probe "https://pub.dev/api/packages/$PROBE_PKG"; PUBP=$?
  if [ "$PUBP" -eq 0 ]; then
    row PASS "pub.dev access" "answered for '$PROBE_PKG'" ""
  elif [ "$PUBP" -eq 1 ]; then
    fail_row pub-access "pub.dev access" "https://pub.dev/api/packages/$PROBE_PKG did NOT answer" \
      "'flutter pub get' is the first stage of scripts/mobile-build.sh and it cannot resolve a single dependency without pub.dev. This is the blocker that has held this repository's mobile build from the start (pub.dev answers 403 from the authoring container). Set PUB_HOSTED_URL to a mirror you control, or run the build from a machine with outbound access."
  else
    row WARN "pub.dev access" "NOT VERIFIED (no curl/wget/python3, or --no-network)" \
      "Install curl, or confirm by hand: 'flutter pub get' inside apps/parent-app. This row refuses to PASS a registry it never contacted."
  fi
fi

# ===========================================================================
# 7. pubspec.lock — reproducibility of a store artifact
# ===========================================================================
for app in $PIN_APPS; do
  LOCK="$REPO_ROOT/apps/$app/pubspec.lock"
  if [ -f "$LOCK" ]; then
    PKG_COUNT="$(sed -nE 's/^  ([a-z0-9_]+):$/\1/p' "$LOCK" | wc -l | tr -d ' ')"
    row PASS "pubspec.lock ($app)" "present, ${PKG_COUNT:-0} packages" ""
  else
    fail_row pubspec-lock "pubspec.lock ($app)" "absent" \
      "Run 'flutter pub get' in apps/$app (needs pub.dev reachable), then COMMIT the generated pubspec.lock. Until it exists, two builds of the same commit can resolve DIFFERENT dependency versions, so no artifact is reproducible. A debug APK still builds — which is why this is BLOCKED only under --profile release."
  fi
done

# ===========================================================================
# 8. Required packages — every `package:` import is a declared dependency
#
# DELEGATED, NOT RE-IMPLEMENTED. scripts/verify_dart_imports.py resolves every
# import/export/part directive in both apps and cross-checks each
# `package:<other>/...` against the owning pubspec's dependency list. That is
# precisely "are the required packages declared", and re-writing it in awk here
# would be a second, weaker answer to a question the repository already answers.
# ===========================================================================
IMPORT_CHECKER="$SCRIPT_DIR/verify_dart_imports.py"
if [ ! -f "$IMPORT_CHECKER" ]; then
  fail_row packages-unverifiable "Required packages" "checker scripts/verify_dart_imports.py not found — NOT VERIFIED" \
    "Restore it: 'git checkout -- scripts/verify_dart_imports.py'. It is the only check that catches an import of a package no pubspec declares, which fails 'flutter pub get' or 'flutter analyze' minutes later."
elif ! have python3; then
  fail_row packages-unverifiable "Required packages" "python3 not available — NOT VERIFIED" \
    "Install Python 3 and run 'python3 scripts/verify_dart_imports.py'. This row does not PASS a check it could not run."
elif python3 "$IMPORT_CHECKER" "$REPO_ROOT" >/dev/null 2>&1; then
  row PASS "Required packages" "every package: import resolves to a declared dependency" ""
else
  fail_row packages "Required packages" "at least one import is unresolved or undeclared" \
    "Run 'python3 scripts/verify_dart_imports.py' for the per-file detail. An undeclared package: import fails 'flutter analyze' and, if it is a plugin, the Gradle build."
fi

# ===========================================================================
# 9. Firebase configuration
#
# GRADED PER APP, FROM WHAT THE APP ACTUALLY DECLARES — see `uses_firebase`.
# THE CHILD APP DOES NOT NEED google-services.json: it declares no
# firebase_core / firebase_messaging, its settings.gradle carries no
# google-services plugin and its app/build.gradle never applies one. An earlier
# doctor demanded the file from both apps and blocked a release on the child
# app's absent one — a requirement the repository does not have.
# ===========================================================================
for app in $PIN_APPS; do
  GS="$REPO_ROOT/apps/$app/android/app/google-services.json"
  # Initialised before the case, so an app added to PIN_APPS without a branch
  # here cannot read an UNSET variable under `set -u` and take the run down.
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

  uses_firebase "$app"; UF=$?
  if [ "$UF" -eq 2 ]; then
    # WAS A SILENT PASS. Missing pubspec/settings/build.gradle used to read as
    # "declares no Firebase" and printed PASS — a green row produced by three
    # files that were not there.
    row BLOCKED "Firebase config ($app)" "cannot decide: pubspec.yaml, android/settings.gradle or android/app/build.gradle is missing" \
      "All three are needed to know whether this app uses Firebase at all. Restore apps/$app from git. This row will not report 'not required' on files it could not read."
    continue
  fi

  if [ "$UF" -ne 0 ]; then
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
        "This file belongs to a different Android app. FCM registration fails at runtime with a mismatched sender. Re-download it for applicationId $EXPECT_ID. (BLOCKED in every profile: a wrong file is worse than an absent one.)"
    fi
  else
    fail_row firebase-config "Firebase config ($app)" "google-services.json absent" \
      "OPERATOR MUST SUPPLY — nothing in this repository can generate it and no placeholder was fabricated. Create the Firebase Android app for applicationId $EXPECT_ID, download google-services.json and place it at apps/$app/android/app/google-services.json (CI reads it from the GOOGLE_SERVICES_JSON secret instead). THE DEBUG APK BUILDS AND RUNS WITHOUT IT — the gradle default -Pabny.firebase=auto only warns — which is why this is WARN under --profile debug and BLOCKED under --profile release: a release in that state ships an artifact whose every push notification silently never arrives. See docs/release/FIREBASE_SETUP.md."
  fi
done

FIREBASE_OPTIONS="$REPO_ROOT/apps/parent-app/lib/firebase_options.dart"
if [ -f "$FIREBASE_OPTIONS" ]; then
  row PASS "firebase_options.dart" "present (parent-app)" ""
else
  fail_row firebase-options "firebase_options.dart" "absent (parent-app)" \
    "Only 'flutterfire configure' can generate it, against a real Firebase project. Without it Firebase.initializeApp() throws, PushRegistrationService returns early, and no FCM token is ever registered. Debug builds proceed without push, which is why this is WARN under --profile debug."
fi

# ===========================================================================
# 10. Signing configuration
#
# THE FILE THE GRADLE ACTUALLY READS IS `signing.properties`, NOT
# `key.properties`. This section checked the latter — Flutter's template name —
# while both apps' android/app/build.gradle read
# `rootProject.file("signing.properties")`, both android/.gitignore files
# ignore `signing.properties` (committing `signing.properties.example` by
# negation), and .github/workflows/build-apk.yml writes
# `android/signing.properties`. The doctor could therefore PASS an operator who
# had created key.properties, and their release build would stop in the
# task-graph guard with "signing.properties is MISSING": THE DOCTOR PASSING
# SOMETHING THE BUILD FAILS ON. That is the false pass this whole file is
# organised against.
# ===========================================================================
for app in $PIN_APPS; do
  ANDROID_DIR="$REPO_ROOT/apps/$app/android"
  SIGNPROPS="$ANDROID_DIR/signing.properties"
  SIGNEXAMPLE="$ANDROID_DIR/signing.properties.example"
  KEYTOOL_CMD="$(keytool_command_for "$app")"

  if [ -f "$SIGNEXAMPLE" ]; then
    row PASS "Signing template ($app)" "android/signing.properties.example present" ""
  else
    fail_row signing-template "Signing template ($app)" "android/signing.properties.example is missing" \
      "It is the committed template and holds the full keytool invocation and the keystore name this doctor quotes. Restore it: git checkout -- apps/$app/android/signing.properties.example"
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
        "apps/$app/android/app/build.gradle stops every release task unless all four of storeFile, storePassword, keyAlias, keyPassword are set AND non-empty. A partial signing config is not signed 'less', it is not signed. Fill them in apps/$app/android/signing.properties — see signing.properties.example. (BLOCKED in every profile: a half-written key file is a mistake in progress, not a debug-only state.)"
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
        # ROW THAT PROVES A RELEASE CANNOT FALL BACK TO A DEBUG KEY.
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
  else
    fail_row signing "Signing ($app)" "android/signing.properties absent" \
      "OPERATOR MUST SUPPLY. No release keystore = no store artifact, and app/build.gradle will NOT fall back to the debug key — it stops the release task with a named message. Do exactly this: cd apps/$app/android && $KEYTOOL_CMD && cp signing.properties.example signing.properties, then fill storeFile / storePassword / keyAlias / keyPassword. Both signing.properties and *.jks are gitignored (apps/$app/android/.gitignore) — never commit either. THE DEBUG APK NEEDS NONE OF THIS, which is why this row is WARN under --profile debug."
  fi

  # A signing file that is NOT ignored is key material one `git add` away from
  # the history. The gitignore is committed, so this is checkable statically.
  GITIGNORE="$ANDROID_DIR/.gitignore"
  if [ -f "$GITIGNORE" ]; then
    UNIGNORED=""
    grep -qE '^[[:space:]]*signing\.properties[[:space:]]*$' "$GITIGNORE" || UNIGNORED="$UNIGNORED signing.properties"
    grep -qE '^[[:space:]]*\*\.jks[[:space:]]*$' "$GITIGNORE" || UNIGNORED="$UNIGNORED *.jks"
    if [ -n "$UNIGNORED" ]; then
      fail_row signing-gitignore "Signing gitignore ($app)" "not ignored:$UNIGNORED" \
        "apps/$app/android/.gitignore must ignore signing.properties and *.jks (and keep !signing.properties.example). Key material one 'git add' from the history is key material already lost."
    else
      row PASS "Signing gitignore ($app)" "signing.properties and *.jks are gitignored" ""
    fi
  else
    fail_row signing-gitignore "Signing gitignore ($app)" "apps/$app/android/.gitignore is missing" \
      "Without it the keystore and its three passwords are committable by accident. Restore it: git checkout -- apps/$app/android/.gitignore"
  fi
done

# ===========================================================================
# 11. The version the release AAB will carry
#
# app/build.gradle REFUSES to package a release on a fallback version, and the
# single source of both halves is pubspec.yaml's `version: <name>+<code>` line
# (flutter build copies it into android/local.properties). A pubspec with no
# `+<code>` builds debug happily and stops the release — a build failure this
# doctor can predict from a committed file, so it does.
# ===========================================================================
for app in $PIN_APPS; do
  PUBSPEC="$REPO_ROOT/apps/$app/pubspec.yaml"
  APP_VERSION="$(first_match "$PUBSPEC" '^version:[[:space:]]*([^[:space:]]+)[[:space:]]*$')"
  if [ -z "$APP_VERSION" ]; then
    fail_row app-version "App version ($app)" "pubspec.yaml declares no version:" \
      "Add 'version: <name>+<code>' to apps/$app/pubspec.yaml. app/build.gradle stops any release task on a fallback version, because Play accepts versionCode 1 exactly once and then blocks every later upload."
  elif ! printf '%s' "$APP_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+$'; then
    fail_row app-version "App version ($app)" "pubspec version '$APP_VERSION' has no +<versionCode>" \
      "app/build.gradle's release guard refuses a FALLBACK versionCode. Write it as '<name>+<code>', e.g. '0.1.0+1'. CI overrides the CODE half per upload via ORG_GRADLE_PROJECT_abnyVersionCode."
  else
    row PASS "App version ($app)" "$APP_VERSION (versionName+versionCode, single source)" ""
  fi
done

# ===========================================================================
# 12. Package IDs and application IDs
#
# TWO DIFFERENT THINGS, TWO ROWS.
#   package IDs      — the two apps must not claim the same applicationId, or
#                      installing one uninstalls the other.
#   application IDs  — within ONE app, `namespace` (the R class / package) and
#                      `applicationId` (the Play identity) must agree, and the
#                      identity must be a legal, immutable-after-first-upload
#                      package name.
# ===========================================================================
if [ "$PIN_PARENT_APP_ID" = "$PIN_CHILD_APP_ID" ]; then
  fail_row package-ids "Package IDs" "both apps declare $PIN_PARENT_APP_ID" \
    "Two apps cannot share an applicationId — the second install replaces the first. Fix apps/*/android/app/build.gradle."
else
  row PASS "Package IDs" "parent=$PIN_PARENT_APP_ID child=$PIN_CHILD_APP_ID" ""
fi

for app in $PIN_APPS; do
  APPGR="$REPO_ROOT/apps/$app/android/app/build.gradle"
  NS="$(first_match "$APPGR" 'namespace[[:space:]]+"([^"]+)"')"
  AID="$(first_match "$APPGR" 'applicationId[[:space:]]+"([^"]+)"')"
  if [ -z "$NS" ] || [ -z "$AID" ]; then
    fail_row application-ids "Application ID ($app)" "namespace='${NS:-<not found>}' applicationId='${AID:-<not found>}'" \
      "Both must be declared in apps/$app/android/app/build.gradle. A missing namespace fails AGP $PIN_AGP outright; a missing applicationId leaves the Play identity to the namespace by accident."
  elif [ "$NS" != "$AID" ]; then
    fail_row application-ids "Application ID ($app)" "namespace '$NS' != applicationId '$AID'" \
      "They are allowed to differ, but in this repository they do not and nothing is built to handle the split (the Kotlin sources, the manifest's .MainActivity and the Firebase registration all follow one name). Reconcile them in apps/$app/android/app/build.gradle."
  elif ! printf '%s' "$AID" | grep -qE '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'; then
    fail_row application-ids "Application ID ($app)" "'$AID' is not a legal Play package name" \
      "Play requires at least two dot-separated segments, lowercase, starting with a letter, and the name is IMMUTABLE after the first upload. Fix it in apps/$app/android/app/build.gradle before the first upload, never after."
  else
    row PASS "Application ID ($app)" "$AID (namespace and applicationId agree)" ""
  fi
done

# ===========================================================================
# 13. Required environment variables for the build itself
#
# JAVA_HOME and ANDROID_HOME already have their own rows above. The remaining
# one is the release API base URL, and it is the only environment variable in
# this repository whose ABSENCE produces a BUILDABLE, SIGNED, CRASHING artifact:
# apps/*/lib/core/config/app_config.dart THROWS StateError at launch in release
# mode unless API_BASE_URL is https, and the repository default
# (AppConfig.debugDefaultApiBaseUrl) is http://10.0.2.2:3000/api/v1.
#
# The variable name is the one .github/workflows/build-apk.yml already uses
# (`RELEASE_API_BASE_URL`), and scripts/mobile-build.sh reads the same name for
# --release, so this row grades exactly what the build will consume.
# ===========================================================================
REL_URL="${RELEASE_API_BASE_URL:-}"
if [ -z "$REL_URL" ]; then
  fail_row api-base-url "RELEASE_API_BASE_URL" "unset" \
    "A release build with the repository default (${PIN_DEBUG_API_URL:-http://...}) throws StateError on launch — apps/*/lib/core/config/app_config.dart requires https in release mode. Export RELEASE_API_BASE_URL=https://<host>/api/v1 (the same name .github/workflows/build-apk.yml uses), or pass --api-base-url to scripts/mobile-build.sh. Debug builds use the http default deliberately, so this is WARN under --profile debug."
elif [ "${REL_URL#https://}" = "$REL_URL" ]; then
  row BLOCKED "RELEASE_API_BASE_URL" "'$REL_URL' is not https" \
    "AppConfig.configurationError() rejects any non-https URL in release mode and assertUsableForBuildMode() turns that into a StateError at launch. (BLOCKED in every profile: an explicitly set, wrong value is not a debug convenience.)"
else
  row PASS "RELEASE_API_BASE_URL" "$REL_URL" ""
fi

# ===========================================================================
# 14. Manifest permissions, and the runtime request behind one of them
# ===========================================================================
for app in $PIN_APPS; do
  MANIFEST="$REPO_ROOT/apps/$app/android/app/src/main/AndroidManifest.xml"
  if [ ! -f "$MANIFEST" ]; then
    fail_row permissions "Permissions ($app)" "AndroidManifest.xml not found" \
      "Expected at apps/$app/android/app/src/main/AndroidManifest.xml."
    continue
  fi
  PERM_COUNT="$(grep -cE '<uses-permission[[:space:]]' "$MANIFEST" 2>/dev/null | tr -d ' ')"
  PERM_COUNT="${PERM_COUNT:-0}"
  if grep -q 'android.permission.INTERNET' "$MANIFEST" && \
     grep -q 'android.permission.POST_NOTIFICATIONS' "$MANIFEST"; then
    row PASS "Permissions ($app)" "$PERM_COUNT declared, incl. INTERNET + POST_NOTIFICATIONS" ""
  else
    MISSING=""
    grep -q 'android.permission.INTERNET' "$MANIFEST" || MISSING="$MISSING INTERNET"
    grep -q 'android.permission.POST_NOTIFICATIONS' "$MANIFEST" || MISSING="$MISSING POST_NOTIFICATIONS"
    fail_row permissions "Permissions ($app)" "$PERM_COUNT declared, missing:$MISSING" \
      "Add the <uses-permission> element(s) to $MANIFEST. Without INTERNET the app reaches no backend; without POST_NOTIFICATIONS nothing this app posts is visible on Android 13+."
  fi
done

# A DECLARED notification permission that is never REQUESTED is a defect
# invisible to every other check here — so the dedicated checker is consulted
# rather than re-implemented.
NOTIF_CHECKER="$SCRIPT_DIR/verify_notification_permission.py"
if [ ! -f "$NOTIF_CHECKER" ]; then
  fail_row notif-unverifiable "POST_NOTIFICATIONS request" "checker scripts/verify_notification_permission.py not found — NOT VERIFIED" \
    "Restore it: it is the only check that catches a permission declared in the manifest but never requested at runtime."
elif ! have python3; then
  fail_row notif-unverifiable "POST_NOTIFICATIONS request" "python3 not available — NOT VERIFIED" \
    "Install Python 3, then run 'python3 scripts/verify_notification_permission.py'. This row does not PASS a check it could not run."
elif python3 "$NOTIF_CHECKER" >/dev/null 2>&1; then
  row PASS "POST_NOTIFICATIONS request" "every declaring app also requests it at runtime" ""
else
  fail_row notif-request "POST_NOTIFICATIONS request" "declared but never requested in at least one app" \
    "Run 'python3 scripts/verify_notification_permission.py' for the per-app detail. On Android 13+ an unrequested POST_NOTIFICATIONS means notifications silently never appear."
fi

# ===========================================================================
# 15. The deep-link scheme, in both manifests
#
# The scheme is READ FROM THE SERVER'S REGISTRY, never typed here: the backend
# is authoritative for `<scheme>://<surface>` and both clients route on what it
# emits. If the two ever disagree, every notification tap in the product lands
# nowhere and no other row in this file would see it.
# ===========================================================================
DEST_REGISTRY="$REPO_ROOT/apps/backend/src/modules/notifications/domain/engine/notification-destination.ts"
DEEP_LINK_SCHEME="$(first_match "$DEST_REGISTRY" "DEEP_LINK_SCHEME[[:space:]]*=[[:space:]]*'([a-z][a-z0-9+.-]*)'")"
if [ -z "$DEEP_LINK_SCHEME" ]; then
  fail_row deep-link "Deep-link scheme" "could not read DEEP_LINK_SCHEME from the notification registry — NOT VERIFIED" \
    "Expected at apps/backend/src/modules/notifications/domain/engine/notification-destination.ts. Fix this check rather than guessing the scheme."
else
  for app in $PIN_APPS; do
    MANIFEST="$REPO_ROOT/apps/$app/android/app/src/main/AndroidManifest.xml"
    if [ ! -f "$MANIFEST" ]; then
      fail_row deep-link "Deep-link scheme ($app)" "AndroidManifest.xml not found — NOT VERIFIED" \
        "Expected at apps/$app/android/app/src/main/AndroidManifest.xml."
      continue
    fi
    if grep -qE "android:scheme[[:space:]]*=[[:space:]]*\"$DEEP_LINK_SCHEME\"" "$MANIFEST"; then
      row PASS "Deep-link scheme ($app)" "$DEEP_LINK_SCHEME:// declared in an intent-filter" ""
    else
      # WARN and not BLOCKED, and the distinction is the whole point of the
      # grading scale: nothing about the BUILD depends on this, and the in-app
      # notification tap works without it (the link travels on the FCM data
      # payload and is routed in Dart). What is missing is the OS-LEVEL
      # registration — a link tapped in a browser, a message or an e-mail
      # resolves to no app on the device.
      fail_row deep-link "Deep-link scheme ($app)" "no <data android:scheme=\"$DEEP_LINK_SCHEME\"> intent-filter" \
        "apps/$app/android/app/src/main/AndroidManifest.xml declares no intent-filter for $DEEP_LINK_SCHEME://, so the OS cannot resolve such a link to this app. In-app notification taps are UNAFFECTED, which is why this is WARN."
    fi
  done
fi

# ===========================================================================
# 16. git status — advisory: a store artifact should trace to a commit
# ===========================================================================
if have git && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)"
  # Defaulted at the point of use: a failed `git status` inside the pipeline
  # yields an EMPTY string, and `[ "" -eq 0 ]` is a shell error, not a false.
  DIRTY_COUNT="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  DIRTY_COUNT="${DIRTY_COUNT:-0}"
  if [ "$DIRTY_COUNT" -eq 0 ]; then
    row PASS "git status" "clean on '${BRANCH:-<detached>}'" ""
  else
    fail_row git-clean "git status" "$DIRTY_COUNT uncommitted path(s) on '${BRANCH:-<detached>}'" \
      "A store artifact should be reproducible from a commit. Run 'git status --short', then commit before building a release."
  fi
else
  fail_row git-clean "git status" "not a git working tree, or git is not on PATH" \
    "Build from a checkout, so the artifact can be traced to a commit."
fi

# ===========================================================================
# VERDICT
#
# THE LAST LINE IS THE GATE. When anything is BLOCKED the final line printed is
# the unindented literal token below and the exit code is 1. It is printed in
# exactly one place, so `scripts/release-doctor.sh | tail -1` is usable as a
# machine gate. A WARN never reaches it.
# ===========================================================================
head_line 'VERDICT'
printf '  PASS %s   WARN %s   BLOCKED %s\n\n' "$N_PASS" "$N_WARN" "$N_BLOCKED"

if [ "$N_BLOCKED" -gt 0 ]; then
  printf '  %sThis machine cannot produce a trustworthy %s artifact yet.%s\n' "$C_RED" "$PROFILE" "$C_RESET"
  printf '  The blocking rows, in the order worth fixing:\n'
  printf '%s' "$ROWS" | awk -F'|' '$1 == "BLOCKED" { printf "    - %s: %s\n", $2, $3 }'
  printf '\n  Nothing was installed, downloaded or modified by this run.\n'
  if [ "$N_WARN" -gt 0 ]; then
    printf '  The %s WARN row(s) above did NOT contribute to this verdict.\n' "$N_WARN"
  fi
  printf '\n'
  printf 'SHIP BLOCKED\n'
  exit 1
fi

if [ "$N_WARN" -gt 0 ]; then
  printf '  %s%s WARN row(s) above are real gaps, and none of them blocks: a %s build can be attempted.%s\n' \
    "$C_YEL" "$N_WARN" "$PROFILE" "$C_RESET"
else
  printf '  %sEvery checked requirement for a %s artifact is met on this machine.%s\n' "$C_GRN" "$PROFILE" "$C_RESET"
fi
printf '\n'
printf 'SHIP GATE PASSED (%s profile, %s checks graded, 0 blocked)\n' "$PROFILE" "$((N_PASS + N_WARN))"
exit 0
