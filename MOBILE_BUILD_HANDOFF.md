# MOBILE BUILD HANDOFF — Windows

Everything below is the complete set of things this cloud container cannot do and your machine can. No analysis, no options: the versions are pinned by the repository and CI fails the build if the runner disagrees with them.

**Why this file exists.** `pub.dev`, `dl.google.com`, `storage.googleapis.com` and `services.gradle.org` all return 403 from the container this project was built in, so no Flutter SDK, Dart SDK or Android SDK could be installed and **no `flutter` command has ever run against this repository.** Every mobile result in `SHIP_BOARD.md` is labelled `STATIC VERIFIED` for that reason. This is the one blocker no amount of code can clear.

---

## 1. Required toolchain — exact versions, not minimums

| Component | Pinned version | Where the pin lives | What happens if you use another |
|---|---|---|---|
| **Flutter** | `3.24.5` | `.github/workflows/build-apk.yml` → `env.FLUTTER_VERSION` | 3.27+ defaults `compileSdk` to 35; AGP 8.1.1 in `android/settings.gradle` refuses anything above 34 |
| **JDK** | `17` | `.github/workflows/build-apk.yml` → `env.JAVA_VERSION` | `gradle-wrapper.properties` pins Gradle 8.3, which only learned to *run* on JDK 21 in 8.5. On JDK 21 the build dies with `Unsupported class file major version` before compiling anything |
| **Gradle** | `8.3` | `android/gradle/wrapper/gradle-wrapper.properties` | Use the wrapper (`gradlew`), never a system Gradle |
| **Android SDK** | `compileSdk 34`, build-tools 34 | `android/app/build.gradle` | See the AGP note above |
| **Android Studio** | optional | — | Only the SDK + platform-tools are required |

`.\scripts\setup-windows-dev.ps1` installs all of the above from 11 pins derived from the repository itself. It has **never been executed** — no PowerShell exists in the container — so treat its first run as the first real test of it.

---

## 2. Firebase — the one thing nobody can generate for you

Two Android apps, two separate Firebase app registrations in one Firebase project:

| App | `applicationId` | File to place at |
|---|---|---|
| Parent | `com.aifamilycoach.parent_app` | `apps/parent-app/android/app/google-services.json` |
| Child | `com.aifamilycoach.child_app` | `apps/child-app/android/app/google-services.json` |

Steps: create the Firebase project → add an Android app for **each** `applicationId` above → download each `google-services.json` → place it at the path shown → add the **SHA-256** fingerprint of your release keystore (§3) to both Firebase apps → enable **Cloud Messaging**.

`docs/mobile/REQUIRED-CREDENTIALS.md` holds the full field list. **No `google-services.json` was fabricated anywhere in this repository** — a placeholder that builds and then silently fails to deliver a notification is worse than a missing file that fails loudly.

---

## 3. Release keystore

```powershell
keytool -genkeypair -v -keystore abny-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias abny
```

Then create `android/key.properties` (or `signing.properties` — check the app's `build.gradle`) for **each** app with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.

Never commit the keystore or the properties file. The release-signing guard (52 executed checks, all passing) already refuses a release build that resolves to the debug config, names a keystore that is not there, or falls through to a fallback `versionCode` — so a mis-configured signing setup fails the build rather than shipping an unsignable artifact.

Get the SHA-256 for Firebase with:

```powershell
keytool -list -v -keystore abny-release.jks -alias abny
```

---

## 4. Exact commands, in order

```powershell
# 0. one-time toolchain install
.\scripts\setup-windows-dev.ps1

# 1. gate — repeat until it reports 0 BLOCKED
.\scripts\release-doctor.ps1
#    last run in the cloud container: 5 PASS / 0 WARN / 14 BLOCKED, exit 1
#    every one of the 14 is an absent SDK, JDK, credential or keystore

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

# 4. artifacts
cd ..\..
.\scripts\mobile-build.ps1 -App both
```

---

## 5. Expected artifacts

| Artifact | Path |
|---|---|
| Parent debug APK | `apps/parent-app/build/app/outputs/flutter-apk/app-debug.apk` |
| Child debug APK | `apps/child-app/build/app/outputs/flutter-apk/app-debug.apk` |
| Parent release AAB | `apps/parent-app/build/app/outputs/bundle/release/app-release.aab` |
| Child release AAB | `apps/child-app/build/app/outputs/bundle/release/app-release.aab` |

Debug APKs are what you install to walk the vertical slice on a real phone. The AAB is the Play Store upload format.

---

## 6. What to expect on the first run, honestly

`flutter analyze` and `flutter test` have **never executed** against this repository. Eight Python checkers stand in for them and all report zero problems — `dart_preflight` (a real static analyser: undefined members, arity, override mismatch, null-safety), `verify_dart_imports` (every directive resolves; dependency fingerprint unchanged), `verify_l10n_parity` (every `t('…')` call site resolves in **both** locales), plus the notification-permission, accessibility, Gradle-syntax, network-security and release-signing checkers.

That is real coverage and it has caught real defects, but it is not a compiler. **Expect the first `flutter analyze` to surface something**, most likely a type inference or generic-variance detail no static checker here models. That is the normal cost of the blocker, not a sign the code is wrong.

Every Dart test written in this project is written-but-never-run. Their first execution is on your machine or in CI.

---

## 7. After the first successful install

The backend half of the full vertical slice is `RUNTIME VERIFIED` against real PostgreSQL, real Redis and a real booted HTTP app — register → family with country → child → invite → redeem → activate → goal → child completes → server verifies → reward granted exactly once → distinct parent and child notifications → timeline → admin counter, then replayed with all four counts still exactly 1.

On a real device, walk that same path and confirm the one thing no test here can: that **push notifications actually arrive**. FCM token *delivery* is Claude #1's workstream; the ABNY-side contract (the `POST /pairing/device/push-token` route, its persistence, and invalidation on permanent failure) is in place, and the child app's token **acquisition** is deliberately not implemented — it needs `firebase_messaging`, which could not be added here without a resolvable package registry.
