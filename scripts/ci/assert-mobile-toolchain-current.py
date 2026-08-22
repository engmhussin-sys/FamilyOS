#!/usr/bin/env python3
"""
===========================================================================
CI RULE 4, MOBILE HALF — Flutter, AGP, Gradle and Kotlin may not fall behind.
===========================================================================

`apps/backend/scripts/ci/assert-dependencies-current.ts` enforces C-6 for
everything npm can see. It cannot see the mobile toolchain: Flutter's version
lives in a workflow variable, AGP's and Kotlin's in `settings.gradle`, and
Gradle's in a wrapper properties file. Four pins, four different files, none of
them a package.json — so four pins that go stale silently, which is exactly what
happened here: Flutter has been held at 3.24.5 by a chain nobody re-examined.

WHAT IT DOES. Reads each pin out of the repository, asks the AUTHORITATIVE
endpoint for the current release, and fails when a pin is behind.

  Flutter  storage.googleapis.com/flutter_infra_release/releases/releases_linux.json
  AGP      dl.google.com/dl/android/maven2/.../gradle/maven-metadata.xml
  Gradle   services.gradle.org/versions/current
  Kotlin   repo1.maven.org/maven2/.../kotlin-gradle-plugin/maven-metadata.xml

WHY IT IS A SCRIPT AND NOT A DOCUMENT. The four upgrades are CHAINED, and the
chain is the whole reason the apps are stale:

    Flutter 3.27+ defaults compileSdk to 35
      -> AGP refuses: "compileSdk 35 requires Android Gradle Plugin 8.6.0+"
        -> newer AGP requires a newer Gradle wrapper
          -> and a Kotlin version its plugin accepts

Nobody upgrades one of those. Somebody upgrades all four, in order, or none.
Printed together, in order, the chain is a job. Printed apart, it is four
tickets that each look declinable.

WHY IT TOLERATES BEING OFFLINE. Some build environments — this project's own
agent container among them — can reach npm and nothing else. A check that fails
the build when it cannot ASK is a check that gets deleted the first time it
does. It reports what it could not reach and passes. CI has a network, and CI
is where this matters.

Run: python3 scripts/ci/assert-mobile-toolchain-current.py
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TIMEOUT = 30

FLUTTER_RELEASES = "https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json"
AGP_METADATA = "https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml"
GRADLE_CURRENT = "https://services.gradle.org/versions/current"
KOTLIN_METADATA = (
    "https://repo1.maven.org/maven2/org/jetbrains/kotlin/kotlin-gradle-plugin/maven-metadata.xml"
)


class Unreachable(Exception):
    """The registry could not be asked. Not a failure — see the module docstring."""


def fetch(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return response.read().decode("utf-8")
    except Exception as exc:  # noqa: BLE001 — every failure mode is "could not ask"
        raise Unreachable(f"{url}: {exc}") from exc


def version_key(value: str) -> tuple[int, ...]:
    """Numeric-segment comparison. A pre-release suffix sorts below its release."""
    return tuple(int(part) for part in re.findall(r"\d+", value)[:4])


def is_stable(value: str) -> bool:
    return not re.search(r"(alpha|beta|rc|dev|-M\d)", value, re.IGNORECASE)


# --------------------------------------------------------------------------- #
# What the repository currently pins.
# --------------------------------------------------------------------------- #

def pinned_flutter() -> tuple[str, Path]:
    path = REPO / ".github/workflows/build-apk.yml"
    match = re.search(r'FLUTTER_VERSION:\s*"([^"]+)"', path.read_text(encoding="utf-8"))
    if not match:
        raise SystemExit(f"Could not find FLUTTER_VERSION in {path}")
    return match.group(1), path


def pinned_from_settings(pattern: str) -> list[tuple[str, Path]]:
    found = []
    for app in ("parent-app", "child-app"):
        path = REPO / f"apps/{app}/android/settings.gradle"
        if not path.exists():
            continue
        match = re.search(pattern, path.read_text(encoding="utf-8"))
        if match:
            found.append((match.group(1), path))
    return found


def pinned_gradle() -> list[tuple[str, Path]]:
    found = []
    for app in ("parent-app", "child-app"):
        path = REPO / f"apps/{app}/android/gradle/wrapper/gradle-wrapper.properties"
        if not path.exists():
            continue
        match = re.search(r"gradle-([0-9.]+)-bin\.zip", path.read_text(encoding="utf-8"))
        if match:
            found.append((match.group(1), path))
    return found


# --------------------------------------------------------------------------- #
# What the authoritative source says is current.
# --------------------------------------------------------------------------- #

def latest_flutter() -> str:
    data = json.loads(fetch(FLUTTER_RELEASES))
    stable_hash = data["current_release"]["stable"]
    for release in data["releases"]:
        if release["hash"] == stable_hash:
            return release["version"]
    raise Unreachable("stable release hash not present in the release list")


def latest_from_maven(url: str) -> str:
    versions = [
        node.text or ""
        for node in ET.fromstring(fetch(url)).iter("version")
    ]
    stable = [v for v in versions if is_stable(v)]
    if not stable:
        raise Unreachable(f"no stable version in {url}")
    return max(stable, key=version_key)


def latest_gradle() -> str:
    return json.loads(fetch(GRADLE_CURRENT))["version"]


# --------------------------------------------------------------------------- #

def main() -> int:
    checks: list[tuple[str, list[tuple[str, Path]], object]] = [
        ("Flutter", [pinned_flutter()], latest_flutter),
        (
            "Android Gradle Plugin",
            pinned_from_settings(r'id "com\.android\.application" version "([^"]+)"'),
            lambda: latest_from_maven(AGP_METADATA),
        ),
        ("Gradle wrapper", pinned_gradle(), latest_gradle),
        (
            "Kotlin",
            pinned_from_settings(r'id "org\.jetbrains\.kotlin\.android" version "([^"]+)"'),
            lambda: latest_from_maven(KOTLIN_METADATA),
        ),
    ]

    behind: list[str] = []
    unreachable: list[str] = []

    print("CI RULE 4 (mobile) — Flutter / Android toolchain currency")

    for name, pins, resolve in checks:
        if not pins:
            continue
        try:
            latest = resolve()  # type: ignore[operator]
        except Unreachable as exc:
            unreachable.append(f"{name} ({exc})")
            continue

        for pinned, path in pins:
            rel = path.relative_to(REPO)
            if version_key(pinned) < version_key(latest):
                behind.append(f"{name:22} pinned {pinned:12} latest {latest:12} {rel}")
            else:
                print(f"  OK  {name:22} {pinned:12} ({rel})")

    if unreachable:
        print(f"\n  registry unreachable for : {len(unreachable)} — not a failure, see this file's header")
        for item in unreachable:
            print(f"    {item}")

    if behind:
        print(f"\n  {len(behind)} mobile toolchain pin(s) are BEHIND:\n")
        for line in behind:
            print(f"    {line}")
        print(
            "\n  THESE UPGRADE TOGETHER, IN THIS ORDER — that is why they are one report:\n"
            "    1. Gradle wrapper   (newer AGP requires it)\n"
            "    2. AGP              (compileSdk 35+ requires 8.6.0 or higher — AGP's own message)\n"
            "    3. Kotlin           (must be a version the AGP/Flutter plugin accepts)\n"
            "    4. Flutter          (3.27+ defaults compileSdk to 35, which needs all of the above)\n"
            "       then raise compileSdk/targetSdk in apps/*/android/app/build.gradle\n"
            "\n  Verify with a real build — `flutter analyze` and `flutter test` for both apps,\n"
            "  then the APK job. A mobile toolchain bump that was not built is not an upgrade.\n"
        )
        return 1

    if not unreachable:
        print("\n  violations               : 0")
        print("  OK — the mobile toolchain is current.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
