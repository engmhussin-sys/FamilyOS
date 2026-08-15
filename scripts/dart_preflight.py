#!/usr/bin/env python3
"""
dart_preflight.py — the checks that stand in for `flutter analyze` while there
is no Dart SDK reachable from this environment.

CONTEXT
-------
`which flutter dart` -> not found. Installing one is impossible here: the agent
proxy answers `403 Forbidden` to `CONNECT storage.googleapis.com:443`,
`CONNECT dl.google.com:443` and `CONNECT pub.dev:443`, so neither the Flutter
SDK archive, the Dart SDK bootstrap, nor `pub get` can complete. The first
`flutter analyze` this tree has ever seen will therefore run on a GitHub
runner. Each error it finds there costs one push/wait/read cycle.

This script front-loads the subset of the analyser's job that can be decided
from the source text alone, so that the CI run reports as few *previously
knowable* errors as possible.

EVERY CHECK BELOW IS DESIGNED AROUND ONE RULE: silence beats noise.
Where the structural model cannot decide, the check abstains and says so in
the `abstained` counter, which is printed. A check that cannot state its own
blind spots is not trustworthy.

CHECKS
------
  CTOR-ARITY    constructor invocations vs. the constructor actually declared
  CTOR-NAMED    named arguments vs. the declared named parameters
  CTOR-REQUIRED required named parameters that the call site omits
  STATIC-MEMBER `Type.member` where Type is an in-tree class/enum
  ENUM-MEMBER   `Enum.value` where Enum is an in-tree enum
  OVERRIDE      `@override` whose name exists nowhere in a fully in-tree chain
  ABSTRACT-IMPL concrete class missing an abstract member of an in-tree chain
  UNUSED-IMPORT in-tree import none of whose exported names is referenced
  DUP-MEMBER    the same member name declared twice in one type
  LITERAL-TYPE  a literal argument whose type cannot match the declared one
  PART-INTEGRITY  `part` / `part of` agreement

Usage:
    python3 scripts/dart_preflight.py                 # human report, exit 1 on error
    python3 scripts/dart_preflight.py --json          # machine readable
    python3 scripts/dart_preflight.py --only CTOR-NAMED
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dart_static_model import (  # noqa: E402
    App,
    Ctor,
    Library,
    Param,
    TypeDecl,
    Workspace,
    find_app_roots,
    line_of,
    match_bracket,
    split_top_level,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# Names the Dart/Flutter SDK provides that a source-only scan cannot see.
# Used ONLY to abstain, never to report — so an incomplete list makes the tool
# quieter, never noisier.
# ---------------------------------------------------------------------------
UNIVERSAL_MEMBERS = {
    "toString", "hashCode", "runtimeType", "noSuchMethod", "==",
}
_DART_KEYWORDS = {
    "return", "await", "final", "const", "var", "assert", "if", "else", "for",
    "while", "case", "default", "break", "continue", "yield", "throw",
    "rethrow", "switch", "try", "catch", "do", "new", "this", "super", "get",
    "set", "static", "late", "required", "in", "is", "as",
}
ENUM_INTRINSICS = {
    "values", "index", "name", "byName", "compareTo", "toString", "hashCode",
    "runtimeType", "firstWhere", "where", "map", "asNameMap", "length",
    "isEmpty", "isNotEmpty", "contains", "indexOf", "elementAt", "first",
    "last", "any", "every", "toList", "cast", "reversed", "sublist",
}


# Names that exist BOTH in this tree and in the Flutter/Dart SDK (or a
# declared package). If a file uses one of these without importing the in-tree
# declaration it may legitimately mean the SDK one, so UNIMPORTED-NAME abstains.
# Grown only from real observed collisions — an entry here costs coverage, so
# it must be justified, never precautionary.
_SDK_NAME_COLLISIONS = {
    "Colors", "Icons", "Theme", "Border", "Radius", "Size", "Duration",
    "Locale", "Key", "Text", "Image", "Route", "Notification", "State",
    "Center", "Padding", "Card", "Badge", "Divider", "Feedback", "Page",
}


class Finding:
    def __init__(self, check: str, file: str, line: int, msg: str, sev: str = "error"):
        self.check, self.file, self.line, self.msg, self.sev = check, file, line, msg, sev

    def as_dict(self):
        return {
            "check": self.check,
            "file": os.path.relpath(self.file, REPO),
            "line": self.line,
            "severity": self.sev,
            "message": self.msg,
        }


class Preflight:
    def __init__(self, repo: str = REPO):
        self.repo = repo
        self.ws = Workspace(find_app_roots(repo))
        self.findings: List[Finding] = []
        self.abstained: Dict[str, int] = defaultdict(int)
        self.examined: Dict[str, int] = defaultdict(int)
        self._visible_cache: Dict[str, Dict[str, TypeDecl]] = {}

    # ------------------------------------------------------------------ util
    def add(self, check, file, line, msg, sev="error"):
        self.findings.append(Finding(check, file, line, msg, sev))

    def _resolve_uri(self, lib: Library, app: App, uri: str) -> Optional[str]:
        """Absolute path of an in-tree Dart file named by `uri`, else None."""
        if uri.startswith("dart:"):
            return None
        if uri.startswith("package:"):
            body = uri[len("package:") :]
            pkg, _, rel = body.partition("/")
            if pkg != app.name:
                return None
            cand = os.path.join(app.root, "lib", rel)
        else:
            cand = os.path.normpath(os.path.join(os.path.dirname(lib.path), uri))
        return cand if cand in app.libs else None

    def visible_types(self, lib: Library, app: App) -> Dict[str, TypeDecl]:
        """Type names this library can name, mapped to their (unique) decl.

        A name declared by two different in-tree files is DROPPED, not picked:
        an ambiguous name is one the checkers must not reason about.
        """
        key = lib.path
        if key in self._visible_cache:
            return self._visible_cache[key]

        seen: Set[str] = set()
        counts: Dict[str, List[TypeDecl]] = defaultdict(list)

        def absorb(path: str, follow_exports: bool) -> None:
            if path in seen:
                return
            seen.add(path)
            l = app.libs[path]
            for t in l.types.values():
                counts[t.name].append(t)
            # a library's own parts contribute their declarations
            for p in l.parts:
                pp = self._resolve_uri(l, app, p)
                if pp:
                    absorb(pp, False)
            if follow_exports:
                for uri, _ln, _pfx, _sh, _hd in l.imports:
                    pass  # `export` is folded into imports below

        absorb(lib.path, False)
        for uri, _ln, prefix, show, hide in lib.imports:
            if prefix:
                continue  # prefixed import: names are not bare-visible
            p = self._resolve_uri(lib, app, uri)
            if not p:
                continue
            target = app.libs[p]
            for t in target.types.values():
                if show and t.name not in show:
                    continue
                if t.name in hide:
                    continue
                counts[t.name].append(t)
            for sub in target.parts:
                sp = self._resolve_uri(target, app, sub)
                if sp:
                    for t in app.libs[sp].types.values():
                        counts[t.name].append(t)
            # Barrel files: importing `design_system.dart` really does make
            # everything it `export`s visible. Two levels is enough for this
            # tree; a third would be re-exported twice and is not present.
            for uri2, _l2 in target.exports:
                p2 = self._resolve_uri(target, app, uri2)
                if not p2:
                    continue
                for t in app.libs[p2].types.values():
                    counts[t.name].append(t)
                for uri3, _l3 in app.libs[p2].exports:
                    p3 = self._resolve_uri(app.libs[p2], app, uri3)
                    if p3:
                        for t in app.libs[p3].types.values():
                            counts[t.name].append(t)
        # if the file is a `part of`, it also sees the parent's imports
        if lib.part_of:
            for other in app.libs.values():
                if any(
                    self._resolve_uri(other, app, p) == lib.path for p in other.parts
                ):
                    for k, v in self.visible_types(other, app).items():
                        counts[k].extend(v if isinstance(v, list) else [v])

        out: Dict[str, TypeDecl] = {}
        for name, decls in counts.items():
            uniq = {(d.file, d.line): d for d in decls}
            if len(uniq) == 1:
                out[name] = next(iter(uniq.values()))
        self._visible_cache[key] = out
        return out

    # ------------------------------------------------------------- supertypes
    def chain(self, decl: TypeDecl, vis: Dict[str, TypeDecl]) -> Optional[List[TypeDecl]]:
        """Full in-tree supertype closure, or None if any link leaves the tree."""
        out: List[TypeDecl] = []
        stack = [decl]
        seen = {decl.name}
        while stack:
            cur = stack.pop()
            out.append(cur)
            for s in cur.supertypes:
                if s in ("Object",):
                    continue
                nxt = vis.get(s)
                if nxt is None:
                    return None  # leaves the tree -> undecidable
                if nxt.name not in seen:
                    seen.add(nxt.name)
                    stack.append(nxt)
        return out

    # ================================================================= checks

    # ---- call-site extraction ------------------------------------------
    CALL_RE = re.compile(
        r"(?<![\w.$'\"])(?:const\s+|new\s+)?"
        r"(?P<type>[A-Z]\w*)"
        r"(?:\s*<(?P<targs>[^<>()]*(?:<[^<>]*>)?[^<>()]*)>)?"
        r"(?:\s*\.\s*(?P<member>[A-Za-z_]\w*))?"
        r"\s*\("
    )

    def _ctor_decl_offsets(self, lib: Library) -> Set[int]:
        return {
            c.decl_offset
            for t in lib.types.values()
            for c in t.ctors.values()
            if c.decl_offset >= 0
        }

    def _args(self, masked: str, popen: int) -> Optional[Tuple[int, List[str]]]:
        pend = match_bracket(masked, popen)
        if pend == -1:
            return None
        inner = masked[popen + 1 : pend - 1]
        return pend, split_top_level(inner)

    def check_calls(self) -> None:
        """CTOR-ARITY / CTOR-NAMED / CTOR-REQUIRED / STATIC-MEMBER / ENUM-MEMBER."""
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                skip_offsets = self._ctor_decl_offsets(lib)
                masked = lib.masked
                # local shadowing: a top-level or member name equal to a type
                local_names = set(lib.top_functions) | set(lib.top_vars)
                for m in self.CALL_RE.finditer(masked):
                    tname = m.group("type")
                    member = m.group("member")
                    decl = vis.get(tname)
                    if decl is None:
                        self.abstained["type-not-in-tree"] += 1
                        continue
                    if tname in local_names:
                        self.abstained["shadowed-name"] += 1
                        continue
                    popen = masked.index("(", m.end() - 1)
                    if any(abs(off - m.start()) < 3 for off in skip_offsets):
                        continue
                    ln = line_of(lib.src, m.start())

                    if decl.kind == "enum":
                        # `Enum.value(` is never legal unless value is a ctor
                        if member and member not in decl.enum_values:
                            if member in ENUM_INTRINSICS or member in decl.members:
                                continue
                            if member in decl.ctors:
                                continue
                            self.add(
                                "ENUM-MEMBER", lib.path, ln,
                                f"`{tname}.{member}` — `{tname}` is an enum declared at "
                                f"{os.path.relpath(decl.file, self.repo)}:{decl.line} "
                                f"with values {decl.enum_values}",
                            )
                        continue

                    if decl.kind in ("extension", "typedef"):
                        self.abstained["extension-or-typedef"] += 1
                        continue

                    ctor_key = member or ""
                    if member and member not in decl.ctors:
                        mem = decl.members.get(member)
                        if mem is None:
                            chain = self.chain(decl, vis)
                            if chain is None:
                                self.abstained["static-chain-unknown"] += 1
                                continue
                            if member in UNIVERSAL_MEMBERS:
                                continue
                            self.add(
                                "STATIC-MEMBER", lib.path, ln,
                                f"`{tname}.{member}(...)` — `{tname}` "
                                f"({os.path.relpath(decl.file, self.repo)}:{decl.line}) "
                                f"declares neither a `{member}` constructor nor a "
                                f"`{member}` member",
                            )
                            continue
                        if not mem.is_static:
                            self.abstained["instance-member-via-type"] += 1
                            continue
                        if mem.kind != "method" or mem.params is None or mem.unparsed:
                            self.abstained["static-member-unparsed"] += 1
                            continue
                        got = self._args(masked, popen)
                        if got is None:
                            continue
                        self._verify(
                            "STATIC", lib, ln, f"{tname}.{member}", mem.params, got[1]
                        )
                        continue

                    ctor = decl.ctors.get(ctor_key)
                    if ctor is None:
                        if decl.ctors:
                            self.add(
                                "CTOR-ARITY", lib.path, ln,
                                f"`{tname}"
                                + (f".{member}" if member else "")
                                + "(...)` — no such constructor on "
                                f"`{tname}` ({os.path.relpath(decl.file, self.repo)}:"
                                f"{decl.line}); declared: "
                                + ", ".join(
                                    f"`{tname}" + (f".{k}" if k else "") + "`"
                                    for k in sorted(decl.ctors)
                                ),
                            )
                        else:
                            self.abstained["implicit-ctor"] += 1
                        continue
                    if ctor.unparsed:
                        self.abstained["ctor-unparsed"] += 1
                        continue
                    got = self._args(masked, popen)
                    if got is None:
                        continue
                    self._verify(
                        "CTOR", lib, ln,
                        f"{tname}" + (f".{member}" if member else ""),
                        ctor.params, got[1], owner=decl,
                    )
                    self.examined["ctor-calls"] += 1

    NAMED_ARG_RE = re.compile(r"^([A-Za-z_]\w*)\s*:(?!:)")

    def _verify(self, prefix, lib, ln, label, params, args, owner=None) -> None:
        named_declared = {p.name: p for p in params if p.named}
        positional = [p for p in params if not p.named]
        req_pos = sum(1 for p in positional if p.required)
        max_pos = len(positional)

        got_named: Dict[str, str] = {}
        got_pos = 0
        for a in args:
            m = self.NAMED_ARG_RE.match(a.strip())
            if m and m.group(1) not in ("case", "default"):
                got_named[m.group(1)] = a.strip()[m.end() :].strip()
            else:
                got_pos += 1

        if got_pos > max_pos or got_pos < req_pos:
            self.add(
                f"{prefix}-ARITY", lib.path, ln,
                f"`{label}(...)` called with {got_pos} positional argument(s); "
                f"the declaration takes {req_pos}"
                + (f"–{max_pos}" if max_pos != req_pos else "")
                + f" (declared: {self._sig(params)})",
            )
            return

        unknown = [k for k in got_named if k not in named_declared]
        if unknown:
            self.add(
                f"{prefix}-NAMED", lib.path, ln,
                f"`{label}(...)` — no named parameter "
                + ", ".join(f"`{u}`" for u in sorted(unknown))
                + f"; declared named: "
                + (", ".join(f"`{k}`" for k in sorted(named_declared)) or "(none)"),
            )
            return

        missing = [
            p.name
            for p in params
            if p.named and p.required and p.name not in got_named
        ]
        if missing:
            self.add(
                f"{prefix}-REQUIRED", lib.path, ln,
                f"`{label}(...)` — required named parameter(s) not supplied: "
                + ", ".join(f"`{x}`" for x in sorted(missing)),
            )
            return

        # ---- LITERAL-TYPE: only literals, only unambiguous mismatches -----
        for k, v in got_named.items():
            p = named_declared[k]
            # `required this.errorTitle` carries no type of its own — the type
            # lives on the FIELD it initialises. Without this lookup the
            # literal check was dead for every Flutter widget in the tree,
            # because `this.` parameters are how they are all written.
            ptype = p.type
            if not ptype and owner is not None:
                fld = owner.members.get(k)
                if fld is not None and fld.kind == "field":
                    ptype = fld.type
            bad = self._literal_conflict(ptype, v)
            if bad:
                self.add("LITERAL-TYPE", lib.path, ln,
                         f"`{label}(...)` — `{k}:` is declared `{ptype}` "
                         f"but the argument is {bad}")

    @staticmethod
    def _sig(params: List[Param]) -> str:
        pos = [p.name for p in params if not p.named]
        nam = [("required " if p.required else "") + p.name for p in params if p.named]
        s = "(" + ", ".join(pos)
        if nam:
            s += (", " if pos else "") + "{" + ", ".join(nam) + "}"
        return s + ")"

    @staticmethod
    def _literal_conflict(decl_type: str, arg: str) -> Optional[str]:
        t = decl_type.strip()
        if not t or t.endswith("?") or t in ("dynamic", "Object", "var", ""):
            return None
        a = arg.strip()
        if a == "null":
            return "the literal `null` and the parameter is non-nullable"
        if re.fullmatch(r"-?\d+", a):
            if t in ("String", "bool", "DateTime", "Duration"):
                return f"the int literal `{a}`"
        elif re.fullmatch(r"-?\d+\.\d+", a):
            if t in ("String", "bool", "int", "DateTime", "Duration"):
                return f"the double literal `{a}`"
        elif a in ("true", "false"):
            if t in ("String", "int", "double", "num", "DateTime", "Duration"):
                return f"the bool literal `{a}`"
        return None

    # ---- MEMBER-REF -------------------------------------------------------
    # `Type.member` in any position, not just as a call. This is where enum
    # typos live — `SparkyMood.happy` is never followed by `(`, so a
    # call-site-only checker cannot see it at all.
    #
    # SOUNDNESS NOTE: static members and enum values are NOT inherited in
    # Dart, so this needs no supertype analysis — `Foo.bar` must be declared
    # on `Foo` itself. The check abstains when an extension in this tree
    # targets the type (extension statics would be invisible to the scan),
    # and whenever the name is ambiguous or shadowed.
    MEMBER_REF_RE = re.compile(
        r"(?<![\w.$])([A-Z]\w*)\s*(?:<[^<>()]*(?:<[^<>]*>)?[^<>()]*>)?\s*\.\s*([A-Za-z_]\w*)"
    )

    def check_member_refs(self) -> None:
        for app in self.ws.apps.values():
            ext_targets: Set[str] = set()
            for lib in app.libs.values():
                for t in lib.types.values():
                    if t.kind == "extension":
                        ext_targets |= set(t.supertypes)
                        m = re.search(r"\bon\s+([A-Za-z_]\w*)", lib.src)
                        if m:
                            ext_targets.add(m.group(1))
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                prefixes = {p for _u, _l, p, _s, _h in lib.imports if p}
                for m in self.MEMBER_REF_RE.finditer(lib.masked):
                    tname, member = m.group(1), m.group(2)
                    if tname in prefixes:
                        continue
                    decl = vis.get(tname)
                    if decl is None or decl.name in ext_targets:
                        continue
                    if decl.kind not in ("class", "enum", "mixin"):
                        continue
                    if member in UNIVERSAL_MEMBERS or member == "new":
                        continue
                    if member in decl.members or member in decl.ctors:
                        continue
                    self.examined["member-refs"] += 1
                    if decl.kind == "enum":
                        if member in decl.enum_values or member in ENUM_INTRINSICS:
                            continue
                        self.add(
                            "ENUM-MEMBER", lib.path, line_of(lib.src, m.start()),
                            f"`{tname}.{member}` — `{tname}` "
                            f"({os.path.relpath(decl.file, self.repo)}:{decl.line}) "
                            f"declares values {decl.enum_values}",
                        )
                        continue
                    # A class member reference. Instance members reached
                    # through a *variable* whose name happens to be capitalised
                    # are not possible here (the receiver is a type name that
                    # resolved to an in-tree declaration), so a missing name is
                    # a real error — but only report when the declaration was
                    # scanned confidently.
                    if not decl.members and not decl.ctors:
                        self.abstained["type-body-empty"] += 1
                        continue
                    self.add(
                        "STATIC-MEMBER", lib.path, line_of(lib.src, m.start()),
                        f"`{tname}.{member}` — `{tname}` "
                        f"({os.path.relpath(decl.file, self.repo)}:{decl.line}) "
                        f"declares no `{member}` (statics and named constructors "
                        f"are never inherited in Dart)",
                    )

    # ---- UNIMPORTED-NAME -------------------------------------------------
    # The single most common first-`flutter analyze` failure: a symbol that
    # really is declared in this app, used in a file that never imports it.
    # A pure filesystem import audit cannot see this — every import resolves;
    # it is the *use* that has no declaration in scope.
    IDENT_USE_RE = re.compile(r"(?<![\w.$])([A-Z]\w*)\b")

    def check_unimported(self) -> None:
        for app in self.ws.apps.values():
            declared: Dict[str, List[TypeDecl]] = self.ws.types_of(app)
            for lib in app.libs.values():
                if lib.part_of:
                    self.abstained["unimported-in-part"] += 1
                    continue
                vis = self.visible_types(lib, app)
                prefixes = {p for _u, _l, p, _s, _h in lib.imports if p}
                body = self._body_after_directives(lib)
                seen: Set[str] = set()
                for m in self.IDENT_USE_RE.finditer(body):
                    n = m.group(1)
                    if n in seen or n in vis or n in prefixes:
                        continue
                    decls = declared.get(n)
                    if not decls:
                        continue
                    if len({(d.file, d.line) for d in decls}) != 1:
                        self.abstained["unimported-ambiguous"] += 1
                        continue
                    if n in _SDK_NAME_COLLISIONS:
                        self.abstained["unimported-sdk-collision"] += 1
                        continue
                    seen.add(n)
                    d = decls[0]
                    self.add(
                        "UNIMPORTED-NAME", lib.path,
                        line_of(lib.src, len(lib.masked) - len(body) + m.start()),
                        f"`{n}` is used here but this file imports nothing that "
                        f"declares it; it is declared in "
                        f"{os.path.relpath(d.file, self.repo)}:{d.line}",
                    )
                self.examined["files-scanned-for-scope"] += 1

    # ---- PROVIDER-SCOPE ---------------------------------------------------
    # Riverpod's `ref.read(xProvider)` fails at ANALYSIS time, not runtime, if
    # `xProvider` is not in scope — and providers in this tree live in one
    # central `core/di/providers.dart`, so a screen that forgets that import
    # produces a wall of errors. Worth its own check.
    PROVIDER_USE_RE = re.compile(
        r"\bref\s*\.\s*(?:read|watch|listen|invalidate|refresh)\s*\(\s*"
        r"([a-z_]\w*)\b"
    )

    def check_providers(self) -> None:
        for app in self.ws.apps.values():
            declared: Dict[str, str] = {}
            for lib in app.libs.values():
                for v in lib.top_vars:
                    declared.setdefault(v, lib.path)
            for lib in app.libs.values():
                if lib.part_of:
                    continue
                in_scope: Set[str] = set(lib.top_vars)
                for uri, _ln, prefix, show, hide in lib.imports:
                    if prefix:
                        continue
                    p = self._resolve_uri(lib, app, uri)
                    if not p:
                        continue
                    names = set(app.libs[p].top_vars)
                    for uri2, _l2 in app.libs[p].exports:
                        p2 = self._resolve_uri(app.libs[p], app, uri2)
                        if p2:
                            names |= set(app.libs[p2].top_vars)
                    if show:
                        names &= set(show)
                    in_scope |= names - set(hide)
                body = self._body_after_directives(lib)
                reported: Set[str] = set()
                for m in self.PROVIDER_USE_RE.finditer(body):
                    n = m.group(1)
                    if n in in_scope or n in reported:
                        continue
                    self.examined["provider-uses"] += 1
                    if n not in declared:
                        self.abstained["provider-declared-nowhere"] += 1
                        continue
                    reported.add(n)
                    self.add(
                        "PROVIDER-SCOPE", lib.path,
                        line_of(lib.src, len(lib.masked) - len(body) + m.start()),
                        f"`ref.…({n})` — `{n}` is declared in "
                        f"{os.path.relpath(declared[n], self.repo)} but is not "
                        f"imported here",
                    )

    # ---- OVERRIDE / ABSTRACT-IMPL / DUP-MEMBER --------------------------
    def check_types(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                for decl in lib.types.values():
                    if decl.kind not in ("class", "mixin"):
                        continue
                    chain = self.chain(decl, vis)
                    if chain is None:
                        self.abstained["chain-leaves-tree"] += 1
                        continue
                    inherited: Set[str] = set()
                    for anc in chain:
                        if anc is decl:
                            continue
                        inherited |= set(anc.members)
                        inherited |= {v for v in anc.enum_values}
                    self.examined["in-tree-chains"] += 1
                    for name, mem in decl.members.items():
                        if not mem.is_override:
                            continue
                        if name in inherited or name in UNIVERSAL_MEMBERS:
                            continue
                        self.add(
                            "OVERRIDE", lib.path, mem.line,
                            f"`{decl.name}.{name}` is marked `@override` but no "
                            f"supertype in its fully in-tree chain "
                            f"({' -> '.join(a.name for a in chain[1:]) or 'Object'}) "
                            f"declares `{name}`",
                        )

    # `  final Map<String, int>? foo = ...;`  /  `  int bar;`
    FIELD_DECL_RE = re.compile(
        r"^  (?:@\w+\s+)*(?:static\s+)?(?:final\s+|const\s+|late\s+|var\s+)*"
        r"(?:[A-Za-z_][\w.]*(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>)?\??\s+)?"
        r"(?P<n>[a-z_]\w*)\s*(?:;|=(?!=|>))"
    )

    def check_duplicates(self) -> None:
        """DUP-MEMBER — the model keeps the FIRST decl, so re-scan for repeats."""
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                for decl in lib.types.values():
                    if decl.body_span == (0, 0):
                        continue
                    body = lib.masked[decl.body_span[0] : decl.body_span[1]]
                    seen: Dict[str, int] = {}
                    off = decl.body_span[0]
                    for raw in body.split("\n"):
                        start_off, off = off, off + len(raw) + 1
                        # Only top-of-body indentation (2 spaces) is a member.
                        if not re.match(r"^  [A-Za-z_@]", raw):
                            continue
                        m = self.FIELD_DECL_RE.match(raw)
                        if not m:
                            continue
                        n = m.group("n")
                        if n in _DART_KEYWORDS:
                            continue
                        if n in seen:
                            self.add(
                                "DUP-MEMBER", lib.path,
                                line_of(lib.src, start_off),
                                f"`{decl.name}` declares field `{n}` more than once "
                                f"(first at line {seen[n]})",
                            )
                        else:
                            seen[n] = line_of(lib.src, start_off)

    # ---- UNUSED-IMPORT ---------------------------------------------------
    def check_unused_imports(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                if lib.part_of or lib.parts:
                    self.abstained["import-in-part-library"] += 1
                    continue
                body = self._body_after_directives(lib)
                idents = set(re.findall(r"[A-Za-z_]\w*", body))
                for uri, ln, prefix, show, hide in lib.imports:
                    p = self._resolve_uri(lib, app, uri)
                    if p is None:
                        self.abstained["import-not-in-tree"] += 1
                        continue
                    if prefix:
                        if prefix not in idents:
                            self.add("UNUSED-IMPORT", lib.path, ln,
                                     f"`import '{uri}' as {prefix};` — the prefix "
                                     f"`{prefix}` is never used in this file",
                                     sev="warning")
                        continue
                    target = app.libs[p]
                    provided = set(target.types)
                    provided |= set(target.top_functions)
                    provided |= set(target.top_vars)
                    for sub in target.parts:
                        sp = self._resolve_uri(target, app, sub)
                        if sp:
                            provided |= set(app.libs[sp].types)
                            provided |= set(app.libs[sp].top_functions)
                            provided |= set(app.libs[sp].top_vars)
                    # A barrel adds everything it re-exports.
                    for uri2, _l2 in target.exports:
                        p2 = self._resolve_uri(target, app, uri2)
                        if not p2:
                            self.abstained["barrel-export-unresolved"] += 1
                            provided = set()
                            break
                        provided |= set(app.libs[p2].types)
                        provided |= set(app.libs[p2].top_functions)
                        provided |= set(app.libs[p2].top_vars)
                        for uri3, _l3 in app.libs[p2].exports:
                            p3 = self._resolve_uri(app.libs[p2], app, uri3)
                            if p3:
                                provided |= set(app.libs[p3].types)
                                provided |= set(app.libs[p3].top_functions)
                                provided |= set(app.libs[p3].top_vars)
                    if not provided:
                        self.abstained["import-provides-nothing-visible"] += 1
                        continue
                    if show:
                        provided &= set(show)
                    provided -= set(hide)
                    if not provided:
                        continue
                    if not (provided & idents):
                        self.add(
                            "UNUSED-IMPORT", lib.path, ln,
                            f"`import '{uri}';` — none of the {len(provided)} "
                            f"name(s) it declares "
                            f"({', '.join(sorted(provided)[:6])}"
                            f"{'…' if len(provided) > 6 else ''}) is referenced here",
                            sev="warning",
                        )
                        self.examined["imports-checked"] += 1

    @staticmethod
    def _body_after_directives(lib: Library) -> str:
        last = 0
        for m in re.finditer(
            r"^\s*(?:import|export|part|library)\b[^;]*;", lib.masked, re.M
        ):
            last = max(last, m.end())
        return lib.masked[last:]

    # ---- PART-INTEGRITY ---------------------------------------------------
    def check_parts(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                for p in lib.parts:
                    target = self._resolve_uri(lib, app, p)
                    if target is None:
                        self.add("PART-INTEGRITY", lib.path, 0,
                                 f"`part '{p}';` does not resolve to a file in the tree")
                        continue
                    t = app.libs[target]
                    if t.part_of is None:
                        self.add("PART-INTEGRITY", target, 1,
                                 f"declared as `part` of "
                                 f"{os.path.relpath(lib.path, self.repo)} but has no "
                                 f"`part of` directive")
                    self.examined["parts"] += 1
                if lib.part_of:
                    owners = [
                        o for o in app.libs.values()
                        if any(self._resolve_uri(o, app, p) == lib.path for p in o.parts)
                    ]
                    if not owners:
                        self.add("PART-INTEGRITY", lib.path, 1,
                                 f"`part of {lib.part_of}` but no library in the tree "
                                 f"declares this file as a `part`")

    # ================================================================== drive
    def run(self, only: Optional[Set[str]] = None) -> None:
        self.check_calls()
        self.check_member_refs()
        self.check_unimported()
        self.check_providers()
        self.check_types()
        self.check_duplicates()
        self.check_unused_imports()
        self.check_parts()
        if only:
            self.findings = [f for f in self.findings if f.check in only]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--warnings-are-errors", action="store_true")
    ap.add_argument("--repo", default=REPO)
    args = ap.parse_args()

    pf = Preflight(args.repo)
    pf.run(set(args.only) or None)

    errs = [f for f in pf.findings if f.sev == "error"]
    warns = [f for f in pf.findings if f.sev != "error"]

    if args.json:
        print(json.dumps(
            {
                "findings": [f.as_dict() for f in pf.findings],
                "abstained": dict(pf.abstained),
                "examined": dict(pf.examined),
            },
            indent=2, ensure_ascii=False,
        ))
    else:
        by = defaultdict(list)
        for f in pf.findings:
            by[f.check].append(f)
        for check in sorted(by):
            print(f"\n=== {check} — {len(by[check])} ===")
            for f in sorted(by[check], key=lambda x: (x.file, x.line)):
                print(f"  {os.path.relpath(f.file, args.repo)}:{f.line}: {f.msg}")
        print("\n--- counters (what the checkers deliberately did NOT decide) ---")
        for k in sorted(pf.abstained):
            print(f"  abstained/{k}: {pf.abstained[k]}")
        for k in sorted(pf.examined):
            print(f"  examined/{k}: {pf.examined[k]}")
        print(f"\nERRORS: {len(errs)}   WARNINGS: {len(warns)}")

    if errs:
        return 1
    if warns and args.warnings_are_errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
