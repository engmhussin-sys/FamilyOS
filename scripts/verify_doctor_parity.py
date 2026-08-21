#!/usr/bin/env python3
"""
THE TWO HALVES OF A DOCTOR MUST NOT DRIFT.

`scripts/deploy-doctor.sh` and `scripts/deploy-doctor.ps1` answer the same
question on two operating systems, and only one of them can be executed in this
project's sandbox — there is no PowerShell here. So the .sh half is RUNTIME
VERIFIED against a really-listening application (see
apps/backend/test/system-diagnostics/deploy-doctor.e2e.spec.ts) and the .ps1
half is, at best, read carefully.

That asymmetry is exactly how a twin script rots: a check gets added, fixed or
regraded on the half someone can run, and the other half keeps answering last
month's question on the machine that actually ships. This repository has
already paid for one doctor that was confidently wrong.

So this compares the two halves on the things that are comparable without an
interpreter:

  1. THE SET OF CHECK IDS is identical. A check present on one side only is the
     drift that matters most — it means one operating system is not being
     asked a question the other is.
  2. EVERY CHECK IS GRADED THE SAME WAY. If `schema-version` can be BLOCKED in
     bash it must be able to be BLOCKED in PowerShell; a check that only WARNs
     on Windows is a gate that does not gate on Windows.
  3. THE TERMINAL VERDICT TOKENS are the same literals in both, because a
     pipeline gating on `| tail -1` compares against a string.

It deliberately does NOT try to parse PowerShell. A half-built parser that
silently matched nothing would be a green check measuring nothing at all, which
is the failure mode every doctor in this repository is written against.

Exit code 0 = the halves agree. 1 = they do not, and the difference is named.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SH = REPO_ROOT / "scripts" / "deploy-doctor.sh"
PS = REPO_ROOT / "scripts" / "deploy-doctor.ps1"

VERDICT_OK = "DEPLOY VERIFIED"
VERDICT_BAD = "DO NOT SHIP"

# bash:  `pass liveness "..."`, and also `200) pass liveness "..." ;;` inside a
# case, and `|| { block toolchain "..."; }` — so the row may begin a line or
# follow a case label, a brace or a semicolon.
SH_CALL = re.compile(r"(?:^\s*|[);{]\s*)(pass|warn|block)\s+([a-z0-9-]+)\s", re.MULTILINE)
# powershell:  Add-Pass 'liveness' '...'   /   Add-Block 'schema-version' "..."
PS_CALL = re.compile(r"Add-(Pass|Warn|Block)\s+'([a-z0-9-]+)'", re.MULTILINE)

GRADE = {"pass": "PASS", "warn": "WARN", "block": "BLOCKED"}

# A check may be absent from one half ONLY with a reason recorded here. The
# alternative — quietly tolerating any difference — would turn this file into a
# green light for the drift it was written to catch.
EXEMPT: dict[str, str] = {
    "toolchain": (
        "bash-only: the .sh half shells out to curl and jq and must check they exist. "
        "PowerShell has Invoke-WebRequest and ConvertFrom-Json built in, so there is "
        "nothing for the .ps1 half to check."
    ),
}


def collect(text: str, pattern: re.Pattern, normalise) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for grade, check_id in pattern.findall(text):
        found.setdefault(check_id, set()).add(normalise(grade))
    return found


def main() -> int:
    problems: list[str] = []

    for path in (SH, PS):
        if not path.exists():
            print(f"MISSING: {path.relative_to(REPO_ROOT)}")
            return 1

    sh_text = SH.read_text(encoding="utf-8")
    ps_text = PS.read_text(encoding="utf-8")

    sh = collect(sh_text, SH_CALL, lambda g: GRADE[g])
    ps = collect(ps_text, PS_CALL, lambda g: GRADE[g.lower()])

    # A pattern that matched nothing would make every comparison below vacuously
    # true — the one outcome this script must never report as success.
    if not sh:
        problems.append("no graded rows found in deploy-doctor.sh — this checker's bash pattern no longer matches the file")
    if not ps:
        problems.append("no graded rows found in deploy-doctor.ps1 — this checker's PowerShell pattern no longer matches the file")

    exempted: list[str] = []
    for check_id in sorted(set(sh) - set(ps)):
        if check_id in EXEMPT:
            exempted.append(check_id)
        else:
            problems.append(f"check '{check_id}' exists in deploy-doctor.sh but not in deploy-doctor.ps1")
    for check_id in sorted(set(ps) - set(sh)):
        if check_id in EXEMPT:
            exempted.append(check_id)
        else:
            problems.append(f"check '{check_id}' exists in deploy-doctor.ps1 but not in deploy-doctor.sh")

    # An exemption for a check that is no longer one-sided is a stale licence to
    # drift, so it is reported rather than left lying around.
    for check_id, reason in EXEMPT.items():
        if check_id in sh and check_id in ps:
            problems.append(
                f"check '{check_id}' is exempted as one-sided but now exists in BOTH halves — delete its EXEMPT entry ({reason})"
            )
        elif check_id not in sh and check_id not in ps:
            problems.append(f"check '{check_id}' is exempted but exists in NEITHER half — delete its EXEMPT entry")

    for check_id in sorted(set(sh) & set(ps)):
        if sh[check_id] != ps[check_id]:
            problems.append(
                f"check '{check_id}' is graded {sorted(sh[check_id])} in bash "
                f"but {sorted(ps[check_id])} in PowerShell"
            )

    for name, text in (("deploy-doctor.sh", sh_text), ("deploy-doctor.ps1", ps_text)):
        for token in (VERDICT_OK, VERDICT_BAD):
            if token not in text:
                problems.append(f"{name} never prints the verdict token '{token}'")

    if problems:
        print("DOCTOR HALVES DISAGREE")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    shared = sorted(set(sh) & set(ps))
    print(f"deploy-doctor parity OK — {len(shared)} checks, identical ids and grades in both halves:")
    for check_id in shared:
        print(f"  {check_id:<18} {'/'.join(sorted(sh[check_id]))}")
    for check_id in exempted:
        print(f"  {check_id:<18} one-sided, exempted: {EXEMPT[check_id]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
