#!/usr/bin/env python3
"""
dart_static_model.py — a structural model of a Dart source tree, built without
a Dart SDK.

WHY THIS EXISTS
---------------
This repository has never been through `flutter analyze`. There is no Flutter
SDK in the execution environment and pub.dev / dl.google.com / storage.
googleapis.com all answer `403` to `CONNECT`, so one cannot be installed.
The first real analyzer run will therefore happen on a GitHub runner, and
every error it reports costs a full CI round-trip.

This module is NOT an analyzer and does not pretend to be one. It is a
deliberately conservative *masker + brace-matching structural scanner* that
recovers enough of the program's shape — libraries, classes, mixins, enums,
extensions, their supertypes, their members, their constructors and those
constructors' parameter lists — for a family of high-precision checks to be
written on top of it (see dart_preflight.py).

DESIGN RULE THAT GOVERNS EVERY LINE BELOW
-----------------------------------------
When the model cannot decide something, it must record "unknown", never
"absent". A checker that reports noise is worse than no checker at all,
because the reader stops trusting the output. Every consumer of this model
is expected to bail out on `unknown` rather than report.

WHAT IS DELIBERATELY NOT MODELLED
---------------------------------
Type inference, generics substitution, extension-method resolution, mixin
member linearisation order, `late` initialisation, control flow, const
evaluation. Anything needing those is out of scope by construction.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------------------
# 1. MASKING
#
# Every downstream regex runs against a *masked* copy of the source in which
# comment bodies and string-literal bodies have been replaced by spaces, with
# byte offsets preserved exactly. That makes `Foo(` inside a doc comment or an
# Arabic UI string invisible to the scanners, which is the single largest
# source of false positives in naive Dart regex tooling.
#
# String interpolation is an exception and is handled on purpose: the contents
# of `${...}` and the identifier of `$name` are real executable code and are
# left intact, because a typo'd symbol inside an interpolation is a real
# compile error that we want to catch.
# ---------------------------------------------------------------------------


def mask_source(src: str) -> str:
    """Return `src` with comment and string bodies blanked, offsets preserved."""
    out = list(src)
    n = len(src)
    i = 0

    def blank(a: int, b: int) -> None:
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]

        # ---- line comment -------------------------------------------------
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j == -1 else j
            blank(i, j)
            i = j
            continue

        # ---- block comment (Dart nests them) ------------------------------
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            depth = 1
            j = i + 2
            while j < n and depth:
                if src.startswith("/*", j):
                    depth += 1
                    j += 2
                elif src.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            blank(i, j)
            i = j
            continue

        # ---- string literal ------------------------------------------------
        if c in "'\"" or (c == "r" and i + 1 < n and src[i + 1] in "'\""):
            raw = c == "r"
            q_at = i + 1 if raw else i
            quote = src[q_at]
            triple = src.startswith(quote * 3, q_at)
            term = quote * 3 if triple else quote
            j = q_at + len(term)
            body_start = j
            while j < n:
                ch = src[j]
                if not raw and ch == "\\":
                    j += 2
                    continue
                if not raw and ch == "$" and j + 1 < n:
                    # interpolation — blank the literal text seen so far, then
                    # step over the interpolated expression leaving it intact.
                    blank(body_start, j)
                    out[j] = " "  # the '$' itself is not an identifier char
                    if src[j + 1] == "{":
                        depth = 1
                        k = j + 2
                        while k < n and depth:
                            if src[k] == "{":
                                depth += 1
                            elif src[k] == "}":
                                depth -= 1
                            k += 1
                        # blank only the braces, keep the expression
                        out[j + 1] = " "
                        if k - 1 < n and src[k - 1] == "}":
                            out[k - 1] = " "
                        j = k
                    else:
                        k = j + 1
                        while k < n and (src[k].isalnum() or src[k] == "_"):
                            k += 1
                        j = k
                    body_start = j
                    continue
                if src.startswith(term, j):
                    blank(body_start, j)
                    j += len(term)
                    break
                if ch == "\n" and not triple:
                    # unterminated single-line string; give up on this literal
                    blank(body_start, j)
                    break
                j += 1
            else:
                blank(body_start, n)
            i = j
            continue

        i += 1

    return "".join(out)


# ---------------------------------------------------------------------------
# 2. BALANCED-SPAN HELPERS
# ---------------------------------------------------------------------------

_OPEN = {"(": ")", "[": "]", "{": "}", "<": ">"}


def match_bracket(masked: str, start: int) -> int:
    """Index just past the bracket that opens at `start`. -1 if unbalanced."""
    open_ch = masked[start]
    close_ch = _OPEN[open_ch]
    depth = 0
    i = start
    n = len(masked)
    while i < n:
        ch = masked[i]
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def split_top_level(text: str, sep: str = ",") -> List[str]:
    """Split on `sep` ignoring anything nested in (), [], {} or <>.

    ANGLE BRACKETS ARE THE HARD PART and getting them wrong is how a naive
    splitter shreds every Flutter argument list in the repository. `>` is far
    more often a comparison, an arrow (`=>`), or `>=` than the close of a type
    argument list. The rule used here:

      * `<` opens a type-argument list only when the previous non-space
        character is an identifier character or `>` — i.e. `List<`, `Map<`,
        `List<List<`  — never `a < b`.
      * `>` closes one only when an angle context is actually open and the
        character before it is not `=` or `-`.

    Anything else is treated as ordinary text. Erring towards "not a bracket"
    keeps depth from going negative, which is what produced the shredding.
    """
    parts: List[str] = []
    depth = 0
    angle = 0
    buf: List[str] = []
    prev = ""
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "<":
            if prev and (prev.isalnum() or prev in "_>"):
                angle += 1
        elif ch == ">":
            if angle > 0 and prev not in ("=", "-"):
                angle -= 1
        if ch == sep and depth == 0 and angle == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        if not ch.isspace():
            prev = ch
    tail = "".join(buf)
    if tail.strip():
        parts.append(tail)
    return [p.strip() for p in parts if p.strip()]


def line_of(src: str, offset: int) -> int:
    return src.count("\n", 0, offset) + 1


# ---------------------------------------------------------------------------
# 3. MODEL TYPES
# ---------------------------------------------------------------------------


@dataclass
class Param:
    name: str
    type: str
    named: bool
    required: bool
    is_super: bool = False
    has_default: bool = False
    # Whether the `required` KEYWORD was literally written. `required` is
    # cleared by `has_default` below, because for well-formed code a named
    # parameter with a default is not required — but `required x = v` is
    # exactly the malformed shape PARAM-DEFAULT exists to catch, and folding
    # the two flags into one made that shape undetectable.
    explicit_required: bool = False


@dataclass
class Ctor:
    owner: str
    name: str            # "" for the unnamed constructor
    params: List[Param]
    is_factory: bool
    redirects: bool      # `: this(...)` / `= Other;` — parameters not authoritative
    line: int
    unparsed: bool = False   # parameter list could not be parsed -> do not check
    decl_offset: int = -1    # absolute offset of the declaration in the file


@dataclass
class Member:
    name: str
    kind: str            # method | getter | setter | field
    is_static: bool
    is_override: bool
    line: int
    params: Optional[List[Param]] = None
    unparsed: bool = False
    type: str = ""     # declared type of a field, "" when not recoverable


@dataclass
class TypeDecl:
    name: str
    kind: str            # class | mixin | enum | extension | typedef
    file: str
    line: int
    is_abstract: bool
    supertypes: List[str] = field(default_factory=list)  # extends/with/implements/on
    # The SAME names, kept apart by clause. `implements` obliges a class to
    # DECLARE every member; `extends`/`with` let it INHERIT them. A checker
    # that cannot tell the two apart cannot decide either question, which is
    # why the flat list above is not enough on its own.
    rel: Dict[str, List[str]] = field(default_factory=dict)
    members: Dict[str, Member] = field(default_factory=dict)
    ctors: Dict[str, Ctor] = field(default_factory=dict)
    enum_values: List[str] = field(default_factory=list)
    body_span: Tuple[int, int] = (0, 0)


@dataclass
class Library:
    """One .dart file plus everything the scanner recovered from it."""
    path: str
    app: str
    src: str
    masked: str
    imports: List[Tuple[str, int, Optional[str], List[str], List[str]]] = field(
        default_factory=list
    )  # (uri, line, prefix, show, hide)
    # `export` is deliberately a SEPARATE list: an `export` directive does not
    # bring any name into the exporting library's own scope, so folding it into
    # `imports` made every barrel file look like it had a dozen unused imports.
    exports: List[Tuple[str, int]] = field(default_factory=list)
    parts: List[str] = field(default_factory=list)
    part_of: Optional[str] = None
    types: Dict[str, TypeDecl] = field(default_factory=dict)
    top_functions: Dict[str, int] = field(default_factory=dict)
    top_vars: Dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 4. PARAMETER-LIST PARSING
#
# Returns (params, ok). `ok=False` means "I could not confidently parse this",
# and every checker must treat that as unknown and stay silent.
# ---------------------------------------------------------------------------

_PARAM_NAME_RE = re.compile(r"(?:^|[\s\>\?\]])([A-Za-z_]\w*)\s*$")


def parse_params(sig: str) -> Tuple[List[Param], bool]:
    """`sig` is the text BETWEEN the outer parentheses of a parameter list."""
    sig = sig.strip()
    if not sig:
        return [], True

    params: List[Param] = []

    # Peel the optional/named group. Dart allows exactly one such group and it
    # is always last: f(a, {b, c}) or f(a, [b, c]).
    group_open = -1
    depth = 0
    for i, ch in enumerate(sig):
        if ch in "(<[":
            depth += 1
        elif ch in ")>]":
            depth -= 1
        if depth == 0 and ch in "{[" and group_open == -1:
            group_open = i
            break
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1

    # simpler + safer: scan at depth 0 only
    group_open = -1
    depth = 0
    for i, ch in enumerate(sig):
        if ch in "([{<":
            if depth == 0 and ch in "[{":
                group_open = i
                break
            depth += 1
        elif ch in ")]}>":
            depth -= 1

    if group_open >= 0:
        opener = sig[group_open]
        closer = "}" if opener == "{" else "]"
        end = sig.rfind(closer)
        if end < group_open:
            return [], False
        positional_text = sig[:group_open].rstrip().rstrip(",")
        group_text = sig[group_open + 1 : end]
        named = opener == "{"
    else:
        positional_text = sig
        group_text = ""
        named = False

    def one(decl: str, is_named: bool) -> Optional[Param]:
        decl = decl.strip()
        if not decl:
            return None
        required = is_named is False
        explicit_required = False
        if decl.startswith("required "):
            required = True
            explicit_required = True
            decl = decl[len("required ") :].strip()
        has_default = False
        for d in ("=", ":"):
            # `:` as a default separator is legacy but still legal
            idx = -1
            dep = 0
            for i, ch in enumerate(decl):
                if ch in "([{<":
                    dep += 1
                elif ch in ")]}>":
                    dep -= 1
                elif ch == d and dep == 0:
                    if d == "=" and i + 1 < len(decl) and decl[i + 1] == ">":
                        continue
                    idx = i
                    break
            if idx > 0:
                decl = decl[:idx].strip()
                has_default = True
                if is_named:
                    required = False
                break
        # function-typed parameter: `void Function(int) cb` or `void cb(int x)`
        is_super = False
        if decl.startswith("this."):
            name = decl[5:].strip().split()[0]
            return Param(name, "", is_named, required and is_named, False,
                         has_default, explicit_required)
        if decl.startswith("super."):
            is_super = True
            name = decl[6:].strip().split()[0]
            return Param(name, "", is_named, required and is_named, True,
                         has_default, explicit_required)
        # Three shapes have to be told apart, and conflating them is how the
        # first version of this parser decided that
        # `void Function()? onSessionExpired` declared a named parameter
        # called `Function`:
        #
        #   A.  `Dio? dio`                              -> name is last ident
        #   B.  `void cb(int x)`  (old-style fn param)  -> name is before '('
        #   C.  `void Function(int)? cb`                -> name is AFTER ')'
        dep = 0
        first_open = -1
        last_close = -1
        for i, ch in enumerate(decl):
            if ch == "(":
                if dep == 0 and first_open == -1:
                    first_open = i
                dep += 1
            elif ch == ")":
                dep -= 1
                if dep == 0:
                    last_close = i

        if last_close != -1:
            tail_raw = decl[last_close + 1 :].strip()
            # The `?` between the `)` and the parameter name is the NULLABILITY
            # of the function type and it belongs to the TYPE, not to the name.
            # Dropping it (the first version did) made
            # `Future<X> Function()? cb` look like a non-nullable parameter, and
            # every checker that reasons about nullability then reasoned about
            # the opposite of what was written.
            fn_nullable = tail_raw.startswith("?")
            tail = tail_raw.lstrip("?").strip()
            tm = re.fullmatch(r"[A-Za-z_]\w*", tail)
            if tm:                                  # shape C
                name = tail
                type_text = decl[: last_close + 1].strip() + ("?" if fn_nullable else "")
                return Param(
                    name, type_text, is_named,
                    (required and is_named) or (not is_named and not has_default),
                    is_super, has_default, explicit_required,
                )
            head = decl[:first_open].strip()        # shape B
        else:
            head = decl.strip()                     # shape A

        m = _PARAM_NAME_RE.search(head)
        if not m:
            # e.g. bare `int` positional with no name — legal only in typedefs
            return None
        name = m.group(1)
        type_text = head[: m.start(1)].strip()
        return Param(
            name,
            type_text,
            is_named,
            (required and is_named) or (not is_named and not has_default),
            is_super,
            has_default,
            explicit_required,
        )

    for decl in split_top_level(positional_text):
        p = one(decl, False)
        if p is None:
            if decl.strip():
                return [], False
            continue
        p.named = False
        params.append(p)

    for decl in split_top_level(group_text):
        p = one(decl, named)
        if p is None:
            if decl.strip():
                return [], False
            continue
        p.named = named
        if not named:
            p.required = False  # optional positional
        params.append(p)

    return params, True


# ---------------------------------------------------------------------------
# 5. FILE SCANNER
# ---------------------------------------------------------------------------

_IMPORT_RE = re.compile(
    r"^\s*(?P<kind>import|export|part)\s+(?P<q>['\"])(?P<uri>[^'\"]+)(?P=q)"
    r"(?P<rest>[^;]*);",
    re.M,
)
_PART_OF_RE = re.compile(
    r"^\s*part\s+of\s+(?:(['\"])(?P<uri>[^'\"]+)\1|(?P<lib>[\w.]+))\s*;", re.M
)

_TYPE_RE = re.compile(
    r"^(?P<mods>(?:@\w+\s+)*(?:abstract\s+|final\s+|base\s+|interface\s+|sealed\s+)*)"
    r"(?P<kind>class|mixin\s+class|mixin|enum|extension\s+type|extension)\s+"
    r"(?P<name>[A-Za-z_]\w*)",
    re.M,
)
# A TOP-LEVEL declaration starts in column 0. Both patterns below use
# HORIZONTAL whitespace only ([ \t]) in their optional type prefix — `\s`
# matches newlines, which let `^(?:[\w\s...]+?\s+)?name\(` start at a blank
# line and reach an INDENTED `Foo(` several lines down. The effect was
# silent and expensive: every widget constructed inside a `main()` body was
# recorded as a top-level function, those names then counted as local
# shadowing, and the constructor checks abstained on 56 real call sites
# instead of checking them.
_TOP_FN_RE = re.compile(
    r"^(?![ \t])(?:[\w<>,\?\[\]\. \t]+?[ \t]+)?"
    r"(?P<name>[a-zA-Z_]\w*)[ \t]*(?:<[^(){};\n]*>)?\(",
    re.M,
)
_TOP_VAR_RE = re.compile(
    r"^(?:const|final|late[ \t]+final|late|var)[ \t]+"
    r"(?:[\w<>,\?\[\]\. \t]+[ \t]+)?"
    r"(?P<name>[a-zA-Z_]\w*)[ \t]*(?:=|;)",
    re.M,
)

_SKIP_DIRS = {"build", ".dart_tool", ".git", "ephemeral"}


def dart_files(root: str) -> List[str]:
    out: List[str] = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            if f.endswith(".dart"):
                out.append(os.path.join(base, f))
    return sorted(out)


def _member_kind_and_name(decl: str) -> Optional[Tuple[str, str, bool, bool]]:
    """(kind, name, is_static, is_override) from a member header, or None."""
    is_override = "@override" in decl
    decl = re.sub(r"@\w+(?:\([^)]*\))?", " ", decl)
    is_static = bool(re.search(r"\bstatic\b", decl))
    body = re.sub(
        r"\b(static|external|abstract|covariant)\b", " ", decl
    ).strip()
    m = re.match(r"^(?:final\s+|const\s+|late\s+)*(?:.*?\s+)?get\s+([A-Za-z_]\w*)", body)
    if m and re.search(r"\bget\s+" + m.group(1) + r"\b", body):
        return ("getter", m.group(1), is_static, is_override)
    m = re.match(r"^(?:.*?\s+)?set\s+([A-Za-z_]\w*)\s*\(", body)
    if m:
        return ("setter", m.group(1), is_static, is_override)
    return None


def scan_file(path: str, app: str) -> Library:
    src = open(path, encoding="utf-8", errors="replace").read()
    masked = mask_source(src)
    lib = Library(path=path, app=app, src=src, masked=masked)

    # Directives are matched against the RAW source, because the masker blanks
    # string bodies and the URI *is* a string body. A match is only accepted if
    # its leading keyword survived masking — that is what proves the directive
    # is real code and not text inside a comment or another string.
    for m in _IMPORT_RE.finditer(src):
        if masked[m.start() : m.end()].lstrip()[: len(m.group("kind"))] != m.group("kind"):
            continue
        kind = m.group("kind")
        uri = m.group("uri")
        if kind == "part":
            lib.parts.append(uri)
            continue
        if kind == "export":
            lib.exports.append((uri, line_of(src, m.start())))
            continue
        rest = m.group("rest") or ""
        pm = re.search(r"\bas\s+([A-Za-z_]\w*)", rest)
        show = re.findall(r"\bshow\s+([\w,\s]+)", rest)
        hide = re.findall(r"\bhide\s+([\w,\s]+)", rest)
        lib.imports.append(
            (
                uri,
                line_of(src, m.start()),
                pm.group(1) if pm else None,
                [s.strip() for grp in show for s in grp.split(",") if s.strip()],
                [s.strip() for grp in hide for s in grp.split(",") if s.strip()],
            )
        )
    po = _PART_OF_RE.search(src)
    if po and masked[po.start() : po.end()].lstrip().startswith("part"):
        lib.part_of = po.group("uri") or po.group("lib")

    # --- type declarations ---------------------------------------------------
    for m in _TYPE_RE.finditer(masked):
        # a `class` keyword nested inside a body is not a top-level decl; the
        # ^-anchor of _TYPE_RE already enforces column 0, which in this tree is
        # true of every top-level declaration.
        name = m.group("name")
        kind = m.group("kind").split()[0]
        brace = masked.find("{", m.end())
        semi = masked.find(";", m.end())
        if brace == -1 or (semi != -1 and semi < brace):
            # `class A = B with C;` (mixin application) — no body
            header = masked[m.end() : semi if semi != -1 else m.end()]
            decl = TypeDecl(
                name=name,
                kind=kind,
                file=path,
                line=line_of(src, m.start()),
                is_abstract="abstract" in m.group("mods"),
                supertypes=_supertypes(header),
                rel=_supertype_rel(header),
            )
            lib.types[name] = decl
            continue
        header = masked[m.end() : brace]
        end = match_bracket(masked, brace)
        if end == -1:
            continue
        decl = TypeDecl(
            name=name,
            kind=kind,
            file=path,
            line=line_of(src, m.start()),
            is_abstract="abstract" in m.group("mods"),
            supertypes=_supertypes(header),
            rel=_supertype_rel(header),
            body_span=(brace + 1, end - 1),
        )
        _scan_body(decl, src, masked, brace + 1, end - 1)
        lib.types[name] = decl

    # --- top-level functions and variables ------------------------------------
    # Only scan the regions of the file that are NOT inside a type body.
    spans = sorted(t.body_span for t in lib.types.values() if t.body_span != (0, 0))

    def outside(off: int) -> bool:
        return not any(a <= off < b for a, b in spans)

    for m in _TOP_FN_RE.finditer(masked):
        if not outside(m.start()):
            continue
        nm = m.group("name")
        if nm in {"if", "for", "while", "switch", "catch", "return", "assert"}:
            continue
        if nm in lib.types:
            continue
        lib.top_functions.setdefault(nm, line_of(src, m.start()))
    for m in _TOP_VAR_RE.finditer(masked):
        if not outside(m.start()):
            continue
        lib.top_vars.setdefault(m.group("name"), line_of(src, m.start()))

    return lib


def _cut_at_top_level_assign(seg: str) -> str:
    """Everything before the first depth-0 `=` that is a real assignment.

    `==`, `=>`, `>=`, `<=`, `!=` are not assignments and must not cut.
    """
    depth = 0
    for i, ch in enumerate(seg):
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1
        elif ch == "=" and depth <= 0:
            nxt = seg[i + 1] if i + 1 < len(seg) else ""
            prv = seg[i - 1] if i else ""
            if nxt in ("=", ">") or prv in ("=", "!", "<", ">"):
                continue
            return seg[:i]
    return seg


def _supertypes(header: str) -> List[str]:
    return [n for names in _supertype_rel(header).values() for n in names]


def _supertype_rel(header: str) -> Dict[str, List[str]]:
    """Supertype names grouped by the clause that introduced them."""
    out: Dict[str, List[str]] = {}
    for kw in ("extends", "with", "implements", "on"):
        m = re.search(r"\b" + kw + r"\s+([^{]*?)(?=\bextends\b|\bwith\b|\bimplements\b|\bon\b|$)", header)
        if m:
            for t in split_top_level(m.group(1)):
                base = re.match(r"([A-Za-z_]\w*)", t.strip())
                if base:
                    out.setdefault(kw, []).append(base.group(1))
    return out


_CTOR_RE_TMPL = r"(?P<pre>(?:const\s+|factory\s+|external\s+)*)\b{cls}\b(?:\s*\.\s*(?P<cname>[A-Za-z_]\w*))?\s*\("


def _scan_body(decl: TypeDecl, src: str, masked: str, start: int, end: int) -> None:
    body = masked[start:end]

    if decl.kind == "enum":
        # Enum values run from the start of the body to the first ';' at depth 0
        # (or to the end of the body if the enum has no members).
        depth = 0
        cut = len(body)
        for i, ch in enumerate(body):
            if ch in "([{<":
                depth += 1
            elif ch in ")]}>":
                depth -= 1
            elif ch == ";" and depth == 0:
                cut = i
                break
        for entry in split_top_level(body[:cut]):
            m = re.match(r"([A-Za-z_]\w*)", entry.strip())
            if m:
                decl.enum_values.append(m.group(1))
        body = body[cut + 1 :] if cut < len(body) else ""
        start = start + cut + 1

    # --- constructors ---------------------------------------------------------
    for m in re.finditer(_CTOR_RE_TMPL.format(cls=re.escape(decl.name)), body):
        # Must be a DECLARATION, not an invocation. A member declaration is
        # always preceded (ignoring whitespace) by ';', '{' or '}', or by the
        # start of the body. `const Foo()` inside a method body is preceded by
        # something else — that distinction is the whole check, and skipping it
        # for `const`/`factory` was a real bug: a static helper containing
        # `=> const OemSetupScreen()` overwrote the real constructor's
        # parameter list with an empty one.
        j = m.start()
        k = j - 1
        while k >= 0 and body[k] in " \t\n":
            k -= 1
        if k >= 0 and body[k] not in ";{}":
            continue
        popen = body.index("(", m.start())
        pend = match_bracket(body, popen)
        if pend == -1:
            continue
        params, ok = parse_params(body[popen + 1 : pend - 1])
        tail = body[pend : pend + 400]
        redirects = bool(re.match(r"\s*(?::[^;{]*\bthis\b|=\s*[A-Za-z_])", tail))
        cname = m.group("cname") or ""
        if cname in decl.ctors:
            continue
        decl.ctors[cname] = Ctor(
            owner=decl.name,
            name=cname,
            params=params,
            is_factory="factory" in m.group("pre"),
            redirects=redirects,
            line=line_of(src, start + m.start()),
            unparsed=not ok,
            decl_offset=start + m.start(),
        )

    # --- members --------------------------------------------------------------
    # Walk the body at depth 0, cutting on ';' and on the end of a '{...}' body.
    depth = 0
    seg_start = 0
    i = 0
    n = len(body)
    segments: List[Tuple[int, str]] = []
    while i < n:
        ch = body[i]
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        elif ch == "{":
            if depth == 0:
                # method body (or a `=> {...}` map literal — accepted as noise)
                close = match_bracket(body, i)
                if close == -1:
                    break
                segments.append((seg_start, body[seg_start:i]))
                i = close
                seg_start = i
                continue
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == ";" and depth == 0:
            segments.append((seg_start, body[seg_start:i]))
            i += 1
            seg_start = i
            continue
        i += 1
    if seg_start < n and body[seg_start:].strip():
        segments.append((seg_start, body[seg_start:]))

    for off, seg in segments:
        s = seg.strip()
        if not s:
            continue
        line = line_of(src, start + off + (len(seg) - len(seg.lstrip())))
        gs = _member_kind_and_name(s)
        if gs:
            kind, name, is_static, is_ovr = gs
            decl.members.setdefault(
                name, Member(name, kind, is_static, is_ovr, line)
            )
            continue
        # Cut the initialiser off FIRST. Without this,
        # `static const SizedBox gapSm = SizedBox(height: sm);`
        # was read as a *method* named `SizedBox`, and the real field `gapSm`
        # was never recorded — which made every `DsSpace.gapSm` in the app
        # look like a reference to an undeclared member. That single mistake
        # produced 300+ false positives; it is the reason this cut exists.
        shape = _cut_at_top_level_assign(s)

        # method?  `<ret> name(<params>)` possibly with `async`, `=>` cut off
        mm = re.search(
            r"(?:^|[\s\>\?\]])(?P<name>[A-Za-z_]\w*)\s*(?:<[^()<>]*>)?\s*\((?P<rest>.*)$",
            shape,
            re.S,
        )
        if mm and mm.group("name") != decl.name:
            s = shape
            popen = s.index("(", mm.start("name"))
            pend = match_bracket(s, popen)
            if pend != -1:
                params, ok = parse_params(s[popen + 1 : pend - 1])
                is_ovr = "@override" in s
                is_static = bool(re.search(r"\bstatic\b", s))
                decl.members.setdefault(
                    mm.group("name"),
                    Member(
                        mm.group("name"),
                        "method",
                        is_static,
                        is_ovr,
                        line,
                        params,
                        not ok,
                    ),
                )
                continue
        # field(s)
        head = re.sub(r"@\w+(?:\([^)]*\))?", " ", shape)
        head = re.sub(r"\b(static|final|const|late|covariant|var)\b", " ", head)
        eq = head.find("=")
        if eq != -1:
            head = head[:eq]
        fm = re.search(r"([A-Za-z_]\w*)\s*$", head.strip())
        if fm:
            fname = fm.group(1)
            ftype = head.strip()[: fm.start(1)].strip()
            decl.members.setdefault(
                fname,
                Member(
                    fname, "field", "static" in s, "@override" in s, line,
                    type=ftype,
                ),
            )


# ---------------------------------------------------------------------------
# 6. WORKSPACE
# ---------------------------------------------------------------------------


@dataclass
class App:
    name: str          # pubspec `name:`
    root: str
    deps: Set[str]
    dev_deps: Set[str]
    libs: Dict[str, Library] = field(default_factory=dict)


class Workspace:
    def __init__(self, app_roots: List[str]):
        self.apps: Dict[str, App] = {}
        for root in app_roots:
            name, deps, dev = _read_pubspec(os.path.join(root, "pubspec.yaml"))
            app = App(name=name, root=root, deps=deps, dev_deps=dev)
            for p in dart_files(root):
                app.libs[p] = scan_file(p, name)
            self.apps[name] = app

    # -- lookups -----------------------------------------------------------
    def types_of(self, app: App) -> Dict[str, List[TypeDecl]]:
        out: Dict[str, List[TypeDecl]] = {}
        for lib in app.libs.values():
            for t in lib.types.values():
                out.setdefault(t.name, []).append(t)
        return out

    def all_libs(self) -> List[Library]:
        return [l for a in self.apps.values() for l in a.libs.values()]


def _read_pubspec(path: str) -> Tuple[str, Set[str], Set[str]]:
    name = ""
    deps: Set[str] = set()
    dev: Set[str] = set()
    section = None
    for raw in open(path, encoding="utf-8").read().splitlines():
        if raw.startswith("name:"):
            name = raw.split(":", 1)[1].strip()
        if re.match(r"^[a-z_]+:", raw):
            key = raw.split(":", 1)[0]
            section = key if key in ("dependencies", "dev_dependencies") else None
            continue
        if section and re.match(r"^  [A-Za-z_]", raw):
            dep = raw.strip().split(":", 1)[0]
            (deps if section == "dependencies" else dev).add(dep)
    return name, deps, dev


def find_app_roots(repo: str) -> List[str]:
    roots = []
    for base, dirs, files in os.walk(os.path.join(repo, "apps")):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        if "pubspec.yaml" in files:
            roots.append(base)
            dirs[:] = []
    return sorted(roots)
