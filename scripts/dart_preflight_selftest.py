#!/usr/bin/env python3
"""
dart_preflight_selftest.py — NEGATIVE CONTROLS for scripts/dart_preflight.py.

A static checker that has never been shown to fail on a real fault is a
decoration. This harness proves each check works, by the only method that
proves anything about a detector: seed the defect, require the detector to
report it, remove the defect, require the detector to go quiet again.

METHOD
------
1. Copy `apps/child-app` and `apps/parent-app` into a scratch tree.
2. Record the BASELINE finding set on the untouched copy.
3. For each control: apply one textual mutation, re-run the full preflight,
   and require (a) the expected check to fire on the expected file, and
   (b) revert to restore the baseline set exactly — a control that leaves
   residue is a bug in the harness, not evidence.

Every mutation is a defect a Dart compiler or the analyser would genuinely
reject; none is a synthetic shape that could not occur in this codebase.

Usage:  python3 scripts/dart_preflight_selftest.py [-v]
Exit 0 = every control passed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from typing import List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dart_preflight import Preflight  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Control:
    def __init__(
        self,
        check: str,
        rel_path: str,
        find: str,
        replace: str,
        why: str,
        count: int = 1,
        expect_rel: str = "",
    ):
        self.check = check
        self.rel_path = rel_path
        self.find = find
        self.replace = replace
        self.why = why
        self.count = count
        # Some checks file the finding against the file the defect POINTS AT
        # rather than the file that was edited (PART-INTEGRITY is the case).
        self.expect_rel = expect_rel or rel_path


# ---------------------------------------------------------------------------
# The controls. Each `find` string is asserted to exist exactly `count` times
# before mutation, so a refactor that moves the anchor fails loudly here rather
# than silently disabling the control.
# ---------------------------------------------------------------------------
CONTROLS: List[Control] = [
    Control(
        "CTOR-ARITY",
        "apps/child-app/lib/features/goals/presentation/my_attempts_screen.dart",
        "KidCard(\n                  padding:",
        "KidCard(\n                  'an extra positional argument',\n                  padding:",
        "a positional argument passed to a constructor that takes none",
    ),
    Control(
        "CTOR-NAMED",
        "apps/child-app/lib/features/goals/presentation/my_attempts_screen.dart",
        "KidCard(\n                  padding:",
        "KidCard(\n                  paddingg:",
        "a misspelled named argument",
    ),
    Control(
        "CTOR-REQUIRED",
        "apps/parent-app/lib/features/rewards/presentation/child_rewards_screen.dart",
        "DsCard(\n                  child: Column(",
        "DsCard(\n                  padding: Column(",
        "a required named parameter (`child`) omitted",
    ),
    Control(
        "LITERAL-TYPE",
        "apps/parent-app/lib/features/rewards/presentation/child_rewards_screen.dart",
        "errorTitle: t('childRewards.errorTitle'),",
        "errorTitle: 7,",
        "an int literal passed where the declaration says String",
    ),
    Control(
        "ENUM-MEMBER",
        "apps/child-app/lib/features/goals/presentation/goal_detail_screen.dart",
        "SparkyMood.happy",
        "SparkyMood.notARealMoodAtAll",
        "a reference to an enum value that does not exist",
    ),
    Control(
        "UNUSED-IMPORT",
        "apps/parent-app/lib/features/rewards/presentation/programs_list_screen.dart",
        "import 'package:flutter/material.dart';",
        "import 'package:flutter/material.dart';\n"
        "import '../../billing/presentation/redeem_code_screen.dart';",
        "an added import whose names are never referenced",
    ),
    Control(
        "UNIMPORTED-NAME",
        "apps/parent-app/lib/features/rewards/presentation/programs_list_screen.dart",
        "import '../../../core/design_system/design_system.dart';",
        "",
        "a type used with its declaring import removed",
    ),
    Control(
        "PROVIDER-SCOPE",
        "apps/parent-app/lib/features/rewards/presentation/programs_list_screen.dart",
        "import '../../../core/di/providers.dart';",
        "",
        "a Riverpod provider used with its declaring import removed",
    ),
    Control(
        "OVERRIDE",
        "apps/parent-app/lib/core/design_system/ds_states.dart",
        "class DsLoadingState",
        "class DsLoadingState",  # replaced below by the member mutation
        "an @override on a member no supertype declares",
    ),
    Control(
        "DUP-MEMBER",
        "apps/child-app/lib/features/goals/domain/child_goal.dart",
        "  final String code;",
        "  final String code;\n  final String code;",
        "the same field declared twice in one class",
    ),
    Control(
        "PART-INTEGRITY",
        "apps/child-app/lib/core/network/api_client.dart",
        "import 'api_exception.dart';",
        "import 'api_exception.dart';\npart 'api_exception.dart';",
        "a `part` whose target has no `part of`",
        expect_rel="apps/child-app/lib/core/network/api_exception.dart",
    ),
    Control(
        "STATIC-MEMBER",
        "apps/child-app/lib/features/device_status/presentation/device_home_screen.dart",
        "await OemSetupScreen.show(context);",
        "await OemSetupScreen.showww(context);",
        "a static call to a member that does not exist on the type",
    ),
]


def _apply(root: str, c: Control) -> Tuple[str, str]:
    path = os.path.join(root, c.rel_path)
    src = open(path, encoding="utf-8").read()
    n = src.count(c.find)
    if n != c.count:
        raise AssertionError(
            f"[{c.check}] anchor {c.find!r} occurs {n}x in {c.rel_path}, "
            f"expected {c.count} — the control is stale, fix it, do not skip it"
        )
    open(path, "w", encoding="utf-8").write(src.replace(c.find, c.replace, 1))
    return path, src


def _override_mutation(root: str) -> Tuple[str, str]:
    """OVERRIDE needs a member, not a header — done separately for clarity."""
    rel = "apps/parent-app/lib/features/rewards/domain/reward_models.dart"
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        for base, _d, fs in os.walk(os.path.join(root, "apps/parent-app/lib")):
            for f in fs:
                if f.endswith(".dart"):
                    p = os.path.join(base, f)
                    s = open(p, encoding="utf-8").read()
                    if "\nclass " in s and " extends " not in s.split("\nclass ", 1)[1][:120]:
                        path = p
                        break
    src = open(path, encoding="utf-8").read()
    head, sep, tail = src.partition("\nclass ")
    if not sep:
        raise AssertionError("no class found for the OVERRIDE control")
    brace = tail.index("{")
    mutated = (
        head + sep + tail[: brace + 1]
        + "\n  @override\n  String get thisOverridesNothingAtAll => 'x';\n"
        + tail[brace + 1 :]
    )
    open(path, "w", encoding="utf-8").write(mutated)
    return path, src


def fingerprint(pf: Preflight):
    return sorted(
        (f.check, os.path.relpath(f.file, pf.repo), f.line, f.msg) for f in pf.findings
    )


def run(root: str):
    pf = Preflight(root)
    pf.run()
    return pf


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    scratch = tempfile.mkdtemp(prefix="abny-preflight-selftest-")
    try:
        os.makedirs(os.path.join(scratch, "apps"))
        for app in ("child-app", "parent-app"):
            shutil.copytree(
                os.path.join(REPO, "apps", app),
                os.path.join(scratch, "apps", app),
                ignore=shutil.ignore_patterns("build", ".dart_tool"),
            )

        base = run(scratch)
        base_fp = set(fingerprint(base))
        print(f"BASELINE on the untouched copy: {len(base_fp)} finding(s)")

        failures: List[str] = []
        for c in CONTROLS:
            if c.check == "OVERRIDE":
                path, original = _override_mutation(scratch)
                rel = os.path.relpath(path, scratch)
            else:
                path, original = _apply(scratch, c)
                rel = c.rel_path
            try:
                pf = run(scratch)
                new = [
                    f
                    for f in pf.findings
                    if (f.check, os.path.relpath(f.file, scratch), f.line, f.msg)
                    not in base_fp
                ]
                hit = [
                    f
                    for f in new
                    if f.check == c.check
                    and os.path.relpath(f.file, scratch).replace("\\", "/")
                    == (c.expect_rel if c.check != "OVERRIDE" else rel)
                ]
                if hit:
                    print(f"  PASS  {c.check:<16} — {c.why}")
                    if args.verbose:
                        for f in hit[:2]:
                            print(f"          -> {f.msg[:160]}")
                else:
                    failures.append(
                        f"{c.check}: seeded «{c.why}» in {rel} and the checker "
                        f"stayed silent (new findings: "
                        f"{[f.check for f in new] or 'none'})"
                    )
                    print(f"  FAIL  {c.check:<16} — NOT DETECTED")
            finally:
                open(path, "w", encoding="utf-8").write(original)

        # Residue check: after every revert the tree must be byte-identical in
        # its findings to the baseline, or the controls above proved nothing.
        after = set(fingerprint(run(scratch)))
        if after != base_fp:
            failures.append(
                "the revert left residue: baseline and post-control finding sets "
                f"differ by {len(after ^ base_fp)} entry/entries"
            )
            print("  FAIL  revert-is-clean")
        else:
            print("  PASS  revert-is-clean   — baseline restored exactly")

        print()
        if failures:
            print(f"{len(failures)} CONTROL FAILURE(S):")
            for f in failures:
                print(f"  - {f}")
            return 1
        print(f"All {len(CONTROLS)} negative controls passed, plus the residue check.")
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
