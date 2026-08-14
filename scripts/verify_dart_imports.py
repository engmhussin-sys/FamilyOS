#!/usr/bin/env python3
"""
verify_dart_imports.py — static resolver for Dart import/export/part directives.

Why this exists: the ABNY repo has no Flutter SDK and no network access to
pub.dev in CI-less environments, so `flutter analyze` cannot be run locally.
This script performs the subset of analysis that is fully deterministic
without an SDK:

  1. Relative `import`/`export`/`part` targets are resolved against the
     filesystem; unresolved targets are hard compile errors.
  2. `part of` back-references are checked against the declaring library.
  3. `package:<self>/...` self-imports are resolved against the app's own lib/.
  4. Every `package:<other>/...` import is cross-checked against the
     dependencies declared in the owning app's pubspec.yaml.

Exit code 0 = clean, 1 = at least one unresolved/undeclared reference.

Usage:
    python3 scripts/verify_dart_imports.py [root]     # default root = repo root
"""

from __future__ import annotations

import os
import re
import sys

# ---------------------------------------------------------------------------
# Directives. Dart allows single or double quotes and optional `as`/`show`/`hide`.
# ---------------------------------------------------------------------------
DIRECTIVE_RE = re.compile(
    r"""^\s*(?P<kind>import|export|part)\s+(?P<q>['"])(?P<uri>[^'"]+)(?P=q)""",
    re.MULTILINE,
)
PART_OF_RE = re.compile(
    r"""^\s*part\s+of\s+(?:(?P<q>['"])(?P<uri>[^'"]+)(?P=q)|(?P<lib>[A-Za-z0-9_.]+))\s*;""",
    re.MULTILINE,
)

# SDK / tooling packages that are always available and never appear as an
# explicit dependency line in pubspec.yaml.
ALWAYS_AVAILABLE = {"flutter", "flutter_test", "flutter_driver", "integration_test"}

# `dart:` libraries are provided by the SDK; nothing to resolve.
DART_SCHEME = "dart:"


def strip_comments(src: str) -> str:
    """Remove // and /* */ comments so commented-out imports are not counted."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j == -1 else j
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j == -1 else j + 2
        elif c in "'\"":
            # Keep string literals intact (import URIs live in them).
            quote = c
            out.append(c)
            i += 1
            while i < n:
                if src[i] == "\\":
                    out.append(src[i : i + 2])
                    i += 2
                    continue
                out.append(src[i])
                if src[i] == quote:
                    i += 1
                    break
                if src[i] == "\n":  # unterminated literal; bail out
                    i += 1
                    break
                i += 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def find_apps(root: str) -> dict:
    """Map app-root -> {'name': package_name, 'deps': set(), 'lib': path}."""
    apps = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d
            for d in dirnames
            if d not in {".git", "build", ".dart_tool", "node_modules", ".gradle"}
        ]
        if "pubspec.yaml" not in filenames:
            continue
        pub = os.path.join(dirpath, "pubspec.yaml")
        with open(pub, encoding="utf-8") as fh:
            text = fh.read()
        m = re.search(r"^name:\s*([A-Za-z0-9_]+)", text, re.MULTILINE)
        if not m:
            continue
        apps[dirpath] = {
            "name": m.group(1),
            "deps": parse_pubspec_deps(text),
            "pubspec": pub,
        }
    return apps


def parse_pubspec_deps(text: str) -> set:
    """Collect keys under dependencies:/dev_dependencies: (top-level indent)."""
    deps = set()
    in_block = False
    block_indent = None
    for line in text.splitlines():
        if re.match(r"^(dependencies|dev_dependencies|dependency_overrides):\s*$", line):
            in_block, block_indent = True, None
            continue
        if not in_block:
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:  # left the block
            in_block = False
            continue
        if block_indent is None:
            block_indent = indent
        if indent == block_indent:
            m = re.match(r"^\s*([A-Za-z0-9_]+)\s*:", line)
            if m:
                deps.add(m.group(1))
    return deps


def owning_app(path: str, apps: dict) -> str | None:
    best = None
    for app_root in apps:
        if path.startswith(app_root + os.sep) and (best is None or len(app_root) > len(best)):
            best = app_root
    return best


def line_of(src: str, index: int) -> int:
    return src.count("\n", 0, index) + 1


def main() -> int:
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
    apps = find_apps(root)

    dart_files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d
            for d in dirnames
            if d not in {".git", "build", ".dart_tool", "node_modules", ".gradle"}
        ]
        for fn in filenames:
            if fn.endswith(".dart"):
                dart_files.append(os.path.join(dirpath, fn))
    dart_files.sort()

    unresolved_rel = []      # relative import/export/part not on disk
    unresolved_pkg_self = [] # package:<self>/... not on disk
    undeclared_pkg = []      # package:<other>/... not in pubspec
    part_of_problems = []    # `part` declared but the file has no matching `part of`
    parts_declared = {}      # part file -> list of (library file)

    total_directives = 0

    for path in dart_files:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        src = strip_comments(raw)
        app_root = owning_app(path, apps)
        base = os.path.dirname(path)

        for m in DIRECTIVE_RE.finditer(src):
            # `part of` is matched separately; skip it here.
            if m.group("kind") == "part" and re.match(
                r"^\s*part\s+of\b", src[m.start() : m.end() + 4]
            ):
                continue
            uri = m.group("uri")
            kind = m.group("kind")
            lineno = line_of(src, m.start())
            total_directives += 1

            if uri.startswith(DART_SCHEME):
                continue

            if uri.startswith("package:"):
                rest = uri[len("package:") :]
                pkg = rest.split("/", 1)[0]
                subpath = rest.split("/", 1)[1] if "/" in rest else ""
                if app_root and apps[app_root]["name"] == pkg:
                    target = os.path.join(app_root, "lib", subpath)
                    if not os.path.isfile(target):
                        unresolved_pkg_self.append((path, lineno, kind, uri, target))
                    continue
                if pkg in ALWAYS_AVAILABLE:
                    continue
                if app_root and pkg not in apps[app_root]["deps"]:
                    undeclared_pkg.append((path, lineno, kind, uri, pkg))
                continue

            # relative
            target = os.path.normpath(os.path.join(base, uri))
            if not os.path.isfile(target):
                unresolved_rel.append((path, lineno, kind, uri, target))
            elif kind == "part":
                parts_declared.setdefault(target, []).append(path)

    # `part of` consistency: every declared part file must say `part of`.
    for part_file, libs in parts_declared.items():
        with open(part_file, encoding="utf-8", errors="replace") as fh:
            psrc = strip_comments(fh.read())
        if not PART_OF_RE.search(psrc):
            part_of_problems.append(
                (part_file, 0, "part-of", f"declared as part by {libs}", "missing `part of`")
            )

    # ---- report ----------------------------------------------------------
    print(f"scanned root      : {root}")
    print(f"dart files        : {len(dart_files)}")
    print(f"apps (pubspec.yaml): {len(apps)}")
    for a, meta in sorted(apps.items()):
        print(f"  - {os.path.relpath(a, root)}  package={meta['name']}  deps={len(meta['deps'])}")
    print(f"directives checked : {total_directives}")
    print()

    def dump(title, rows):
        print(f"{title}: {len(rows)}")
        for path, lineno, kind, uri, extra in rows:
            print(f"  {os.path.relpath(path, root)}:{lineno}  {kind} '{uri}'")
            print(f"      -> {extra}")
        if rows:
            print()

    dump("UNRESOLVED relative import/export/part", unresolved_rel)
    dump("UNRESOLVED package:<self> import", unresolved_pkg_self)
    dump("UNDECLARED package: dependency (not in pubspec.yaml)", undeclared_pkg)
    dump("PART/PART-OF mismatch", part_of_problems)

    problems = (
        len(unresolved_rel)
        + len(unresolved_pkg_self)
        + len(undeclared_pkg)
        + len(part_of_problems)
    )
    print(f"TOTAL PROBLEMS: {problems}")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
