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
3. Resolve every control's injection site up front and report ALL that no
   longer resolve — a control whose anchor has rotted is a FAILURE, never a
   skip, but it must not cancel the controls that are still sound (it used to:
   the first stale anchor threw out of `main` and took the rest of the run and
   the residue check with it). Anchors whose text can legitimately recur name a
   declaration (`within=`) instead of hoping a string stays unique.
4. For each control: apply one textual mutation, re-run the full preflight,
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
        within: str = "",
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
        # SCOPE-QUALIFIED ANCHOR. When set, `find` is looked for ONLY inside the
        # brace-balanced body introduced by this marker; the marker itself must
        # occur exactly once in the file and must END at that body's opening
        # brace. Use it whenever the anchor text is a shape that can legitimately
        # recur (a bare `return x as T;`, a `super.dispose();`), so the control
        # names a SITE — "that statement inside THIS declaration" — instead of a
        # string that any future sibling method duplicates merely by existing.
        # See the UNREACHABLE control for the case that forced this.
        self.within = within


# ---------------------------------------------------------------------------
# The controls. Each `find` string is asserted to exist exactly `count` times
# (inside `within`, when the control is scope-qualified) before mutation, so a
# refactor that moves the anchor fails loudly here rather than silently
# disabling the control.
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
    # =====================================================================
    # PHASE E — the thirteen controls for the thirteen checks added past
    # Phase C's twelve. Same discipline, same harness, same residue check:
    # a checker that has not been SHOWN to fire proves nothing by its
    # silence, and three of the ones below were caught reporting nonsense
    # by exactly this method before they were allowed into the run.
    # =====================================================================
    Control(
        "DUP-NAMED-ARG",
        "apps/child-app/lib/features/goals/presentation/my_attempts_screen.dart",
        "KidCard(\n                  padding:",
        "KidCard(\n                  dimmed: false,\n                  dimmed: true,\n"
        "                  padding:",
        "the same named argument supplied twice in one invocation",
    ),
    Control(
        "PARAM-DEFAULT",
        "apps/child-app/lib/core/design_system/kid_components.dart",
        "    required this.child,",
        "    required this.child = const SizedBox.shrink(),",
        "a `required` parameter that also carries a default value",
    ),
    Control(
        "PARAM-DEFAULT",
        "apps/child-app/lib/core/network/api_client.dart",
        "  Future<Map<String, dynamic>> post(\n    String path, {\n"
        "    Map<String, dynamic>? body,",
        "  Future<Map<String, dynamic>> post(\n    String path, {\n"
        "    Map<String, dynamic> body,",
        "a non-nullable optional named parameter with no default",
    ),
    Control(
        "FIELD-INIT",
        "apps/child-app/lib/core/design_system/kid_components.dart",
        "  final Widget child;",
        "  final Widget child;\n  final String neverInitialisedField;",
        "a non-nullable field no constructor initialises",
    ),
    Control(
        "LATE-FIELD",
        "apps/child-app/lib/core/design_system/kid_components.dart",
        "  final Widget child;",
        "  final Widget child;\n  late final String _neverAssignedLateField;",
        "a `late` private field assigned nowhere in its library",
    ),
    Control(
        "SWITCH-EXHAUSTIVE",
        "apps/child-app/lib/core/state/ui_state.dart",
        "      case UiStatus.empty:\n        return empty();\n",
        "",
        "an enum `switch` with a value dropped and no `default`",
    ),
    Control(
        "UNUSED-PRIVATE",
        "apps/child-app/lib/core/design_system/kid_components.dart",
        "  final Widget child;",
        "  final Widget child;\n  static const String _neverUsedPrivateField = 'x';",
        "a private field referenced nowhere in its library",
    ),
    Control(
        "UNUSED-LOCAL",
        "apps/child-app/lib/core/design_system/kid_components.dart",
        "    return Opacity(",
        "    final neverUsedLocalVariable = 1;\n    return Opacity(",
        "a local variable referenced nowhere in its file",
    ),
    Control(
        # SCOPE-QUALIFIED, and here is the incident that earned the mechanism.
        # This control originally anchored on the bare line
        # `return response.data as List<dynamic>;`, which was unique in
        # api_client.dart on the day it was written because `getList` was the
        # only list-returning method. Commit 7928575 then added `postList` — a
        # correct fix for a real defect (POST /smart-tasks/generate returns a
        # bare array and `post`'s Map cast threw on every call) — and the anchor
        # became ambiguous, which aborted the WHOLE harness at this control and
        # took the six controls after it, plus the residue check, down with it.
        #
        # `getList` and `postList` are NOT a duplication to be merged: different
        # verb, different parameters, and one of them is the entire point of the
        # commit that added it. The single line they share is a one-statement
        # return-and-cast, a shape that is identical in any two methods that
        # return a list — so the fault was the ANCHOR, not the source, and the
        # fix is to name the declaration the statement must live in.
        "UNREACHABLE",
        "apps/child-app/lib/core/network/api_client.dart",
        "      return response.data as List<dynamic>;",
        "      return response.data as List<dynamic>;\n"
        "      return response.data as List<dynamic>;",
        "a statement following a `return` in the same block",
        within="Future<List<dynamic>> getList(String path) async {",
    ),
    Control(
        # NOTE the class chosen. `TodayGoalsController extends StateNotifier<…>`
        # was the first candidate and the control FAILED on it — correctly:
        # StateNotifier is not in this tree, so the chain is incomplete and
        # SELF-CALL abstains by design. `HeartbeatService` has no supertype at
        # all, so its chain is trivially complete and the check can speak.
        "SELF-ARITY",
        "apps/child-app/lib/features/pairing/application/heartbeat_service.dart",
        "    stop();",
        "    stop('an argument stop() does not take');",
        "an argument passed to a no-argument method of the enclosing class",
    ),
    Control(
        "LITERAL-TYPE",
        "apps/child-app/lib/features/goals/presentation/my_attempts_screen.dart",
        "KidCard(\n                  padding:",
        "KidCard(\n                  dimmed: 'not a bool at all',\n                  padding:",
        "a STRING literal passed where the declaration says bool (ARG-TYPE widening)",
    ),
    Control(
        "SELF-MEMBER",
        "apps/child-app/lib/core/state/ui_state.dart",
        "  bool get isLoading => status == UiStatus.loading;",
        "  bool get isLoading => this.notARealMemberAtAll;",
        "`this.name` where the enclosing class has no such member",
    ),
    Control(
        "OVERRIDE-SIG",
        "apps/child-app/lib/core/platform/agent_channel_impl.dart",
        "    required List<String> blockedPackages,\n  }) async {",
        "  }) async {",
        "an @override that drops a named parameter of the member it overrides",
    ),
    Control(
        "IMPLEMENTS-MISSING",
        "apps/child-app/test/features/pairing/device_registration_service_test.dart",
        "  @override\n  dynamic noSuchMethod(Invocation invocation) => "
        "super.noSuchMethod(invocation);\n}\n\nclass _FakePairingApi implements "
        "PairingApi {",
        "}\n\nclass _FakePairingApi implements PairingApi {",
        "an `implements` class missing members with no `noSuchMethod`",
    ),
]


def _body_span(src: str, marker: str, c: Control) -> Tuple[int, int]:
    """Span of the brace-balanced body introduced by `marker` (which must end at
    that body's opening brace) — [start, end) exclusive of the braces."""
    n = src.count(marker)
    if n != 1:
        raise AssertionError(
            f"scope marker {marker!r} occurs {n}x in {c.rel_path}, expected 1 — "
            f"the declaration this control targets was renamed, reformatted or "
            f"removed; re-point the control at the site it means"
        )
    if not marker.rstrip().endswith("{"):
        raise AssertionError(
            f"scope marker {marker!r} must end at the opening brace of the body "
            f"it names"
        )
    open_at = src.index(marker) + len(marker.rstrip()) - 1
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return open_at + 1, i
    raise AssertionError(f"unbalanced braces after {marker!r} in {c.rel_path}")


def _site(src: str, c: Control) -> int:
    """Absolute offset of the injection site, or AssertionError saying why not.

    Brace balancing does not know about braces inside string literals or
    comments; it does not have to. A miscounted span can only ever make the
    anchor count inside it come out wrong, and that is checked right here.
    """
    if c.within:
        lo, hi = _body_span(src, c.within, c)
        region, where = src[lo:hi], f"inside {c.within!r}"
    else:
        lo, region, where = 0, src, ""
    n = region.count(c.find)
    if n != c.count:
        raise AssertionError(
            f"anchor {c.find!r} occurs {n}x in {c.rel_path}{' ' + where if where else ''}, "
            f"expected {c.count} — the control is stale, fix it, do not skip it"
            + ("" if c.within else "; if the shape can legitimately recur, give "
               "the control a `within=` scope rather than a longer string")
        )
    return lo + region.index(c.find)


def stale_controls(root: str) -> List[Tuple[Control, str]]:
    """Resolve EVERY control's anchor against the pristine copy, up front.

    Before this existed, `_apply` raised on the first stale anchor and the
    exception escaped `main`, so one rotted control did not merely fail — it
    cancelled every control after it and the residue check as well, and the run
    reported a traceback instead of a verdict. Staleness is now collected for
    all controls at once, reported together, and counted as a failure, while
    every control that still resolves runs and reports normally.
    """
    problems: List[Tuple[Control, str]] = []
    for c in CONTROLS:
        if c.check == "OVERRIDE":
            continue  # _override_mutation locates its own site
        try:
            src = open(os.path.join(root, c.rel_path), encoding="utf-8").read()
        except OSError as e:
            problems.append((c, f"{c.rel_path} is unreadable: {e}"))
            continue
        try:
            _site(src, c)
        except AssertionError as e:
            problems.append((c, str(e)))
    return problems


def _apply(root: str, c: Control) -> Tuple[str, str]:
    path = os.path.join(root, c.rel_path)
    src = open(path, encoding="utf-8").read()
    at = _site(src, c)
    open(path, "w", encoding="utf-8").write(
        src[:at] + c.replace + src[at + len(c.find) :]
    )
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

        # Anchors first, all of them, on the untouched copy. A stale anchor is a
        # control failure — never a skip — but it must not be allowed to cancel
        # the controls that are still sound.
        stale = stale_controls(scratch)
        if stale:
            print(f"  FAIL  anchor-resolution — {len(stale)} control(s) cannot be applied")
            for c, why in stale:
                print(f"          {c.check}: {why}")
                failures.append(f"{c.check}: stale anchor — {why}")
        else:
            print(f"  PASS  anchor-resolution — all {len(CONTROLS)} anchors resolve uniquely")
        blocked = {id(c) for c, _ in stale}

        for c in CONTROLS:
            if id(c) in blocked:
                print(f"  SKIP  {c.check:<16} — anchor stale (reported above)")
                continue
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
        print(
            f"All {len(CONTROLS)} negative controls passed, plus anchor "
            f"resolution and the residue check."
        )
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
