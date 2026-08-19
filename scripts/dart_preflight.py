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

CHECKS — PHASE C (1–12)
-----------------------
  CTOR-ARITY    constructor invocations vs. the constructor actually declared
  CTOR-NAMED    named arguments vs. the declared named parameters
  CTOR-REQUIRED required named parameters that the call site omits
  STATIC-MEMBER `Type.member` where Type is an in-tree class/enum
  ENUM-MEMBER   `Enum.value` where Enum is an in-tree enum
  OVERRIDE      `@override` whose name exists nowhere in a fully in-tree chain
  UNIMPORTED-NAME a name declared in this app, used in a file that never imports it
  PROVIDER-SCOPE  `ref.read(xProvider)` where xProvider is not in scope
  UNUSED-IMPORT in-tree import none of whose exported names is referenced
  DUP-MEMBER    the same member name declared twice in one type
  LITERAL-TYPE  a literal argument whose type cannot match the declared one
  PART-INTEGRITY  `part` / `part of` agreement

CHECKS — PHASE E (13–22)
------------------------
Phase C's twelve all answer "does this NAME resolve?". `flutter analyze` fails
far more often on questions one step past that, and the ten below are the
subset of those that stay decidable WITHOUT type inference — i.e. where the
answer is fixed by a declaration this tree contains, not by a type the
analyser would have to infer.

  DUP-NAMED-ARG   the same named argument supplied twice in one invocation
                  (`duplicate_named_argument`, a compile-time ERROR)
  PARAM-DEFAULT   `required` parameter carrying a default value, and
                  non-nullable optional-named parameters with no default
                  (`default_value_on_required_parameter`,
                   `missing_default_value_for_parameter` — both ERRORS)
  FIELD-INIT      a non-nullable instance field that no constructor
                  initialises (`not_initialized_non_nullable_instance_field`)
  LATE-FIELD      a `late` private field never assigned anywhere in its
                  library — a guaranteed LateInitializationError
  SWITCH-EXHAUSTIVE  a `switch` over an in-tree enum that omits values and has
                  no `default` (Dart 3 `non_exhaustive_switch_*`)
  UNUSED-PRIVATE  a private member whose only occurrence in its library is its
                  own declaration (`unused_field` / `unused_element` — a
                  WARNING, therefore fatal under `flutter analyze`'s default)
  UNUSED-LOCAL    a local variable whose only occurrence in its file is its own
                  declaration (`unused_local_variable`, also fatal)
  UNREACHABLE     a statement following `return`/`throw` in the same block, and
                  `if (true)` / `if (false)` (`dead_code`, also fatal)
  SELF-CALL       a bare `m(...)` inside a class whose supertype chain is fully
                  in-tree, checked for arity / named / required against the
                  declaration the chain provides
  ARG-TYPE        the LITERAL-TYPE decision widened past numeric literals to
                  string, list and map/set literals

CHECKS — PHASE F (23)
---------------------
  SCOPE-UNDEF     identifier scope resolution: a BARE lowercase identifier used
                  in a declaration that can reach no declaration of that name —
                  not a local, not a parameter, not a member of the enclosing
                  type or of its in-tree supertypes, not a top-level of this
                  file or of anything it imports (`undefined_identifier`, an
                  ERROR)

                  Every check above answers "does this name resolve AS A
                  MEMBER / AS A CONSTRUCTOR / AS AN IMPORT". None of them asked
                  the flattest question of all — "does this name resolve at
                  all" — and a `t('myGrowth.newLabel')` in a class with no `t`
                  in scope therefore passed all twenty-two of them, plus
                  `verify_l10n_parity`, which resolved the KEY without ever
                  type-checking the CALL SITE. The app could not be built. See
                  the block comment above `check_scope` for what it decides,
                  what it refuses to decide, and why.

DELIBERATELY STILL NOT ATTEMPTED, by name: type inference of any expression
that is not a literal; generics substitution; nullability FLOW analysis;
extension-method resolution; exhaustiveness over sealed hierarchies; const
evaluation. Those remain where `flutter analyze` will find most of what it
finds.

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
    mask_source,
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
        dup: List[str] = []
        for a in args:
            m = self.NAMED_ARG_RE.match(a.strip())
            if m and m.group(1) not in ("case", "default"):
                # PHASE E / DUP-NAMED-ARG. `duplicate_named_argument` is a
                # compile-time error, and the shape that produces it —
                # copy-paste of an argument line inside a long Flutter widget
                # invocation — is endemic to this codebase's screen files.
                # It was invisible before because this dict silently
                # overwrote the first occurrence.
                if m.group(1) in got_named:
                    dup.append(m.group(1))
                got_named[m.group(1)] = a.strip()[m.end() :].strip()
            else:
                got_pos += 1
        if dup:
            self.add(
                "DUP-NAMED-ARG", lib.path, ln,
                f"`{label}(...)` — named argument "
                + ", ".join(f"`{d}:`" for d in sorted(set(dup)))
                + " supplied more than once in the same invocation",
            )

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

    # PHASE E / ARG-TYPE. The scalar declared types this checker is willing to
    # contradict. Everything not in this set abstains — the point is that the
    # set is CLOSED and hand-audited, so widening the literal side of the
    # decision cannot widen the false-positive surface to arbitrary types.
    _SCALARS = {"String", "bool", "int", "double", "num", "DateTime", "Duration"}

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
        # ---- PHASE E: the three literal shapes Phase C did not decide -------
        # NOTE ON MASKING: by the time an argument reaches here, string bodies
        # have been blanked but the QUOTES SURVIVE, so `'abc'` arrives as
        # `'   '`. That is exactly enough to know it is a string literal and
        # not enough to know anything else about it — which is the right
        # amount of knowledge for this check.
        elif re.fullmatch(r"r?(?:'''|\"\"\"|'|\")[\s\S]*(?:'''|\"\"\"|'|\")", a):
            if t in Preflight._SCALARS - {"String"}:
                return "a string literal"
        elif a.startswith("[") and a.endswith("]"):
            if t in Preflight._SCALARS:
                return "a list literal"
        elif a.startswith("{") and a.endswith("}"):
            if t in Preflight._SCALARS:
                return "a map/set literal"
        elif re.fullmatch(r"const\s*\[[\s\S]*\]", a):
            if t in Preflight._SCALARS:
                return "a const list literal"
        return None

    # ======================================================================
    # PHASE E CHECKS
    # ======================================================================

    # A "declared type is non-nullable" decision. Everything uncertain is
    # NULLABLE-OR-UNKNOWN, because the consequence of guessing wrong here is a
    # false error on correct code.
    _TYPE_VARS = re.compile(r"^[A-Z]\d?$")

    @classmethod
    def _definitely_non_nullable(cls, t: str) -> bool:
        t = t.strip()
        if not t:
            return False
        if t.endswith("?") or "?" in t.split("<", 1)[0]:
            return False
        head = t.split("<", 1)[0].strip()
        if head in ("dynamic", "Object", "var", "void", "Null", "Never", "Function"):
            return False
        # `T`, `K`, `V`, `T1` — a type VARIABLE may be instantiated at a
        # nullable type, so nothing can be concluded.
        if cls._TYPE_VARS.match(head):
            return False
        if not re.fullmatch(r"[A-Za-z_][\w.]*", head):
            return False
        return True

    # ---- PARAM-DEFAULT ---------------------------------------------------
    # Two compile-time ERRORS that live entirely inside a parameter list, so
    # no call site and no type inference is involved:
    #
    #   required T x = v    -> default_value_on_required_parameter
    #   {T x}   (T non-nullable, no default, not required)
    #                       -> missing_default_value_for_parameter
    #
    # `this.x` and `super.x` parameters carry NO type of their own in this
    # model, so `_definitely_non_nullable("")` is false and they abstain — the
    # second rule genuinely does not apply to `super.` parameters anyway, since
    # the superclass default carries over.
    def check_param_defaults(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                for decl in lib.types.values():
                    plists: List[Tuple[str, int, List[Param]]] = []
                    for c in decl.ctors.values():
                        if c.unparsed:
                            self.abstained["paramlist-unparsed"] += 1
                            continue
                        label = decl.name + (f".{c.name}" if c.name else "")
                        plists.append((label, c.line, c.params))
                    for mem in decl.members.values():
                        if mem.kind != "method" or mem.params is None:
                            continue
                        if mem.unparsed:
                            self.abstained["paramlist-unparsed"] += 1
                            continue
                        plists.append((f"{decl.name}.{mem.name}", mem.line, mem.params))
                    for label, line, params in plists:
                        self.examined["param-lists"] += 1
                        for p in params:
                            if not p.named:
                                continue
                            if p.explicit_required and p.has_default:
                                self.add(
                                    "PARAM-DEFAULT", lib.path, line,
                                    f"`{label}(...)` — parameter `{p.name}` is "
                                    f"`required` and also carries a default value; "
                                    f"Dart rejects that outright "
                                    f"(default_value_on_required_parameter)",
                                )
                            elif (
                                not p.required
                                and not p.has_default
                                and not p.is_super
                                and self._definitely_non_nullable(p.type)
                            ):
                                self.add(
                                    "PARAM-DEFAULT", lib.path, line,
                                    f"`{label}(...)` — optional named parameter "
                                    f"`{p.name}` is declared `{p.type}`, which is "
                                    f"non-nullable, but is neither `required` nor "
                                    f"given a default "
                                    f"(missing_default_value_for_parameter)",
                                )

    # ---- FIELD-INIT ------------------------------------------------------
    # `not_initialized_non_nullable_instance_field`. Decidable only under a
    # deliberately narrow set of conditions, all of which are enforced below:
    #   * the class is concrete and declares at least one generative
    #     constructor (a class with only the implicit constructor is often an
    #     interface-shaped declaration in this tree, and reporting those would
    #     be noise);
    #   * the field is an instance field, non-`late`, non-`static`,
    #     non-`const`, has no initialiser, and its declared type is
    #     DEFINITELY non-nullable by the conservative test above;
    #   * the field's name appears NOWHERE in any constructor's header —
    #     neither as `this.name`, nor in an initialiser list, nor as the
    #     target of an assignment anywhere in the class body.
    # Any doubt at all and it abstains.
    _INST_FIELD_RE = re.compile(
        r"^  (?P<mods>(?:@\w+\s+)*)"
        r"(?P<kw>(?:static|final|const|late|var|covariant)\s+)*"
        r"(?P<type>[A-Za-z_][\w.]*(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>)?\??)\s+"
        r"(?P<n>[a-z_]\w*)\s*(?P<tail>;|=(?!=|>))"
    )

    def check_field_init(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                for decl in lib.types.values():
                    if decl.kind != "class" or decl.is_abstract:
                        continue
                    if decl.body_span == (0, 0):
                        continue
                    gen = [
                        c for c in decl.ctors.values()
                        if not c.is_factory and not c.redirects and not c.unparsed
                    ]
                    if not gen:
                        self.abstained["field-init-no-generative-ctor"] += 1
                        continue
                    body = lib.masked[decl.body_span[0] : decl.body_span[1]]
                    ctor_headers = " ".join(
                        self._ctor_header_text(lib, c) for c in gen
                    )
                    off = decl.body_span[0]
                    for raw in body.split("\n"):
                        start_off, off = off, off + len(raw) + 1
                        m = self._INST_FIELD_RE.match(raw)
                        if not m:
                            continue
                        kws = raw[: m.start("type")]
                        if re.search(r"\b(static|late|const)\b", kws):
                            continue
                        if m.group("tail") != ";":
                            continue          # has an initialiser
                        name, tname = m.group("n"), m.group("type")
                        if name in _DART_KEYWORDS or tname in _DART_KEYWORDS:
                            continue
                        if not self._definitely_non_nullable(tname):
                            continue
                        self.examined["non-nullable-fields"] += 1
                        if re.search(r"\b" + re.escape(name) + r"\b", ctor_headers):
                            continue
                        # assigned somewhere in the body (initState, a setter…)
                        if re.search(
                            r"(?<![\w.])(?:this\s*\.\s*)?"
                            + re.escape(name) + r"\s*(?:\?\?)?=(?!=)",
                            body,
                        ):
                            self.abstained["field-assigned-in-body"] += 1
                            continue
                        self.add(
                            "FIELD-INIT", lib.path, line_of(lib.src, start_off),
                            f"`{decl.name}.{name}` is declared `{tname}` — "
                            f"non-nullable with no initialiser — and none of the "
                            f"{len(gen)} generative constructor(s) of `{decl.name}` "
                            f"mentions it",
                        )

    def _ctor_header_text(self, lib: Library, c: Ctor) -> str:
        """A constructor's text from its name to its body/`;` — params + `:` list."""
        if c.decl_offset < 0:
            return ""
        m = lib.masked
        i = m.find("(", c.decl_offset)
        if i == -1:
            return ""
        j = match_bracket(m, i)
        if j == -1:
            return ""
        k = j
        while k < len(m) and m[k] not in "{;":
            k += 1
        return m[c.decl_offset : k]

    # ---- LATE-FIELD ------------------------------------------------------
    # A `late` field with no initialiser that is assigned NOWHERE in its own
    # library is a guaranteed LateInitializationError on first read. Restricted
    # to PRIVATE fields (`_x`) for one reason that makes it decidable at all:
    # a private name cannot be assigned from outside its library, so "not
    # assigned in this file" really does mean "not assigned".
    _LATE_FIELD_RE = re.compile(
        r"^  (?:@\w+\s+)*(?:static\s+)?late\s+(?:final\s+)?"
        r"(?:[A-Za-z_][\w.]*(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>)?\??\s+)?"
        r"(?P<n>_\w+)\s*(?P<tail>;|=(?!=|>))"
    )

    def check_late_fields(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                # a library's parts can assign its private members
                scope = lib.masked
                for p in lib.parts:
                    tp = self._resolve_uri(lib, app, p)
                    if tp:
                        scope += "\n" + app.libs[tp].masked
                if lib.part_of:
                    self.abstained["late-in-part"] += 1
                    continue
                for decl in lib.types.values():
                    if decl.body_span == (0, 0):
                        continue
                    body = lib.masked[decl.body_span[0] : decl.body_span[1]]
                    off = decl.body_span[0]
                    for raw in body.split("\n"):
                        start_off, off = off, off + len(raw) + 1
                        m = self._LATE_FIELD_RE.match(raw)
                        if not m or m.group("tail") != ";":
                            continue
                        name = m.group("n")
                        self.examined["late-private-fields"] += 1
                        if re.search(
                            r"(?<![\w.])(?:this\s*\.\s*)?"
                            + re.escape(name) + r"\s*(?:\?\?|\|\||&&)?=(?!=)",
                            scope,
                        ):
                            continue
                        self.add(
                            "LATE-FIELD", lib.path, line_of(lib.src, start_off),
                            f"`{decl.name}.{name}` is `late` with no initialiser and "
                            f"is never assigned anywhere in this library; the first "
                            f"read throws LateInitializationError",
                            sev="warning",
                        )

    # ---- SWITCH-EXHAUSTIVE ----------------------------------------------
    # Dart 3 makes a switch over an enum exhaustiveness-checked. This fires
    # ONLY when every case label in the switch is written `SomeEnum.value` for
    # ONE in-tree enum and there is no `default:` and no `_` wildcard — i.e.
    # when the switched type is not inferred but SPELLED OUT by the labels
    # themselves. Anything else abstains.
    _SWITCH_RE = re.compile(r"(?<![\w.])switch\s*\(")
    _CASE_RE = re.compile(r"(?<![\w.])case\s+([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)")

    def check_switch_exhaustive(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                m = lib.masked
                for sm in self._SWITCH_RE.finditer(m):
                    popen = m.index("(", sm.end() - 1)
                    pend = match_bracket(m, popen)
                    if pend == -1:
                        continue
                    bopen = m.find("{", pend)
                    if bopen == -1 or m[pend:bopen].strip():
                        self.abstained["switch-expression-or-arrow"] += 1
                        continue
                    bend = match_bracket(m, bopen)
                    if bend == -1:
                        continue
                    body = m[bopen + 1 : bend - 1]
                    if re.search(r"(?<![\w.])(?:default\s*:|case\s+_\b)", body):
                        continue
                    cases = self._CASE_RE.findall(body)
                    if not cases:
                        self.abstained["switch-not-enum-labelled"] += 1
                        continue
                    enums = {c[0] for c in cases}
                    if len(enums) != 1:
                        self.abstained["switch-mixed-labels"] += 1
                        continue
                    ename = next(iter(enums))
                    decl = vis.get(ename)
                    if decl is None or decl.kind != "enum":
                        self.abstained["switch-enum-not-in-tree"] += 1
                        continue
                    # every label must be `Enum.value` — a bare `case foo:`
                    # anywhere means the labels are not all enum constants.
                    label_count = len(re.findall(r"(?<![\w.])case\s", body))
                    if label_count != len(cases):
                        self.abstained["switch-mixed-labels"] += 1
                        continue
                    self.examined["enum-switches"] += 1
                    covered = {c[1] for c in cases}
                    missing = [v for v in decl.enum_values if v not in covered]
                    if missing:
                        self.add(
                            "SWITCH-EXHAUSTIVE", lib.path,
                            line_of(lib.src, sm.start()),
                            f"`switch` over enum `{ename}` "
                            f"({os.path.relpath(decl.file, self.repo)}:{decl.line}) "
                            f"has no `default` and does not cover "
                            + ", ".join(f"`{ename}.{v}`" for v in missing),
                        )

    # ---- UNUSED-PRIVATE --------------------------------------------------
    # `unused_field` / `unused_element` are WARNINGS, and `flutter analyze`
    # treats warnings as fatal by default, so they redden CI exactly like
    # errors. The decision rule is deliberately the crudest one that cannot be
    # wrong: count occurrences of the identifier in the WHOLE library (its own
    # file plus its parts, masked so comments and Arabic strings do not
    # count). Exactly one occurrence = the declaration itself = unused.
    def check_unused_private(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                if lib.part_of:
                    continue
                scope = lib.masked
                for p in lib.parts:
                    tp = self._resolve_uri(lib, app, p)
                    if tp:
                        scope += "\n" + app.libs[tp].masked
                counts: Dict[str, int] = defaultdict(int)
                # NOTE the lookbehind deliberately does NOT exclude a preceding
                # `.`. Counting `this._x` and `widget._x` as occurrences can
                # only make this check QUIETER, and quieter is the safe
                # direction for a rule whose whole content is "the count is
                # exactly one". Excluding `.` also silently swallowed `...xs`
                # (the spread operator), which is what produced the first false
                # positive this check ever emitted.
                for mm in re.finditer(r"(?<![\w$])(_\w+)", scope):
                    counts[mm.group(1)] += 1
                for decl in lib.types.values():
                    # A private member of a widget State subclass may be
                    # referenced only from a generated part; there are none in
                    # this tree, but the parts sweep above covers it anyway.
                    for name, mem in decl.members.items():
                        if not name.startswith("_") or name.startswith("__"):
                            continue
                        if mem.is_override:
                            continue
                        self.examined["private-members"] += 1
                        if counts.get(name, 0) != 1:
                            continue
                        self.add(
                            "UNUSED-PRIVATE", lib.path, mem.line,
                            f"`{decl.name}.{name}` ({mem.kind}) is private and its "
                            f"declaration is its only occurrence in this library "
                            f"— `flutter analyze` reports this as "
                            f"`unused_{'field' if mem.kind == 'field' else 'element'}`, "
                            f"which is fatal by default",
                            sev="warning",
                        )

    # ---- UNUSED-LOCAL ----------------------------------------------------
    # Same rule, one scope down: a `final`/`var`/`const` local declaration
    # whose identifier occurs exactly once in the entire file. Restricting the
    # count to the whole file (not the enclosing block) is what makes
    # shadowing irrelevant — if the name occurs once, there is nothing to
    # shadow and nothing to be shadowed by.
    _LOCAL_RE = re.compile(
        r"^[ \t]{4,}(?:final|const|var)[ \t]+"
        r"(?:[A-Za-z_][\w.]*(?:<[^<>]*(?:<[^<>]*>)?[^<>]*>)?\??[ \t]+)?"
        r"(?P<n>[a-z_]\w*)[ \t]*=(?!=|>)",
        re.M,
    )

    def check_unused_locals(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                scope = lib.masked
                counts: Dict[str, int] = defaultdict(int)
                # Same reasoning as check_unused_private: over-counting is the
                # safe error. `final goals = …; final sorted = [...goals]…`
                # was reported as an unused local purely because the spread
                # operator's dots hid the second occurrence.
                for mm in re.finditer(r"(?<![\w$])([A-Za-z_]\w*)", scope):
                    counts[mm.group(1)] += 1
                for m in self._LOCAL_RE.finditer(scope):
                    name = m.group("n")
                    if name in _DART_KEYWORDS or name.startswith("_"):
                        # `_` and `_x` are the conventional "I do not want
                        # this" names and the analyser exempts them.
                        continue
                    self.examined["locals-checked"] += 1
                    if counts.get(name, 0) != 1:
                        continue
                    self.add(
                        "UNUSED-LOCAL", lib.path, line_of(lib.src, m.start("n")),
                        f"local variable `{name}` is declared here and its "
                        f"declaration is its only occurrence in this file "
                        f"(`unused_local_variable`, fatal by default)",
                        sev="warning",
                    )

    # ---- UNREACHABLE -----------------------------------------------------
    # `dead_code`, again a fatal warning. Two shapes only:
    #
    #   (a) a statement that FOLLOWS a `return …;` / `throw …;` inside the same
    #       block. Every `case`/`default` label, every `}` and every `else`
    #       is excluded, because a `return` at the end of a switch case is
    #       normal and correct.
    #   (b) `if (true)` / `if (false)` / `while (false)` — a literal condition.
    _TERMINATOR_RE = re.compile(r"(?<![\w.$])(return|throw)\b")
    _CONST_COND_RE = re.compile(r"(?<![\w.$])(if|while)\s*\(\s*(true|false)\s*\)")

    @staticmethod
    def _end_of_statement(text: str, start: int) -> int:
        """Index just past the `;` that ends the statement beginning at `start`.

        The `;` must be at bracket depth 0. A regex `[^;{}]*;` is NOT good
        enough and got this wrong twice on real code: BOTH
        `return [for (var i = 0; i <= last; i += 1) …];` and a `Wrap(children:
        [for (var juz = 1; …)])` contain semicolons inside a collection-`for`
        header, so the regex ended the statement in the middle of a list
        literal and every following token looked like dead code.
        """
        depth = 0
        i = start
        n = len(text)
        while i < n:
            c = text[i]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                if depth == 0:
                    return -1
                depth -= 1
            elif c == ";" and depth == 0:
                return i + 1
            i += 1
        return -1

    def check_unreachable(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                m = lib.masked
                for cm in self._CONST_COND_RE.finditer(m):
                    self.add(
                        "UNREACHABLE", lib.path, line_of(lib.src, cm.start()),
                        f"`{cm.group(1)} ({cm.group(2)})` — a constant condition; "
                        f"one branch is dead code",
                        sev="warning",
                    )
                for tm in self._TERMINATOR_RE.finditer(m):
                    # ---------------------------------------------------------
                    # SOUNDNESS GATE, and the reason this check is worth
                    # trusting. `if (cond) return;` is the most common single
                    # statement in this codebase and NOTHING after it is dead.
                    # The first version of this check ignored that and produced
                    # 98 findings of which every one was wrong.
                    #
                    # A terminator only kills the rest of its block when it is a
                    # DIRECT statement of that block — i.e. the previous
                    # non-whitespace character is `;`, `{` or `}`. If it is `)`
                    # the terminator is the braceless body of an
                    # `if`/`for`/`while`; if it is `>` it is an `=>` expression
                    # body; if it is `:` it is a `case` label body and the next
                    # `case` is not dead. All three abstain.
                    # ---------------------------------------------------------
                    k = tm.start() - 1
                    while k >= 0 and m[k] in " \t\n\r":
                        k -= 1
                    if k < 0 or m[k] not in ";{}":
                        self.abstained["terminator-not-a-block-statement"] += 1
                        continue
                    end = self._end_of_statement(m, tm.end())
                    if end == -1:
                        self.abstained["terminator-unterminated"] += 1
                        continue
                    rest = m[end:]
                    stripped = rest.lstrip()
                    lead = len(rest) - len(stripped)
                    if not stripped:
                        continue
                    if stripped[0] == "}":
                        continue
                    nxt = re.match(r"[A-Za-z_]\w*", stripped)
                    if nxt and nxt.group(0) in (
                        "case", "default", "else", "catch", "finally", "on",
                    ):
                        continue
                    # A `return`/`throw` inside a closure passed as an argument
                    # is followed by `)` / `,` — not dead code.
                    self.examined["terminators"] += 1
                    if stripped[0] in ")],;":
                        continue
                    self.add(
                        "UNREACHABLE", lib.path,
                        line_of(lib.src, end + lead),
                        f"statement follows a `{tm.group(1)}` in the same block — "
                        f"`dead_code`, fatal under `flutter analyze` defaults",
                        sev="warning",
                    )

    # ---- SELF-MEMBER -----------------------------------------------------
    # `this.name` is the one member reference in Dart whose receiver needs no
    # inference at all: it is the enclosing class, exactly. So when that
    # class's supertype chain is entirely in-tree, "does `name` exist?" is
    # fully decidable — `undefined_getter` / `undefined_method`, a
    # compile-time error.
    #
    # The one shape that must NOT be read this way is `this.x` in a
    # CONSTRUCTOR PARAMETER LIST, where it declares an initialising formal
    # rather than referring to anything. Those spans are excluded explicitly
    # below; they are also the overwhelming majority of `this.` occurrences in
    # a Flutter codebase, so getting this wrong would have been loud.
    _THIS_MEMBER_RE = re.compile(r"(?<![\w.$])this\s*\.\s*([A-Za-z_]\w*)")

    def check_self_members(self) -> None:
        for app in self.ws.apps.values():
            ext_targets: Set[str] = set()
            for lib in app.libs.values():
                for t in lib.types.values():
                    if t.kind == "extension":
                        ext_targets |= set(t.supertypes)
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                for decl in lib.types.values():
                    if decl.kind not in ("class", "mixin"):
                        continue
                    if decl.name in ext_targets or decl.body_span == (0, 0):
                        continue
                    chain = self.chain(decl, vis)
                    if chain is None:
                        self.abstained["self-member-chain-leaves-tree"] += 1
                        continue
                    known: Set[str] = set()
                    for anc in chain:
                        known |= set(anc.members)
                        known |= set(anc.enum_values)
                    # constructor parameter lists: `this.x` there is a
                    # declaration, not a reference
                    skip: List[Tuple[int, int]] = []
                    for c in decl.ctors.values():
                        if c.decl_offset < 0:
                            continue
                        o = lib.masked.find("(", c.decl_offset)
                        if o == -1:
                            continue
                        e = match_bracket(lib.masked, o)
                        if e != -1:
                            skip.append((o, e))
                    a, b = decl.body_span
                    for m in self._THIS_MEMBER_RE.finditer(lib.masked, a, b):
                        if any(s <= m.start() < e for s, e in skip):
                            continue
                        name = m.group(1)
                        if name in UNIVERSAL_MEMBERS or name in known:
                            continue
                        # `const UiState.loading() : this._(…, null, null);` is
                        # a REDIRECTING CONSTRUCTOR INVOCATION, not a member
                        # reference. `this.` followed by a name this class
                        # declares as a constructor is always that, never a
                        # getter — and it accounted for every finding this
                        # check produced on its first run.
                        if name in decl.ctors:
                            self.abstained["this-redirecting-ctor"] += 1
                            continue
                        self.examined["this-member-refs"] += 1
                        self.add(
                            "SELF-MEMBER", lib.path, line_of(lib.src, m.start()),
                            f"`this.{name}` inside `{decl.name}` — no `{name}` is "
                            f"declared by `{decl.name}` or by any type in its "
                            f"fully in-tree chain "
                            f"({' -> '.join(x.name for x in chain[1:]) or 'Object'})",
                        )

    # ---- OVERRIDE-SIG ----------------------------------------------------
    # Phase C's OVERRIDE check answers "does an ancestor declare this NAME?".
    # `invalid_override` is the next question and a compile-time ERROR: the
    # overriding signature must stay substitutable for the one it replaces.
    # When the whole chain is in-tree both signatures are in hand, and the four
    # rules below are about COUNTS AND NAMES only — never about types — so no
    # inference is involved.
    def check_override_signatures(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                for decl in lib.types.values():
                    if decl.kind not in ("class", "mixin"):
                        continue
                    chain = self.chain(decl, vis)
                    if chain is None:
                        continue
                    for name, mem in decl.members.items():
                        if not mem.is_override or mem.kind != "method":
                            continue
                        if mem.params is None or mem.unparsed:
                            self.abstained["override-sig-unparsed"] += 1
                            continue
                        base = None
                        for anc in chain:
                            if anc is decl:
                                continue
                            cand = anc.members.get(name)
                            if cand is not None and cand.kind == "method":
                                base = (anc, cand)
                                break
                        if base is None:
                            continue          # Phase C's OVERRIDE check owns this
                        anc, bm = base
                        if bm.params is None or bm.unparsed:
                            self.abstained["override-sig-unparsed"] += 1
                            continue
                        self.examined["overrides-compared"] += 1
                        o_pos = [p for p in mem.params if not p.named]
                        b_pos = [p for p in bm.params if not p.named]
                        o_named = {p.name: p for p in mem.params if p.named}
                        b_named = {p.name: p for p in bm.params if p.named}
                        why: List[str] = []
                        if len(o_pos) < len(b_pos):
                            why.append(
                                f"accepts {len(o_pos)} positional parameter(s) where "
                                f"`{anc.name}.{name}` accepts {len(b_pos)}"
                            )
                        if sum(1 for p in o_pos if p.required) > sum(
                            1 for p in b_pos if p.required
                        ):
                            why.append(
                                "makes a positional parameter required that the "
                                "overridden member leaves optional"
                            )
                        gone = sorted(set(b_named) - set(o_named))
                        if gone:
                            why.append(
                                "drops named parameter(s) "
                                + ", ".join(f"`{g}`" for g in gone)
                            )
                        newly_required = sorted(
                            n2 for n2, p in o_named.items()
                            if p.required and not b_named.get(n2, p).required
                        )
                        if newly_required:
                            why.append(
                                "newly requires named parameter(s) "
                                + ", ".join(f"`{n2}`" for n2 in newly_required)
                            )
                        if why:
                            self.add(
                                "OVERRIDE-SIG", lib.path, mem.line,
                                f"`{decl.name}.{name}` is not a valid override of "
                                f"`{anc.name}.{name}` "
                                f"({os.path.relpath(anc.file, self.repo)}:{bm.line}): "
                                + "; ".join(why),
                            )

    # ---- IMPLEMENTS-MISSING ---------------------------------------------
    # `implements` obliges a class to DECLARE every member of the interface —
    # inheriting an implementation is exactly what it does NOT do. Omitting one
    # is `non_abstract_class_inherits_abstract_member`, a compile-time error,
    # and hand-written test fakes are where it happens. A class declaring
    # `noSuchMethod` is exempt by the language, and this tree's fakes rely on
    # precisely that, so they are skipped rather than reported.
    def check_implements(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                for decl in lib.types.values():
                    if decl.kind != "class" or decl.is_abstract:
                        continue
                    ifaces = decl.rel.get("implements") or []
                    if not ifaces:
                        continue
                    if "noSuchMethod" in decl.members:
                        self.abstained["implements-nosuchmethod"] += 1
                        continue
                    required: Dict[str, TypeDecl] = {}
                    bail = False
                    for iname in ifaces:
                        idecl = vis.get(iname)
                        if idecl is None:
                            bail = True
                            break
                        ichain = self.chain(idecl, vis)
                        if ichain is None:
                            bail = True
                            break
                        for anc in ichain:
                            for n, m2 in anc.members.items():
                                # A private member cannot be implemented from
                                # another library at all — out of scope here.
                                if n.startswith("_") or m2.is_static:
                                    continue
                                required.setdefault(n, anc)
                    if bail:
                        self.abstained["implements-interface-not-in-tree"] += 1
                        continue
                    have = set(decl.members)
                    for sup in (decl.rel.get("extends") or []) + (
                        decl.rel.get("with") or []
                    ):
                        sdecl = vis.get(sup)
                        if sdecl is None:
                            bail = True
                            break
                        schain = self.chain(sdecl, vis)
                        if schain is None:
                            bail = True
                            break
                        for anc in schain:
                            have |= set(anc.members)
                    if bail:
                        self.abstained["implements-superclass-not-in-tree"] += 1
                        continue
                    self.examined["implements-classes"] += 1
                    missing = sorted(
                        n for n in required
                        if n not in have and n not in UNIVERSAL_MEMBERS
                    )
                    if missing:
                        self.add(
                            "IMPLEMENTS-MISSING", lib.path, decl.line,
                            f"`{decl.name}` implements "
                            + ", ".join(f"`{i}`" for i in ifaces)
                            + " but declares no "
                            + ", ".join(f"`{n}`" for n in missing[:8])
                            + (f" (+{len(missing) - 8} more)" if len(missing) > 8 else "")
                            + ", and has no `noSuchMethod` to absorb the difference",
                        )

    # ---- SELF-CALL -------------------------------------------------------
    # A bare `m(...)` inside a class body resolves to that class's own chain.
    # When the WHOLE chain is in-tree the declaration is known exactly, so the
    # same arity / named / required verification the constructor checks use
    # applies with no type inference at all. Abstains when the name is not
    # found in the chain (it could be a top-level function, a local closure, a
    # callable field or an extension method) — this check only ever speaks
    # when it has the declaration in hand.
    _SELF_CALL_RE = re.compile(r"(?<![\w.$'\")\]])([a-z_]\w*)\s*\(")
    # Keywords after which an identifier followed by `(` is an INVOCATION.
    # Anything else that reads as a type is a DECLARATION.
    _CALL_LEAD_KEYWORDS = {
        "await", "return", "yield", "throw", "else", "in", "is", "as", "case",
        "do", "if", "while", "assert", "print", "new", "const",
    }

    @staticmethod
    def _looks_like_invocation(body: str, at: int) -> Optional[bool]:
        """True = call site, False = declaration, None = cannot tell.

        WHY THIS EXISTS. The first version of SELF-CALL matched
        `Future<Map<String, dynamic>> post(\\n    String path, {` — a METHOD
        DECLARATION — as a call to `post`, read its own parameter list as the
        argument list, and reported 64 arity errors on a tree in which every
        one of them was correct. The distinction is entirely in what precedes
        the name: a declaration is preceded by its return type, an invocation
        is preceded by a statement or operator boundary.
        """
        i = at - 1
        while i >= 0 and body[i] in " \t\n\r":
            i -= 1
        if i < 0:
            return None
        c = body[i]
        if c in ";{}(,[=&|!:+-*/%":
            return True
        if c == ">":
            # `=>` is an arrow (call follows); a lone `>` closes a generic
            # return type (declaration follows).
            return body[i - 1] == "=" if i > 0 else None
        if c in "?]":
            return False               # `Foo? name(`  /  `List<Foo> name(`
        if c.isalnum() or c == "_":
            j = i
            while j >= 0 and (body[j].isalnum() or body[j] == "_"):
                j -= 1
            word = body[j + 1 : i + 1]
            if word in Preflight._CALL_LEAD_KEYWORDS:
                return True
            return False               # a return type, `static`, `async`, …
        return None

    def check_self_calls(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                vis = self.visible_types(lib, app)
                shadow = set(lib.top_functions) | set(lib.top_vars)
                for decl in lib.types.values():
                    if decl.kind not in ("class", "mixin") or decl.body_span == (0, 0):
                        continue
                    chain = self.chain(decl, vis)
                    if chain is None:
                        continue
                    known: Dict[str, "object"] = {}
                    for anc in chain:
                        for n, mem in anc.members.items():
                            known.setdefault(n, mem)
                    body = lib.masked[decl.body_span[0] : decl.body_span[1]]
                    # local declarations inside the body can shadow a method
                    local = set(re.findall(
                        r"(?:final|var|const)\s+(?:[\w<>,\?\[\]\.]+\s+)?([a-z_]\w*)\s*=",
                        body,
                    ))
                    local |= {
                        p.name
                        for c in decl.ctors.values() for p in c.params
                    }
                    for m in self._SELF_CALL_RE.finditer(body):
                        name = m.group(1)
                        if name in _DART_KEYWORDS or name in shadow or name in local:
                            continue
                        kind = self._looks_like_invocation(body, m.start())
                        if kind is not True:
                            self.abstained["self-call-is-declaration-or-unclear"] += 1
                            continue
                        mem = known.get(name)
                        if mem is None:
                            self.abstained["self-call-not-in-chain"] += 1
                            continue
                        if getattr(mem, "kind", "") != "method":
                            self.abstained["self-call-not-a-method"] += 1
                            continue
                        if mem.params is None or mem.unparsed:
                            self.abstained["self-call-unparsed"] += 1
                            continue
                        popen = decl.body_span[0] + m.end() - 1
                        got = self._args(lib.masked, popen)
                        if got is None:
                            continue
                        self.examined["self-calls"] += 1
                        self._verify(
                            "SELF", lib,
                            line_of(lib.src, decl.body_span[0] + m.start()),
                            f"{decl.name}.{name}", mem.params, got[1],
                        )

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
                self.examined["files-scanned-for-unimported"] += 1

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

    # ---- SCOPE-UNDEF ------------------------------------------------------
    # WHY THIS CHECK EXISTS
    # ---------------------
    # `_MessageCard.build` in apps/child-app/.../my_growth_screen.dart called
    # `t('myGrowth.newLabel')` inside a class that had no `t` in scope, no
    # enclosing closure to inherit one from, and no top-level `t()` anywhere in
    # the app. That is `undefined_identifier` — a COMPILE error, not a runtime
    # one — and it sat behind roughly three hundred green `t(...)` call sites.
    # Nine checkers reported zero problems on a tree that could not be built:
    # `verify_l10n_parity` resolved the KEY (it exists in both locales) without
    # ever type-checking the CALL SITE, and nothing else in this repo asked
    # whether a bare identifier resolves at all. This check asks exactly that.
    #
    # WHAT IT DECIDES, AND HOW IT REFUSES TO GUESS
    # -------------------------------------------
    # For each "scope unit" — one member declaration (its parameter list plus
    # its body) or one top-level declaration — every occurrence of a bare
    # lowercase identifier is classified USE / DECL / UNKNOWN. A name is
    # reported ONLY when, in that unit:
    #
    #     uses >= 1   AND   decls == 0   AND   unknowns == 0
    #
    # and the name is absent from every scope that could supply it: the
    # enclosing type's members and its in-tree supertype closure, the library's
    # own top-level declarations, the top-level declarations of every in-tree
    # import, and the SDK inventory below.
    #
    # The three-way classification is the zero-false-positive mechanism.
    # Misreading a declaration as a use is the only way this check can lie, so
    # every ambiguous shape is resolved TOWARDS silence: DECL and UNKNOWN both
    # suppress the report, and only shapes that are unambiguously a use count
    # as one. An incomplete classifier therefore makes the check quieter, never
    # noisier — the same rule the rest of this file is built on.
    #
    # THE IDIOM GATE — the second, independent reason a report is trustworthy
    # ---------------------------------------------------------------------
    # A bare lowercase name could always be something a source-only scan cannot
    # see: a top-level function of a package this environment cannot download,
    # a member inherited from a Flutter base class, an extension method. So a
    # name is a candidate ONLY if the LIBRARY ITSELF proves the name needs
    # declaring — it is declared as a local or a parameter in at least
    # `_IDIOM_MIN_UNITS` OTHER scope units of the same file. That is exactly
    # the shape of the escaped error ("299 methods declare `final t = …`, one
    # forgot") and it is what makes the finding self-evidencing: the file's own
    # author, elsewhere in the same file, wrote the declaration this site is
    # missing. `min` from `dart:math` is never declared as a local, so the
    # check never has an opinion about it.
    #
    # DELIBERATELY NOT ANALYSED, and why
    # ----------------------------------
    #   `part` / `part of`      A part's scope is its parent library's, spread
    #                           across files; the unit model here is per-file.
    #                           Neither app contains one — if one appears, this
    #                           check abstains on it rather than guess.
    #   extension bodies        Inside `extension E on T`, every member of `T`
    #                           is nameable bare. When `T` is out of tree its
    #                           member set is unknowable. Abstained outright.
    #   mixins from outside     `with SomeMixin` where the mixin is not in tree
    #                           contributes members this scan cannot see; those
    #                           names fall to the SDK inventory and the idiom
    #                           gate, which is why both exist.
    #   `dynamic` receivers     Irrelevant here: this check only looks at BARE
    #                           identifiers, never at `x.member`.
    #   generated code          `.g.dart` / `.freezed.dart` are skipped: their
    #                           declarations are produced by a builder that has
    #                           never run in this environment. Neither app has
    #                           any today.
    #   conditional imports     `import … if (dart.library.io) …` makes the
    #                           visible name set configuration-dependent. The
    #                           file is abstained on. Neither app has one.
    #   use-before-declaration  A local declared LATER in the same block than
    #                           its use is a real Dart error; a declaration
    #                           anywhere in the unit counts here, so this check
    #                           stays silent on it.
    #
    # Names the SDK and the declared packages provide as BARE identifiers —
    # top-level functions/getters, and members inherited from base classes this
    # tree does not contain (StatefulWidget, State, ChangeNotifier, Notifier…).
    # Used ONLY to abstain, so an incomplete entry costs coverage, never
    # correctness. Every entry is a name that is ALSO declared as a local
    # somewhere in this tree — anything else could never reach this gate.
    _SDK_BARE_NAMES = {
        # dart:core / dart:async / dart:convert / dart:math / dart:io
        "print", "identical", "identityHashCode", "min", "max", "pow", "sqrt",
        "sin", "cos", "tan", "atan2", "exp", "log", "pi", "e", "json",
        "jsonEncode", "jsonDecode", "utf8", "ascii", "latin1", "base64",
        "base64Encode", "base64Decode", "base64Url", "base64UrlEncode",
        "unawaited", "scheduleMicrotask", "runZonedGuarded", "runZoned",
        "exit", "sleep", "stdout", "stderr", "stdin", "pid", "exitCode",
        # flutter foundation / widgets / material top-levels
        "debugPrint", "debugPrintStack", "runApp", "compute", "describeEnum",
        "precacheImage", "showDialog", "showModalBottomSheet",
        "showGeneralDialog", "showDatePicker", "showTimePicker", "showMenu",
        "showSearch", "showBottomSheet", "showAboutDialog", "showLicensePage",
        "lerpDouble", "clampDouble", "defaultTargetPlatform", "kIsWeb",
        "kDebugMode", "kReleaseMode", "kProfileMode", "kToolbarHeight",
        "rootBundle", "imageCache", "timeDilation", "nonconst",
        # members inherited from out-of-tree base classes, nameable bare
        "widget", "context", "mounted", "setState", "initState", "dispose",
        "didUpdateWidget", "didChangeDependencies", "deactivate", "activate",
        "reassemble", "createState", "createElement", "build", "key", "ref",
        "state", "stream", "value", "listen", "read", "watch", "refresh",
        "invalidate", "notifyListeners", "addListener", "removeListener",
        "hasListeners", "debugFillProperties", "toStringShort", "toStringDeep",
        "debugDescribeChildren", "updateShouldNotify", "wantKeepAlive",
        "createTicker", "vsync", "didChangeAppLifecycleState",
        "didChangeMetrics", "didChangeLocales", "didChangePlatformBrightness",
        "didChangeTextScaleFactor", "didHaveMemoryPressure", "didPopRoute",
        "didPushRoute", "didPushRouteInformation", "didRequestAppExit",
        "didChangeAccessibilityFeatures", "restoreState", "restorationId",
        "registerForRestoration", "unregisterFromRestoration", "bucket",
        "didToggleBucket", "onError", "noSuchMethod", "toString", "hashCode",
        "runtimeType", "future", "isCompleted", "complete", "cancel", "close",
        "mock", "when", "then", "verify",
    }

    # How many OTHER scope units in the same library must declare the name as a
    # local or a parameter before a use of it here is reportable. One would
    # already be evidence; two is the threshold at which the name is an
    # established local idiom of the file rather than a single coincidental
    # shadow of something the SDK provides. Lowering this to 1 was tried and
    # produced the `value` / `state` class of false positive.
    _IDIOM_MIN_UNITS = 2

    _IDENT_RE = re.compile(r"(?<![\w$.])([a-z_]\w*)")

    # Words that can never be an identifier reference. `_DART_KEYWORDS` above
    # is the set the OTHER checks needed and is missing several of these; a
    # missing entry here is a false positive, so this list is deliberately
    # over-long rather than minimal.
    _NEVER_AN_IDENTIFIER = {
        "null", "true", "false", "try", "finally", "on", "with", "extends",
        "implements", "operator", "external", "abstract", "async", "sync",
        "base", "sealed", "interface", "of", "when", "assert", "export",
        "typedef",
    }

    # Words after which a following identifier is being DECLARED.
    _DECL_LEAD = {
        "final", "var", "const", "late", "required", "covariant", "factory",
        "get", "set", "typedef", "class", "enum", "mixin", "extension",
        "deferred", "as", "show", "hide", "part", "library", "on",
    }
    # Lowercase words that introduce a type, so a following identifier is a
    # declaration. Uppercase-initial predecessors are handled positionally.
    _LOWER_TYPE_LEAD = {
        "void", "int", "double", "num", "bool", "dynamic", "var",
    }
    # Words after which a following identifier is unambiguously a USE.
    _USE_LEAD = {
        "return", "await", "yield", "throw", "rethrow", "if", "else", "while",
        "do", "switch", "case", "in", "is", "new", "assert", "when", "print",
    }
    # Statement/expression punctuation after which an identifier is a USE.
    _USE_PUNCT = set(";}{)]!&|+-*/%^~,=<>?:([")

    @staticmethod
    def _scope_units(masked: str, start: int, end: int) -> List[Tuple[int, int]]:
        """Partition [start, end) into one span per declaration.

        A span is a declaration's header PLUS its brace body when it has one,
        so a method's parameter names and its locals land in the same unit and
        are both seen as declarations without the parser ever having to tell
        the two apart. Segments end at a depth-0 `;` otherwise, which is what
        puts a field initialiser in a unit of its own.
        """
        units: List[Tuple[int, int]] = []
        depth = 0
        seg = start
        i = start
        while i < end:
            ch = masked[i]
            if ch in "([":
                depth += 1
            elif ch in ")]":
                depth -= 1
            elif ch == "{":
                if depth == 0:
                    close = match_bracket(masked, i)
                    if close == -1 or close > end:
                        break
                    units.append((seg, close))
                    i = close
                    seg = i
                    continue
                depth += 1
            elif ch == "}":
                depth -= 1
            elif ch == ";" and depth == 0:
                units.append((seg, i))
                i += 1
                seg = i
                continue
            i += 1
        if seg < end:
            units.append((seg, end))
        return units

    @staticmethod
    def _prev_token(u: str, at: int) -> Tuple[str, str]:
        """(kind, text) of the token before offset `at`. kind: word|punct|bos."""
        i = at - 1
        while i >= 0 and u[i] in " \t\r\n":
            i -= 1
        if i < 0:
            return ("bos", "")
        if u[i].isalnum() or u[i] == "_":
            j = i
            while j >= 0 and (u[j].isalnum() or u[j] == "_"):
                j -= 1
            return ("word", u[j + 1 : i + 1])
        return ("punct", u[i])

    @classmethod
    def _is_param_list(cls, u: str, at: int) -> bool:
        """Is offset `at` directly inside a parameter list (of a declaration,
        a closure or a `catch`)? Deciding YES suppresses a report, so this
        errs towards YES whenever the shape is not clearly a call."""
        depth = 0
        i = at - 1
        while i >= 0:
            c = u[i]
            if c in ")]}":
                depth += 1
            elif c in "([{":
                if depth == 0:
                    if c != "(":
                        return False
                    break
                depth -= 1
            i -= 1
        if i < 0:
            return False
        close = match_bracket(u, i)
        if close == -1:
            return False
        kind, text = cls._prev_token(u, i)
        if kind == "word" and text == "catch":
            return True
        # `if (…) {` / `while (…) {` / `switch (…) {` / `for (…) {` are control
        # headers, not parameter lists — their contents are uses.
        if kind == "word" and text in {"if", "while", "switch", "for"}:
            return False
        tail = u[close:]
        m = re.match(r"\s*(?:async\*?|sync\*)?\s*(=>|\{)", tail)
        return bool(m)

    @classmethod
    def _classify(cls, u: str, at: int, name: str) -> str:
        """USE / DECL / UNKNOWN for the identifier `name` at offset `at` in the
        scope-unit text `u`. Anything not certainly a use is not a use."""
        after = at + len(name)
        # `r'…'` / `r"…"`. The source masker blanks a raw string's BODY but
        # leaves its `r` prefix and its quotes standing, so the prefix reads as
        # a bare identifier named `r`. It is not one.
        if after < len(u) and u[after] in "'\"":
            return "SKIP"
        j = after
        while j < len(u) and u[j] in " \t\r\n":
            j += 1
        nxt = u[j] if j < len(u) else ""
        nxt2 = u[j + 1] if j + 1 < len(u) else ""

        # `name:` — a named-argument label, a map key, a pattern field name or
        # a statement label. Never a use of a value called `name`.
        if nxt == ":" and nxt2 != ":":
            return "DECL"
        # `name = …` (but not `==`, `=>`): an initialiser or an assignment. An
        # assignment to a name that resolves nowhere is its own error; treating
        # it as a declaration keeps this check to one claim.
        if nxt == "=" and nxt2 not in "=>":
            return "DECL"

        kind, tok = cls._prev_token(u, at)
        if kind == "bos":
            return "UNKNOWN"
        if kind == "word":
            if tok in cls._DECL_LEAD or tok in cls._LOWER_TYPE_LEAD:
                return "DECL"
            if tok in cls._USE_LEAD:
                return "USE"
            if tok.lstrip("_")[:1].isupper():
                # `SomeType name` and `_PrivateType name` are both declarations.
                return "DECL"
            return "UNKNOWN"           # two lowercase words: cannot tell
        # punctuation
        if tok == ">":
            # `=>` is an arrow and everything after it is an expression; a lone
            # `>` closes a generic type, so what follows it is being declared.
            # Conflating the two made EVERY arrow-bodied member in the tree
            # invisible to this check — `int get doubled => length * 2;` read
            # `length` as a declaration and the whole unit went quiet.
            return "USE" if u[:at].rstrip().endswith("=>") else "DECL"
        if tok in "?])":
            # `T? name`, `List<T> name`, and — the shape that produced this
            # check's first false positive — `String Function(String) t`, a
            # function-TYPED parameter whose declared name follows the closing
            # paren of the function type. `t` there is a declaration; reading
            # it as a use made `_buildFriendlyError` look like it called an
            # undefined `t` when the name was its own parameter.
            return "DECL"
        if tok == ".":
            return "SKIP"              # member access, not a bare identifier
        if tok == "@":
            return "SKIP"              # an annotation name, not a value use
        if tok in "'\"":
            # The masker blanks a string's TEXT but keeps its quotes and its
            # interpolated expressions, so an identifier whose predecessor is a
            # quote is the first thing inside `'…$name…'` — a use. Without this
            # the check was blind to every `'${t('key')}'`, which in a
            # localised app is where a large share of the call sites live.
            return "USE"
        if tok in "(,":
            if cls._is_param_list(u, at):
                return "DECL"
            return "USE"
        if tok == ":":
            # `label: value` and `cond ? a : b` are uses; `Foo(:name)` is a
            # pattern binding.
            k2, t2 = cls._prev_token(u, at - 1)
            if k2 == "punct" and t2 in "(,":
                return "DECL"
            return "USE"
        if tok in cls._USE_PUNCT:
            return "USE"
        return "UNKNOWN"

    def visible_values(self, lib: Library, app: App) -> Set[str]:
        """Bare top-level value/function names this library can name."""
        names: Set[str] = set(lib.top_functions) | set(lib.top_vars)
        for uri, _ln, prefix, show, hide in lib.imports:
            if prefix:
                # `import 'dart:developer' as developer;` puts `developer`
                # itself in scope as a name. Missing this made every
                # `developer.log(…)` look like an undefined identifier.
                names.add(prefix)
                continue
            p = self._resolve_uri(lib, app, uri)
            if not p:
                continue
            got: Set[str] = set()
            target = app.libs[p]
            got |= set(target.top_functions) | set(target.top_vars)
            for t in target.types.values():
                got |= set(t.enum_values)
            for uri2, _l2 in target.exports:
                p2 = self._resolve_uri(target, app, uri2)
                if not p2:
                    continue
                got |= set(app.libs[p2].top_functions) | set(app.libs[p2].top_vars)
                for uri3, _l3 in app.libs[p2].exports:
                    p3 = self._resolve_uri(app.libs[p2], app, uri3)
                    if p3:
                        got |= set(app.libs[p3].top_functions)
                        got |= set(app.libs[p3].top_vars)
            if show:
                got &= set(show)
            names |= got - set(hide)
        return names

    def _chain_members(
        self, decl: TypeDecl, vis: Dict[str, TypeDecl]
    ) -> Set[str]:
        """Every member name reachable from `decl` through the part of its
        supertype closure that IS in this tree. A link that leaves the tree
        (`extends ConsumerWidget`, `with SingleTickerProviderStateMixin`) ends
        that branch rather than the whole walk, so what comes back is a LOWER
        bound on the names really in scope.

        Be clear about which way that cuts: a lower bound makes the caller
        NOISIER, not quieter — a member inherited from a Flutter base class is
        absent from this set and would read as unresolved. That is exactly the
        hole `_SDK_BARE_NAMES` and the idiom gate exist to plug, and it is why
        neither is optional. Refusing to walk at all on an out-of-tree link,
        the way `chain()` does, would leave the check no reach worth having:
        almost every widget in this tree extends something Flutter owns —
        including `_MessageCard`, where the escaped error lived."""
        out: Set[str] = set()
        stack = [decl]
        seen = {decl.name}
        while stack:
            cur = stack.pop()
            out |= set(cur.members)
            out |= set(cur.enum_values)
            for c in cur.ctors.values():
                out |= {p.name for p in c.params}
            for s in cur.supertypes:
                nxt = vis.get(s)
                if nxt is not None and nxt.name not in seen:
                    seen.add(nxt.name)
                    stack.append(nxt)
        return out

    def check_scope(self) -> None:
        for app in self.ws.apps.values():
            for lib in app.libs.values():
                base = os.path.basename(lib.path)
                if base.endswith((".g.dart", ".freezed.dart", ".gr.dart")):
                    self.abstained["scope-generated-file"] += 1
                    continue
                if lib.part_of or lib.parts:
                    self.abstained["scope-part-file"] += 1
                    continue
                if "if (dart.library" in lib.masked:
                    self.abstained["scope-conditional-import"] += 1
                    continue

                # The DEEP mask. `lib.masked` leaves a string literal nested
                # inside an interpolation — `'${t('healthTrend.title')}'` —
                # completely unmasked, so `healthTrend` read as a bare
                # identifier preceded by a quote and produced 21 false
                # positives, every one of them an l10n key segment. Offsets are
                # identical to `lib.masked`, so every span already computed
                # against it stays valid.
                masked = mask_source(lib.src, deep=True)

                vis = self.visible_types(lib, app)
                top = self.visible_values(lib, app)
                type_names = set(vis) | set(lib.types)

                # ---- collect every unit, with its owning type -------------
                spans = sorted(
                    (t.body_span[0] - 1, t.body_span[1] + 1)
                    for t in lib.types.values()
                    if t.body_span != (0, 0)
                )
                units: List[Tuple[int, int, Optional[TypeDecl]]] = []
                for t in lib.types.values():
                    if t.body_span == (0, 0):
                        continue
                    if t.kind == "extension":
                        # Inside an extension every member of the extended type
                        # is nameable bare; when that type is not in tree its
                        # members are unknowable. No opinion, by construction.
                        self.abstained["scope-extension-body"] += 1
                        continue
                    for a, b in self._scope_units(
                        masked, t.body_span[0], t.body_span[1]
                    ):
                        units.append((a, b, t))
                cursor = 0
                gaps: List[Tuple[int, int]] = []
                for a, b in spans:
                    if cursor < a:
                        gaps.append((cursor, a))
                    cursor = max(cursor, b)
                if cursor < len(masked):
                    gaps.append((cursor, len(masked)))
                for a, b in gaps:
                    for ua, ub in self._scope_units(masked, a, b):
                        units.append((ua, ub, None))

                # ---- pass 1: classify, and learn the file's local idiom ----
                per_unit: List[Tuple[int, int, Optional[TypeDecl], Dict[str, Dict[str, int]]]] = []
                declaring_units: Dict[str, int] = defaultdict(int)
                for ua, ub, owner in units:
                    u = masked[ua:ub]
                    if not u.strip():
                        continue
                    tally: Dict[str, Dict[str, int]] = defaultdict(
                        lambda: {"USE": 0, "DECL": 0, "UNKNOWN": 0}
                    )
                    for m in self._IDENT_RE.finditer(u):
                        n = m.group(1)
                        if n in _DART_KEYWORDS or n in self._DECL_LEAD:
                            continue
                        if n in self._NEVER_AN_IDENTIFIER:
                            continue
                        if set(n) == {"_"}:
                            continue   # `_`, `__` — the wildcard parameter
                        if n in self._LOWER_TYPE_LEAD or n in self._USE_LEAD:
                            continue
                        verdict = self._classify(u, m.start(1), n)
                        if verdict == "SKIP":
                            continue
                        tally[n][verdict] += 1
                    for n, t in tally.items():
                        if t["DECL"]:
                            declaring_units[n] += 1
                    per_unit.append((ua, ub, owner, tally))

                # ---- pass 2: report ---------------------------------------
                reported: Set[Tuple[str, int]] = set()
                for ua, ub, owner, tally in per_unit:
                    scope = set(top) | type_names
                    if owner is not None:
                        scope |= self._chain_members(owner, vis)
                    for n, t in sorted(tally.items()):
                        if t["USE"] < 1:
                            continue
                        if t["UNKNOWN"]:
                            self.abstained["scope-use-not-classifiable"] += 1
                            continue
                        self.examined["scope-identifier-uses"] += t["USE"]
                        if t["DECL"]:
                            continue
                        if n in scope or n in self._SDK_BARE_NAMES:
                            continue
                        self.examined["scope-uses-unresolved"] += 1
                        # The idiom gate: the file must itself prove, in OTHER
                        # units, that this name is one you have to declare.
                        if declaring_units.get(n, 0) < self._IDIOM_MIN_UNITS:
                            self.abstained["scope-not-a-local-idiom"] += 1
                            continue
                        if (n, ua) in reported:
                            continue
                        reported.add((n, ua))
                        where = f" of `{owner.name}`" if owner is not None else ""
                        self.add(
                            "SCOPE-UNDEF", lib.path,
                            line_of(lib.src, ua + next(
                                m.start(1)
                                for m in self._IDENT_RE.finditer(masked[ua:ub])
                                if m.group(1) == n
                            )),
                            f"`{n}` is used in this declaration{where} but is "
                            f"declared nowhere it can reach: not a local here, "
                            f"not a parameter, not a member of this type or of "
                            f"its in-tree supertypes, not a top-level "
                            f"declaration of this file or of anything it "
                            f"imports. {declaring_units.get(n, 0)} other "
                            f"declaration(s) in this same file DO declare `{n}` "
                            f"as a local — this one does not "
                            f"(`undefined_identifier`, a compile ERROR)",
                        )
                self.examined["scope-units"] += len(per_unit)

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
        self.check_scope()
        self.check_providers()
        self.check_types()
        self.check_duplicates()
        self.check_unused_imports()
        self.check_parts()
        # --- Phase E ---
        self.check_param_defaults()
        self.check_field_init()
        self.check_late_fields()
        self.check_switch_exhaustive()
        self.check_unused_private()
        self.check_unused_locals()
        self.check_unreachable()
        self.check_self_calls()
        self.check_self_members()
        self.check_override_signatures()
        self.check_implements()
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
