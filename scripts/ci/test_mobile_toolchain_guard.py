#!/usr/bin/env python3
"""
Proves the mobile-toolchain guard actually DETECTS, rather than passing because
it could not ask.

The guard tolerates an unreachable registry on purpose — a check that fails when
it cannot reach the network is a check that gets deleted. But that tolerance is
also how a broken guard hides: in an offline container it prints "unreachable"
and exits 0 whether its logic works or not. This file removes that hiding place
by running the two halves that need no network:

  1. THE PIN EXTRACTION, against the repository's REAL files. If someone
     reformats settings.gradle or the wrapper properties, the regexes stop
     matching and the guard silently checks nothing — this fails instead.
  2. THE COMPARISON, against fixed pairs. Including the ordering trap that
     version strings invite: 8.10 is NEWER than 8.9, and a string comparison
     says the opposite.

Run: python3 scripts/ci/test_mobile_toolchain_guard.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "guard", REPO / "scripts/ci/assert-mobile-toolchain-current.py"
)
guard = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(guard)

failures: list[str] = []


def check(label: str, actual: object, expected: object) -> None:
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")
    else:
        print(f"  OK  {label}")


print("mobile toolchain guard — self test")

# --- 1. Extraction, from the real files -------------------------------------
flutter, flutter_path = guard.pinned_flutter()
check("reads FLUTTER_VERSION from the workflow", bool(flutter and flutter[0].isdigit()), True)
check("names the file it read it from", flutter_path.exists(), True)

agp = guard.pinned_from_settings(r'id "com\.android\.application" version "([^"]+)"')
check("finds an AGP pin in both apps", len(agp), 2)
check("AGP pins agree across the two apps", len({v for v, _ in agp}), 1)

kotlin = guard.pinned_from_settings(r'id "org\.jetbrains\.kotlin\.android" version "([^"]+)"')
check("finds a Kotlin pin in both apps", len(kotlin), 2)

gradle = guard.pinned_gradle()
check("finds a Gradle wrapper pin in both apps", len(gradle), 2)

# --- 2. Comparison ----------------------------------------------------------
behind_pairs = [("3.24.5", "3.29.0"), ("8.1.1", "8.7.3"), ("8.3", "8.11"), ("1.9.10", "2.0.21")]
for pinned, newer in behind_pairs:
    check(
        f"{pinned} is detected as behind {newer}",
        guard.version_key(pinned) < guard.version_key(newer),
        True,
    )

# THE TRAP. "8.10" < "8.9" as strings, and 8.10 is the newer release. A guard
# that compared strings would report a current toolchain as behind, cry wolf
# once, and be switched off.
check("8.10 is NEWER than 8.9 (numeric, not lexical)", guard.version_key("8.10") > guard.version_key("8.9"), True)
check("an equal pin is not behind", guard.version_key("8.7.3") < guard.version_key("8.7.3"), False)
check("a newer pin is not behind", guard.version_key("9.0.0") < guard.version_key("8.7.3"), False)

# --- 3. Stability filter ----------------------------------------------------
check("a release candidate is not 'latest'", guard.is_stable("8.8.0-rc01"), False)
check("an alpha is not 'latest'", guard.is_stable("8.9.0-alpha03"), False)
check("a plain release is", guard.is_stable("8.7.3"), True)

if failures:
    print("\nFAILED:")
    for line in failures:
        print(f"  {line}")
    sys.exit(1)

print(f"\n  all checks passed — the guard can read this repository's pins and compare them.")
print(f"  (pins today: Flutter {flutter}, AGP {agp[0][0]}, Gradle {gradle[0][0]}, Kotlin {kotlin[0][0]})")
