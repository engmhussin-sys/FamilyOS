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

## STEP 3 — Run the doctor

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-doctor.ps1
```

Every check prints `PASS`, `WARN` or `BLOCKED`. `WARN` never stops you. If anything is `BLOCKED` the run ends with the literal line:

```
SHIP BLOCKED
```

## STEP 4 — Clear every BLOCKED

Each `BLOCKED` line names the missing file, directory or command. Fix them and re-run STEP 3 until the run does **not** end in `SHIP BLOCKED`.

For the debug APK you do **not** need Firebase or a keystore — those are `WARN` on this path. If the doctor blocks on either while you are building debug, that is a doctor defect worth reporting.

## STEP 5 — Build

```powershell
powershell -ExecutionPolicy Bypass -File scripts\mobile-build.ps1
```

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

For each of the seventeen steps: `PASS` / `FAIL` / `BLOCKED`, the screen name, and the verbatim message on any failure. Screenshots of failures.

Send back the failing step numbers with their messages. That is enough to fix without another round trip.

---

## If STEP 5 fails

The build log names the file and the line. Send that line. Do not start editing app code to make the build pass — the codebase is feature frozen, and a compile error is a small, local, known-shaped fix.

## If a step in STEP 7 fails

Only five things stop the pass: a crash, an authorization hole, a child-safety failure, data loss, or an unbuildable APK. Everything else is recorded and the pass continues.
