# MOBILE BUILD HANDOFF — Windows operator

This is the **single authoritative build document**. Execute it top to bottom without reading any source: every number and every string below was read out of a committed file, and the file is named beside it so you can check it yourself in one `type` / `cat`.

**Two things before anything else, because they are your first hour:**

1. **The debug APK needs NO keystore and NO Firebase file.** Nothing about `flutter build apk --debug` touches `signing.properties`, `google-services.json` or `firebase_options.dart`. It is the first artifact, it is installable on a real phone, and it is unblocked today. Everything in §13 and §15 is for the *release* artifact only.
2. **The child app does not need `google-services.json`.** Only the parent app does. `apps/child-app/pubspec.yaml` declares no `firebase_core` and no `firebase_messaging`, `apps/child-app/android/settings.gradle` carries no `com.google.gms.google-services` plugin, and `apps/child-app/android/app/build.gradle` never applies one — so no child build has ever read that file. An earlier version of this document demanded it from both apps. That was wrong.

**Why this document exists.** `pub.dev`, `dl.google.com`, `storage.googleapis.com` and `services.gradle.org` all answer 403 from the container this project was built in, so no Flutter SDK, Dart SDK, JDK or Android SDK could be installed and **no `flutter`, `gradle`, `java` or `adb` command has ever run against this repository.** That is the one blocker no amount of code can clear, and it is why your machine is the only one that can produce an artifact.

**Evidence vocabulary used here.** `STATIC VERIFIED` = read out of the committed files, no execution. `CODE REVIEWED` = the logic was walked by reading. `RUNTIME VERIFIED` = a process actually ran and its output was read (only the Python checkers qualify). `BLOCKED` = needs something this container does not have. `HUMAN DECISION / ENVIRONMENT VALUE REQUIRED` = the value does not exist anywhere in the repository and only you can supply it. **Nothing here is `BUILD VERIFIED`**, because nothing has been built.

---

## THE NINETEEN VALUES, AT A GLANCE

| # | Item | Value | Read from |
|---|---|---|---|
| 1 | Flutter | `3.24.5` | `.github/workflows/build-apk.yml` → `env.FLUTTER_VERSION` |
| 2 | Dart | constraint `>=3.3.0 <4.0.0`; ships inside Flutter | `apps/*/pubspec.yaml` → `environment.sdk` |
| 3 | Android SDK platform | `platforms;android-34` + `platform-tools` | derived from compileSdk; installed by `scripts/setup-windows-dev.ps1` |
| 4 | compileSdk | `34` | `apps/*/android/app/build.gradle` |
| 5 | buildTools | **not declared** → derived `34.0.0` | derivation in `scripts/lib/repo-pins.sh` |
| 6 | Gradle | `8.3` | `apps/*/android/gradle/wrapper/gradle-wrapper.properties` |
| 7 | JDK | `17`, Temurin | `.github/workflows/build-apk.yml` → `env.JAVA_VERSION` |
| 8 | Android Gradle Plugin | `8.1.1` | `apps/*/android/settings.gradle` |
| 9 | Exact commands | §9 | — |
| 10 | Expected output | §10 | — |
| 11 | Environment variables | §11 | — |
| 12 | Required files | §12 | — |
| 13 | Firebase | parent app only | §13 |
| 14 | Debug APK command | §14 | — |
| 15 | Release APK command | §15 | — |
| 16 | AAB command | §16 | — |
| 17 | Device install (`adb`) | §17 | — |
| 18 | Smoke test | `GOLDEN_DEVICE_SMOKE_TEST.md` | §18 |
| 19 | External blockers | §19 | — |

Each is expanded below with the exact line it came from.

---

## 1. Flutter version — `3.24.5`

`STATIC VERIFIED`. `.github/workflows/build-apk.yml`:

```yaml
FLUTTER_VERSION: "3.24.5"
```

Install exactly this. The pin is load-bearing and that file says why in its own comment: Flutter 3.27+ defaults `compileSdk` to 35, and AGP 8.1.1 (§8) refuses anything above 34 outright with *"compileSdk 35 requires Android Gradle Plugin 8.6.0 or higher"*. A build on a different Flutter proves nothing about the pinned one. The same workflow re-measures the runner and fails the job on a mismatch (`FLUTTER VERSION MISMATCH`), so CI and your machine are held to the same number.

Channel: `stable` — `.github/workflows/build-apk.yml`, the `subosito/flutter-action@v2` step (`channel: stable`).

---

## 2. Dart version — constraint `>=3.3.0 <4.0.0`, and it ships inside Flutter

`STATIC VERIFIED`. Both `apps/parent-app/pubspec.yaml` and `apps/child-app/pubspec.yaml` declare, identically:

```yaml
environment:
  sdk: ">=3.3.0 <4.0.0"
  flutter: ">=3.19.0"
```

**Do not install a standalone Dart SDK.** Dart is bundled with Flutter at `<flutter>\bin\dart.bat`; a separately installed one drifts from the Flutter pin and then `flutter pub get` and `flutter analyze` disagree about the language version. `.github/workflows/build-apk.yml`'s own comment on the Flutter pin records which Dart that is: *"Flutter 3.24.5 ships Dart 3.5.4 — inside the range."* That is the workflow's statement, not a measurement made here — no `dart --version` has ever run against this repository.

---

## 3. Android SDK — `platforms;android-34`, `platform-tools`, plus the installer

`STATIC VERIFIED`.

| Package | Value | Source |
|---|---|---|
| Platform | `platforms;android-34` | derived from `compileSdk 34` (§4). `scripts/setup-windows-dev.ps1` installs `platforms;android-$($pins.CompileSdk)` |
| Platform tools (`adb`) | unversioned — `platform-tools` | `scripts/setup-windows-dev.ps1`'s `$packages` list |
| Build tools | `34.0.0` (derived, see §5) | `scripts/setup-windows-dev.ps1` |
| cmdline-tools (the **installer**) | `commandlinetools-win-11076708_latest.zip` | `scripts/setup-windows-dev.ps1` → default `-CmdlineToolsUrl` |
| NDK | **none installed** | both `apps/*/android/app/build.gradle` keep `ndkVersion flutter.ndkVersion` |

The cmdline-tools bundle is **not a build input** — it only provides `sdkmanager`, which then installs the packages that do matter. The NDK is deliberately left to Flutter's own resolution; a debug APK for these two apps needs none, and if a plugin ever does, Gradle names the version it wants.

You must also accept the SDK licences (`sdkmanager --licenses`) or Gradle refuses to use the platform. `scripts/setup-windows-dev.ps1` does this for you.

---

## 4. compileSdk — `34`

`STATIC VERIFIED`. Both `apps/parent-app/android/app/build.gradle` and `apps/child-app/android/app/build.gradle`:

```groovy
compileSdk 34
```

It is a **literal**, deliberately not `flutter.compileSdkVersion`, so the API level no longer moves with the Flutter version. The same files also pin:

| | Value | Note (from the file's own comment) |
|---|---|---|
| `targetSdk` | `34` | 34 is what makes the child app's `FOREGROUND_SERVICE_SPECIAL_USE` declaration the correct form |
| `minSdk` | `21` | Flutter 3.24.5's own floor, and the floor `com.google.firebase:firebase-bom:33.1.2` requires |

`release-doctor` checks `minSdk <= targetSdk <= compileSdk` and `compileSdk` against the AGP ceiling as two separate rows.

---

## 5. buildTools — NOT DECLARED ANYWHERE; derived as `34.0.0`

`STATIC VERIFIED`. **Neither app declares `buildToolsVersion`.** Grep both `apps/*/android/app/build.gradle`: the property does not appear. AGP 8.1.1 therefore picks its own default.

The derivation used by every script here is `<compileSdk>.0.0` = **`34.0.0`**, and it is printed as derived wherever it is used (`scripts/lib/repo-pins.sh` sets `PIN_BUILD_TOOLS_DERIVED=yes`; `scripts/setup-windows-dev.ps1` prints `DERIVED from compileSdk — not declared anywhere in the repo`).

Install `build-tools;34.0.0`. If AGP asks for a different one it will name it, and that name — not this derivation — is authoritative. `release-doctor` grades *"any build-tools installed"* as **required** and *"exactly 34.0.0"* as **advisory**, for exactly this reason.

---

## 6. Gradle — `8.3`, and only via the wrapper

`STATIC VERIFIED`. Both `apps/parent-app/android/gradle/wrapper/gradle-wrapper.properties` and `apps/child-app/android/gradle/wrapper/gradle-wrapper.properties`, byte-identical:

```properties
distributionUrl=https\://services.gradle.org/distributions/gradle-8.3-bin.zip
```

`gradle-wrapper.jar` (56,921 bytes) is **committed** in both apps — `apps/*/android/.gitignore` deliberately does not ignore it, and its own comment says why: the wrapper had never been committed at all, which was the root cause of an earlier bring-up failure.

**Never substitute a `gradle` from PATH.** The wrapper pin is what AGP 8.1.1 was validated against. The first `.\gradlew` run downloads `gradle-8.3-bin.zip` from `services.gradle.org` and caches it in `%GRADLE_USER_HOME%\wrapper\dists` (default `%USERPROFILE%\.gradle`); that download is a §19 blocker if your network blocks it.

---

## 7. Java / JDK — `17`, Temurin

`STATIC VERIFIED`. Three independent files agree:

| Source | What it says |
|---|---|
| `.github/workflows/build-apk.yml` | `JAVA_VERSION: "17"`, and `distribution: temurin` on the `actions/setup-java@v4` step |
| `apps/*/android/app/build.gradle` | `sourceCompatibility JavaVersion.VERSION_17`, `targetCompatibility JavaVersion.VERSION_17`, `jvmTarget = JavaVersion.VERSION_17` |
| `.github/workflows/build-apk.yml` (comment) | Gradle 8.3 only learned to **run** on JDK 21 in 8.5, so JDK 21 dies with `Unsupported class file major version 65` before compiling anything; AGP 8.1.1 independently wants 17 |

**Set `JAVA_HOME` to the JDK 17 root.** Gradle prefers `JAVA_HOME` over `PATH`; a machine with 17 on `PATH` and `JAVA_HOME` pointing at 21 builds with 21 and fails. `release-doctor` has a separate `java-home` row for precisely this.

---

## 8. Android Gradle Plugin — `8.1.1` (with Kotlin `1.9.10`)

`STATIC VERIFIED`. Both `apps/*/android/settings.gradle`:

```groovy
id "dev.flutter.flutter-plugin-loader" version "1.0.0"
id "com.android.application" version "8.1.1" apply false
id "org.jetbrains.kotlin.android" version "1.9.10" apply false
```

**`apps/parent-app/android/settings.gradle` has one extra line the child app does not:**

```groovy
id "com.google.gms.google-services" version "4.4.2" apply false
```

That single line is the mechanical reason §13 applies to the parent app only.

Other declared Gradle dependencies, for completeness:

* `apps/parent-app/android/app/build.gradle` → `implementation platform("com.google.firebase:firebase-bom:33.1.2")`, and `multiDexEnabled true`.
* `apps/child-app/android/app/build.gradle` → `implementation "androidx.work:work-runtime-ktx:2.9.0"` and `implementation "androidx.core:core-ktx:1.13.1"`.
* Both `apps/*/android/build.gradle` → repositories `google()` + `mavenCentral()`, and `rootProject.buildDir = "../build"`, which is why every artifact path in §5-of-the-old-numbering (now §14–§16) starts at `apps/<app>/build/`.

---

## 9. Exact commands, in order

Run from the repository root in **PowerShell**. Nothing here is optional and nothing is a choice.

```powershell
# 0. ONE-TIME TOOLCHAIN INSTALL (Flutter 3.24.5, Temurin 17, Android SDK 34)
.\scripts\setup-windows-dev.ps1

# 1. THE GATE. Repeat until it does not end on SHIP BLOCKED.
#    Debug-only readiness (what you need for step 3):
.\scripts\release-doctor.ps1 -Profile debug
#    Full store readiness (needs §13 and §15 done first):
.\scripts\release-doctor.ps1

# 2. PUSH, so CI can build what you are about to build locally
git push origin abny/sprint-f1-unblock

# 3. THE DEBUG ARTIFACTS — no keystore, no Firebase, unblocked today
.\scripts\mobile-build.ps1 -App both

# 4. COMMIT THE LOCKFILES that step 3 just generated. This is not optional:
#    until they exist, two builds of the same commit can resolve different
#    dependency versions and no artifact is reproducible.
git add apps/parent-app/pubspec.lock apps/child-app/pubspec.lock
git commit -m "chore(mobile): commit resolved pubspec.lock for both apps"

# 5. THE RELEASE ARTIFACTS — only after §13 (Firebase) and §15 (keystore)
$env:RELEASE_API_BASE_URL = "https://<your-host>/api/v1"   # see §11
.\scripts\mobile-build.ps1 -App both -Release
```

`mobile-build.ps1` runs, per app and in this order, stopping at the first failure and printing the failing command, its working directory, its log path and its exit code:

```
flutter pub get  ->  flutter analyze  ->  flutter test  ->  flutter build apk --debug
```

and with `-Release`, a RELEASE PREFLIGHT (which reads §13 and §15's files before spending a minute on anything) followed by `flutter build apk --release` and `flutter build appbundle --release`.

If you would rather run the stages by hand, these are the same four, per app:

```powershell
cd apps\parent-app
flutter pub get
flutter analyze
flutter test
flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 --dart-define=ENABLE_PUSH=false
cd ..\child-app
# ...identical four commands...
```

`--dart-define=API_BASE_URL` is **mandatory on every build** (audit MA-004): without it the APK installs and can talk to nothing. See §11 for the value.

---

## 10. Expected output of each command

`CODE REVIEWED` — these are the success and failure signatures written into the repository's own files. **None of them has been observed**, because no build has run.

| Command | Success looks like | Failure you should expect to see |
|---|---|---|
| `.\scripts\setup-windows-dev.ps1` | a SETUP table of steps with `PASS`, an APPS table with `pub get` / `analyze` / `test` / `build apk` per app, an ARTEFACTS list naming one APK per app, then `All stages passed.` and exit 0 | any `FAIL*` or `not reached` in the APPS table → `One or more stages FAILED.` and exit 1 |
| `.\scripts\release-doctor.ps1` | the CHECK POLICY table, then one classified line per check, then `PASS n WARN n BLOCKED 0` and a final line beginning `SHIP GATE PASSED`, exit 0 | any blocked check → the blocking rows listed in fix order, then the final line `SHIP BLOCKED`, exit 1 |
| `flutter pub get` | resolves and writes `pubspec.lock` in that app directory, exit 0 | with no pub.dev access it fails here, and every later stage is moot (§19) |
| `flutter analyze` | `No issues found!`, exit 0 | **expect this to surface something on the first ever run** — see §19 |
| `flutter test` | a passing test summary, exit 0 | first execution ever; treat a failure as information, not as a regression |
| `flutter build apk --debug` | the APK at the path in §14, exit 0. On the **parent** app with no Firebase file, Gradle also prints `ABNY WARNING: android/app/google-services.json is ABSENT.` and continues — that warning is correct and expected for a debug build | a Gradle error naming the missing SDK component |
| `flutter build apk --release` / `appbundle --release`, **correctly configured** | Gradle prints `ABNY: release signing OK — keystore <name>, alias <alias>`, then the artifact at §15/§16's path | see the four rows below |
| release build, **no `signing.properties`** | — | `ABNY: REFUSING TO PRODUCE AN UNSIGNABLE RELEASE ARTIFACT.` … `apps/<app>/android/signing.properties is MISSING.` (`apps/*/android/app/build.gradle`) |
| release build, **partial `signing.properties`** | — | `ABNY: android/signing.properties is present but INCOMPLETE.` + the names of the missing keys |
| release build, **keystore file absent** | — | `ABNY: the keystore named by signing.properties does not exist.` + the path it resolved to |
| release build, **debug keystore named** | — | `ABNY: signing.properties points the RELEASE config at what looks like a DEBUG keystore:` + the path |
| release build, **version on the fallback** | — | `ABNY: refusing to package a release on a FALLBACK version.` |
| parent release build **with** Firebase | Gradle prints `ABNY: google-services.json found — Firebase Messaging is ENABLED.` | with `-Pabny.firebase=required` and no file: `ABNY: abny.firebase=required but android/app/google-services.json is missing.` |
| `.\scripts\mobile-build.ps1` | one `[ OK ]` line per stage, an ARTIFACTS block with a size per file, then `ALL STAGES PASSED AND EVERY DECLARED ARTIFACT EXISTS.`, exit 0 | a boxed `STOPPED — stage FAILED:` block naming the command, directory, exit code and log tail; or `n DECLARED ARTIFACT(S) ARE NOT ON DISK.` and exit 1 |
| `.\scripts\mobile-build.ps1 -Release` without an https URL | — | it refuses **before** the first stage: `a RELEASE build needs an explicit https API_BASE_URL and none was given.` (§11) |

---

## 11. Required environment variables

`STATIC VERIFIED`.

### On your machine, for the build

| Variable | Required for | Value | Source |
|---|---|---|---|
| `JAVA_HOME` | every Gradle task | the **root** of a Temurin JDK 17 install (the folder holding `bin\` and `lib\`) | `.github/workflows/build-apk.yml` `env.JAVA_VERSION`; set by `scripts/setup-windows-dev.ps1` |
| `ANDROID_SDK_ROOT` | Flutter's Android toolchain | your SDK root | set by `scripts/setup-windows-dev.ps1` |
| `ANDROID_HOME` | same, older name still read by some tooling | same value as `ANDROID_SDK_ROOT` | set by `scripts/setup-windows-dev.ps1` |
| `PATH` | must contain | `<flutter>\bin`, `<jdk>\bin`, `%ANDROID_SDK_ROOT%\platform-tools`, `%ANDROID_SDK_ROOT%\cmdline-tools\latest\bin` | `scripts/setup-windows-dev.ps1` |
| `RELEASE_API_BASE_URL` | **release builds only** | **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED** | name from `.github/workflows/build-apk.yml`; read by `scripts/mobile-build.ps1 -Release` and graded by `release-doctor` |
| `GRADLE_USER_HOME` | optional | defaults to `%USERPROFILE%\.gradle` | — |

**`RELEASE_API_BASE_URL` is the one that will bite you.** No value for it exists anywhere in this repository and none was invented. It must be an **https** URL ending in `/api/v1` pointing at your deployed backend. `apps/*/lib/core/config/app_config.dart` throws `StateError` on the first frame of a release build whose `API_BASE_URL` is not https, so a release built on the debug default is a signed, uploadable artifact **that cannot open**. `mobile-build.ps1 -Release` now refuses to start without one.

### Build-time `--dart-define`s (not environment variables — they are baked into the artifact)

| Define | What `mobile-build` passes for debug | What it passes for release | Source |
|---|---|---|---|
| `API_BASE_URL` | `http://10.0.2.2:3000/api/v1` | your https URL | `AppConfig.debugDefaultApiBaseUrl` in both `apps/*/lib/core/config/app_config.dart` |
| `ENABLE_PUSH` | `false` when `google-services.json` is absent, `true` when present | `true` | the Dart side is `bool.fromEnvironment('ENABLE_PUSH', defaultValue: true)` in `apps/parent-app/lib/core/notifications/push_registration_service.dart` |

Note the asymmetry: the **Dart default is `true`**, so an artifact built with no `--dart-define=ENABLE_PUSH` at all claims push is on. `mobile-build` therefore passes the define explicitly on every build and derives it from whether that app actually has a `google-services.json`, so an artifact without Firebase is labelled honestly rather than silently shipping a push path that cannot work.

`10.0.2.2` is the Android **emulator's** alias for the host machine. On a physical phone that address does not exist — pass your LAN IP instead, and note that `apps/*/android/app/src/debug/res/xml/network_security_config.xml` permits cleartext for exactly five hosts: `10.0.2.2`, `10.0.3.2`, `127.0.0.1`, `localhost`, `abny-dev.local`. A cleartext URL on any other host is blocked by the platform with no error the app can show. The same five are mirrored in `AppConfig.cleartextDevHosts`.

### CI-side (GitHub), only if you also want CI to build

From `.github/workflows/build-apk.yml`. Repository **variables**: `DEV_API_BASE_URL`, `RELEASE_API_BASE_URL`, `ABNY_RELEASE_BUILD`, `ABNY_VERSION_CODE_OFFSET`. Repository **secrets**: `GOOGLE_SERVICES_JSON`, and per app `ANDROID_KEYSTORE_BASE64_{PARENT,CHILD}`, `ANDROID_KEYSTORE_PASSWORD_{PARENT,CHILD}`, `ANDROID_KEY_ALIAS_{PARENT,CHILD}`, `ANDROID_KEY_PASSWORD_{PARENT,CHILD}`. Every one of their values is **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED**.

### The backend the app talks to

The full variable list is `apps/backend/.env.example`, which is committed and annotated. The ones that fail the backend closed if unset — so the app sees errors rather than data — are `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (two **different** values, each ≥32 characters), `LOCATION_ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS` (empty means *no* origins, not *all*), `INTERNAL_ADMIN_API_KEY` and `STRIPE_WEBHOOK_SECRET`. Every value in that file is `change-me` or empty: all of them are **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED**. `FIREBASE_SERVICE_ACCOUNT_JSON` is the server half of §13 and the push pipeline no-ops without it.

---

## 12. Required files

`STATIC VERIFIED`.

| File | Who provides it | Needed for | Present today |
|---|---|---|---|
| `apps/*/android/gradle/wrapper/gradle-wrapper.jar` | committed | every Gradle task | **yes** |
| `apps/*/android/gradle/wrapper/gradle-wrapper.properties` | committed | pins Gradle 8.3 | **yes** |
| `apps/*/android/signing.properties.example` | committed | the template + the keytool command | **yes** |
| `apps/*/android/.gitignore` | committed | keeps key material out of history | **yes** |
| `apps/*/android/local.properties` | **generated by `flutter build`** | carries `flutter.sdk`, `flutter.versionName`, `flutter.versionCode` | no — and it is gitignored, correctly |
| `apps/*/pubspec.lock` | **generated by `flutter pub get`, then commit it** | reproducibility | **no** — see §19 |
| `apps/*/android/signing.properties` | **you** | release only | no — see §15 |
| `apps/*/android/<keystore>.jks` | **you** | release only | no — see §15 |
| `apps/parent-app/android/app/google-services.json` | **you** | parent release; parent push | no — see §13 |
| `apps/parent-app/lib/firebase_options.dart` | **you**, via `flutterfire configure` | parent push at runtime | no — see §13 |
| `apps/child-app/android/app/google-services.json` | **nobody — not required** | — | not required, and must not be fabricated |

`apps/*/android/settings.gradle` reads `flutter.sdk` out of `local.properties` and asserts on it (`assert flutterSdkPath != null, "flutter.sdk not set in local.properties"`). That file is written by `flutter build`, so **always drive the build through `flutter`, never by calling `.\gradlew` directly in a fresh checkout.**

---

## 13. Firebase — parent app only, and nobody but you can create it

`STATIC VERIFIED`.

| App | Needs `google-services.json`? | The three files that decide it |
|---|---|---|
| **Parent** — `com.aifamilycoach.parent_app` | **Yes** | `pubspec.yaml` declares `firebase_core: ^3.6.0` and `firebase_messaging: ^15.1.3`; `android/settings.gradle` declares `com.google.gms.google-services` version `4.4.2`; `android/app/build.gradle` applies it conditionally and pins `com.google.firebase:firebase-bom:33.1.2` |
| **Child** — `com.aifamilycoach.child_app` | **No** | no `firebase_*` line in `pubspec.yaml`, no `google-services` plugin in `android/settings.gradle`, no `apply plugin` in `android/app/build.gradle` |

Every script in `scripts/` derives this from those same three files rather than hardcoding either answer, so the day the child app gains `firebase_messaging` the requirement appears by itself.

**For the parent app only:**

1. Create the Firebase project. Its name and id are **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED**.
2. Add an **Android app** with `applicationId` exactly `com.aifamilycoach.parent_app` (from `apps/parent-app/android/app/build.gradle`).
3. Download `google-services.json` → `apps/parent-app/android/app/google-services.json`.
4. Add the **SHA-256** fingerprint of your release keystore (§15) to that Firebase app.
5. Enable **Cloud Messaging**.
6. Generate `apps/parent-app/lib/firebase_options.dart` with `flutterfire configure`. It is **absent** today, and only that command against a real project can produce it.
7. Server side: put the service-account JSON in the backend's `FIREBASE_SERVICE_ACCOUNT_JSON` (§11).

**The build does not stop when the file is missing, and that is the trap.** `apps/parent-app/android/app/build.gradle` defaults to `-Pabny.firebase=auto`, which prints `ABNY WARNING: android/app/google-services.json is ABSENT.` and continues; `PushRegistrationService` catches the init failure and the app runs with push disabled. **That is correct for a debug APK and wrong for a store release** — a release built in that state is a valid, signed, uploadable artifact in which *every push notification silently never arrives*. `release-doctor` grades it `BLOCKED` under `-Profile release` and `WARN` under `-Profile debug`; `mobile-build.ps1 -Release` refuses it in the RELEASE PREFLIGHT; CI does the same (`RELEASE BUILD REQUESTED FOR THE PARENT APP WITHOUT FIREBASE`). To build a release-signed QA sideload without push **on purpose**, say so explicitly: `-AllowReleaseWithoutPush`.

**No `google-services.json` was fabricated anywhere in this repository.** A placeholder builds and then fails silently at runtime, which is worse than a file that is honestly absent. `docs/release/FIREBASE_SETUP.md` has the field-by-field detail. `BLOCKED` here: only you can create it.

---

## 14. Debug APK — the first artifact, and it needs nothing from you

**No keystore. No `signing.properties`. No `google-services.json`. No Firebase project. No https URL.** This is the one you can build in the next twenty minutes.

```powershell
# via the script (both apps, with logs)
.\scripts\mobile-build.ps1 -App both

# or by hand, per app
cd apps\parent-app
flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 --dart-define=ENABLE_PUSH=false
```

| Artifact | Path |
|---|---|
| Parent debug APK | `apps/parent-app/build/app/outputs/flutter-apk/app-debug.apk` |
| Child debug APK | `apps/child-app/build/app/outputs/flutter-apk/app-debug.apk` |

Paths confirmed against `.github/workflows/build-apk.yml`'s own upload step (`path: apps/${{ matrix.app }}/build/app/outputs/flutter-apk/app-debug.apk`). The debug variant signs with AGP's implicit debug key, which is untouched by everything in §15 — `apps/*/android/app/build.gradle` says so in as many words: *"debug builds keep working from a bare checkout with no key material."*

Debug builds also resolve `@xml/network_security_config` to `src/debug/res/xml/`, which is why the cleartext `10.0.2.2` default works at all (§11).

---

## 15. Release APK — everything in this section is a prerequisite

`STATIC VERIFIED`.

### 15a. The keystore. The file Gradle reads is `signing.properties`, **not** `key.properties`

`apps/*/android/app/build.gradle` reads `rootProject.file("signing.properties")`. `apps/*/android/.gitignore` ignores `signing.properties`, `*.jks`, `*.keystore`, `*.p12` and `*.pepk`, and commits `signing.properties.example` by explicit negation. `.github/workflows/build-apk.yml` writes `android/signing.properties`. Nothing in this repository reads `key.properties`.

Do this **per app**, in that app's `android\` directory. The keystore names and aliases below are the ones the committed templates already name:

```powershell
# parent — run from apps\parent-app\android\
keytool -genkeypair -v -keystore abny-parent-upload.jks -alias abny-parent-upload `
  -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12
copy signing.properties.example signing.properties

# child — run from apps\child-app\android\
keytool -genkeypair -v -keystore abny-child-upload.jks -alias abny-child-upload `
  -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12
copy signing.properties.example signing.properties
```

Then fill **all four** values in each `signing.properties`: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`. All four passwords are **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED** — use different store and key passwords, and store all of them in a password manager. `storeFile` resolves **relative to `apps/<app>/android/`**, so a bare filename works; an absolute path is better if you keep the keystore outside the working tree.

`-validity 10000` and `-storetype PKCS12` are the template's own terms, and it explains both: Play requires an upload key valid past 22 October 2033, and JKS is a format `keytool` warns about on every use.

**Never commit the keystore or `signing.properties`.** Both are gitignored; a private key one `git add -A` from the history is a key already lost. **Enrol in Play App Signing** — that single choice converts "lost the key, the app is dead, republish under a new package name and lose every install" into a support ticket.

The debug-signing guard is real and it is three independent layers in each `android/app/build.gradle`: **L1** structural (`buildTypes.release` is assigned `signingConfigs.release`, and the identifier `signingConfigs.debug` occurs nowhere else in the file), **L2** a `gradle.taskGraph.whenReady` guard that stops any `assemble|bundle|package|installRelease` task when `signing.properties` is missing, incomplete, names a keystore that is not there, or the version is on a fallback, and **L3** an identity assertion comparing the resolved release config against the debug one and rejecting well-known debug keystore names. `scripts/verify_release_signing.py` executes that guard's logic: **52 checks, 0 failures** — `RUNTIME VERIFIED` for the Python checker; the Gradle build itself has never run.

Get the SHA-256 for §13 with:

```powershell
keytool -list -v -keystore abny-parent-upload.jks -alias abny-parent-upload
```

### 15b. Version numbers

`apps/*/pubspec.yaml` carries `version: 0.1.0+1` — versionName + versionCode, and the **only** declaration of either in this repository. `flutter build` copies both halves into `android/local.properties`, which `app/build.gradle` reads. The release guard **refuses to package on a fallback version**, because Play accepts `versionCode 1` exactly once and then blocks every later upload. CI overrides the code half per upload via `ORG_GRADLE_PROJECT_abnyVersionCode`; **locally, bump the `+N` in `pubspec.yaml` before each upload.**

### 15c. The command

```powershell
$env:RELEASE_API_BASE_URL = "https://<your-host>/api/v1"
.\scripts\mobile-build.ps1 -App both -Release

# or by hand, per app
cd apps\parent-app
flutter build apk --release --dart-define=API_BASE_URL=https://<your-host>/api/v1 --dart-define=ENABLE_PUSH=true
```

| Artifact | Path |
|---|---|
| Parent release APK | `apps/parent-app/build/app/outputs/flutter-apk/app-release.apk` |
| Child release APK | `apps/child-app/build/app/outputs/flutter-apk/app-release.apk` |

The release APK is for **sideloaded QA on a physical phone**, not for the store — a tester cannot install an AAB. Same key, same defines, so what QA installs is what Play receives.

---

## 16. AAB — the artifact Play actually accepts

```powershell
cd apps\parent-app
flutter build appbundle --release --dart-define=API_BASE_URL=https://<your-host>/api/v1 --dart-define=ENABLE_PUSH=true
```

`.\scripts\mobile-build.ps1 -App both -Release` builds it as its last stage.

| Artifact | Path |
|---|---|
| Parent release AAB | `apps/parent-app/build/app/outputs/bundle/release/app-release.aab` |
| Child release AAB | `apps/child-app/build/app/outputs/bundle/release/app-release.aab` |

Path confirmed against `.github/workflows/build-apk.yml` (`path: apps/${{ matrix.app }}/build/app/outputs/bundle/release/app-release.aab`) and against both `signing.properties.example` files, which name the same location. Play has not accepted APKs for new apps since August 2021 — **the AAB is the upload.**

Before uploading, verify the signature: `python3 scripts\verify_release_signing.py`.

---

## 17. Installing on a device — `adb`

`adb` comes from `platform-tools` (§3) and lives at `%ANDROID_SDK_ROOT%\platform-tools\adb.exe`. **No build stage uses it**, which is why `release-doctor` grades a missing `adb` as `WARN` and not `BLOCKED` — it does not block a build, it blocks getting the build onto a phone.

On the phone: Settings → About phone → tap **Build number** seven times → Developer options → enable **USB debugging**. Connect by cable and accept the RSA fingerprint prompt on the phone.

```powershell
# 1. the phone must appear, with state "device" (not "unauthorized", not "offline")
adb devices

# 2. install. -r replaces an existing install and keeps its data.
adb install -r apps\parent-app\build\app\outputs\flutter-apk\app-debug.apk
adb install -r apps\child-app\build\app\outputs\flutter-apk\app-debug.apk

# 3. the two apps are separate Play identities and install side by side
adb shell pm list packages | findstr aifamilycoach
#   expect: package:com.aifamilycoach.parent_app
#           package:com.aifamilycoach.child_app

# 4. watch the app's own logs while you use it. Two steps, because PowerShell
#    does not substitute a command inside a bare --flag=value argument — and
#    NOT into $pid, which is a read-only automatic variable in PowerShell.
$appPid = (adb shell pidof -s com.aifamilycoach.parent_app).Trim()
adb logcat --pid=$appPid

# 5. exercise the deep-link scheme from outside the app
adb shell am start -a android.intent.action.VIEW -d "abny://notifications"

# 6. remove, between clean runs
adb uninstall com.aifamilycoach.parent_app
adb uninstall com.aifamilycoach.child_app
```

The two `applicationId`s and the `abny` scheme are read from `apps/*/android/app/build.gradle` and from `DEEP_LINK_SCHEME` in `apps/backend/src/modules/notifications/domain/engine/notification-destination.ts`; both manifests declare `<data android:scheme="abny" />` on the launcher activity, so step 5 resolves.

**Two install failures worth naming up front.** `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means a build signed with a different key is already installed — `adb uninstall` first; you cannot replace a debug-signed install with a release-signed one. `INSTALL_FAILED_USER_RESTRICTED` on Xiaomi/Redmi devices means "Install via USB" is off in Developer options.

---

## 18. Smoke test

**Do not improvise one.** The device smoke test is `GOLDEN_DEVICE_SMOKE_TEST.md`, at the repository root, written and owned separately from this document. Once §17 has the APK on the phone, that file — not this one — defines what to tap, in what order, and what counts as a pass.

This section owns only the `adb` mechanics above. Two mechanical preconditions the smoke test depends on and that belong here:

* The backend must be reachable from the phone at whatever `API_BASE_URL` the artifact was built with. A debug APK built with the `10.0.2.2` default reaches **nothing** on a physical device — rebuild with your LAN IP and make sure that host is in the cleartext allow-list named in §11, or Android refuses the connection with no error the app can show.
* Push notifications cannot be exercised at all on an artifact built without §13. `ENABLE_PUSH` is baked in at build time.

---

## 19. Known external blockers

`BLOCKED` — every one of these needs something outside this repository.

| # | Blocker | Consequence | Who clears it |
|---|---|---|---|
| 1 | **`pub.dev` answers 403** from the authoring container | `flutter pub get` has never run; there is **no `pubspec.lock` in either app** and none was fabricated. Until you run `pub get` and commit both lockfiles, two builds of the same commit can resolve different dependency versions and no artifact is reproducible | your machine, step 3–4 of §9 |
| 2 | **`storage.googleapis.com`, `dl.google.com`, `services.gradle.org` all 403** | no Flutter SDK, no Android SDK, no Gradle distribution could be installed or cached here | your machine / network |
| 3 | **No `flutter analyze` or `flutter test` has ever run** against these 23,860 lines of Dart | eight Python checkers stand in for them and all report zero problems — `dart_preflight` (a real static analyser: undefined members, arity, override mismatch, null-safety), `verify_dart_imports` (every directive resolves; every `package:` import is a declared dependency), `verify_l10n_parity` (every `t('…')` resolves in **both** locales), plus the notification-permission, accessibility, Gradle-syntax, network-security and release-signing checkers. That is real coverage and it has caught real defects, **but it is not a compiler. Expect the first `flutter analyze` to surface something** — most likely a type-inference or generic-variance detail no static checker here models. That is the cost of this blocker, not a sign the code is wrong | your machine |
| 4 | **No Firebase project exists** | parent-app push is unavailable and `firebase_options.dart` cannot be generated (§13) | you |
| 5 | **No upload keystore exists** | no release APK and no AAB (§15) | you |
| 6 | **No release backend URL exists** | `RELEASE_API_BASE_URL` is **HUMAN DECISION / ENVIRONMENT VALUE REQUIRED**; without it a release build is a crash-on-launch artifact (§11) | you |
| 7 | **No Google Play Console account / listing** | nothing can be uploaded, and the `applicationId` is immutable after the first upload | you |
| 8 | **The `applicationId` naming question is open** | `apps/*/android/signing.properties.example` records it as an open **HUMAN DECISION** (the EBNEY/ABNY question, `PROJECT_STATUS.md` §0 and `docs/release/IOS_READINESS.md`). The current values are `com.aifamilycoach.parent_app` and `com.aifamilycoach.child_app`. **Settle it before the first upload**, never after | you |
| 9 | **Every Dart test in this project is written-but-never-run** | their first execution is on your machine or in CI | your machine |
| 10 | **No PowerShell in the authoring container** | `scripts/release-doctor.ps1`, `scripts/mobile-build.ps1` and `scripts/setup-windows-dev.ps1` are `STATIC VERIFIED / CODE REVIEWED` and have **never been executed**. Their bash twins have run here. Treat your first run of each as its first real test | your machine |

---

## 20. What the gate is, and how to read it

`scripts/release-doctor.ps1` (and its bash twin `scripts/release-doctor.sh`) is **the single build gate**. It builds nothing and changes nothing. It prints, first, a **CHECK POLICY table** listing every check and whether a failure of it is `BLOCKED` (required) or `WARN` (advisory) — the classification is data, not scattered branches, and the two halves carry the same table so they cannot disagree. Then one classified line per check. Then the verdict.

* **A `WARN` never blocks.** It is a real gap that still permits a build attempt, or a requirement the run could not measure and refuses to claim as passed.
* **A `BLOCKED` always blocks**, and the run's **last line is `SHIP BLOCKED`**, with exit code 1. That token is printed in exactly one place, so `.\scripts\release-doctor.ps1 | Select-Object -Last 1` is usable as a machine gate.
* A run with nothing blocked ends on a line beginning `SHIP GATE PASSED`, exit 0.

The checks, and the specific things they exist to catch, are: Flutter · Dart · Java · **JAVA_HOME separately from PATH**, because Gradle prefers it · Android SDK root (and it must actually contain an SDK, not merely exist) · platform `android-34` · build-tools present, and separately the exact `34.0.0` · adb · Gradle wrapper · the Gradle distribution (cached, **or** `services.gradle.org` reachable) · compileSdk against the AGP ceiling · `minSdk ≤ targetSdk ≤ compileSdk` · pub.dev reachability · both lockfiles · every `package:` import declared · Firebase per app · `firebase_options.dart` · signing per app · the signing gitignore · the app version's `+<code>` · the two package IDs differing · `namespace` equalling `applicationId` in each app · `RELEASE_API_BASE_URL` · manifest permissions · `POST_NOTIFICATIONS` actually requested at runtime · the `abny://` intent-filter · working-tree cleanliness.

Two properties of that list are deliberate and worth trusting:

* **No check passes because something was absent.** A missing command, an unset variable, an unreadable file or a regex that found nothing produces `BLOCKED`, or `WARN` with the words `NOT VERIFIED` — never `PASS`.
* **The doctor checks every precondition `mobile-build` depends on.** If a build would fail on something the doctor passed, that is a defect in the doctor, and it is the one defect a gate must not have.

Run the debug profile first (`-Profile debug`); it is the shorter list, and clearing it is what gets you §14.
