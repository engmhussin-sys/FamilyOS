#!/usr/bin/env python3
"""
summarize_pubspec_lock.py — turn a resolved `pubspec.lock` into a Markdown
table of the DIRECT dependencies and the exact versions this build got.

Why it exists as a file rather than a heredoc inside the workflow: a `run: |`
block scalar cannot contain a shell heredoc whose body sits at column 0, and
silently mangling the indentation is how workflows acquire mystery failures.
A script is also testable — which matters, because this is the output the
client reads to decide what to commit for PA-M-016.

Usage:  python3 scripts/summarize_pubspec_lock.py [path/to/pubspec.lock]
"""

from __future__ import annotations

import os
import re
import sys


def parse(text: str):
    """[(name, version, dependency-kind)] for every package in the lockfile."""
    out = []
    blocks = re.split(r"\n(?=  \S+:\n)", text)
    for b in blocks:
        m = re.match(r"\s*(\S+):\n", b)
        if not m:
            continue
        name = m.group(1)
        if name in ("packages", "sdks", "version"):
            continue
        kind = re.search(r'dependency:\s*"?([^"\n]+)"?', b)
        ver = re.search(r'version:\s*"([^"]+)"', b)
        if kind and ver:
            out.append((name, ver.group(1), kind.group(1).strip()))
    return out


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "pubspec.lock"
    if not os.path.exists(path):
        print(f"_no `{path}` — this build is not reproducible (audit PA-M-016)_")
        return 0
    pkgs = parse(open(path, encoding="utf-8").read())
    direct = [p for p in pkgs if p[2].startswith("direct main")]
    dev = [p for p in pkgs if p[2].startswith("direct dev")]
    trans = [p for p in pkgs if p[2].startswith("transitive")]

    print(f"`{path}` — {len(direct)} direct · {len(dev)} dev · "
          f"{len(trans)} transitive · {len(pkgs)} total")
    print()
    print("| Direct dependency | Resolved version |")
    print("|---|---|")
    for name, ver, _ in sorted(direct):
        print(f"| `{name}` | `{ver}` |")
    sdk = re.search(r"sdks:\n(?:\s+\w+:.*\n?)+", open(path, encoding="utf-8").read())
    if sdk:
        print()
        print("```")
        print(sdk.group(0).rstrip())
        print("```")
    return 0


if __name__ == "__main__":
    sys.exit(main())
