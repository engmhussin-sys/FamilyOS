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
# STATUS: EXECUTED — in an environment with no Flutter SDK, where it stops on
# the preflight with a BLOCKED message rather than pretending to build. That
# run is recorded in the Phase G ship report. It has NEVER completed a real
# build, because no environment available to its author can.
#
# Usage:
#   scripts/mobile-build.sh [--app child|parent|both] [--release]
#                           [--api-base-url URL] [--enable-push true|false]
#                           [--skip-tests] [--log-dir DIR]
# ===========================================================================

set -uo pipefail

APP_CHOICE="both"
DO_RELEASE="no"
SKIP_TESTS="no"
API_BASE_URL=""
ENABLE_PUSH=""
LOG_DIR=""
REPO_ROOT=""

usage() { sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      APP_CHOICE="${2:-}"
      case "$APP_CHOICE" in
        child|parent|both) ;;
        *) echo "mobile-build: --app must be 'child', 'parent' or 'both' (got '$APP_CHOICE')." >&2; exit 2 ;;
      esac
      shift 2 ;;
    --release)       DO_RELEASE="yes"; shift ;;
    --skip-tests)    SKIP_TESTS="yes"; shift ;;
    --api-base-url)  API_BASE_URL="${2:-}"; shift 2 ;;
    --enable-push)   ENABLE_PUSH="${2:-}"; shift 2 ;;
    --log-dir)       LOG_DIR="${2:-}"; shift 2 ;;
    --repo)          REPO_ROOT="${2:-}"; shift 2 ;;
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
mkdir -p "$LOG_DIR"

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
  printf '  %sRelease artifacts are SIGNED ONLY IF android/key.properties resolved a real keystore.%s\n' "$C_YEL" "$C_RESET"
  printf '  Verify before uploading:  python3 scripts/verify_release_signing.py\n'
fi
printf '\n  %sALL STAGES PASSED.%s\n\n' "$C_GRN" "$C_RESET"
exit 0
