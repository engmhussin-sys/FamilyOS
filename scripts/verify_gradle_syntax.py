#!/usr/bin/env python3
"""
verify_gradle_syntax.py — parse every Gradle build script with the real Groovy
parser, without running Gradle.

WHY: Phase C made `apps/parent-app/android/app/build.gradle` conditional (the
Firebase decoupling) and pinned the SDK levels in both apps. A Groovy syntax
error there fails the Android build several minutes into a CI run, after the
Flutter SDK download and `pub get`. Parsing is free and catches it in a second.

WHAT THIS IS NOT: it does not evaluate the scripts, resolve plugins, or check
that `android { }` is configured correctly — that needs a real Gradle run with
a real Flutter SDK, and `settings.gradle` asserts `flutter.sdk` in
local.properties. This is PARSE-ONLY. It proves the file is well-formed
Groovy, nothing more.

It needs a `groovy-*.jar`, which ships inside any Gradle distribution. If none
is found the script says so and exits 0 — a missing parser is not a defect in
the repository, and failing CI for it would be a lie.
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHECKER = r"""
import org.codehaus.groovy.control.*;
import java.io.File;
public class GradleParseCheck {
  public static void main(String[] a) throws Exception {
    int bad = 0;
    for (String p : a) {
      try {
        CompilationUnit cu = new CompilationUnit();
        cu.addSource(new File(p));
        cu.compile(Phases.CONVERSION);
        System.out.println("  ok    " + p);
      } catch (Throwable t) {
        bad++;
        System.out.println("  FAIL  " + p);
        System.out.println("        " + t.getMessage());
      }
    }
    System.exit(bad == 0 ? 0 : 1);
  }
}
"""


def find_groovy_jar() -> str:
    roots = [
        os.environ.get("GRADLE_HOME", ""),
        "/opt/gradle",
        "/usr/share/gradle",
        os.path.expanduser("~/.sdkman/candidates/gradle/current"),
    ]
    for r in roots:
        if not r:
            continue
        for j in sorted(glob.glob(os.path.join(r, "lib", "groovy-[0-9]*.jar"))):
            return j
    for j in sorted(glob.glob("/**/lib/groovy-[0-9]*.jar", recursive=False)):
        return j
    return ""


def main() -> int:
    scripts = sorted(
        p
        for app in ("parent-app", "child-app")
        for p in glob.glob(os.path.join(REPO, "apps", app, "android", "**", "*.gradle"),
                           recursive=True)
        if "/build/" not in p
    )
    print(f"gradle scripts found: {len(scripts)}")
    for s in scripts:
        print(f"    {os.path.relpath(s, REPO)}")

    jar = find_groovy_jar()
    if not jar:
        print("\nSKIPPED: no groovy-*.jar found (looked in $GRADLE_HOME, /opt/gradle,")
        print("/usr/share/gradle, ~/.sdkman). Nothing was verified — this is NOT a pass.")
        return 0
    print(f"\ngroovy parser: {jar}\n")

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "GradleParseCheck.java")
        open(src, "w").write(CHECKER)
        r = subprocess.run(
            ["javac", "-cp", jar, "-d", tmp, src], capture_output=True, text=True
        )
        if r.returncode:
            print("SKIPPED: could not compile the parser helper:")
            print(r.stderr.strip()[:400])
            return 0
        r = subprocess.run(
            ["java", "-cp", f"{jar}:{tmp}", "GradleParseCheck", *scripts],
            capture_output=True, text=True,
        )
        out = "\n".join(
            l for l in r.stdout.splitlines() if "JAVA_TOOL_OPTIONS" not in l
        )
        print(out)
        print(f"\nTOTAL PROBLEMS: {0 if r.returncode == 0 else 'see FAIL lines above'}")
        return r.returncode


if __name__ == "__main__":
    sys.exit(main())
