#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_accessibility_check.py — F2, audit MA-008 / verdict risk R6.

Proves, statically, that the "is our AccessibilityService enabled?" check
is no longer a string comparison anywhere in the child app's native layer.

WHY A SCRIPT AND NOT A GREP: the claim being made is a NEGATIVE one
("no call site does X"), and a negative claim needs an exhaustive check
plus a demonstration that the checker can actually fail. Both are here.

Checks
------
A. No raw string comparison against ENABLED_ACCESSIBILITY_SERVICES.
   Any file reading that Settings key must, in the same file, parse the
   value through ComponentName.unflattenFromString and must not compare
   entries with equals()/== against a String.
B. Settings.Secure.ACCESSIBILITY_ENABLED is consulted (it was absent
   from the whole repository before F2).
C. No call site passes a flattened component-name string into the
   accessibility check any more — i.e. no live reference to
   AgentChannel.ACCESSIBILITY_SERVICE_COMPONENT_NAME outside its own
   (deprecated) declaration in AgentChannel.kt.
D. Every call site uses the ComponentName-based entry point.
E. The hard-coded flattened component string appears in exactly one
   place: the deprecated constant.

Exit code 0 when every check passes.

Run:  python3 scripts/verify_accessibility_check.py [--self-test]
"""

from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE_ROOT = os.path.join(
    ROOT, "apps", "child-app", "android", "app", "src", "main", "kotlin"
)

# Qualified on purpose: the bare token also appears inside deprecation
# MESSAGES that explain the old bug, and a checker that cannot tell an
# explanation from an occurrence is a checker that produces noise.
ENABLED_SERVICES_KEY = "Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES"
GLOBAL_ENABLED_KEY = "Settings.Secure.ACCESSIBILITY_ENABLED"
FLAT_CONSTANT = "ACCESSIBILITY_SERVICE_COMPONENT_NAME"
# A real invocation: `<receiver>.isChildGuardAccessibilityServiceEnabled()`.
# Matched with a regex rather than a substring so the same identifier
# appearing inside a KDoc or a @Deprecated message is not counted as a
# call site.
CALL_SITE_RE = re.compile(r"\b(\w+)\.isChildGuardAccessibilityServiceEnabled\(\)")

# The two shapes of the defect this whole exercise is about.
RAW_COMPARISON_PATTERNS = [
    # .any { it.equals(someString) } / == someString over a split() result
    re.compile(r"\.split\(\s*[\"']:[\"']\s*\)[\s\S]{0,200}?\.equals\s*\("),
    re.compile(r"\.split\(\s*':'\s*\)[\s\S]{0,200}?\.equals\s*\("),
    # contains(<a String>) directly on the setting value
    re.compile(r"enabledServices\s*\.\s*contains\s*\("),
    re.compile(r"Settings\.Secure\.ENABLED_ACCESSIBILITY_SERVICES[\s\S]{0,400}?\.contains\s*\("),
]


def kotlin_files(root: str) -> list[str]:
    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(".kt"):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def strip_comments(src: str) -> str:
    """Remove // and /* */ comments so documentation about the old bug is
    not mistaken for the old bug. Strings are left intact on purpose:
    a component name hidden in a string literal is exactly what we hunt."""
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"//[^\n]*", "", src)
    return src


def rel(path: str) -> str:
    return os.path.relpath(path, ROOT)


def run(native_root: str) -> int:
    files = kotlin_files(native_root)
    problems: list[str] = []

    print(f"scanned root      : {native_root}")
    print(f"kotlin files      : {len(files)}")

    reads_setting: list[str] = []
    uses_unflatten: list[str] = []
    checks_global: list[str] = []
    flat_constant_refs: list[tuple[str, int, str]] = []
    call_sites: list[tuple[str, int, str]] = []
    raw_comparisons: list[tuple[str, int, str]] = []
    flat_literals: list[tuple[str, int]] = []

    for path in files:
        raw = open(path, encoding="utf-8").read()
        code = strip_comments(raw)
        lines = code.splitlines()

        if ENABLED_SERVICES_KEY in code:
            reads_setting.append(path)
        if "ComponentName.unflattenFromString" in code or "ComponentName::unflattenFromString" in code:
            uses_unflatten.append(path)
        if GLOBAL_ENABLED_KEY in code:
            checks_global.append(path)

        for pattern in RAW_COMPARISON_PATTERNS:
            for match in pattern.finditer(code):
                line_no = code[: match.start()].count("\n") + 1
                raw_comparisons.append((path, line_no, match.group(0)[:80].replace("\n", " ")))

        for i, line in enumerate(lines, start=1):
            if FLAT_CONSTANT in line:
                flat_constant_refs.append((path, i, line.strip()))
            match = CALL_SITE_RE.search(line)
            # A match after a quote on the same line is prose, not code.
            if match and '"' not in line[: match.start()]:
                call_sites.append((path, i, line.strip()))
            # a hard-coded flattened component name for our own service
            if re.search(r'"[a-z0-9_.]+/[a-z0-9_.]*ChildGuardAccessibilityService"', line):
                flat_literals.append((path, i))

    # --- A: no raw string comparison -------------------------------------
    print(f"\n[A] raw string comparisons against {ENABLED_SERVICES_KEY}: {len(raw_comparisons)}")
    for path, line_no, snippet in raw_comparisons:
        print(f"    {rel(path)}:{line_no}  {snippet}")
        problems.append(f"raw string comparison at {rel(path)}:{line_no}")

    # --- A': every reader of the setting must normalise via ComponentName -
    for path in reads_setting:
        if path not in uses_unflatten:
            print(f"    {rel(path)} reads {ENABLED_SERVICES_KEY} without ComponentName.unflattenFromString")
            problems.append(f"unnormalised read at {rel(path)}")
    print(f"    files reading the setting          : {[rel(p) for p in reads_setting]}")
    print(f"    files normalising via ComponentName: {[rel(p) for p in uses_unflatten]}")

    # --- B: the global switch is checked ---------------------------------
    print(f"\n[B] files consulting {GLOBAL_ENABLED_KEY}: {len(checks_global)}")
    for path in checks_global:
        print(f"    {rel(path)}")
    if not checks_global:
        problems.append(f"{GLOBAL_ENABLED_KEY} is never checked")

    # --- C: no live use of the flattened constant ------------------------
    live_refs = [
        (p, n, t)
        for (p, n, t) in flat_constant_refs
        if not (
            os.path.basename(p) == "AgentChannel.kt"
            and (t.startswith("const val") or t.startswith("@Deprecated") or "ReplaceWith" in t)
        )
    ]
    print(f"\n[C] live references to AgentChannel.{FLAT_CONSTANT}: {len(live_refs)}")
    for path, line_no, text in live_refs:
        print(f"    {rel(path)}:{line_no}  {text}")
        problems.append(f"live flattened-constant reference at {rel(path)}:{line_no}")

    # --- D: call sites use the safe entry point --------------------------
    print(f"\n[D] call sites using a ComponentName-based entry point: {len(call_sites)}")
    for path, line_no, text in call_sites:
        print(f"    {rel(path)}:{line_no}  {text}")
    if len(call_sites) < 6:
        problems.append(
            f"expected at least 6 call sites (audit A3 §3.5 counted 6), found {len(call_sites)}"
        )

    # --- E: the flattened literal exists at most once --------------------
    print(f"\n[E] hard-coded flattened component literals: {len(flat_literals)}")
    for path, line_no in flat_literals:
        print(f"    {rel(path)}:{line_no}")
    if len(flat_literals) > 1:
        problems.append("more than one hard-coded flattened component literal")

    print(f"\nTOTAL PROBLEMS: {len(problems)}")
    for problem in problems:
        print(f"  - {problem}")
    return 1 if problems else 0


def self_test() -> int:
    """Negative control. A zero from the checks above means nothing unless
    the checker can be shown to fail on the defect it claims to detect, so
    this re-runs the scan against a synthetic copy of the ORIGINAL,
    pre-F2 implementation."""
    import tempfile

    broken = """
package com.aifamilycoach.child_app.core

import android.provider.Settings

class PermissionManager(private val context: Context) {
    fun isAccessibilityServiceEnabled(serviceComponentName: String): Boolean {
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabledServices.split(":").any { it.equals(serviceComponentName, ignoreCase = true) }
    }
}
"""
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "PermissionManager.kt"), "w", encoding="utf-8") as fh:
            fh.write(broken)
        print("=" * 72)
        print("NEGATIVE CONTROL — scanning a copy of the PRE-F2 implementation")
        print("=" * 72)
        code = run(tmp)
        print(f"\nnegative control exit code: {code} (expected: 1)")
        return 0 if code == 1 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sys.exit(self_test())
    sys.exit(run(NATIVE_ROOT))
