#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_l10n_parity.py — F2.

Arabic is this product's FIRST language (CONTEXT §1), so a missing Arabic
key is not a cosmetic defect: `translate()` falls back to the default
locale and, since F1 made the default Arabic, a missing ARABIC key is what
surfaces a raw key string to a child. F2 added ~60 new keys across two
locales and two layers, so this asserts they all landed.

Checks
------
1. Dart localization_engine.dart: AppLocale.en and AppLocale.ar declare
   exactly the same key set, with no duplicates inside either map.
2. Every localisation key referenced from Dart UI code as a string
   literal in a `t('...')` call exists in the resource maps.
3. Android res/values/strings.xml and res/values-ar/strings.xml declare
   the same <string>/<plurals> names.
4. Every @string/@xml/@plurals reference in AndroidManifest.xml and in
   res/xml/*.xml resolves to a declared resource.

Exit code 0 when every check passes.
"""

from __future__ import annotations

import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = ["apps/child-app", "apps/parent-app"]

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


KEY_RE = re.compile(r"^\s{4}'([^']+)':", re.M)


def check_dart_locales(app: str) -> set[str]:
    path = os.path.join(ROOT, app, "lib", "core", "localization", "localization_engine.dart")
    if not os.path.exists(path):
        fail(f"{app}: localization_engine.dart not found")
        return set()
    src = open(path, encoding="utf-8").read()
    i_en, i_ar = src.index("AppLocale.en: {"), src.index("AppLocale.ar: {")
    en_block = src[i_en:i_ar]
    ar_block = src[i_ar:src.index("\n};", i_ar)]
    en, ar = KEY_RE.findall(en_block), KEY_RE.findall(ar_block)

    for name, keys in (("en", en), ("ar", ar)):
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            fail(f"{app}: duplicate keys in AppLocale.{name}: {dupes}")
    missing_ar = sorted(set(en) - set(ar))
    missing_en = sorted(set(ar) - set(en))
    if missing_ar:
        fail(f"{app}: keys missing from Arabic: {missing_ar}")
    if missing_en:
        fail(f"{app}: keys missing from English: {missing_en}")
    if not (missing_ar or missing_en):
        ok(f"{app}: dart locale parity {len(set(en))}/{len(set(ar))} keys")
    return set(en) | set(ar)


T_CALL_RE = re.compile(r"\bt\(\s*'([a-zA-Z][\w.]*)'")


def check_dart_usage(app: str, declared: set[str]) -> None:
    lib = os.path.join(ROOT, app, "lib")
    unknown: list[tuple[str, str]] = []
    used = 0
    for dirpath, _dirs, files in os.walk(lib):
        for name in files:
            if not name.endswith(".dart"):
                continue
            path = os.path.join(dirpath, name)
            src = open(path, encoding="utf-8").read()
            for key in T_CALL_RE.findall(src):
                used += 1
                if key not in declared:
                    unknown.append((os.path.relpath(path, ROOT), key))
    for path, key in unknown:
        fail(f"{app}: t('{key}') in {path} has no resource in either locale")
    if not unknown:
        ok(f"{app}: {used} t('...') literal call sites all resolve")


def android_strings(path: str) -> set[str]:
    if not os.path.exists(path):
        return set()
    root = ET.parse(path).getroot()
    return {
        el.get("name")
        for el in root
        if el.tag in ("string", "plurals") and el.get("name")
    }


def check_android(app: str) -> None:
    res = os.path.join(ROOT, app, "android", "app", "src", "main", "res")
    default = android_strings(os.path.join(res, "values", "strings.xml"))
    arabic = android_strings(os.path.join(res, "values-ar", "strings.xml"))
    if not default:
        fail(f"{app}: no res/values/strings.xml")
        return
    if default != arabic:
        fail(f"{app}: values vs values-ar mismatch: only-default={sorted(default - arabic)} only-ar={sorted(arabic - default)}")
    else:
        ok(f"{app}: android strings parity {len(default)}/{len(arabic)}")

    # every @string / @plurals / @xml reference resolves
    xml_files = [os.path.join(ROOT, app, "android", "app", "src", "main", "AndroidManifest.xml")]
    xml_dir = os.path.join(res, "xml")
    if os.path.isdir(xml_dir):
        xml_files += [os.path.join(xml_dir, f) for f in sorted(os.listdir(xml_dir)) if f.endswith(".xml")]

    available_xml = {
        os.path.splitext(f)[0] for f in os.listdir(xml_dir)
    } if os.path.isdir(xml_dir) else set()
    # debug-variant resources are legitimate targets too
    debug_xml_dir = os.path.join(ROOT, app, "android", "app", "src", "debug", "res", "xml")
    if os.path.isdir(debug_xml_dir):
        available_xml |= {os.path.splitext(f)[0] for f in os.listdir(debug_xml_dir)}

    bad = []
    for path in xml_files:
        src = open(path, encoding="utf-8").read()
        # strip comments so prose examples are not treated as references
        src = re.sub(r"<!--[\s\S]*?-->", "", src)
        for kind, name in re.findall(r'"@(string|plurals|xml)/([\w.]+)"', src):
            pool = default if kind in ("string", "plurals") else available_xml
            if name not in pool:
                bad.append((os.path.relpath(path, ROOT), f"@{kind}/{name}"))
    for path, ref in bad:
        fail(f"{app}: unresolved {ref} in {path}")
    if not bad:
        ok(f"{app}: every @string/@plurals/@xml reference resolves")


if __name__ == "__main__":
    for app in APPS:
        print(f"\n=== {app} ===")
        declared = check_dart_locales(app)
        check_dart_usage(app, declared)
        check_android(app)
    print(f"\nTOTAL PROBLEMS: {len(problems)}")
    sys.exit(1 if problems else 0)
