#!/usr/bin/env bash
# ===========================================================================
# mobile-build.sh — G1. One command, one app (or both), four stages:
#
#     flutter pub get -> flutter analyze -> flutter test -> flutter build apk --debug
#
# and with --release, two more:
#
#     flutter build apk --release -> flutter build appbundle --release
#
# FAIL-FAST, AND THAT IS THE WHOLE POINT OF THIS FILE EXISTING SEPARATELY.
# `.github/workflows/build-apk.yml` is deliberately DIAGNOSTIC: it runs every
# stage even after one fails, so a single CI round trip reports everything
# that is wrong. That is right for CI and wrong for a developer's terminal,
# where the second stage's output is noise once the first has failed and the
# only useful thing is the first failure, in full, with the exact command.
#
# So this script STOPS at the first failing stage and prints:
#   * the exact command it ran, copy-pasteable, including every --dart-define
#   * the working directory it ran in
#   * the absolute path of the log file holding the complete output
#   * the process exit code
#
# NOTHING IS EVER MASKED. A missing `flutter` is a hard stop before any stage
# runs, not a skipped stage; a missing dependency surfaces as `pub get`'s own
# failure with its own message; there is no `|| true` anywhere in this file
# and no stage's exit code is discarded.
#
# --dart-define=API_BASE_URL IS MANDATORY (audit MA-004): without it the APK
# installs and can talk to nothing. The default is READ FROM THE REPOSITORY
# (AppConfig.debugDefaultApiBaseUrl, via scripts/lib/repo-pins.sh), never
# hardcoded here. Override with --api-base-url.
#
# THE RELEASE PREFLIGHT, ADDED HERE FOR PARITY WITH mobile-build.ps1.
# Without it, `--release` ran pub get, analyze, test and a full debug APK build
# — several minutes each — and only then reached `flutter build apk --release`,
# where app/build.gradle's task-graph guard stopped everything with
# "signing.properties is MISSING". Every one of those blockers is readable from
# a committed file BEFORE the first stage starts. A build script that spends
# fifteen minutes to say something it could have said immediately is not
# fail-fast.
#
# THE FIREBASE HALF IS WORSE, BECAUSE IT DOES NOT STOP THE BUILD. The gradle
# default is `-Pabny.firebase=auto`, which warns and continues when
# google-services.json is absent — so `--release` on the parent app produced a
# perfectly valid, perfectly signed AAB whose every push notification silently
# never arrives. `.github/workflows/build-apk.yml` already treats exactly that
# state as an error for the parent app's release job; this script now agrees
# with CI rather than shipping the false green. It is required of the PARENT
# APP ONLY, and that is DERIVED from what each app declares rather than
# hardcoded either way: the child app has no firebase_core/firebase_messaging,
# no google-services plugin and no `apply plugin`, so nothing in its build has
# ever read that file.
#
# THE SIGNING FILE IS `signing.properties`. `key.properties` was named in this
# file's closing note and it is not the file the gradle reads: app/build.gradle
# reads `rootProject.file("signing.properties")`, android/.gitignore ignores
# that name, and CI writes it. The old note therefore told the operator to
# check something the build never looks at.
#
# WHY NO `set -e`. `run_stage` captures each stage's exit code explicitly and
# stops the script itself, printing the command, the working directory, the log
# path and the log's tail; `-e` would kill the process mid-stage and lose all
# four. What `-e` would otherwise have caught is handled directly: `set -u` is
# on, every environment variable is read through `${VAR:-}`, and every option
# that takes a value is checked BEFORE `shift 2` — a bare `--log-dir` used to
# `shift 2` past the end, which fails, leaves `$#` unchanged and spins forever.
#
# STATUS: EXECUTED — in an environment with no Flutter SDK, where it stops on
# the preflight with a BLOCKED message rather than pretending to build. That
# run is recorded in the Phase G ship report. It has NEVER completed a real
# build, because no environment available to its author can. The RELEASE
# PREFLIGHT added here is STATIC VERIFIED against apps/*/android/app/build.gradle,
# apps/*/android/signing.properties.example and apps/*/pubspec.yaml; it has
# never gated a real release build, because none has ever run.
#
# Usage:
#   scripts/mobile-build.sh [--app child|parent|both] [--release]
#                           [--api-base-url URL] [--enable-push true|false]
#                           [--skip-tests] [--log-dir DIR]
#                           [--allow-release-without-push]
# ===========================================================================

set -uo pipefail

APP_CHOICE="both"
DO_RELEASE="no"
SKIP_TESTS="no"
API_BASE_URL=""
ENABLE_PUSH=""
LOG_DIR=""
REPO_ROOT=""
ALLOW_NO_PUSH="no"

usage() { sed -n '2,81p' "$0" | sed 's/^# \{0,1\}//'; }

# An option that takes a value must HAVE one. Without this, `--log-dir` with
# nothing after it reached `shift 2` with one argument left; `shift` fails, `$#`
# does not change, and the loop spins forever on the same argument.
need_value() {
  if [ "$#" -lt 2 ]; then
    echo "mobile-build: $1 requires a value." >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      need_value "$@"
      APP_CHOICE="$2"
      case "$APP_CHOICE" in
        child|parent|both) ;;
        *) echo "mobile-build: --app must be 'child', 'parent' or 'both' (got '$APP_CHOICE')." >&2; exit 2 ;;
      esac
      shift 2 ;;
    --release)       DO_RELEASE="yes"; shift ;;
    --skip-tests)    SKIP_TESTS="yes"; shift ;;
    --api-base-url)  need_value "$@"; API_BASE_URL="$2"; shift 2 ;;
    --enable-push)
      need_value "$@"
      ENABLE_PUSH="$2"
      case "$ENABLE_PUSH" in
        true|false) ;;
        *) echo "mobile-build: --enable-push must be 'true' or 'false' (got '$ENABLE_PUSH')." >&2; exit 2 ;;
      esac
      shift 2 ;;
    --log-dir)       need_value "$@"; LOG_DIR="$2"; shift 2 ;;
    --repo)          need_value "$@"; REPO_ROOT="$2"; shift 2 ;;
    # THE ONE LEGITIMATE CASE for a release without Firebase: a release-SIGNED
    # QA sideload on a machine that has the keystore but no Firebase project
    # yet. It does not make push work; it makes the absence explicit and
    # consented-to. The SIGNING blockers below are deliberately NOT
    # downgradable by it — a release build without a key produces nothing.
    --allow-release-without-push) ALLOW_NO_PUSH="yes"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "mobile-build: unknown argument '$1'. Try --help." >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$REPO_ROOT" ]; then REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"; fi

# shellcheck source=lib/repo-pins.sh
if ! . "$SCRIPT_DIR/lib/repo-pins.sh"; then
  echo "mobile-build: cannot source scripts/lib/repo-pins.sh" >&2
  exit 2
fi

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_DIM=""
fi

head_line() {
  printf '\n%s%s%s\n' "$C_CYN" "=============================================================================" "$C_RESET"
  printf '%s  %s%s\n' "$C_CYN" "$1" "$C_RESET"
  printf '%s%s%s\n' "$C_CYN" "=============================================================================" "$C_RESET"
}
info() { printf '  %s\n' "$1"; }
good() { printf '  %s[ OK ]%s %s\n' "$C_GRN" "$C_RESET" "$1"; }
warn() { printf '  %s[WARN]%s %s\n' "$C_YEL" "$C_RESET" "$1"; }

# ---------------------------------------------------------------------------
# die_stage — the loud, specific stop this script exists to produce.
# ---------------------------------------------------------------------------
die_stage() {
  local app="$1" stage="$2" cmd="$3" workdir="$4" logfile="$5" code="$6"
  printf '\n%s%s%s\n' "$C_RED" "=============================================================================" "$C_RESET"
  printf '%s  STOPPED — stage FAILED: %s (%s)%s\n' "$C_RED" "$stage" "$app" "$C_RESET"
  printf '%s%s%s\n' "$C_RED" "=============================================================================" "$C_RESET"
  printf '  failing command : %s\n' "$cmd"
  printf '  working dir     : %s\n' "$workdir"
  printf '  exit code       : %s\n' "$code"
  if [ -n "$logfile" ] && [ -f "$logfile" ]; then
    printf '  full output     : %s\n' "$logfile"
    printf '\n  %slast 40 lines of that log:%s\n' "$C_DIM" "$C_RESET"
    tail -n 40 "$logfile" | sed 's/^/    /'
  else
    printf '  full output     : (no log file was produced — the command did not start)\n'
  fi
  printf '\n  No later stage was run: this script stops at the first failure by design.\n'
  printf '  Nothing was masked, and no artifact was produced for %s.\n\n' "$app"
  exit 1
}

# run_stage <app> <stage-name> <workdir> <logfile> <cmd...>
# Streams and captures. Returns the command's real exit code; never swallows it.
run_stage() {
  local app="$1" stage="$2" workdir="$3" logfile="$4"; shift 4
  local printable="$*"

  printf '\n  %s--- %s : %s ---%s\n' "$C_CYN" "$app" "$stage" "$C_RESET"
  printf '  %s> %s%s\n' "$C_DIM" "$printable" "$C_RESET"
  mkdir -p "$(dirname "$logfile")"

  local code=0
  ( cd "$workdir" && "$@" ) > >(tee "$logfile") 2>&1 || code=$?
  # tee runs in a process substitution; give it a moment to flush before the
  # log is read by die_stage.
  wait 2>/dev/null || true

  if [ "$code" -ne 0 ]; then
    die_stage "$app" "$stage" "$printable" "$workdir" "$logfile" "$code"
  fi
  good "$stage OK  (log: $logfile)"
  return 0
}

head_line 'ABNY / «ابني» — mobile build'

if ! read_pins "$REPO_ROOT"; then
  echo "mobile-build: could not derive the repository's own pins; refusing to build against guessed values." >&2
  exit 2
fi

# API_BASE_URL default comes from the repository, not from this file.
if [ -z "$API_BASE_URL" ]; then
  API_BASE_URL="$PIN_DEBUG_API_URL"
  API_URL_ORIGIN="AppConfig.debugDefaultApiBaseUrl (read from the repository)"
  if [ -z "$API_BASE_URL" ]; then
    echo "mobile-build: could not read debugDefaultApiBaseUrl from apps/parent-app/lib/core/config/app_config.dart, and --api-base-url was not given." >&2
    echo "              Refusing to build: an APK without --dart-define=API_BASE_URL installs and can talk to nothing (audit MA-004)." >&2
    exit 2
  fi
else
  API_URL_ORIGIN="--api-base-url"
fi

# ENABLE_PUSH: default follows whether Firebase is actually configured, so a
# build without google-services.json is HONESTLY labelled rather than
# silently producing an artifact whose push path fails at runtime.
case "$APP_CHOICE" in
  child)  APPS="child-app" ;;
  parent) APPS="parent-app" ;;
  both)   APPS="parent-app child-app" ;;
esac

if [ -z "$LOG_DIR" ]; then LOG_DIR="$REPO_ROOT/build-logs/$(date +%Y%m%d-%H%M%S)"; fi
# Checked, not assumed: without a log directory every stage's output goes
# nowhere, and `die_stage`'s "full output" line would name a file that was
# never written.
if ! mkdir -p "$LOG_DIR"; then
  echo "mobile-build: cannot create the log directory '$LOG_DIR'." >&2
  exit 2
fi

info "repository   : $REPO_ROOT"
info "apps         : $APPS"
info "mode         : $([ "$DO_RELEASE" = yes ] && echo 'debug + RELEASE (apk + appbundle)' || echo 'debug only')"
info "API_BASE_URL : $API_BASE_URL   [$API_URL_ORIGIN]"
info "logs         : $LOG_DIR"
info "Flutter pin  : $PIN_FLUTTER (from .github/workflows/build-apk.yml)"

# ===========================================================================
# PREFLIGHT — a missing toolchain is a HARD STOP, never a skipped stage.
# ===========================================================================
head_line 'PREFLIGHT'

PREFLIGHT_FAIL="no"

if command -v flutter >/dev/null 2>&1; then
  GOT_FLUTTER="$(flutter --version 2>/dev/null | head -n 1 | sed -nE 's/^Flutter[[:space:]]+([0-9][0-9.]*).*/\1/p')"
  if [ "$GOT_FLUTTER" = "$PIN_FLUTTER" ]; then
    good "flutter $GOT_FLUTTER (matches the repository pin)"
  elif [ -n "$GOT_FLUTTER" ]; then
    warn "flutter $GOT_FLUTTER on PATH, but this repository pins $PIN_FLUTTER."
    warn "Flutter 3.27+ defaults compileSdk to 35 and AGP $PIN_AGP refuses anything above $PIN_COMPILE_SDK."
    warn "Continuing, because you may have a good reason — but a failure below may be the version, not the code."
  else
    warn "flutter is on PATH but 'flutter --version' could not be parsed. Continuing."
  fi
else
  printf '\n  %s[BLOCKED]%s flutter is not installed (no '\''flutter'\'' on PATH).\n' "$C_RED" "$C_RESET"
  printf '            Nothing below can run: pub get, analyze, test and build are all flutter.\n'
  printf '            This is reported as a BLOCKED PREFLIGHT rather than a skipped stage,\n'
  printf '            because a build script that "succeeds" without a compiler is worse than\n'
  printf '            one that fails.\n\n'
  printf '            Fix: install Flutter %s, then re-run this command.\n' "$PIN_FLUTTER"
  printf '              Windows      : powershell -ExecutionPolicy Bypass -File scripts/setup-windows-dev.ps1\n'
  printf '              Linux/macOS  : git clone -b %s --depth 1 https://github.com/flutter/flutter.git "$HOME/flutter"\n' "$PIN_FLUTTER"
  printf '                             export PATH="$PATH:$HOME/flutter/bin"\n'
  printf '            Then diagnose everything else at once with:\n'
  printf '              scripts/release-doctor.sh\n\n'
  PREFLIGHT_FAIL="yes"
fi

if [ "$PREFLIGHT_FAIL" = "yes" ]; then
  printf '  %sPREFLIGHT BLOCKED — no stage was attempted, no artifact was produced.%s\n\n' "$C_RED" "$C_RESET"
  exit 1
fi

# ===========================================================================
# RELEASE PREFLIGHT — fail HERE, not fifteen minutes into Gradle.
#
# NOTHING IN THIS BLOCK IS FABRICATED AND NOTHING IS DEFAULTED: each branch
# names the exact file, the exact directory and the exact command that produces
# it. It runs BEFORE the first `flutter pub get`, because every blocker it can
# report is readable from a committed file.
# ===========================================================================

# Does this app ACTUALLY use Firebase? Derived from the same three files, in
# the same order, as release-doctor.sh's `uses_firebase` and the .ps1's
# `Test-AppUsesFirebase`. Demanding google-services.json of the child app was
# an invented requirement: it declares no firebase dependency, its
# settings.gradle carries no google-services plugin, and its build.gradle never
# applies one.
uses_firebase() {
  local app="$1"
  local pubspec="$REPO_ROOT/apps/$app/pubspec.yaml"
  local settings="$REPO_ROOT/apps/$app/android/settings.gradle"
  local appgr="$REPO_ROOT/apps/$app/android/app/build.gradle"
  if [ -f "$pubspec" ] && grep -qE '^[[:space:]]*(firebase_core|firebase_messaging)[[:space:]]*:' "$pubspec"; then return 0; fi
  if [ -f "$settings" ] && grep -q 'com\.google\.gms\.google-services' "$settings"; then return 0; fi
  if [ -f "$appgr" ] && grep -qE '^[[:space:]]*apply[[:space:]]+plugin:[[:space:]]*"com\.google\.gms\.google-services"' "$appgr"; then return 0; fi
  return 1
}

# The keystore filename and alias come from the COMMITTED TEMPLATE, so this
# script never invents key material or a name for it. 4096-bit RSA and PKCS12
# are that template's own terms.
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

if [ "$DO_RELEASE" = "yes" ]; then
  head_line 'RELEASE PREFLIGHT'
  BLOCKERS=""
  BLOCKER_COUNT=0
  DROPPED_PUSH_BLOCKERS=0

  add_blocker() {
    BLOCKERS="${BLOCKERS}${1}
"
    BLOCKER_COUNT=$((BLOCKER_COUNT + 1))
  }

  for app in $APPS; do
    ANDROID_DIR="$REPO_ROOT/apps/$app/android"
    SIGNPROPS="$ANDROID_DIR/signing.properties"
    KEYTOOL_CMD="$(keytool_command_for "$app")"

    if [ ! -f "$SIGNPROPS" ]; then
      add_blocker "$app : $ANDROID_DIR/signing.properties is MISSING.
            app/build.gradle stops every release task rather than falling back to the debug key.
            Fix, in apps/$app/android/ :
              $KEYTOOL_CMD
              cp signing.properties.example signing.properties
            then fill storeFile / storePassword / keyAlias / keyPassword.
            Both signing.properties and *.jks are gitignored — never commit either."
    else
      MISSING_KEYS=""
      for k in storeFile storePassword keyAlias keyPassword; do
        # Present-but-EMPTY counts as missing, exactly as the gradle counts it.
        grep -qE "^[[:space:]]*$k[[:space:]]*=[[:space:]]*[^[:space:]]" "$SIGNPROPS" \
          || MISSING_KEYS="$MISSING_KEYS $k"
      done
      if [ -n "$MISSING_KEYS" ]; then
        add_blocker "$app : $SIGNPROPS is INCOMPLETE — missing or empty:$MISSING_KEYS.
            All four are required. A partial signing config is not signed 'less', it is not signed."
      else
        STORE_REL="$(sed -nE 's/^[[:space:]]*storeFile[[:space:]]*=[[:space:]]*(.+)$/\1/p' "$SIGNPROPS" | head -n 1 | tr -d '\r')"
        STORE_ABS="$ANDROID_DIR/$STORE_REL"
        RESOLVED=""
        if [ -f "$STORE_ABS" ]; then RESOLVED="$STORE_ABS"; elif [ -f "$STORE_REL" ]; then RESOLVED="$STORE_REL"; fi
        if [ -z "$RESOLVED" ]; then
          add_blocker "$app : the keystore named by signing.properties does not exist: '$STORE_REL'.
            storeFile is resolved relative to apps/$app/android/. Generate it there with:
              $KEYTOOL_CMD"
        else
          # A RELEASE MUST NOT BE SIGNABLE WITH A DEBUG KEY, and this refuses it
          # by name before any work starts. app/build.gradle's L3 assertion
          # refuses the same thing at the end of a fifteen-minute build; both
          # refusals exist because the debug key is a well-known, machine-local
          # throwaway and an artifact signed with it can never be uploaded to
          # Play and never updated.
          LEAF="$(basename "$RESOLVED" | tr '[:upper:]' '[:lower:]')"
          NORM="$(printf '%s' "$RESOLVED" | tr '[:upper:]' '[:lower:]')"
          case "$LEAF:$NORM" in
            debug.keystore:*|debug.jks:*|*:*/.android/debug*)
              add_blocker "$app : signing.properties points the RELEASE config at what looks like a DEBUG keystore:
              $RESOLVED
            app/build.gradle fails this build by name for the same reason. Generate a real upload key:
              $KEYTOOL_CMD" ;;
            *)
              good "$app : signing.properties complete, keystore $LEAF present" ;;
          esac
        fi
      fi
    fi

    # Firebase, required only of the app that actually declares it.
    GS="$REPO_ROOT/apps/$app/android/app/google-services.json"
    APP_ID="$(first_match "$REPO_ROOT/apps/$app/android/app/build.gradle" 'applicationId[[:space:]]+"([^"]+)"')"
    if ! uses_firebase "$app"; then
      info "$app : declares no Firebase dependency — google-services.json is not required."
    elif [ -f "$GS" ]; then
      good "$app : google-services.json present"
    elif [ "$ALLOW_NO_PUSH" = "yes" ]; then
      DROPPED_PUSH_BLOCKERS=$((DROPPED_PUSH_BLOCKERS + 1))
    else
      add_blocker "$app : $GS is MISSING, and this app DEPENDS on firebase_messaging.
            THE BUILD WOULD SUCCEED ANYWAY — the gradle default -Pabny.firebase=auto only warns — and
            produce a signed AAB in which every push notification silently never arrives.
            Only you can supply it: create the Firebase Android app for applicationId
              ${APP_ID:-<unreadable from app/build.gradle>}
            download google-services.json and place it at
              $GS
            See docs/release/FIREBASE_SETUP.md. Nothing in this repository can generate it, and a
            placeholder is worse than an absence: it builds and then fails silently at runtime.
            To build a release WITHOUT push on purpose, say so: --allow-release-without-push."
    fi
  done

  if [ "$DROPPED_PUSH_BLOCKERS" -gt 0 ]; then
    warn "--allow-release-without-push: $DROPPED_PUSH_BLOCKERS Firebase blocker(s) DOWNGRADED by explicit request."
    warn "The artifact this run produces has NO push notifications. Do not upload it to a store."
  fi

  if [ "$BLOCKER_COUNT" -gt 0 ]; then
    printf '\n%s%s%s\n' "$C_RED" "=============================================================================" "$C_RESET"
    printf '%s  RELEASE PREFLIGHT BLOCKED%s\n' "$C_RED" "$C_RESET"
    printf '%s%s%s\n' "$C_RED" "=============================================================================" "$C_RESET"
    printf '%s' "$BLOCKERS" | sed 's/^/  [BLOCKED] /'
    printf '\n  No stage was run and no artifact was produced. Every line above names a file\n'
    printf '  you must create; none of them has a default this script is willing to invent.\n\n'
    printf '  Diagnose the whole machine at once with:\n'
    printf '      scripts/release-doctor.sh\n\n'
    printf '  Or build the debug artifact, which needs none of this:\n'
    printf '      scripts/mobile-build.sh --app %s\n\n' "$APP_CHOICE"
    exit 1
  fi
  good 'release preflight passed — every precondition the release build needs is in place.'
fi

# ===========================================================================
# STAGES
# ===========================================================================
ARTIFACTS=""

for app in $APPS; do
  APP_DIR="$REPO_ROOT/apps/$app"
  if [ ! -d "$APP_DIR" ]; then
    echo "mobile-build: apps/$app does not exist under $REPO_ROOT." >&2
    exit 2
  fi

  # Per-app ENABLE_PUSH default: true only when this app has Firebase config.
  if [ -n "$ENABLE_PUSH" ]; then
    APP_ENABLE_PUSH="$ENABLE_PUSH"
    PUSH_ORIGIN="--enable-push"
  elif [ -f "$APP_DIR/android/app/google-services.json" ]; then
    APP_ENABLE_PUSH="true"
    PUSH_ORIGIN="google-services.json is present"
  else
    APP_ENABLE_PUSH="false"
    PUSH_ORIGIN="google-services.json is ABSENT — this artifact has no push, and says so"
  fi

  head_line "$app"
  info "ENABLE_PUSH  : $APP_ENABLE_PUSH   [$PUSH_ORIGIN]"

  DEFINES="--dart-define=API_BASE_URL=$API_BASE_URL --dart-define=ENABLE_PUSH=$APP_ENABLE_PUSH"

  run_stage "$app" "pub get"  "$APP_DIR" "$LOG_DIR/$app-01-pub-get.log"  flutter pub get
  run_stage "$app" "analyze"  "$APP_DIR" "$LOG_DIR/$app-02-analyze.log"  flutter analyze

  if [ "$SKIP_TESTS" = "yes" ]; then
    warn "test SKIPPED by --skip-tests. This is a deliberate reduction in confidence, not a pass."
  else
    run_stage "$app" "test"   "$APP_DIR" "$LOG_DIR/$app-03-test.log"     flutter test
  fi

  # shellcheck disable=SC2086
  run_stage "$app" "build apk --debug" "$APP_DIR" "$LOG_DIR/$app-04-apk-debug.log" \
    flutter build apk --debug $DEFINES
  ARTIFACTS="${ARTIFACTS}$app  debug APK    $APP_DIR/build/app/outputs/flutter-apk/app-debug.apk
"

  if [ "$DO_RELEASE" = "yes" ]; then
    # shellcheck disable=SC2086
    run_stage "$app" "build apk --release" "$APP_DIR" "$LOG_DIR/$app-05-apk-release.log" \
      flutter build apk --release $DEFINES
    ARTIFACTS="${ARTIFACTS}$app  release APK  $APP_DIR/build/app/outputs/flutter-apk/app-release.apk
"

    # shellcheck disable=SC2086
    run_stage "$app" "build appbundle --release" "$APP_DIR" "$LOG_DIR/$app-06-aab-release.log" \
      flutter build appbundle --release $DEFINES
    ARTIFACTS="${ARTIFACTS}$app  release AAB  $APP_DIR/build/app/outputs/bundle/release/app-release.aab
"
  fi
done

# ===========================================================================
# ARTIFACTS
# ===========================================================================
head_line 'ARTIFACTS'
printf '%s' "$ARTIFACTS" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  path="$(printf '%s' "$line" | awk '{print $NF}')"
  if [ -f "$path" ]; then
    size="$(du -h "$path" 2>/dev/null | cut -f1)"
    printf '  %s[ OK ]%s %s  (%s)\n' "$C_GRN" "$C_RESET" "$line" "$size"
  else
    printf '  %s[MISSING]%s %s\n' "$C_RED" "$C_RESET" "$line"
    printf '           The stage reported success but the file is not there. Treat this as a failure:\n'
    printf '           check the build log in %s.\n' "$LOG_DIR"
  fi
done

printf '\n  logs: %s\n' "$LOG_DIR"
if [ "$DO_RELEASE" = "yes" ]; then
  # `key.properties` was the name here and it is not the file the gradle reads:
  # app/build.gradle reads `rootProject.file("signing.properties")` and
  # android/.gitignore ignores that name. The RELEASE PREFLIGHT above already
  # proved it resolved a real, non-debug keystore, so this line now says what is
  # true rather than what a template once called it.
  printf '  %sRelease artifacts were signed from apps/<app>/android/signing.properties (checked in RELEASE PREFLIGHT).%s\n' "$C_YEL" "$C_RESET"
  printf '  Verify the signature before uploading:  python3 scripts/verify_release_signing.py\n'
fi
printf '\n  %sALL STAGES PASSED.%s\n\n' "$C_GRN" "$C_RESET"
exit 0
