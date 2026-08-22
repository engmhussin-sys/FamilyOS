#!/usr/bin/env python3
"""
===========================================================================
CI RULE 6 — A WORKFLOW EXPRESSION MAY ONLY USE OPERATORS THAT EXIST.
===========================================================================

WHY THIS EXISTS. `.github/workflows/build-apk.yml` carried this line:

    ORG_GRADLE_PROJECT_abnyVersionCode:
      ${{ fromJSON(vars.ABNY_VERSION_CODE_OFFSET || '0') + github.run_number }}

The GitHub Actions expression language HAS NO ARITHMETIC. Its complete
operator set is:

    !   <   <=   >   >=   ==   !=   &&   ||

and nothing else — no `+`, no `-`, no `*`, no `/`, no `%`.

WHAT IT COST. An invalid expression does not fail a step; it makes the whole
FILE invalid. And `ci.yml` calls this file with `uses:`, so the error
propagated to the caller:

    Invalid workflow file: .github/workflows/ci.yml#L218
    error parsing called workflow ".github/workflows/build-apk.yml"
    (Line: 175, Col: 39): Unexpected symbol: '+'

EVERY ci.yml RUN FAILED TO PARSE, AND NOT ONE JOB IN IT EVER STARTED —
including runs on commits that were perfectly healthy. The red X on the
Actions page meant "this file does not compile", not "your code is broken",
and the two are indistinguishable from the outside. That is the worst kind of
CI failure: it looks exactly like a real one and teaches people to ignore it.

WHY A SEPARATE SCRIPT AND NOT A CI STEP ALONE. A guard that lives only inside
the workflow it guards cannot save that workflow — if the file will not parse,
nothing in it runs, including this. So this is written to be run BY HAND
before a workflow change is pushed, and wired into CI as well for the cases
where the caller still parses.

    python3 scripts/ci/assert-workflow-expressions.py
"""

from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"

# Everything the expression language actually understands, longest first so
# `<=` is consumed before `<` and `!=` before `!`.
VALID_OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "<", ">", "!"]

# What is being looked for, once strings and valid operators are gone.
ARITHMETIC = {
    "+": "addition",
    "*": "multiplication",
    "%": "modulo",
}


def strip_comment_lines(text: str) -> str:
    """
    Blank out whole-line YAML comments, keeping the line count intact so
    reported line numbers still point at the real file.

    Needed because this repository's workflows explain themselves at length,
    and one of those comments QUOTES the very defect this guard exists for.
    Flagging documentation would make the guard wrong on its first run.

    Only lines whose first non-space character is `#` are removed. A `#`
    inside a value can be part of a string, and guessing about that is how a
    checker starts lying.
    """
    return "\n".join("" if line.lstrip().startswith("#") else line for line in text.split("\n"))


def expressions(text: str):
    """Every ${{ … }} in the file, with the line it starts on."""
    text = strip_comment_lines(text)
    for match in re.finditer(r"\$\{\{(.*?)\}\}", text, re.DOTALL):
        yield text[: match.start()].count("\n") + 1, match.group(1)


def strip_literals(expr: str) -> str:
    """
    Remove single-quoted string literals. A dash inside
    `fromJSON('["child-app"]')` is data, not an operator, and flagging it
    would make this guard cry wolf on its first run — which is how a guard
    gets deleted.
    """
    return re.sub(r"'(?:[^']|'')*'", "''", expr)


def main() -> int:
    if not WORKFLOWS.is_dir():
        print(f"No workflows directory at {WORKFLOWS}")
        return 0

    files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    violations: list[str] = []
    checked = 0

    for path in files:
        text = path.read_text(encoding="utf-8")
        for line_no, expr in expressions(text):
            checked += 1
            body = strip_literals(expr)
            for op in VALID_OPERATORS:
                body = body.replace(op, " ")

            for char, name in ARITHMETIC.items():
                if char in body:
                    violations.append(
                        f"{path.relative_to(REPO)}:{line_no}  {name} `{char}` in an expression\n"
                        f"      ${{{{{expr.strip()}}}}}"
                    )
                    break
            else:
                # `-` is checked separately: it is legal inside a property
                # access like `github.event.inputs`, never as an operator.
                # Only a `-` with whitespace on at least one side can be a
                # subtraction attempt.
                if re.search(r"(?:\s-|-\s)", body):
                    violations.append(
                        f"{path.relative_to(REPO)}:{line_no}  subtraction `-` in an expression\n"
                        f"      ${{{{{expr.strip()}}}}}"
                    )

    print("CI RULE 6 — GitHub Actions expression syntax")
    print(f"  workflow files      : {len(files)}")
    print(f"  expressions checked : {checked}")

    if violations:
        print(f"  violations          : {len(violations)}\n")
        for v in violations:
            print(f"  ✗ {v}")
        print(
            "\n  The expression language has no arithmetic. Its operators are exactly\n"
            "  !  <  <=  >  >=  ==  !=  &&  ||\n"
            "\n  Compute the value in a `run:` step instead and publish it with\n"
            "  `>> \"$GITHUB_ENV\"` or `>> \"$GITHUB_OUTPUT\"`. An invalid expression does\n"
            "  not fail one step — it makes the whole FILE unparseable, and any\n"
            "  workflow that `uses:` it fails too, with no job ever starting.\n"
        )
        return 1

    print("  violations          : 0")
    print("  OK — every expression uses operators that exist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
