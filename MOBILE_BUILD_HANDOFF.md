# MOBILE BUILD HANDOFF — Windows

Everything below is the complete set of things this cloud container cannot do and your machine can. No analysis, no options: the versions are pinned by the repository and CI fails the build if the runner disagrees with them.

**Why this file exists.** `pub.dev`, `dl.google.com`, `storage.googleapis.com` and `services.gradle.org` all return 403 from the container this project was built in, so no Flutter SDK, Dart SDK or Android SDK could be installed and **no `flutter` command has ever run against this repository.** Every mobile result in `SHIP_BOARD.md` is labelled `STATIC VERIFIED` for that reason. This is the one blocker no amount of code can clear.

**Evidence labels used below.** `STATIC VERIFIED` = read out of the committed files, no execution. `RUNTIME VERIFIED` = a process actually ran and its output was read. `BLOCKED` = requires something this container does not have. Nothing here is `BUILD VERIFIED`, because nothing has been built.

---

## 1. Required toolchain — exact versions, not minimums

Every value in this table was re-read from the file named beside it. `STATIC VERIFIED`.

| Component | Pinned value | Where the pin lives | What happens if you use another |
|---|---|---|---|
| **Flutter** | `3.24.5` | `.github/workflows/build-apk.yml` → `env.FLUTTER_VERSION` | 3.27+ defaults `compileSdk` to 35; AGP 8.1.1 refuses anything above 34 |
| **Dart SDK** | `>=3.3.0 <4.0.0` | `apps/*/pubspec.yaml` → `environment.sdk` (identical in both apps) | Use the Dart bundled inside Flutter 3.24.5; a standalone Dart SDK drifts from the pin |
| **JDK** | `17` | `.github/workflows/build-apk.yml` → `env.JAVA_VERSION`; also `sourceCompatibility`/`targetCompatibility`/`jvmTarget` = `VERSION_17` in both `android/app/build.gradle` | `gradle-wrapper.properties` pins Gradle 8.3, which only learned to *run* on JDK 21 in 8.5. On JDK 21 the build dies with `Unsupported class file major version` before compiling anything |
| **Gradle wrapper** | `8.3` | `apps/*/android/gradle/wrapper/gradle-wrapper.properties` (`gradle-8.3-bin.zip`, identical in both apps) | Use the wrapper (`gradlew`), never a system Gradle |
| **Android Gradle Plugin** | `8.1.1` | `apps/*/android/settings.gradle` → `id "com.android.application" version "8.1.1"` | AGP 8.1.1 hard-refuses `compileSdk` > 34 |
| **Kotlin plugin** | `1.9.10` | `apps/*/android/settings.gradle` → `id "org.jetbrains.kotlin.android"` | — |
| **compileSdk** | `34` | `apps/*/android/app/build.gradle` (a literal, deliberately not `flutter.compileSdkVersion`) | See the AGP note above |
| **targetSdk** | `34` | `apps/*/android/app/build.gradle` | 34 is what makes the child app's `FOREGROUND_SERVICE_SPECIAL_USE` declaration the correct form |
| **minSdk** | `21` | `apps/*/android/app/build.gradle` | 21 is Flutter 3.24.5's floor and satisfies `firebase-bom:33.1.2` |
| **Android platform** | `platforms;android-34` | derived from `compileSdk` | `sdkmanager "platforms;android-34"` |
| **Android build-tools** | `34.0.0` | **not declared anywhere** — derived as `<compileSdk>.0.0` | Neither app sets `buildToolsVersion`, so AGP picks its own default; installing `34.0.0` matches the derivation exactly |
| **NDK** | not pinned | both gradles keep `ndkVersion flutter.ndkVersion` | No NDK is installed; if a plugin ever needs one Gradle names it |
| **Android Studio** | optional | — | Only the SDK + platform-tools are required |

`.\scripts\setup-windows-dev.ps1` installs all of the above. It reads **ten pins out of this repository at run time** (Flutter, JDK, Gradle, AGP, Kotlin, compileSdk, targetSdk, minSdk, Dart constraint, API_BASE_URL) and **derives** build-tools from compileSdk, printing that it did so. It parses both apps independently and stops rather than picking a winner if they disagree. It has **never been executed** — no PowerShell exists in the container — so treat its first run as the first real test of it. `STATIC VERIFIED`.

---

## 2. Firebase — the one thing nobody can generate for you

**Only the parent app uses Firebase.** `STATIC VERIFIED`:

| App | Needs `google-services.json`? | Evidence |
|---|---|---|
| **Parent** (`com.aifamilycoach.parent_app`) | **Yes** | `pubspec.yaml` declares `firebase_core: ^3.6.0` and `firebase_messaging: ^15.1.3`; `android/settings.gradle` declares `com.google.gms.google-services` version `4.4.2`; `android/app/build.gradle` applies it conditionally and depends on `firebase-bom:33.1.2` |
| **Child** (`com.aifamilycoach.child_app`) | **No** | no `firebase_*` dependency in `pubspec.yaml`, no `google-services` plugin in `android/settings.gradle`, no `apply plugin` in `android/app/build.gradle`. Nothing in the child build reads that file, and §7 below says why: the child app's FCM token acquisition is deliberately not implemented |

So, for the parent app only:

1. Create the Firebase project.
2. Add an **Android app** for `applicationId` **`com.aifamilycoach.parent_app`** (exact string, from `apps/parent-app/android/app/build.gradle`).
3. Download `google-services.json` and place it at **`apps/parent-app/android/app/google-services.json`**.
4. Add the **SHA-256** fingerprint of your release keystore (§3) to that Firebase app.
5. Enable **Cloud Messaging**.
6. Generate `apps/parent-app/lib/firebase_options.dart` with `flutterfire configure`. It is **absent** today and only that command, against a real project, can produce it.

**The build does NOT stop when the file is missing.** `android/app/build.gradle` defaults to `-Pabny.firebase=auto`, which prints a loud warning and continues; `PushRegistrationService` catches the init failure and the app runs with push disabled. That is correct for a debug APK and wrong for a store release — a release built in that state is a signed, uploadable artifact in which **every push notification silently never arrives**. Both `scripts/release-doctor.ps1` (BLOCKED row) and `scripts/mobile-build.ps1 -Release` (RELEASE PREFLIGHT) now refuse it by name; CI does the same (`RELEASE BUILD REQUESTED FOR THE PARENT APP WITHOUT FIREBASE`).

`docs/mobile/REQUIRED-CREDENTIALS.md` holds the full field list. **No `google-services.json` was fabricated anywhere in this repository** — a placeholder that builds and then silently fails to deliver a notification is worse than a missing file that fails loudly. `BLOCKED` here: only you can create it.

---

## 3. Release keystore and signing

**The file the Gradle reads is `signing.properties`, not `key.properties`.** `apps/*/android/app/build.gradle` reads `rootProject.file("signing.properties")`; `apps/*/android/.gitignore` ignores `signing.properties` and `*.jks`, `*.keystore`, `*.p12`, `*.pepk`, and commits `signing.properties.example` by explicit negation. `STATIC VERIFIED`.

Do this **per app**, in that app's `android/` directory. The keystore filenames and aliases below are the ones the committed templates already name:

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

Then fill all four values in each `signing.properties`: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`. `storeFile` is resolved **relative to `apps/<app>/android/`**, so a bare filename works; an absolute path also works and is better if you keep the keystore outside the working tree. Use **different** store and key passwords — `signing.properties.example` explains every flag, including why `-validity 10000` (Play requires an upload key valid past 22 October 2033) and why `-storetype PKCS12`.

**Never commit the keystore or `signing.properties`.** Both are gitignored; a private key one `git add -A` from the history is a key already lost.

**The debug-signing guard is real, and it is three independent layers** in each `android/app/build.gradle` — L1 structural (`buildTypes.release` is assigned `signingConfigs.release` and the identifier `signingConfigs.debug` occurs nowhere else), L2 a `gradle.taskGraph.whenReady` guard that stops any `assemble/bundle/package/installRelease` task when `signing.properties` is missing, incomplete, names a keystore that is not there, or the version is on a fallback, and L3 an identity assertion comparing the resolved release config against the debug one and rejecting well-known debug keystore names. `scripts/verify_release_signing.py` executes that guard's logic: **52 checks, 0 failures** — `RUNTIME VERIFIED` (the Python checker ran; the Gradle build did not).

Get the SHA-256 for Firebase with:

```powershell
keytool -list -v -keystore abny-parent-upload.jks -alias abny-parent-upload
```

**Version numbers.** `apps/*/pubspec.yaml` carries `version: 0.1.0+1` — versionName + versionCode, and the *only* declaration of either in the repository. The release guard **refuses to package on a fallback version**, because Play accepts `versionCode 1` exactly once and then blocks every later upload. CI overrides the code half per upload via `ORG_GRADLE_PROJECT_abnyVersionCode`; locally, bump the `+N` in `pubspec.yaml` before each upload.

---

## 4. Exact commands, in order

```powershell
# 0. one-time toolchain install
.\scripts\setup-windows-dev.ps1

# 1. gate — repeat until it reports 0 BLOCKED
.\scripts\release-doctor.ps1
#    Debug-only readiness instead:  .\scripts\release-doctor.ps1 -Profile debug

# 2. push first — CI cannot build what it cannot see
git push origin abny/sprint-f1-unblock

# 3. per app
cd apps\parent-app
flutter pub get
flutter analyze
flutter test
cd ..\child-app
flutter pub get
flutter analyze
flutter test

# 4a. debug artifacts (no keystore, no Firebase needed)
cd ..\..
.\scripts\mobile-build.ps1 -App both

# 4b. release artifacts — needs §2 and §3 done first.
#     The RELEASE PREFLIGHT runs before any stage and names every missing file.
.\scripts\mobile-build.ps1 -App both -Release
```

The last recorded doctor run in the cloud container was of the **bash twin**, `scripts/release-doctor.sh`: **5 PASS / 0 WARN / 14 BLOCKED, exit 1** — `RUNTIME VERIFIED` for that file. Every one of the 14 was an absent SDK, JDK, credential or keystore. `scripts/release-doctor.ps1` has **never been executed** and its first run on your machine is its first measurement; it now also carries three corrections the `.sh` does not (see §8), so expect its row *names* to differ.

---

## 5. Expected artifacts

| Artifact | Path | Produced by |
|---|---|---|
| Parent debug APK | `apps/parent-app/build/app/outputs/flutter-apk/app-debug.apk` | step 4a |
| Child debug APK | `apps/child-app/build/app/outputs/flutter-apk/app-debug.apk` | step 4a |
| Parent release APK | `apps/parent-app/build/app/outputs/flutter-apk/app-release.apk` | step 4b |
| Child release APK | `apps/child-app/build/app/outputs/flutter-apk/app-release.apk` | step 4b |
| Parent release AAB | `apps/parent-app/build/app/outputs/bundle/release/app-release.aab` | step 4b |
| Child release AAB | `apps/child-app/build/app/outputs/bundle/release/app-release.aab` | step 4b |

Debug APKs are what you install to walk the vertical slice on a real phone. The AAB is the Play Store upload format. **Step 4a produces no release artifact** — the release rows require `-Release`.

---

## 6. Permissions and the deep-link scheme

**`POST_NOTIFICATIONS` is declared by both apps** (`android/app/src/main/AndroidManifest.xml`; parent declares 2 permissions, child declares 10) **and is also requested at runtime by both** — `scripts/verify_notification_permission.py` exits 0, which is the check that catches a permission declared and never asked for. On Android 13+ an unrequested `POST_NOTIFICATIONS` means notifications silently never appear. `RUNTIME VERIFIED` (the Python checker ran).

**The `abny://` scheme is NOT registered in either AndroidManifest.xml.** `STATIC VERIFIED` — neither manifest contains a `<data android:scheme="abny">` element; the only `<intent-filter>` in each is `MAIN`/`LAUNCHER` (plus the child app's accessibility-service and `BOOT_COMPLETED` filters). What this does and does not break:

* **In-app notification taps are unaffected.** The server resolves `abny://<surface>[/<id>]` and puts it on the FCM `data` payload under `deepLink`; both Dart routers (`apps/parent-app/lib/core/routing/deep_link_router.dart`, `apps/child-app/lib/core/routing/child_deep_link_router.dart`) parse the string themselves. No OS intent resolution is involved.
* **An `abny://` link outside the app resolves to nothing** — tapped in a browser, an SMS, an e-mail or another app, Android finds no handler.

That is a gap in `apps/parent-app/` and `apps/child-app/`, which this workstream does not own. `scripts/release-doctor.ps1` now reports it as a **WARN** row per app, reading the scheme itself from the server's registry (`apps/backend/src/.../notification-destination.ts` → `DEEP_LINK_SCHEME`) rather than typing it from memory, so the two can never silently disagree.

---

## 7. What to expect on the first run, honestly

`flutter analyze` and `flutter test` have **never executed** against this repository. Eight Python checkers stand in for them and all report zero problems — `dart_preflight` (a real static analyser: undefined members, arity, override mismatch, null-safety), `verify_dart_imports` (every directive resolves; dependency fingerprint unchanged), `verify_l10n_parity` (every `t('…')` call site resolves in **both** locales), plus the notification-permission, accessibility, Gradle-syntax, network-security and release-signing checkers.

That is real coverage and it has caught real defects, but it is not a compiler. **Expect the first `flutter analyze` to surface something**, most likely a type inference or generic-variance detail no static checker here models. That is the normal cost of the blocker, not a sign the code is wrong.

There is **no `pubspec.lock` in either app** and none was fabricated. Until `flutter pub get` runs on your machine and the resulting lockfiles are committed, two builds of the same commit can resolve different dependency versions and no artifact is reproducible. `scripts/release-doctor.ps1` grades this BLOCKED for exactly that reason.

Every Dart test written in this project is written-but-never-run. Their first execution is on your machine or in CI.

---

## 8. What changed in the scripts, so you are not reading a stale one

Three defects were found by re-reading every claim these scripts make against the repository as it exists now. All three are fixed in the `.ps1` files; **the `.sh` twins still carry them** and need the same corrections from whoever owns them.

| Where | Was | Is |
|---|---|---|
| `release-doctor.ps1` §9 | checked `android/key.properties` | checks `android/signing.properties` — the file `app/build.gradle` and CI actually use. The doctor could previously PASS a machine whose release build then stopped in the Gradle guard |
| `release-doctor.ps1` §8 | demanded `google-services.json` from **both** apps, BLOCKED on the child's absent one | derives the requirement per app from `pubspec.yaml` + `settings.gradle` + `app/build.gradle`; the child app declares no Firebase, so its row is PASS/not-required |
| `release-doctor.ps1` keytool line | `abny-release.jks`, `-keysize 2048`, `-alias abny` | the values from `signing.properties.example`: per-app keystore name and alias, `-keysize 4096`, `-storetype PKCS12` |
| `release-doctor.ps1` new rows | — | app version (`<name>+<code>`, a release-stopping Gradle guard), `signing.properties`/`*.jks` gitignore, debug-keystore detection (mirrors L3), `abny://` scheme in both manifests |
| `mobile-build.ps1 -Release` | ran four stages, then failed inside Gradle on missing signing material; built a push-less parent release silently | RELEASE PREFLIGHT before the first stage: `signing.properties` present + complete + keystore resolves, and `google-services.json` for the app that declares Firebase. Each blocker names the file, the directory and the command |
| `verification-script.ps1`, `verification-script-en.ps1` | hardcoded a live deployment URL, an account e-mail and its password | `-BaseUrl` / `-Email` / `-Password` (or `ABNY_VERIFY_*` env vars), with no defaults and a loud refusal. **The old password is still in git history — rotate that account.** |

Both `.ps1` build scripts are **STATIC VERIFIED / NEVER EXECUTED**. There is no PowerShell in the authoring container, so no claim in this document about their runtime behaviour exists, and none should be made until you run them.

---

## 9. After the first successful install

The backend half of the full vertical slice is `RUNTIME VERIFIED` against real PostgreSQL, real Redis and a real booted HTTP app — register → family with country → child → invite → redeem → activate → goal → child completes → server verifies → reward granted exactly once → distinct parent and child notifications → timeline → admin counter, then replayed with all four counts still exactly 1.

On a real device, walk that same path and confirm the one thing no test here can: that **push notifications actually arrive**. FCM token *delivery* is Claude #1's workstream; the ABNY-side contract (the `POST /pairing/device/push-token` route, its persistence, and invalidation on permanent failure) is in place, and the child app's token **acquisition** is deliberately not implemented — it needs `firebase_messaging`, which could not be added here without a resolvable package registry. That is also why §2 requires a `google-services.json` for the parent app only.
