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

ADDED AT SPRINT F1 — the same principle, applied to a second permission:
  F. IF the manifest declares RECORD_AUDIO, THEN a runtime request site exists
     and is reachable. Sprint F1 declares RECORD_AUDIO for the first time (the
     recitation is recorded IN PROCESS by `record`, so the microphone is this
     app's to hold), and a dangerous permission that is declared and never
     requested fails exactly the way POST_NOTIFICATIONS failed from Sprint 4
     to G18: silently, on a real device, with every unit test still green.
     Accepted evidence:
       - Kotlin: requestPermissions(...) with Manifest.permission.RECORD_AUDIO
       - Dart  : a call to a `*[Mm]icrophonePermission*` method — which is
                 what PlatformEvidenceCaptureSource wraps `record`'s
                 hasPermission() in. (`record`'s method name is misleading:
                 hasPermission() CHECKS AND REQUESTS, and it is the runtime
                 request.)
     Reachability is asserted the same way as B, and for the same reason.

     CAMERA / READ_MEDIA_IMAGES are NOT checked here, because F1 deliberately
     declares neither — see the AndroidManifest comment. If a later sprint
     declares one, it belongs in this check rather than in a review comment.

ADDED NOW — the same shape of defect, one layer out:
  G. THE `abny://` DEEP-LINK SCHEME, END TO END.

     THE DEFECT THIS CLOSES, MEASURED: the backend resolves an
     `abny://<surface>[/<id>]` for EVERY notification, both Flutter apps have
     routers that answer every surface, a backend guard proves there are no dead
     destinations — and NEITHER MANIFEST DECLARED THE SCHEME. In-app taps worked
     (the link travels on the FCM `data` payload and is parsed in Dart), so every
     test in the repository stayed green while any `abny://` link arriving from
     OUTSIDE the app resolved to no app at all. That is this file's own thesis —
     "declared here, therefore reachable there" — applied to the scheme instead
     of to a permission, and no other checker in this repository can see it:
     `dart_preflight.py` does not read XML, `verify_l10n_parity.py` checks
     strings, and a Kotlin compiler is content with an intent nobody reads.

     WHY IT LIVES HERE AND NOT IN A NEW FILE: the claim is the same conjunction
     across the same three languages (a manifest, Kotlin, Dart) that checks A–F
     already make, and it is about the delivery of a NOTIFICATION. A tenth
     checker would only duplicate this file's walk, its Report and its runner.

     THE SCHEME STRING IS READ FROM THE BACKEND AT CHECK TIME
     (`DEEP_LINK_SCHEME` in notifications/domain/engine/notification-destination.ts),
     never typed here. The server is authoritative for the scheme; a rename
     there must fail this check rather than pass it, which a hardcoded "abny"
     could not do.

     Per app, all of it required only when the registry's scheme is readable:
       G1. some <intent-filter> declares <data android:scheme="<scheme>">.
       G2. that same filter carries VIEW + DEFAULT + BROWSABLE. Any one of the
           three missing and the OS will not resolve a link to the app, which is
           indistinguishable from not declaring it at all.
       G3. the MAIN/LAUNCHER filter still stands ALONE — no <data> element in
           it. Folding the two together is the documented way to lose the
           launcher icon.
       G4. a COLD-START HANDLER exists in Dart: something calls
           `DeepLinkChannel.consumeInitialLink()`, and the same app routes
           through its EXISTING router (`*DeepLinkRouter.follow*`). A scheme the
           OS resolves to an app that then drops the URI is the same dead tap
           one layer down.
       G5. the channel name is identical in Kotlin and Dart — same reason as
           check C, and it is the exact failure C exists to catch.

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

# --- F1: the same conjunction, for the microphone. -------------------------
RECORD_AUDIO = "android.permission.RECORD_AUDIO"
KOTLIN_RECORD_AUDIO_CONST = re.compile(r"Manifest\.permission\.RECORD_AUDIO")
DART_MIC_REQUEST = re.compile(r"\brequestMicrophonePermission\s*\(")
DART_MIC_METHOD_DECL = re.compile(
    r"^\s*(?:Future<[^>]*>|void)\s+(\w*[Mm]icrophone[Pp]ermission\w*)\s*\(",
    re.M,
)

# --- G: the `abny://` deep-link scheme. ------------------------------------
# The registry is the SERVER's, and it is read rather than mirrored: this
# checker must fail when the scheme is renamed there, which is exactly what a
# hardcoded "abny" here could never do.
DEEP_LINK_REGISTRY = os.path.join(
    "apps", "backend", "src", "modules", "notifications", "domain", "engine",
    "notification-destination.ts",
)
# RFC 3986 scheme shape, lower-cased because Android matches `android:scheme`
# case-sensitively against an already-lower-cased URI scheme.
DEEP_LINK_SCHEME_DECL = re.compile(
    r"export\s+const\s+DEEP_LINK_SCHEME\s*=\s*['\"]([a-z][a-z0-9+.\-]*)['\"]"
)

XML_COMMENT = re.compile(r"<!--.*?-->", re.S)
INTENT_FILTER = re.compile(r"<intent-filter\b.*?</intent-filter>", re.S)
DATA_SCHEME = re.compile(r"<data\b[^>]*android:scheme\s*=\s*\"([^\"]*)\"")
ACTION_VIEW = re.compile(r"<action\b[^>]*android:name\s*=\s*\"android\.intent\.action\.VIEW\"")
ACTION_MAIN = re.compile(r"<action\b[^>]*android:name\s*=\s*\"android\.intent\.action\.MAIN\"")
CATEGORY_LAUNCHER = re.compile(
    r"<category\b[^>]*android:name\s*=\s*\"android\.intent\.category\.LAUNCHER\""
)
CATEGORY_DEFAULT = re.compile(
    r"<category\b[^>]*android:name\s*=\s*\"android\.intent\.category\.DEFAULT\""
)
CATEGORY_BROWSABLE = re.compile(
    r"<category\b[^>]*android:name\s*=\s*\"android\.intent\.category\.BROWSABLE\""
)
DATA_ELEMENT = re.compile(r"<data\b")

# The Dart half of the cold-start path. A CALL, never the declaration: the
# declaration is `static Future<String?> consumeInitialLink()`, which this
# pattern cannot match.
DART_CONSUME_INITIAL_LINK = re.compile(r"DeepLinkChannel\.consumeInitialLink\s*\(")
# Whatever that app's own router is called — parent `DeepLinkRouter`, child
# `ChildDeepLinkRouter`. Deliberately not a fixed name: the requirement is that
# the cold-start path reaches the app's EXISTING router, not that some
# particular class exists.
DART_ROUTER_FOLLOW = re.compile(r"\b\w*DeepLinkRouter\.follow\w*\s*\(")
KOTLIN_CHANNEL_NAME = re.compile(r"const\s+val\s+CHANNEL_NAME\s*=\s*\"([^\"]+)\"")
DART_CHANNEL_NAME = re.compile(r"channelName\s*=\s*'([^']+)'")


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


def check_record_audio(app_root: str, app_name: str, rep: Report) -> None:
    """Check F — declared RECORD_AUDIO implies a reachable runtime request.

    Structurally identical to `check_app`, on purpose: the defect is identical.
    A dangerous permission sitting in a manifest with nothing asking for it is
    not "mostly working" — on Android 13+ it is a feature that silently never
    runs, and the app has already shipped that exact bug once.
    """
    manifest = os.path.join(
        app_root, "android", "app", "src", "main", "AndroidManifest.xml"
    )
    manifest_text = read(manifest)
    if not manifest_text:
        rep.fail(f"{app_name}: AndroidManifest.xml not found or unreadable at {manifest}")
        return

    if RECORD_AUDIO not in manifest_text:
        rep.ok(
            f"{app_name}: does not declare RECORD_AUDIO — nothing to request "
            "(this check applies only to apps that declare it)"
        )
        return

    kotlin_files = walk(os.path.join(app_root, "android"), (".kt",))
    dart_files = walk(os.path.join(app_root, "lib"), (".dart",))

    request_sites: list[str] = []
    for path in kotlin_files:
        text = read(path)
        if KOTLIN_REQUEST_CALL.search(text) and KOTLIN_RECORD_AUDIO_CONST.search(text):
            request_sites.append(os.path.relpath(path, ROOT))
    for path in dart_files:
        if DART_MIC_REQUEST.search(read(path)):
            request_sites.append(os.path.relpath(path, ROOT))

    if not request_sites:
        rep.fail(
            f"{app_name}: declares {RECORD_AUDIO} in AndroidManifest.xml but NOTHING "
            "in this app ever requests it at runtime. RECORD_AUDIO is dangerous on "
            "every API level: the recorder will fail and no dialog will ever appear. "
            "Add an ActivityCompat.requestPermissions call (native) or a "
            "requestMicrophonePermission() call (Dart) — invoked AFTER the child has "
            "been told, in their own words, what the microphone is for."
        )
        return

    rep.ok(
        f"{app_name}: declares RECORD_AUDIO and requests it at runtime "
        f"({len(request_sites)} site(s): {', '.join(sorted(request_sites))})"
    )

    # Reachability, exactly as in check B: a request method nothing calls is
    # the same defect wearing a disguise.
    all_dart = {path: read(path) for path in dart_files}
    for path, text in all_dart.items():
        for match in DART_MIC_METHOD_DECL.finditer(text):
            name = match.group(1)
            call_re = re.compile(rf"\b{re.escape(name)}\s*\(")
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
                    "it is unreachable, so the microphone permission is never actually "
                    "requested. Wire it to the UI that explains it."
                )


def read_deep_link_scheme(registry_path: str) -> str | None:
    """The scheme the SERVER emits, or None when it cannot be read.

    None is never treated as "no scheme required": the caller reports it as a
    failure, because a checker that silently passes when it cannot find its own
    reference value is worse than no checker.
    """
    match = DEEP_LINK_SCHEME_DECL.search(read(registry_path))
    return match.group(1) if match else None


def check_deep_link_scheme(
    app_roots: dict[str, str],
    registry_path: str,
    rep: Report,
) -> None:
    """Check G — the `abny://` scheme, from the server's registry to the OS.

    Structurally the same claim as check A: a thing DECLARED in one language is
    worthless unless the thing that consumes it exists in another. Here the
    declaration is the server's `DEEP_LINK_SCHEME` and the consumers are the two
    manifests and the two cold-start handlers.
    """
    scheme = read_deep_link_scheme(registry_path)
    if scheme is None:
        rep.fail(
            "cannot read DEEP_LINK_SCHEME from "
            f"{os.path.relpath(registry_path, ROOT) if registry_path.startswith(ROOT) else registry_path}. "
            "The scheme both clients register with Android is READ from the "
            "backend registry rather than typed here, so that a rename cannot "
            "pass this check. Fix the path or the constant — do not hardcode "
            "the scheme in this checker."
        )
        return

    rep.ok(f"backend registry emits scheme '{scheme}://' (read, not hardcoded)")

    for app_name, app_root in app_roots.items():
        manifest_path = os.path.join(
            app_root, "android", "app", "src", "main", "AndroidManifest.xml"
        )
        raw = read(manifest_path)
        if not raw:
            rep.fail(f"{app_name}: AndroidManifest.xml not found or unreadable at {manifest_path}")
            continue

        # Comments are stripped first: this file's own comments quote the
        # elements they explain, and a checker satisfied by a comment is a
        # checker satisfied by prose.
        text = XML_COMMENT.sub("", raw)
        filters = INTENT_FILTER.findall(text)

        scheme_filters = [f for f in filters if scheme in DATA_SCHEME.findall(f)]
        declared = sorted({s for f in filters for s in DATA_SCHEME.findall(f)})

        # ---- G1 ----------------------------------------------------------
        if not scheme_filters:
            rep.fail(
                f"{app_name}: no <intent-filter> declares "
                f'<data android:scheme="{scheme}"> — schemes found in this '
                f"manifest: {declared or ['none']}. The backend resolves an "
                f"{scheme}://<surface> for EVERY notification and this app's "
                "router answers every surface, but the OS has never been told "
                "this package answers the scheme, so a link arriving from "
                "outside the app (a browser, a message, `adb shell am start "
                f"-a android.intent.action.VIEW -d {scheme}://notifications`) "
                "resolves to nothing. Add a SECOND intent-filter to the "
                "launcher activity in "
                f"{os.path.relpath(manifest_path, ROOT) if manifest_path.startswith(ROOT) else manifest_path} "
                "with VIEW + DEFAULT + BROWSABLE and that <data> element; do "
                "not touch the MAIN/LAUNCHER filter."
            )
            continue

        # ---- G2 ----------------------------------------------------------
        complete = [
            f for f in scheme_filters
            if ACTION_VIEW.search(f)
            and CATEGORY_DEFAULT.search(f)
            and CATEGORY_BROWSABLE.search(f)
        ]
        if not complete:
            missing_report = []
            for f in scheme_filters:
                missing = [
                    name for name, pattern in (
                        ("action VIEW", ACTION_VIEW),
                        ("category DEFAULT", CATEGORY_DEFAULT),
                        ("category BROWSABLE", CATEGORY_BROWSABLE),
                    ) if not pattern.search(f)
                ]
                missing_report.append(", ".join(missing))
            rep.fail(
                f"{app_name}: the intent-filter carrying "
                f'android:scheme="{scheme}" is missing {"; ".join(missing_report)}. '
                "All three are required together: without VIEW nothing dispatches "
                "to it, without DEFAULT an implicit intent never matches, and "
                "without BROWSABLE a link tapped in a browser or a messaging app "
                "— the whole point of registering the scheme — is refused."
            )
            continue

        # ---- G3 ----------------------------------------------------------
        launcher = [
            f for f in filters if ACTION_MAIN.search(f) and CATEGORY_LAUNCHER.search(f)
        ]
        if not launcher:
            rep.fail(
                f"{app_name}: no MAIN/LAUNCHER intent-filter survives in the "
                "manifest — this app has no launcher icon at all. The deep-link "
                "filter must be a SECOND filter, never a replacement."
            )
            continue
        polluted = [f for f in launcher if DATA_ELEMENT.search(f)]
        if polluted:
            rep.fail(
                f"{app_name}: the MAIN/LAUNCHER intent-filter now contains a "
                "<data> element. Android matches an intent against a filter AS A "
                "WHOLE, so the launcher entry becomes conditional on that data "
                "and the icon can disappear from the launcher. Keep the two "
                "filters separate: MAIN/LAUNCHER alone, VIEW/DEFAULT/BROWSABLE "
                "+ <data> in its own filter."
            )
            continue

        rep.ok(
            f"{app_name}: declares {scheme}:// in a VIEW/DEFAULT/BROWSABLE "
            "intent-filter, and MAIN/LAUNCHER still stands alone"
        )

        # ---- G4: the cold-start handler ----------------------------------
        dart_files = walk(os.path.join(app_root, "lib"), (".dart",))
        consume_sites: list[str] = []
        router_sites: list[str] = []
        for path in dart_files:
            body = read(path)
            rel = os.path.relpath(path, ROOT) if path.startswith(ROOT) else path
            if DART_CONSUME_INITIAL_LINK.search(body):
                consume_sites.append(rel)
            if DART_ROUTER_FOLLOW.search(body):
                router_sites.append(rel)

        if not consume_sites:
            rep.fail(
                f"{app_name}: the manifest declares {scheme}:// but NOTHING in "
                "lib/ calls DeepLinkChannel.consumeInitialLink(). The OS then "
                "launches this app for the link and the URI is dropped on the "
                "floor — the app opens on its normal landing screen as if the "
                "icon had been tapped, which is the same dead tap one layer "
                "down. Wire the cold-start intent to the router this app "
                "already has; do not write a second resolver."
            )
        elif not router_sites:
            rep.fail(
                f"{app_name}: DeepLinkChannel.consumeInitialLink() is called "
                f"({', '.join(sorted(consume_sites))}) but nothing in lib/ calls "
                "this app's own *DeepLinkRouter.follow*(). A link read and not "
                "routed is a link dropped, and a cold-start path that resolves "
                "destinations by itself is the second opinion deep_link.dart "
                "exists to prevent."
            )
        else:
            rep.ok(
                f"{app_name}: cold-start link consumed in "
                f"{', '.join(sorted(consume_sites))} and routed through the "
                "app's own DeepLinkRouter"
            )

        # ---- G5: one channel name, two languages -------------------------
        kotlin_names: set[str] = set()
        for path in walk(os.path.join(app_root, "android"), (".kt",)):
            if os.path.basename(path) != "DeepLinkChannel.kt":
                continue
            kotlin_names.update(KOTLIN_CHANNEL_NAME.findall(read(path)))
        dart_names: set[str] = set()
        for path in dart_files:
            if os.path.basename(path) != "deep_link_channel.dart":
                continue
            dart_names.update(DART_CHANNEL_NAME.findall(read(path)))

        if not kotlin_names or not dart_names:
            rep.fail(
                f"{app_name}: could not read the deep-link channel name on both "
                f"sides (Kotlin: {sorted(kotlin_names) or 'none'}, Dart: "
                f"{sorted(dart_names) or 'none'}). Both DeepLinkChannel.kt and "
                "deep_link_channel.dart must declare it as a named constant — "
                "an inline literal is a typo waiting to become a silent runtime "
                "failure on a device."
            )
        elif kotlin_names != dart_names:
            rep.fail(
                f"{app_name}: the deep-link channel name differs across "
                f"languages — Kotlin {sorted(kotlin_names)} vs Dart "
                f"{sorted(dart_names)}. There is no compile-time link between "
                "them: the link would reach the process and never reach Dart."
            )
        else:
            rep.ok(
                f"{app_name}: deep-link channel '{sorted(dart_names)[0]}' "
                "matches in Kotlin and Dart"
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


def run(
    app_roots: dict[str, str],
    check_channel: bool = True,
    check_scheme: bool = True,
    registry_path: str = "",
) -> int:
    rep = Report()
    print("=" * 72)
    print("verify_notification_permission.py — G18")
    print("A permission DECLARED but never REQUESTED is invisible on Android 13+.")
    print("A scheme NEVER DECLARED is a notification link the OS cannot resolve.")
    print("=" * 72)

    for app_name, app_root in app_roots.items():
        print(f"\n=== apps/{app_name} ===")
        check_app(app_root, app_name, rep)
        check_record_audio(app_root, app_name, rep)

    if check_scheme:
        print("\n=== the abny:// deep-link scheme (check G) ===")
        check_deep_link_scheme(
            app_roots,
            registry_path or os.path.join(ROOT, DEEP_LINK_REGISTRY),
            rep,
        )

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
        # check_channel/check_scheme=False: the synthetic tree has no native
        # layer and no manifest intent-filter, and this control is about check
        # A, which must fail on its own. Check G has its own negative controls
        # in scripts/dart_preflight_selftest.py.
        code = run(
            {"child-app (synthetic, pre-G18)": app},
            check_channel=False,
            check_scheme=False,
        )
        print(f"\nnegative control exit code: {code} (expected: 1)")
        return 0 if code == 1 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        sys.exit(self_test())
    sys.exit(run({app: os.path.join(ROOT, "apps", app) for app in APPS}))
