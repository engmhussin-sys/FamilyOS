# ABNY — WINDOWS PROCEDURE

**This is the only procedure.** Eight steps, in order. If another document disagrees with this one, this one wins.

Goal: a debug APK on a real Android phone. Not the Play Store, not a signed release — the first artifact, which needs no Firebase, no keystore and no store account.

---

## STEP 1 — Get the branch

Download `ABNY-commits.bundle`, then from inside your local clone:

```powershell
git fetch C:\path\to\ABNY-commits.bundle abny/sprint-f1-unblock:abny/sprint-f1-unblock
git checkout abny/sprint-f1-unblock
git push origin abny/sprint-f1-unblock
```

The bundle carries the complete history — 263 commits. The push is optional for building and necessary for everything after.

## STEP 2 — Install the toolchain

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows-dev.ps1
```

Installs and pins Flutter, the Android SDK and JDK 17. Close and reopen the terminal afterwards so `PATH` and `JAVA_HOME` take effect.

## STEP 3 — Run the doctor **in the debug profile**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1 -Profile debug
```

**Use `-Profile debug` for the first APK.** The default is `release`, which correctly blocks on Firebase, the keystore, `pubspec.lock` and an https API URL — none of which a debug build needs. In the debug profile those five checks degrade to `WARN` and cannot stop you.

Every check prints `PASS`, `WARN` or `BLOCKED`. `WARN` never stops you. If anything is `BLOCKED` the run ends with the literal line:

```
SHIP BLOCKED
```

The doctor runs 31 checks. In the debug profile **19 can block**, and of those only the nine below are things you install — the other ten are facts about the repository that already pass.

## STEP 4 — Clear every BLOCKED

Each `BLOCKED` line names a check id. This table is the complete set of ids that can block a debug build for an environment reason, in the order the doctor reports them. Nothing else needs installing.

| Check id | Dependency | Exact version | Source | Command | Verify |
|---|---|---|---|---|---|
| `flutter` | Flutter SDK | **3.47.1** stable | `docs.flutter.dev/get-started/install/windows` — or `scripts\setup-windows-dev.ps1` does it | Unzip to `C:\src\flutter`, add `C:\src\flutter\bin` to `PATH` | `flutter --version` → `Flutter 3.47.1` |
| `dart` | Dart SDK | bundled in Flutter 3.47.1 (both apps require `>=3.3.0 <4.0.0`) | Comes with Flutter — **do not install separately** | none | `dart --version` |
| `java` | JDK | **17** (Temurin) | `adoptium.net/temurin/releases/?version=17` | Run the `.msi`, accept the defaults | `java -version` → `17.x` |
| `java-home` | `JAVA_HOME` | points at the JDK 17 root | environment variable | `setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-17…"` then reopen the terminal | `echo %JAVA_HOME%` and `%JAVA_HOME%\bin\java -version` |
| `android-sdk` | Android SDK root | — | Android Studio, or `commandlinetools-win-11076708_latest.zip` from `developer.android.com/studio` | `setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"`, reopen the terminal | `echo %ANDROID_HOME%` and the folder contains `platform-tools` |
| `android-platform` | Platform | **android-34** | `sdkmanager` | `sdkmanager "platforms;android-34"` | `%ANDROID_HOME%\platforms\android-34` exists |
| `android-buildtools` | Build tools | **34.0.0** | `sdkmanager` | `sdkmanager "build-tools;34.0.0"` | `%ANDROID_HOME%\build-tools\34.0.0` exists |
| `gradle-dist` | Gradle | **8.3**, via the wrapper | `services.gradle.org` | Nothing to install — just be online the first time; the wrapper downloads and caches it | `dir %USERPROFILE%\.gradle\wrapper\dists` |
| `pub-access` | pub.dev reachable | — | network | Nothing to install — `flutter pub get` is stage 1 of the build | `flutter pub get` inside `apps\parent-app` succeeds |

Not blocking, but you need it in STEP 6:

| Check id | Dependency | Command | Verify |
|---|---|---|---|
| `adb` | platform-tools | `sdkmanager "platform-tools"`, then add `%ANDROID_HOME%\platform-tools` to `PATH` | `adb version` |

**Do not install anything that is not on this list.** If the doctor blocks on an id that is not here, it is one of the ten repository checks (`gradle-wrapper`, `gradle-agp-sdk`, `sdk-levels`, `packages`, `signing-gitignore`, `app-version`, `package-ids`, `application-ids`, `permissions`, `notif-request`) — those are code facts that pass today, so a block there means something changed in the tree. Send me the line rather than editing.

Re-run STEP 3 until the run does **not** end in `SHIP BLOCKED`.

## STEP 5 — Build

Start the backend first and note your LAN IP (see below), then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\mobile-build.ps1 -ApiBaseUrl "http://<your-lan-ip>:3000"
```

No `-Release` — that is the debug path, and it is the one that needs no Firebase and no keystore.

Produces:

```
apps\parent-app\build\app\outputs\flutter-apk\app-debug.apk
apps\child-app\build\app\outputs\flutter-apk\app-debug.apk
```

**This is the first time Flutter code in this repository has ever been compiled.** Expect the analyzer or Gradle to have something to say. That is not a sign the work is wrong — it is the cost of nine static checkers standing in for a compiler. The build log names the file and line.

Before this step, start the backend and note your LAN IP — the phones cannot reach `localhost`:

```powershell
docker compose up -d
cd apps\backend
npx prisma migrate deploy
npm run start:dev
ipconfig      # take the IPv4 address on your Wi-Fi adapter
```

`MOBILE_BUILD_HANDOFF.md` §14 has the exact `--dart-define=API_BASE_URL=http://<your-lan-ip>:3000` form.

## STEP 6 — Install on the phones

```powershell
adb devices
adb -s <parent-device-id> install -r apps\parent-app\build\app\outputs\flutter-apk\app-debug.apk
adb -s <child-device-id>  install -r apps\child-app\build\app\outputs\flutter-apk\app-debug.apk
```

Two phones: one parent, one child. Both on the same Wi-Fi as your machine.

## STEP 7 — Run the Golden Device Smoke Test

`GOLDEN_DEVICE_SMOKE_TEST.md`, seventeen steps, one pass, top to bottom. Do not fix as you go — finish the pass first so one build teaches you everything it can.

## STEP 8 — Capture the result

**First, the build evidence.** This is the first real mobile evidence this project has ever had — everything before it is static analysis. Run this after STEP 5 and paste the whole output:

```powershell
flutter --version
java -version
$env:ANDROID_HOME
$apk = "apps\parent-app\build\app\outputs\flutter-apk\app-debug.apk"
Get-Item $apk | Select-Object FullName, Length, LastWriteTime
Get-FileHash $apk -Algorithm SHA256
adb devices -l
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
```

Plus the build's own exit code (`$LASTEXITCODE` immediately after STEP 5) and whether each app launched.

**Then the smoke test.** For each of the seventeen steps in `GOLDEN_DEVICE_SMOKE_TEST.md`: `PASS` / `FAIL` / `BLOCKED`, the screen name, and the verbatim message on any failure. Screenshots of failures.

Send back the failing step numbers with their messages. That is enough to fix without another round trip.

---

## If STEP 5 fails

The build log names the file and the line. Send that line. Do not start editing app code to make the build pass — the codebase is feature frozen, and a compile error is a small, local, known-shaped fix.

## If a step in STEP 7 fails

Only five things stop the pass: a crash, an authorization hole, a child-safety failure, data loss, or an unbuildable APK. Everything else is recorded and the pass continues.
