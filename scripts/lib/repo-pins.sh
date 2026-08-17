# shellcheck shell=bash
# ===========================================================================
# repo-pins.sh — the POSIX-shell half of `Get-RepoPins`.
#
# WHY THIS FILE EXISTS
# `scripts/setup-windows-dev.ps1` established the rule that this repository
# obeys and that this file continues: NO TOOLCHAIN VERSION IS EVER TYPED FROM
# MEMORY. Every expected value is parsed out of the file that already owns it,
# at run time, so a pin can never drift from the thing that enforces it.
#
# That script is PowerShell and cannot be sourced by bash, so the *parsing*
# is expressed here once and shared by BOTH bash consumers
# (`release-doctor.sh`, `mobile-build.sh`) instead of being written twice.
# The SOURCES and the REGEXES below are deliberately the same ones
# `Get-RepoPins` uses — that function remains the reference implementation:
#
#   Flutter SDK      .github/workflows/build-apk.yml   env.FLUTTER_VERSION
#   JDK major        .github/workflows/build-apk.yml   env.JAVA_VERSION
#   Gradle           apps/*/android/gradle/wrapper/gradle-wrapper.properties
#   AGP              apps/*/android/settings.gradle    com.android.application
#   Kotlin           apps/*/android/settings.gradle    kotlin.android
#   compileSdk       apps/*/android/app/build.gradle
#   targetSdk        apps/*/android/app/build.gradle
#   minSdk           apps/*/android/app/build.gradle
#   applicationId    apps/*/android/app/build.gradle
#   Dart constraint  apps/*/pubspec.yaml               environment.sdk
#   API_BASE_URL     apps/*/lib/core/config/app_config.dart
#
# LIKE Get-RepoPins, THE TWO APPS ARE PARSED INDEPENDENTLY AND THEN COMPARED.
# A disagreement on a shared toolchain pin is a HARD STOP, not a pick-one:
# one toolchain cannot satisfy two different pins, and a silent divergence
# between the two apps is precisely the defect class this parsing prevents.
#
# NOT IN THE REPOSITORY, AND SAID PLAINLY (same three caveats as the .ps1):
#   1. build-tools — no `buildToolsVersion` is declared by either app, so it
#      is DERIVED as "<compileSdk>.0.0" and the derivation is printed.
#   2. The cmdline-tools bundle version is an INSTALLER, not a build input.
#   3. ndkVersion is left as `flutter.ndkVersion` by both apps; no NDK is
#      expected, and Gradle will name one by plugin if that ever changes.
#
# Every function sets globals prefixed PIN_ and returns non-zero on a parse
# failure rather than emitting an empty string, because an empty expected
# value silently turns every comparison downstream into a false PASS.
# ===========================================================================

PIN_APPS="parent-app child-app"

# first_match <file> <extended-regex-with-one-capture-group>
# Prints capture group 1 of the first match, or nothing. sed is used rather
# than grep -P because busybox/macOS grep has no -P.
first_match() {
  local file="$1" re="$2"
  [ -f "$file" ] || return 1
  sed -nE "s/.*${re}.*/\1/p" "$file" | head -n 1
}

# Multi-line variant for pubspec's `environment:` block: the `sdk:` key only
# counts when it is inside that block, so a `sdk:` under some other key can
# never be mistaken for the Dart constraint.
parse_dart_sdk() {
  local pubspec="$1"
  [ -f "$pubspec" ] || return 1
  awk '
    /^environment:/ { inenv = 1; next }
    inenv && /^[a-zA-Z]/ { inenv = 0 }
    inenv && /^[[:space:]]+sdk:/ {
      if (match($0, /"[^"]+"/)) {
        print substr($0, RSTART + 1, RLENGTH - 2); exit
      }
    }
  ' "$pubspec"
}

pins_fail() {
  echo "REPO-PINS FATAL: $*" >&2
  return 1
}

# read_pins <repo-root>
# On success every PIN_* global below is a non-empty, repository-derived value.
read_pins() {
  local root="$1"
  local wf="$root/.github/workflows/build-apk.yml"

  if [ ! -f "$wf" ]; then
    pins_fail "cannot find .github/workflows/build-apk.yml under '$root'."
    return 1
  fi

  PIN_FLUTTER="$(first_match "$wf" 'FLUTTER_VERSION:[[:space:]]*"?([0-9.]+)"?')"
  PIN_JAVA_MAJOR="$(first_match "$wf" 'JAVA_VERSION:[[:space:]]*"?([0-9]+)"?')"
  [ -n "$PIN_FLUTTER" ]    || { pins_fail "FLUTTER_VERSION not found in $wf."; return 1; }
  [ -n "$PIN_JAVA_MAJOR" ] || { pins_fail "JAVA_VERSION not found in $wf."; return 1; }

  local app a wrapper settings appgr pubspec config
  local shared_keys="GRADLE AGP KOTLIN COMPILE_SDK TARGET_SDK MIN_SDK"

  for app in $PIN_APPS; do
    a="$root/apps/$app"
    [ -d "$a" ] || { pins_fail "missing apps/$app under '$root'."; return 1; }

    wrapper="$a/android/gradle/wrapper/gradle-wrapper.properties"
    settings="$a/android/settings.gradle"
    appgr="$a/android/app/build.gradle"
    pubspec="$a/pubspec.yaml"
    config="$a/lib/core/config/app_config.dart"

    local v_gradle v_agp v_kotlin v_compile v_target v_min v_appid v_dart v_url
    v_gradle="$(first_match  "$wrapper"  'gradle-([0-9.]+)-(bin|all)\.zip')"
    v_agp="$(first_match     "$settings" 'id[[:space:]]+"com\.android\.application"[[:space:]]+version[[:space:]]+"([^"]+)"')"
    v_kotlin="$(first_match  "$settings" 'id[[:space:]]+"org\.jetbrains\.kotlin\.android"[[:space:]]+version[[:space:]]+"([^"]+)"')"
    v_compile="$(first_match "$appgr"    '^[[:space:]]*compileSdk[[:space:]]+([0-9]+)[[:space:]]*$')"
    v_target="$(first_match  "$appgr"    '^[[:space:]]*targetSdk[[:space:]]+([0-9]+)[[:space:]]*$')"
    v_min="$(first_match     "$appgr"    '^[[:space:]]*minSdk[[:space:]]+([0-9]+)[[:space:]]*$')"
    v_appid="$(first_match   "$appgr"    'applicationId[[:space:]]+"([^"]+)"')"
    v_dart="$(parse_dart_sdk "$pubspec")"
    v_url="$(first_match     "$config"   "debugDefaultApiBaseUrl[[:space:]]*=[[:space:]]*'([^']+)'")"

    # Same hard-stop list as Get-RepoPins: these six are the toolchain, and a
    # guess is worse than a refusal.
    local key val
    for key in $shared_keys; do
      case "$key" in
        GRADLE)      val="$v_gradle" ;;
        AGP)         val="$v_agp" ;;
        KOTLIN)      val="$v_kotlin" ;;
        COMPILE_SDK) val="$v_compile" ;;
        TARGET_SDK)  val="$v_target" ;;
        MIN_SDK)     val="$v_min" ;;
      esac
      if [ -z "$val" ]; then
        pins_fail "could not read '$key' for $app. The Gradle files moved; fix scripts/lib/repo-pins.sh rather than guessing a value."
        return 1
      fi
    done

    case "$app" in
      parent-app)
        P_GRADLE="$v_gradle"; P_AGP="$v_agp"; P_KOTLIN="$v_kotlin"
        P_COMPILE_SDK="$v_compile"; P_TARGET_SDK="$v_target"; P_MIN_SDK="$v_min"
        PIN_PARENT_APP_ID="$v_appid"; PIN_DART_SDK="$v_dart"; PIN_DEBUG_API_URL="$v_url"
        ;;
      child-app)
        C_GRADLE="$v_gradle"; C_AGP="$v_agp"; C_KOTLIN="$v_kotlin"
        C_COMPILE_SDK="$v_compile"; C_TARGET_SDK="$v_target"; C_MIN_SDK="$v_min"
        PIN_CHILD_APP_ID="$v_appid"
        ;;
    esac
  done

  # ---- the two apps must AGREE; disagreement is a hard stop ---------------
  local k pv cv
  for k in $shared_keys; do
    case "$k" in
      GRADLE)      pv="$P_GRADLE";      cv="$C_GRADLE" ;;
      AGP)         pv="$P_AGP";         cv="$C_AGP" ;;
      KOTLIN)      pv="$P_KOTLIN";      cv="$C_KOTLIN" ;;
      COMPILE_SDK) pv="$P_COMPILE_SDK"; cv="$C_COMPILE_SDK" ;;
      TARGET_SDK)  pv="$P_TARGET_SDK";  cv="$C_TARGET_SDK" ;;
      MIN_SDK)     pv="$P_MIN_SDK";     cv="$C_MIN_SDK" ;;
    esac
    if [ "$pv" != "$cv" ]; then
      pins_fail "apps/parent-app and apps/child-app disagree on ${k}: '$pv' vs '$cv'. One toolchain cannot satisfy both. Reconcile the Gradle files first."
      return 1
    fi
  done

  PIN_GRADLE="$P_GRADLE"
  PIN_AGP="$P_AGP"
  PIN_KOTLIN="$P_KOTLIN"
  PIN_COMPILE_SDK="$P_COMPILE_SDK"
  PIN_TARGET_SDK="$P_TARGET_SDK"
  PIN_MIN_SDK="$P_MIN_SDK"

  # DERIVED, not read — stated wherever it is used. See caveat 1 above.
  PIN_BUILD_TOOLS="${PIN_COMPILE_SDK}.0.0"
  PIN_BUILD_TOOLS_DERIVED="yes"

  return 0
}
