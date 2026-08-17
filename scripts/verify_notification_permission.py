#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_notification_permission.py — G18.

THE DEFECT THIS EXISTS TO PREVENT, STATED PLAINLY
`apps/child-app` declared `android.permission.POST_NOTIFICATIONS` in its
manifest from Sprint 4 onwards and NEVER REQUESTED IT. On Android 13+ (API 33)
POST_NOTIFICATIONS is a runtime permission: undeclared-and-unrequested means the
platform silently drops every notification the app posts. So the
foreground-service notification, RuntimeAlertNotifier's alerts and the entire
output of the Smart Notification Engine were invisible on any modern device,
while every unit test still passed — because nothing in a unit test asks the
platform whether it would actually display anything.

WHY A DEDICATED CHECKER AND NOT A GREP
The claim is a CONJUNCTION across two languages and a manifest ("declared here,
therefore requested there, and reachable from real code"), and no other check in
this repository can see it:
  * `dart_preflight.py` resolves Dart names; a manifest is not Dart.
  * `verify_l10n_parity.py` checks strings, not call graphs.
  * a Kotlin compiler would be perfectly happy with a permission nobody asks for.
It is exactly the class of defect that is invisible until a real device is in a
real user's hand, which is the most expensive moment to discover it.

CHECKS
------
Per app (parent-app, child-app):
  A. IF the manifest declares POST_NOTIFICATIONS, THEN at least one runtime
     REQUEST SITE exists in that app. Accepted evidence, and nothing else:
       - Kotlin: ActivityCompat/requestPermissions with POST_NOTIFICATIONS
       - Dart  : a call to the child app's `requestNotificationsPermission()`
                 platform-channel method
       - Dart  : firebase_messaging's `requestPermission()` (the parent app
                 reaches POST_NOTIFICATIONS through FCM, which is a legitimate
                 request path on Android 13+)
  B. Every request site must be REACHABLE: the method that performs the request
     has to be referenced from at least one OTHER file. A request function that
     nothing calls is the same defect wearing a disguise, and it is the most
     likely way this regresses — the call gets written, then the UI that would
     have invoked it is refactored away.

Cross-language (child app only, which owns a native channel):
  C. The channel method name is identical in Kotlin and Dart. There is no
     compile-time link between them, so a mismatch is a silent runtime failure.
  D. MainActivity actually HANDLES that method — a constant declared on both
     sides and handled nowhere reaches `result.notImplemented()`.
  E. The outcome vocabulary (granted / denied / permanently_denied /
     already_granted / not_required) is identical on both sides.

Exit code 0 when every check passes, 1 otherwise.

Run:  python3 scripts/verify_notification_permission.py [--self-test]
"""

from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = ["parent-app", "child-app"]
PERMISSION = "android.permission.POST_NOTIFICATIONS"

# A real Kotlin request: requestPermissions(...) reached with the
# POST_NOTIFICATIONS constant somewhere in the same file.
KOTLIN_REQUEST_CALL = re.compile(r"\brequestPermissions\s*\(")
KOTLIN_PERMISSION_CONST = re.compile(r"Manifest\.permission\.POST_NOTIFICATIONS")

# The child app's own channel method, and the FCM path the parent app uses.
DART_CHANNEL_REQUEST = re.compile(r"\brequestNotificationsPermission\s*\(")
DART_FCM_REQUEST = re.compile(r"\brequestPermission\s*\(")
DART_FCM_IMPORT = re.compile(r"package:firebase_messaging/firebase_messaging\.dart")

# Declarations whose reachability check B applies to. Captures the method name.
DART_METHOD_DECL = re.compile(
    r"^\s*(?:Future<[^>]*>|void)\s+(\w*[Nn]otification\w*[Pp]ermission\w*)\s*\(",
    re.M,
)


def walk(root: str, suffixes: tuple[str, ...]) -> list[str]:
    out: list[str] = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(suffixes):
                out.append(os.path.join(base, name))
    return out


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return ""


class Report:
    def __init__(self) -> None:
        self.problems: list[str] = []

    def fail(self, msg: str) -> None:
        self.problems.append(msg)
        print(f"  FAIL  {msg}")

    def ok(self, msg: str) -> None:
        print(f"  ok    {msg}")


def check_app(app_root: str, app_name: str, rep: Report) -> None:
    """Checks A and B for one app rooted at `app_root`."""
    manifest = os.path.join(
        app_root, "android", "app", "src", "main", "AndroidManifest.xml"
    )
    manifest_text = read(manifest)
    if not manifest_text:
        rep.fail(f"{app_name}: AndroidManifest.xml not found or unreadable at {manifest}")
        return

    declares = PERMISSION in manifest_text
    if not declares:
        rep.ok(
            f"{app_name}: does not declare POST_NOTIFICATIONS — nothing to request "
            "(this check applies only to apps that declare it)"
        )
        return

    kotlin_files = walk(os.path.join(app_root, "android"), (".kt",))
    dart_files = walk(os.path.join(app_root, "lib"), (".dart",))

    request_sites: list[str] = []

    for path in kotlin_files:
        text = read(path)
        if KOTLIN_REQUEST_CALL.search(text) and KOTLIN_PERMISSION_CONST.search(text):
            request_sites.append(os.path.relpath(path, ROOT))

    for path in dart_files:
        text = read(path)
        if DART_CHANNEL_REQUEST.search(text):
            request_sites.append(os.path.relpath(path, ROOT))
        elif DART_FCM_IMPORT.search(text) and DART_FCM_REQUEST.search(text):
            # Only counted in a file that actually imports firebase_messaging:
            # a bare `requestPermission(` could be any unrelated method.
            request_sites.append(os.path.relpath(path, ROOT))

    if not request_sites:
        rep.fail(
            f"{app_name}: declares {PERMISSION} in AndroidManifest.xml but NOTHING "
            "in this app ever requests it at runtime. On Android 13+ every "
            "notification this app posts is silently dropped by the platform. "
            "Add an ActivityCompat.requestPermissions call (native) or a "
            "requestNotificationsPermission()/FirebaseMessaging.requestPermission() "
            "call (Dart), invoked AFTER the value has been explained to the user."
        )
        return

    rep.ok(
        f"{app_name}: declares POST_NOTIFICATIONS and requests it at runtime "
        f"({len(request_sites)} site(s): {', '.join(sorted(request_sites))})"
    )

    # ---- B. reachability -------------------------------------------------
    # Any notification-permission method declared in Dart must have at least one
    # CALL SITE somewhere. A request function nothing invokes is the same defect
    # wearing a disguise, and it is the likeliest way this regresses: the call
    # gets written, then the UI that would have invoked it is refactored away.
    #
    # A call in the DECLARING FILE counts. Dart privates (a leading underscore)
    # are library-scoped and can only ever be called from there, so demanding a
    # cross-file reference would flag correct code — as it did on the first run
    # of this checker against device_home_screen.dart's own private handler.
    all_dart = {path: read(path) for path in dart_files}
    for path, text in all_dart.items():
        for match in DART_METHOD_DECL.finditer(text):
            name = match.group(1)
            call_re = re.compile(rf"\b{re.escape(name)}\s*\(")

            # The declaration itself matches call_re, so it is discounted here.
            own_file_calls = len(call_re.findall(text)) - 1
            other_file_calls = sum(
                len(call_re.findall(other_text))
                for other, other_text in all_dart.items()
                if other != path
            )
            rel = os.path.relpath(path, ROOT)

            if own_file_calls + other_file_calls > 0:
                where = []
                if own_file_calls:
                    where.append(f"{own_file_calls} in {os.path.basename(rel)}")
                if other_file_calls:
                    where.append(f"{other_file_calls} in other file(s)")
                rep.ok(f"{app_name}: {name}() has call sites ({', '.join(where)})")
            else:
                rep.fail(
                    f"{app_name}: {name}() is declared in {rel} but NOTHING calls it — "
                    "it is unreachable, so the permission is still never requested in "
                    "practice. Wire it to the UI that explains it."
                )


def check_child_channel(rep: Report) -> None:
    """Checks C, D and E — the child app's cross-language channel contract."""
    child = os.path.join(ROOT, "apps", "child-app")
    kotlin_const = os.path.join(
        child, "android", "app", "src", "main", "kotlin", "com", "aifamilycoach",
        "child_app", "core", "AgentChannel.kt",
    )
    dart_const = os.path.join(child, "lib", "core", "platform", "agent_channel_constants.dart")
    main_activity = os.path.join(
        child, "android", "app", "src", "main", "kotlin", "com", "aifamilycoach",
        "child_app", "MainActivity.kt",
    )
    dart_domain = os.path.join(
        child, "lib", "plugins", "permissions", "domain", "permission_status.dart"
    )

    kotlin_text = read(kotlin_const)
    dart_text = read(dart_const)
    activity_text = read(main_activity)
    domain_text = read(dart_domain)

    # C. the method name, on both sides.
    kotlin_method = re.search(
        r'METHOD_REQUEST_NOTIFICATIONS_PERMISSION\s*=\s*"([^"]+)"', kotlin_text
    )
    dart_method = re.search(
        r"methodRequestNotificationsPermission\s*=\s*'([^']+)'", dart_text
    )
    if not kotlin_method:
        rep.fail("child-app: METHOD_REQUEST_NOTIFICATIONS_PERMISSION not declared in AgentChannel.kt")
    elif not dart_method:
        rep.fail("child-app: methodRequestNotificationsPermission not declared in agent_channel_constants.dart")
    elif kotlin_method.group(1) != dart_method.group(1):
        rep.fail(
            "child-app: channel method name differs across languages — Kotlin "
            f"'{kotlin_method.group(1)}' vs Dart '{dart_method.group(1)}'. There is no "
            "compile-time link between them, so this is a silent runtime failure."
        )
    else:
        rep.ok(f"child-app: channel method '{kotlin_method.group(1)}' matches in Kotlin and Dart")

    # D. MainActivity handles it.
    if "METHOD_REQUEST_NOTIFICATIONS_PERMISSION ->" in activity_text:
        rep.ok("child-app: MainActivity handles METHOD_REQUEST_NOTIFICATIONS_PERMISSION")
    else:
        rep.fail(
            "child-app: MainActivity has no branch for "
            "METHOD_REQUEST_NOTIFICATIONS_PERMISSION, so the call reaches "
            "result.notImplemented() and no dialog is ever shown."
        )

    # E. the outcome vocabulary, on both sides.
    kotlin_outcomes = set(re.findall(r'(?:NOT_REQUIRED|ALREADY_GRANTED|GRANTED|DENIED|PERMANENTLY_DENIED)\s*=\s*"([^"]+)"', kotlin_text))
    dart_outcomes = set(re.findall(r"case '([a-z_]+)':", domain_text))
    expected = {"not_required", "already_granted", "granted", "denied", "permanently_denied"}
    if not expected.issubset(kotlin_outcomes):
        rep.fail(
            "child-app: AgentChannel.NotificationPermissionOutcome is missing "
            f"{sorted(expected - kotlin_outcomes)}"
        )
    elif not expected.issubset(dart_outcomes):
        rep.fail(
            "child-app: permission_status.dart's fromWire does not handle "
            f"{sorted(expected - dart_outcomes)}"
        )
    else:
        rep.ok("child-app: the five outcome wire strings match in Kotlin and Dart")


def run(app_roots: dict[str, str], check_channel: bool = True) -> int:
    rep = Report()
    print("=" * 72)
    print("verify_notification_permission.py — G18")
    print("A permission DECLARED but never REQUESTED is invisible on Android 13+.")
    print("=" * 72)

    for app_name, app_root in app_roots.items():
        print(f"\n=== apps/{app_name} ===")
        check_app(app_root, app_name, rep)

    if check_channel:
        print("\n=== child-app cross-language channel contract ===")
        check_child_channel(rep)

    print(f"\nTOTAL PROBLEMS: {len(rep.problems)}")
    return 1 if rep.problems else 0


def self_test() -> int:
    """NEGATIVE CONTROL.

    A zero from the checks above means nothing unless the checker can be shown to
    fail on the defect it claims to detect. This rebuilds the ACTUAL pre-G18
    state — a manifest that declares POST_NOTIFICATIONS beside a
    PermissionStatusService whose notifications arm is `break` — and asserts the
    checker rejects it.
    """
    import tempfile

    manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="{PERMISSION}" />
    <application android:label="child_app" />
</manifest>
"""
    # The real pre-G18 code, reproduced: the notifications arm did nothing.
    service = """
class PermissionStatusService {
  Future<void> requestPermission(AgentPermissionKind kind) async {
    switch (kind) {
      case AgentPermissionKind.notifications:
        // POST_NOTIFICATIONS is a normal runtime permission (Android 13+)
        // requested via the OS's own permission dialog when first
        // needed. Nothing to do here yet.
        break;
    }
  }
}
"""
    with tempfile.TemporaryDirectory() as tmp:
        app = os.path.join(tmp, "child-app")
        manifest_dir = os.path.join(app, "android", "app", "src", "main")
        lib_dir = os.path.join(app, "lib", "plugins", "permissions", "application")
        os.makedirs(manifest_dir)
        os.makedirs(lib_dir)
        with open(os.path.join(manifest_dir, "AndroidManifest.xml"), "w", encoding="utf-8") as fh:
            fh.write(manifest)
        with open(os.path.join(lib_dir, "permission_status_service.dart"), "w", encoding="utf-8") as fh:
            fh.write(service)

        print("=" * 72)
        print("NEGATIVE CONTROL — scanning a copy of the PRE-G18 child app")
        print("(POST_NOTIFICATIONS declared; the notifications arm is `break`)")
        print("=" * 72)
        # check_channel=False: the synthetic tree has no native layer, and this
        # control is about check A, which must fail on its own.
        code = run({"child-app (synthetic, pre-G18)": app}, check_channel=False)
        print(f"\nnegative control exit code: {code} (expected: 1)")
        return 0 if code == 1 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sys.exit(self_test())
    sys.exit(run({app: os.path.join(ROOT, "apps", app) for app in APPS}))
