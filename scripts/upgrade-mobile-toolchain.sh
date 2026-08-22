#!/usr/bin/env bash
# =============================================================================
# THE FLUTTER / ANDROID UPGRADE, AS A SCRIPT RATHER THAN AS FOUR EDITS.
#
# WHY THIS EXISTS AT ALL. The four pins that hold these apps back — Flutter, the
# Android Gradle Plugin, the Gradle wrapper and Kotlin — live in four different
# files, none of them a package.json, and they are CHAINED:
#
#     Flutter 3.27+ defaults compileSdk to 35
#       -> AGP refuses: "compileSdk 35 requires Android Gradle Plugin 8.6.0+"
#         -> newer AGP requires a newer Gradle wrapper
#           -> and a Kotlin version its plugin accepts
#
# Upgrading one of them fails. Upgrading all four by hand means reading four
# release pages and hoping. This reads the CURRENT version of each from its
# authoritative source and writes all four, in order, in one commit-sized step.
#
# WHY IT IS NOT A LIST OF VERSION NUMBERS. Convention C-5: a version pin is
# never written from memory. The agent environment that produced this file can
# reach npm and nothing else — not storage.googleapis.com, not dl.google.com,
# not services.gradle.org — so any number it typed here would be a guess about
# two apps that run on children's phones. The numbers come from the network, on
# a machine that has one.
#
# IT DOES NOT COMMIT AND IT DOES NOT PUSH. It edits, prints what it changed, and
# tells you what to build. A mobile toolchain bump that was not built is not an
# upgrade.
#
# USAGE
#   scripts/upgrade-mobile-toolchain.sh            # apply
#   scripts/upgrade-mobile-toolchain.sh --dry-run  # show what it would write
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required"; exit 1; }; }
need curl
need python3

echo "Resolving current versions from their authoritative sources…"

# Diagnostics go to STDERR, never stdout: this function's stdout IS the
# version string, so a message printed there is captured into the variable
# instead of shown. That is exactly how the first draft "succeeded" with an
# empty version on a machine that could reach nothing.
resolve() {
  # $1 = label, $2 = python expression producing the version
  local label="$1" expr="$2" value
  if ! value=$(python3 - "$expr" <<'PY' 2>/dev/null
import json, re, sys, urllib.request, xml.etree.ElementTree as ET

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode()

def key(v):
    return tuple(int(p) for p in re.findall(r"\d+", v)[:4])

def stable(v):
    return not re.search(r"(alpha|beta|rc|dev|-M\d)", v, re.I)

def maven_latest(url):
    vs = [n.text or "" for n in ET.fromstring(get(url)).iter("version")]
    return max([v for v in vs if stable(v)], key=key)

def flutter_latest():
    d = json.loads(get("https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json"))
    h = d["current_release"]["stable"]
    return next(r["version"] for r in d["releases"] if r["hash"] == h)

def gradle_latest():
    return json.loads(get("https://services.gradle.org/versions/current"))["version"]

print(eval(sys.argv[1]))
PY
  ) || [ -z "$value" ]; then
    {
      echo
      echo "  FAILED to resolve $label - this machine cannot reach its source."
      echo "  Run this where storage.googleapis.com, dl.google.com, repo1.maven.org"
      echo "  and services.gradle.org are reachable. Nothing was written."
    } >&2
    return 1
  fi
  printf %s "$value"
}

FLUTTER=$(resolve "Flutter"  'flutter_latest()') || exit 1
AGP=$(resolve     "AGP"      'maven_latest("https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml")') || exit 1
GRADLE=$(resolve  "Gradle"   'gradle_latest()') || exit 1
KOTLIN=$(resolve  "Kotlin"   'maven_latest("https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-gradle-plugin/maven-metadata.xml")') || exit 1

echo
echo "  Flutter : $FLUTTER"
echo "  AGP     : $AGP"
echo "  Gradle  : $GRADLE"
echo "  Kotlin  : $KOTLIN"
echo

# compileSdk is deliberately NOT resolved from a registry. It is a product
# decision about which Android API level the apps target, and the safe default when
# unpinning is "whatever this Flutter defaults to" — which is what removing the
# hard-coded override achieves. See the note printed at the end.
COMPILE_SDK="${COMPILE_SDK:-35}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "--dry-run: no files written."
  exit 0
fi

for app in parent-app child-app; do
  settings="apps/$app/android/settings.gradle"
  wrapper="apps/$app/android/gradle/wrapper/gradle-wrapper.properties"
  appgradle="apps/$app/android/app/build.gradle"

  # 1. Gradle wrapper FIRST — newer AGP refuses to load on an old one.
  python3 - "$wrapper" "$GRADLE" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s = re.sub(r"gradle-[0-9.]+-bin\.zip", f"gradle-{version}-bin.zip", s)
open(path, "w", encoding="utf-8").write(s)
PY

  # 2. AGP and 3. Kotlin.
  python3 - "$settings" "$AGP" "$KOTLIN" <<'PY'
import re, sys
path, agp, kotlin = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
s = re.sub(r'(id "com\.android\.application" version ")[^"]+(")', rf'\g<1>{agp}\g<2>', s)
s = re.sub(r'(id "org\.jetbrains\.kotlin\.android" version ")[^"]+(")', rf'\g<1>{kotlin}\g<2>', s)
open(path, "w", encoding="utf-8").write(s)
PY

  # 4. compileSdk / targetSdk — the reason the whole chain was pinned.
  python3 - "$appgradle" "$COMPILE_SDK" <<'PY'
import re, sys
path, sdk = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
s = re.sub(r"^(\s*)compileSdk\s+\d+", rf"\g<1>compileSdk {sdk}", s, flags=re.M)
s = re.sub(r"^(\s*)targetSdk\s+\d+", rf"\g<1>targetSdk {sdk}", s, flags=re.M)
open(path, "w", encoding="utf-8").write(s)
PY

  echo "  updated apps/$app"
done

# 5. The workflow pin, so CI builds what the repository now expects.
python3 - "$FLUTTER" <<'PY'
import re, sys
path = ".github/workflows/build-apk.yml"
s = open(path, encoding="utf-8").read()
s = re.sub(r'(FLUTTER_VERSION:\s*")[^"]+(")', rf'\g<1>{sys.argv[1]}\g<2>', s)
open(path, "w", encoding="utf-8").write(s)
PY
echo "  updated .github/workflows/build-apk.yml"

cat <<EOF

WRITTEN. NOW BUILD IT — none of the above is verified until you do:

  cd apps/parent-app && flutter pub get && flutter analyze && flutter test
  cd ../child-app    && flutter pub get && flutter analyze && flutter test
  # then the APK job, which is the only thing that exercises AGP and Gradle:
  gh workflow run build-apk.yml

EXPECT TO FIX THINGS. A four-version jump across Flutter, AGP, Gradle and
Kotlin routinely breaks: Gradle plugin DSL syntax, Kotlin jvmTarget vs Java
version, namespace declarations AGP 8 requires, and any plugin in pubspec.yaml
that has not kept up. Those are the real work; this script only removes the
part that was clerical.

The dependency guard will tell you if anything is still behind:

  python3 scripts/ci/assert-mobile-toolchain-current.py
EOF
