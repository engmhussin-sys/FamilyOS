#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_network_security.py — F2, audit MA-004.

MA-004 is the defect that made the difference between "the APK installs"
and "the APK works": since API 28 Android denies cleartext HTTP, and both
apps default to http://10.0.2.2:3000, so every API call in a debug build
failed before this sprint.

The fix spans four files per app that MUST agree with each other. Nothing
in the toolchain checks that agreement, and the failure mode is silent at
build time and total at runtime. Hence this script.

Per app it asserts:
  1. src/main/res/xml/network_security_config.xml exists and permits NO
     cleartext anywhere (this is the file that ships).
  2. src/debug/res/xml/network_security_config.xml exists, keeps its
     base-config cleartext-denied, and permits cleartext ONLY for the
     agreed local development hosts.
  3. AndroidManifest.xml wires android:networkSecurityConfig and sets
     android:usesCleartextTraffic="false".
  4. AppConfig.cleartextDevHosts (Dart) is EXACTLY the domain list in the
     debug XML — a mismatch here is MA-004 all over again, one layer up.
  5. The app's own default base URL resolves to a permitted host.

And repo-wide:
  6. Every `flutter build apk|appbundle` invocation in .github/workflows passes
     --dart-define=API_BASE_URL.

Exit code 0 when every check passes.
"""

from __future__ import annotations

import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = ["apps/child-app", "apps/parent-app"]

EXPECTED_DEV_HOSTS = {
    "10.0.2.2",       # Android emulator -> host loopback
    "10.0.3.2",       # Genymotion -> host loopback
    "127.0.0.1",      # `adb reverse tcp:3000 tcp:3000` on a real device
    "localhost",
    "abny-dev.local", # documented, editable per-developer LAN entry
}

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def parse(path: str):
    return ET.parse(path).getroot()


def cleartext(node) -> str | None:
    return node.get("cleartextTrafficPermitted")


def check_app(app: str) -> None:
    print(f"\n=== {app} ===")
    android = os.path.join(ROOT, app, "android", "app", "src")
    main_xml = os.path.join(android, "main", "res", "xml", "network_security_config.xml")
    debug_xml = os.path.join(android, "debug", "res", "xml", "network_security_config.xml")
    manifest = os.path.join(android, "main", "AndroidManifest.xml")
    app_config = os.path.join(ROOT, app, "lib", "core", "config", "app_config.dart")

    # --- 1. production config -------------------------------------------
    if not os.path.exists(main_xml):
        fail(f"{app}: missing src/main/res/xml/network_security_config.xml")
        return
    root = parse(main_xml)
    base = root.find("base-config")
    if base is None or cleartext(base) != "false":
        fail(f"{app}: production base-config must set cleartextTrafficPermitted=\"false\"")
    else:
        ok(f"{app}: production base-config denies cleartext")
    if root.findall("domain-config"):
        fail(f"{app}: production config must contain NO domain-config exceptions")
    else:
        ok(f"{app}: production config has zero cleartext exceptions")
    anchors = base.find("trust-anchors") if base is not None else None
    srcs = {c.get("src") for c in anchors.findall("certificates")} if anchors is not None else set()
    if "user" in srcs:
        fail(f"{app}: production config must not trust user-added CAs")
    else:
        ok(f"{app}: production config trusts system CAs only ({sorted(srcs)})")

    # --- 2. debug config -------------------------------------------------
    if not os.path.exists(debug_xml):
        fail(f"{app}: missing src/debug/res/xml/network_security_config.xml — debug APK cannot reach a dev backend")
        return
    droot = parse(debug_xml)
    dbase = droot.find("base-config")
    if dbase is None or cleartext(dbase) != "false":
        fail(f"{app}: debug base-config must still deny cleartext by default")
    else:
        ok(f"{app}: debug base-config denies cleartext by default")

    hosts: set[str] = set()
    for dc in droot.findall("domain-config"):
        if cleartext(dc) != "true":
            continue
        for domain in dc.findall("domain"):
            hosts.add((domain.text or "").strip())
    if hosts != EXPECTED_DEV_HOSTS:
        fail(f"{app}: debug cleartext hosts {sorted(hosts)} != expected {sorted(EXPECTED_DEV_HOSTS)}")
    else:
        ok(f"{app}: debug cleartext hosts == {sorted(hosts)}")

    # --- 3. manifest wiring ----------------------------------------------
    m = open(manifest, encoding="utf-8").read()
    if 'android:networkSecurityConfig="@xml/network_security_config"' not in m:
        fail(f"{app}: AndroidManifest does not reference @xml/network_security_config")
    else:
        ok(f"{app}: manifest references @xml/network_security_config")
    if 'android:usesCleartextTraffic="false"' not in m:
        fail(f"{app}: AndroidManifest does not set usesCleartextTraffic=\"false\"")
    else:
        ok(f"{app}: manifest sets usesCleartextTraffic=\"false\"")

    # --- 4/5. Dart side agrees -------------------------------------------
    dart = open(app_config, encoding="utf-8").read()
    block = re.search(r"cleartextDevHosts\s*=\s*<String>\[(.*?)\];", dart, re.S)
    if not block:
        fail(f"{app}: AppConfig.cleartextDevHosts not found")
    else:
        dart_hosts = set(re.findall(r"'([^']+)'", block.group(1)))
        if dart_hosts != EXPECTED_DEV_HOSTS:
            fail(f"{app}: AppConfig.cleartextDevHosts {sorted(dart_hosts)} != XML {sorted(EXPECTED_DEV_HOSTS)}")
        else:
            ok(f"{app}: AppConfig.cleartextDevHosts matches the debug XML exactly")

    default = re.search(r"debugDefaultApiBaseUrl\s*=\s*'([^']+)'", dart)
    if not default:
        fail(f"{app}: AppConfig.debugDefaultApiBaseUrl not found")
    else:
        url = default.group(1)
        host = re.sub(r"^https?://", "", url).split("/")[0].split(":")[0]
        if url.startswith("http://") and host not in EXPECTED_DEV_HOSTS:
            fail(f"{app}: default base URL host '{host}' is not cleartext-permitted — every call would fail")
        else:
            ok(f"{app}: default base URL '{url}' resolves to a permitted host")


def check_workflows() -> None:
    print("\n=== .github/workflows ===")
    wf_dir = os.path.join(ROOT, ".github", "workflows")
    builds = 0
    for name in sorted(os.listdir(wf_dir)):
        if not name.endswith((".yml", ".yaml")):
            continue
        text = open(os.path.join(wf_dir, name), encoding="utf-8").read()

        # PHASE C: the naive line-by-line form of this check produced seven
        # false positives the moment build-apk.yml was rewritten, because it
        # matched (a) YAML `- name:` step labels, (b) `echo` lines inside job
        # summaries, and (c) the first physical line of a shell command split
        # across several lines with a trailing `\`. All three are text ABOUT a
        # build, not a build. So: join shell line-continuations first, then
        # require the match to look like an actual invocation.
        joined = re.sub(r"\\\n\s*", " ", text)
        for raw in joined.splitlines():
            line = raw.strip()
            # PHASE G: `appbundle` too. The release artifact Play accepts is an
            # AAB, not an APK, and MA-004's rule ("an artifact nobody can log
            # into is not evidence") applies to it identically — more so, since
            # this is the one that reaches real users.
            if "flutter build apk" not in line and "flutter build appbundle" not in line:
                continue
            if line.startswith("#"):
                continue                       # YAML comment / prose
            if re.match(r"^-?\s*name\s*:", line):
                continue                       # a step label
            if re.match(r"^(echo|printf)\b", line):
                continue                       # job-summary text, not a command
            builds += 1
            if "--dart-define=API_BASE_URL=" not in line:
                fail(f"{name}: `flutter build` without --dart-define=API_BASE_URL -> {line}")
            else:
                ok(f"{name}: {line[:110]}")
    if builds == 0:
        fail("no `flutter build apk|appbundle` invocation found in any workflow")


if __name__ == "__main__":
    for app in APPS:
        check_app(app)
    check_workflows()
    print(f"\nTOTAL PROBLEMS: {len(problems)}")
    sys.exit(1 if problems else 0)
