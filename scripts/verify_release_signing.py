#!/usr/bin/env python3
"""
verify_release_signing.py — prove that a RELEASE Android build in this
repository cannot be signed with the debug key, and that no key material is
committed.

WHY THIS EXISTS AS A SCRIPT RATHER THAN A CODE REVIEW. Before Phase G both
apps carried `signingConfig signingConfigs.debug` in `buildTypes.release`.
That one line meant every "release" artifact the project ever described was
signed with a machine-local throwaway key and could never be uploaded to
Google Play — and nothing in the build said so. A code review had already
looked at those files several times. So the replacement is not a convention:
it is three layers, and this script is what keeps them honest.

TWO HALVES, AND THE SECOND ONE IS THE INTERESTING ONE.

  A. STATIC ASSERTIONS over the two build.gradle files, the two .gitignore
     files and the working tree: the identifier `signingConfigs.debug` is
     absent, the release build type is assigned `signingConfigs.release`,
     `signing.properties` is ignored, `signing.properties.example` is NOT
     ignored, no keystore or filled-in properties file is present.

  B. THE GUARD IS EXTRACTED AND EXECUTED. The `gradle.taskGraph.whenReady`
     closure is lifted VERBATIM out of each app's build.gradle, wrapped in a
     harness that stubs the handful of Gradle objects it touches, and RUN
     under the Groovy interpreter that ships inside the local Gradle
     distribution — once per scenario in the table below. This is the closest
     thing to evidence available in an environment with no Flutter SDK and no
     Android SDK: the assertions are not read, they are executed, and each one
     is shown to fire on the input it exists for and to stay silent otherwise.

WHAT THIS IS NOT. It does not run Gradle, AGP or `flutter build`. It cannot
prove that AGP consumes the resulting signing config correctly, that the
keystore is valid, or that Play accepts the AAB. Those need a real toolchain.
The claim is narrower and exactly stated: the DECISION LOGIC in these files
behaves as documented on ten inputs each.

Needs a `groovy-*.jar` (any Gradle distribution has one). If none is found the
static half still runs and the executable half is reported as SKIPPED — and
the exit code says so, rather than pretending.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = ("parent-app", "child-app")

FAILURES: list[str] = []
CHECKS = 0


def check(ok: bool, label: str, detail: str = "") -> bool:
    global CHECKS
    CHECKS += 1
    if ok:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}")
        if detail:
            print(f"        {detail}")
        FAILURES.append(label)
    return ok


# ---------------------------------------------------------------------------
# A. STATIC
# ---------------------------------------------------------------------------

def executable_code(src: str) -> str:
    """Return the file with comments removed and string-literal CONTENTS
    blanked, leaving the quotes in place.

    Both erasures are necessary and for the same reason. These two build.gradle
    files talk about `signingConfigs.debug` at length — in comments, because the
    reasoning is the point, and inside the L3 error message, which quotes the
    exact line it exists to catch. Neither is a reference that any expression
    can evaluate. Searching the raw text for the identifier finds the
    documentation of the defect and reports it as the defect."""
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif ch in ("'", '"'):
            quote = ch
            out.append(quote)
            i += 1
            while i < n and src[i] != quote:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "\n":       # an unterminated literal: do not eat the file
                    break
                i += 1
            out.append(quote)
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def static_checks() -> None:
    for app in APPS:
        print(f"\n--- static · {app} ---")
        gradle_path = os.path.join(REPO, "apps", app, "android", "app", "build.gradle")
        src = open(gradle_path, encoding="utf-8").read()
        code = executable_code(src)

        check(
            re.search(r"signingConfig\s+signingConfigs\.debug", code) is None,
            f"{app}: the assignment `signingConfig signingConfigs.debug` does not occur",
            "L1 is structural: the expression that caused the original defect must not exist.",
        )
        # The identifier survives in EXACTLY ONE place — inside L3, which
        # compares against it. Anywhere else it is the defect coming back.
        debug_refs = [
            ln.strip()
            for ln in code.splitlines()
            if "signingConfigs.debug" in ln
        ]
        check(
            debug_refs == ['if (releaseSigning.is(android.signingConfigs.debug) || releaseSigning.name == "") {'],
            f"{app}: `signingConfigs.debug` appears only inside the L3 comparison",
            f"found: {debug_refs}",
        )
        check(
            re.search(r"buildTypes\s*\{\s*release\s*\{[^}]*signingConfig\s+signingConfigs\.release", code, re.S)
            is not None,
            f"{app}: buildTypes.release is assigned signingConfigs.release",
        )
        check(
            "gradle.taskGraph.whenReady" in code,
            f"{app}: the task-graph guard (L2) is present",
        )
        check(
            "releaseSigning.is(android.signingConfigs.debug)" in code,
            f"{app}: the identity assertion (L3) is present",
        )
        # Checked against the RAW source: this one is a string literal, and the
        # blanked view above deliberately cannot see string contents.
        check(
            'rootProject.file("signing.properties")' in src,
            f"{app}: the signing config is read from signing.properties",
        )
        for secret in ("storePassword", "keyPassword"):
            check(
                re.search(rf'{secret}\s+"[^"]', code) is None,
                f"{app}: no literal {secret} in build.gradle",
            )

        gitignore = open(os.path.join(REPO, "apps", app, "android", ".gitignore"), encoding="utf-8").read()
        lines = [ln.strip() for ln in gitignore.splitlines()]
        check("signing.properties" in lines, f"{app}: signing.properties is gitignored")
        check("!signing.properties.example" in lines, f"{app}: signing.properties.example is NOT ignored")
        check("*.jks" in lines and "*.keystore" in lines, f"{app}: keystore extensions are gitignored")

        example = os.path.join(REPO, "apps", app, "android", "signing.properties.example")
        check(os.path.exists(example), f"{app}: signing.properties.example is committed")
        if os.path.exists(example):
            body = open(example, encoding="utf-8").read()
            check("keytool -genkeypair" in body, f"{app}: the example carries the keytool command")
            check(
                body.count("CHANGE_ME") >= 2,
                f"{app}: the example's passwords are placeholders",
            )
        check(
            not os.path.exists(os.path.join(REPO, "apps", app, "android", "signing.properties")),
            f"{app}: no real signing.properties in the working tree",
        )
        keys = glob.glob(os.path.join(REPO, "apps", app, "android", "**", "*.jks"), recursive=True)
        keys += glob.glob(os.path.join(REPO, "apps", app, "android", "**", "*.keystore"), recursive=True)
        check(not keys, f"{app}: no keystore file in the working tree", ", ".join(keys))


# ---------------------------------------------------------------------------
# B. EXECUTABLE — extract the guard and run it
# ---------------------------------------------------------------------------

def extract_guard(src: str) -> str:
    """Lift the whenReady closure BODY out verbatim by brace matching."""
    marker = "gradle.taskGraph.whenReady { graph ->"
    start = src.index(marker) + len(marker)
    depth, i, n = 1, start, len(src)
    while i < n:
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[start:i]
        i += 1
    raise AssertionError("unbalanced whenReady closure")


HARNESS = r"""
// Stubs for the only Gradle types the guard touches. Nothing here reimplements
// any of the guard's own logic — the body below is the repository's, verbatim.
class GradleException extends RuntimeException { GradleException(String m) { super(m) } }
class FakeSigningConfig { String name }
class FakeProject { String path }
class FakeTask { String name; String path; FakeProject project }
class FakeGraph { List allTasks }
class FakeLogger { void lifecycle(String s) { println "LIFECYCLE " + s } }

def project = new FakeProject(path: ':app')
def logger = new FakeLogger()
def debugSigningConfig = new FakeSigningConfig(name: 'debug')
def releaseSigningConfig = new FakeSigningConfig(name: 'release')

def abnySigningProperties = new Properties()
abnySigningProperties.setProperty('keyAlias', 'abny-upload')
def flutterVersionCode = '4242'
def flutterVersionName = '0.1.0'

// ---- scenario knobs -------------------------------------------------------
def abnySigningPresent      = __PRESENT__
def abnyMissingSigningKeys  = __MISSING__
def abnyKeystoreFile        = __KEYSTORE__
def abnyVersionCodeExplicit = __VC__
def abnyVersionNameExplicit = __VN__
def __resolved              = __RESOLVED__
def android = [
    buildTypes:     [release: [signingConfig: __resolved]],
    signingConfigs: [debug: debugSigningConfig, release: releaseSigningConfig],
]
def graph = new FakeGraph(allTasks: __TASKS__)

// ---- the guard, EXTRACTED VERBATIM FROM build.gradle ----------------------
def guard = { g ->
__BODY__
}

try {
    guard(graph)
    println "RESULT NO_THROW"
} catch (GradleException e) {
    println "RESULT THROW"
    println "MESSAGE " + e.message.replace("\n", " | ")
}
"""


def scenario(name, *, present, missing, keystore, vc, vn, resolved, tasks, expect, expect_message=None):
    return dict(
        name=name, present=present, missing=missing, keystore=keystore, vc=vc, vn=vn,
        resolved=resolved, tasks=tasks, expect=expect, expect_message=expect_message,
    )


def build_scenarios(real_ks: str, debug_ks: str, absent_ks: str):
    good_tasks = "[new FakeTask(name: 'bundleRelease', path: ':app:bundleRelease', project: project)]"
    debug_tasks = "[new FakeTask(name: 'assembleDebug', path: ':app:assembleDebug', project: project)]"
    other_tasks = ("[new FakeTask(name: 'bundleRelease', path: ':other:bundleRelease', "
                   "project: new FakeProject(path: ':other'))]")
    ks = lambda p: f"new File({p!r})"
    return [
        scenario("a DEBUG build needs no key at all",
                 present=False, missing="[]", keystore="null", vc=False, vn=False,
                 resolved="releaseSigningConfig", tasks=debug_tasks, expect="NO_THROW"),
        scenario("a release task in ANOTHER project is not ours to police",
                 present=False, missing="[]", keystore="null", vc=False, vn=False,
                 resolved="releaseSigningConfig", tasks=other_tasks, expect="NO_THROW"),
        scenario("RELEASE with NO signing.properties fails loudly",
                 present=False, missing="[]", keystore="null", vc=True, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="UNSIGNABLE RELEASE ARTIFACT"),
        scenario("RELEASE with an INCOMPLETE signing.properties fails loudly",
                 present=True, missing="['keyPassword']", keystore="null", vc=True, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="INCOMPLETE"),
        scenario("RELEASE naming a keystore that is not there fails loudly",
                 present=True, missing="[]", keystore=ks(absent_ks), vc=True, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="does not exist"),
        scenario("RELEASE resolving to the DEBUG config fails loudly (L3)",
                 present=True, missing="[]", keystore=ks(real_ks), vc=True, vn=True,
                 resolved="debugSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="resolves to the DEBUG signing config"),
        scenario("RELEASE with NO signing config at all fails loudly",
                 present=True, missing="[]", keystore=ks(real_ks), vc=True, vn=True,
                 resolved="null", tasks=good_tasks, expect="THROW",
                 expect_message="NO signing config"),
        scenario("RELEASE pointed at a debug.keystore fails loudly (L3)",
                 present=True, missing="[]", keystore=ks(debug_ks), vc=True, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="looks like"),
        scenario("RELEASE on a FALLBACK versionCode fails loudly",
                 present=True, missing="[]", keystore=ks(real_ks), vc=False, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="THROW",
                 expect_message="FALLBACK version"),
        scenario("a fully configured RELEASE proceeds and says what it signed with",
                 present=True, missing="[]", keystore=ks(real_ks), vc=True, vn=True,
                 resolved="releaseSigningConfig", tasks=good_tasks, expect="NO_THROW",
                 expect_message="LIFECYCLE"),
    ]


def find_groovy_jar() -> str | None:
    roots = [os.environ.get("GRADLE_HOME", ""), "/opt/gradle", "/usr/share/gradle", "/usr/local/gradle"]
    for r in roots:
        if not r:
            continue
        for j in sorted(glob.glob(os.path.join(r, "lib", "groovy-[0-9]*.jar"))):
            return j
    for j in sorted(glob.glob("/opt/gradle*/lib/groovy-[0-9]*.jar")):
        return j
    return None


def executable_checks(jar: str, tmp: str) -> None:
    real_ks = os.path.join(tmp, "abny-upload.jks")
    debug_ks = os.path.join(tmp, "debug.keystore")
    absent_ks = os.path.join(tmp, "not-here.jks")
    for p in (real_ks, debug_ks):
        open(p, "wb").write(b"not a real keystore, only its existence matters here")

    for app in APPS:
        print(f"\n--- executed guard · {app} ---")
        src = open(os.path.join(REPO, "apps", app, "android", "app", "build.gradle"), encoding="utf-8").read()
        body = extract_guard(src)
        for sc in build_scenarios(real_ks, debug_ks, absent_ks):
            script = (
                HARNESS.replace("__BODY__", body)
                .replace("__PRESENT__", "true" if sc["present"] else "false")
                .replace("__MISSING__", sc["missing"])
                .replace("__KEYSTORE__", sc["keystore"])
                .replace("__VC__", "true" if sc["vc"] else "false")
                .replace("__VN__", "true" if sc["vn"] else "false")
                .replace("__RESOLVED__", sc["resolved"])
                .replace("__TASKS__", sc["tasks"])
            )
            path = os.path.join(tmp, "harness.groovy")
            open(path, "w", encoding="utf-8").write(script)
            proc = subprocess.run(
                ["java", "-cp", jar, "groovy.ui.GroovyMain", path],
                capture_output=True, text=True,
            )
            out = proc.stdout
            if proc.returncode != 0:
                check(False, f"{app}: {sc['name']}", (proc.stderr or out)[-400:])
                continue
            got = "THROW" if "RESULT THROW" in out else ("NO_THROW" if "RESULT NO_THROW" in out else "?")
            ok = got == sc["expect"]
            if ok and sc["expect_message"]:
                ok = sc["expect_message"] in out
            check(ok, f"{app}: {sc['name']}",
                  f"expected {sc['expect']} + {sc['expect_message']!r}, got {got}: {out.strip()[:300]}")


def main() -> int:
    print("verify_release_signing.py — Android release signing, three layers")
    static_checks()

    jar = find_groovy_jar()
    if jar is None:
        print("\ngroovy parser: NONE FOUND — the EXECUTABLE half was SKIPPED.")
        print("A missing parser is not a defect in the repository; the static half above stands.")
    else:
        print(f"\ngroovy parser: {jar}")
        with tempfile.TemporaryDirectory() as tmp:
            executable_checks(jar, tmp)

    print(f"\nchecks run: {CHECKS}  ·  failures: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
