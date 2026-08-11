# SPRINT 17.2 — MOBILE REAL-ENVIRONMENT VALIDATION & DEVICE BRING-UP

**Date:** 2026-08-11

---

## HEADLINE FINDING (read this first)

This Sprint made real progress on the **environment** side (real Android tools installed and working, for the first time in this project's history) and made a **critical, previously-undiscovered finding** on the **project** side: **neither mobile app has a complete, buildable platform scaffold**, independent of any tooling availability. This is a **PROJECT BUG**, not an Environment Blocker, and this report does not conflate the two.

- **Child App**: has `android/app/src/main/` (Manifest, Kotlin source, resources) but is **missing `android/build.gradle`, `android/app/build.gradle`, `android/settings.gradle`, and the Gradle wrapper entirely**. Confirmed via `git log --all` across the full project history: **no commit has ever added these files.**
- **Parent App**: is missing **any platform folder at all** — no `android/`, no `ios/`, no `test/`. Only `lib/`, `pubspec.yaml`, and documentation files exist.

**This means: even with a fully working Flutter/Dart/Android SDK toolchain, `flutter build apk` would fail immediately for both apps today, for a reason that has nothing to do with this sandbox's network restrictions.** This is the single most important finding of this Sprint.

---

## 1. Environment Discovery (Phase 1)

| Tool | Status | Version/Path |
|---|---|---|
| Java/JDK | Available | OpenJDK 21.0.10, `/usr/bin/java` |
| adb | NEWLY INSTALLED, WORKING | Android Debug Bridge 1.0.41 (v34.0.4), `/usr/bin/adb`, daemon starts successfully |
| aapt | NEWLY INSTALLED, WORKING | v0.2-debian, `/usr/bin/aapt` |
| aidl | NEWLY INSTALLED | v10.0.0+r36-4, `/usr/bin/aidl` |
| zipalign | NEWLY INSTALLED | v10.0.0+r36, `/usr/bin/zipalign` |
| gradle | NEWLY INSTALLED but incompatible | 4.4.1 (2017-era Ubuntu archives) -- far too old for any modern Android Gradle Plugin; real builds need the project's own Gradle Wrapper, which needs `services.gradle.org` (unreachable) |
| Flutter SDK | BLOCKED -- confirmed, see Phase 2 | N/A |
| Dart SDK | BLOCKED -- confirmed, see Phase 2 | N/A |
| Android full SDK | Partial only | aapt/aidl/zipalign present individually via apt; no sdkmanager, no installed platforms, no licenses accepted |
| Emulator/device | None | `adb devices` runs successfully but lists zero devices (correct, honest -- none exist here) |

**This is real, evidence-based progress**: this sandbox previously had zero working Android tooling. It now has a real, working `adb`, `aapt`, `aidl`, and `zipalign` -- genuine binaries installed from Ubuntu's own package archives (within the network allowlist), not simulated.

## 2. Flutter SDK Recovery (Phase 2)

Multiple real recovery attempts made this Sprint:

1. `git clone` Flutter from GitHub: succeeded (as in Sprint 17.1).
2. `flutter --version`: failed -- attempts to download the Dart SDK from `storage.googleapis.com`, confirmed unreachable.
3. `apt-cache search dart`: zero relevant results -- Ubuntu's `dart` packages are unrelated physics/robotics libraries.
4. GitHub Releases for `dart-lang/sdk`: checked via the real GitHub API -- zero downloadable assets exist there; Dart SDK binaries are distributed exclusively via Google's own CDN.

**Exact failure details:**
- **URL requested:** `https://storage.googleapis.com/flutter_infra_release/flutter/<engine-hash>/dart-sdk-linux-x64.zip`
- **Reason:** domain not in this sandbox's network allowlist.
- **File size received:** 109 bytes (an error response, not a real SDK archive).
- **Command that failed:** `flutter --version`.
- **Classification: ENVIRONMENT BLOCKER**, confirmed exhaustively.

## 3. Child App Static Audit (Phase 3)

- **AndroidManifest.xml**: present, structurally valid; real permission set confirmed (INTERNET, SYSTEM_ALERT_WINDOW, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE, RECEIVE_BOOT_COMPLETED, POST_NOTIFICATIONS, PACKAGE_USAGE_STATS, SCHEDULE_EXACT_ALARM, USE_EXACT_ALARM, WAKE_LOCK); AccessibilityService declared correctly.
- `aapt dump badging` attempted directly against source AndroidManifest.xml -- failed ("no AndroidManifest.xml found") because aapt expects a *compiled* manifest inside an APK, not raw source XML. Tool-usage limitation, not a project defect.
- **MISSING: `android/build.gradle`, `android/app/build.gradle`, `android/settings.gradle`, Gradle wrapper** -- confirmed absent via `find`, confirmed *never committed* via `git log --all --diff-filter=A -- "apps/child-app/android/*"` (zero commit in full history ever added these). **Classification: PROJECT BUG.**
- Kotlin source files (AppCategoryClassifier.kt, SessionAnalyzer.kt, AgentChannel.kt, MainActivity.kt): present, non-empty; cannot be compiled without the missing Gradle scaffold, regardless of toolchain.
- TODO/FIXME/placeholder scan: zero real hits (one false positive: 'XXXX-XXXX' pairing-code hint string, confirmed in Sprint 17.1).
- Test folder exists; cannot execute without Dart SDK.

## 4. Parent App Static Audit (Phase 4)

- **CRITICAL: zero `android/` folder, zero `ios/` folder, zero `test/` folder.** Only `lib/`, `pubspec.yaml`, `.env.example`, and two markdown docs exist at the project root. **Classification: PROJECT BUG -- more severe than Child App's gap.**
- `pubspec.yaml`: valid YAML, real dependencies declared.
- Backend endpoint usage: not re-audited beyond what Sprint 16's own API-contract work already confirmed.

## 5. Build Preparation (Phase 5)

**Not reached.** `flutter pub get` requires a working `flutter` command, which requires the Dart SDK. Zero build-preparation commands could execute.

## 6. Android Native Compilation (Phase 6)

**Cannot be classified as pure ENVIRONMENT BLOCKER** -- a second, independent PROJECT BUG exists underneath it. Even with full Flutter/Dart/Android SDK access, Child App's build would fail at Gradle configuration (missing build.gradle/settings.gradle), and Parent App's build would fail even earlier (no android/ folder to build at all). Both confirmed PROJECT BUG via git history.

## 7. Real Device / Emulator (Phase 7)

`adb devices` executed successfully -- zero devices listed, correctly and honestly. No further steps reachable without a device.

## 8. Critical Child-Agent Validation (Phase 8)

BLOCKED -- Environment (no device) AND PROJECT BUG (no buildable APK to install even if a device existed).

## 9. End-to-End FamilyOS Journey (Phase 9)

| Scenario | Result |
|---|---|
| 1. Parent Login -> Add Child -> Pair Device | BLOCKED -- no runnable app |
| 2. Child uses app -> Usage collected -> Aggregated -> Backend | BLOCKED |
| 3. Night usage -> Insight generated | BLOCKED |
| 4. Habit -> Reward -> Notification | BLOCKED (backend half verified via 649 tests) |
| 5. Education -> Streak -> Reward -> Notification | BLOCKED (same) |
| 6. Offline -> Queue -> Sync | BLOCKED (same) |

**0/6 PASS.**

## 10. Security Validation (Phase 10)

Runtime mobile-side: BLOCKED (no app to run). Backend-side equivalents remain verified via 649 real tests -- that is backend evidence, not mobile-runtime evidence.

## 11. Performance & Battery (Phase 11)

BLOCKED -- cannot measure without a running device. Sprint 14.2's sync-frequency design remains present in source, unchanged, confirmed via file read only.

## 12. Final Evidence Table

| Component | Static | Build | Runtime | Device | Status |
|---|---|---|---|---|---|
| Child Flutter | PASS -- Static Verified | NOT BUILT -- PROJECT BUG + BLOCKED -- Environment | BLOCKED | BLOCKED | RED |
| Child Kotlin | PASS -- Static Verified | NOT BUILT -- PROJECT BUG | BLOCKED | BLOCKED | RED |
| Parent Flutter | PASS -- Static Verified | NOT BUILT -- PROJECT BUG (no platform folder) | BLOCKED | BLOCKED | RED |
| Backend | PASS -- Static Verified | PASS -- Build Verified (294 files) | PASS -- Runtime Tested (649/649) | N/A | GREEN |
| Admin | PASS -- Static Verified | PASS -- Build Verified (150 modules) | PASS -- Runtime Tested (28/28) | N/A | GREEN |
| Usage Tracking | PASS -- Static Verified | NOT BUILT | BLOCKED | BLOCKED | RED |
| Accessibility | PASS -- Static Verified | NOT BUILT | BLOCKED | BLOCKED | RED |
| Offline Queue | PASS -- Static Verified | NOT BUILT | BLOCKED | BLOCKED | RED |
| Pairing | Backend PASS -- Runtime Tested | Backend PASS; Mobile NOT BUILT | Backend PASS; Mobile BLOCKED | BLOCKED | SPLIT |
| Notifications | Backend PASS -- Runtime Tested | Backend PASS; Mobile NOT BUILT | Backend PASS; Mobile BLOCKED | BLOCKED | SPLIT |
| Rewards | Backend PASS -- Runtime Tested | Backend PASS; Mobile NOT BUILT | Backend PASS; Mobile BLOCKED | BLOCKED | SPLIT |

## Tests (real numbers)

- Backend: 649/649 PASS -- Runtime Tested
- Admin Dashboard: 28/28 PASS -- Runtime Tested
- Child App: 0 executed -- BLOCKED
- Parent App: 0 executed -- BLOCKED (also has no test/ folder at all)

## Builds

- Backend: real `nest build`, 294 compiled files.
- Admin Dashboard: real `vite build`, 150 modules.
- Child App: not built -- blocked by missing Dart SDK AND missing Gradle scaffold.
- Parent App: not built -- blocked by missing Dart SDK AND missing platform folder entirely.

## Runtime

- Backend: all 649 tests executed for real via Jest with a real Prisma Client.
- adb: executed for real (`adb devices`, daemon start) -- genuine tool execution, zero devices found (correct).
- Mobile apps: zero runtime execution -- no build exists to run.

## E2E

**0/6 PASS.** All BLOCKED -- no runnable mobile app exists in any environment tested this Sprint.

## Blockers

### Environment Blockers
1. Dart SDK unreachable (`storage.googleapis.com` outside network allowlist) -- confirmed via repeated real attempts.
2. No Android emulator/device.
3. Full Android SDK (platforms, licenses, sdkmanager) unavailable -- only individual tools installable via apt.

### Project Bugs (NEW finding this Sprint)
1. Child App: android/build.gradle, android/app/build.gradle, android/settings.gradle, Gradle wrapper -- all missing, never committed in project history.
2. Parent App: entire android/ and ios/ platform folders missing; test/ folder also missing.

### Missing Features
None identified this Sprint -- scope was validation, not feature discovery.

## Production Readiness Score (re-evaluated)

| Category | Score | Change | Rationale |
|---|---|---|---|
| Architecture | 13/15 | unchanged | |
| Backend | 14/15 | unchanged | |
| Child App | 2/15 | -2 | New evidence (missing Gradle scaffold) makes prior 4/15 too generous -- confirmed non-buildable regardless of environment. |
| Parent App | 1/10 | -3 | Same reasoning, more severe -- zero platform folder at all. |
| Security | 11/15 | unchanged | |
| Reliability | 5/10 | unchanged | |
| Cost | 5/10 | unchanged | |
| Testing | 9/10 | unchanged | |

**TOTAL: 60/100** (down from 65/100 -- a real, evidence-based decrease. This is the honest downward revision this Sprint's own rules require: re-evaluate based only on new evidence, and this Sprint's new evidence was worse than assumed, not better.)

## Final Decision: GO / CONDITIONAL GO / NO-GO

**NO-GO -- and more urgently so than Sprint 17/17.1 concluded.**

The prior framing ("mobile apps are code-complete but environment-blocked") was too optimistic. The real, new finding this Sprint is that **the mobile apps are not currently buildable in ANY environment** -- not this sandbox, not the user's own Windows machine, not a CI/CD pipeline -- until the missing platform scaffolding is restored. This is a project completeness gap, independent of tooling access.

## Exact Next Steps (revised priority order)

1. **FIRST, before attempting any build anywhere**: regenerate the missing platform scaffolding.
   - Child App: on a machine with Flutter installed, run `flutter create --platforms=android .` inside `apps/child-app/` -- this regenerates `android/build.gradle`, `settings.gradle`, and the Gradle wrapper without touching existing `lib/`, existing Kotlin code, or `pubspec.yaml` (Flutter's own `create` is additive when run with `--platforms` against an existing project).
   - Parent App: same command inside `apps/parent-app/` -- a larger, first-time scaffold, since zero platform folder currently exists.
   - This step requires a real Flutter SDK -- the user's own Windows machine (already proven capable of running npm/prisma with full internet access) is the correct place to run this.
2. After scaffolding exists: run `flutter pub get`, `flutter analyze`, `flutter test`, `flutter build apk --debug` for both apps, for real.
3. Only after a real APK exists: proceed to device/emulator installation and the six E2E scenarios this Sprint defined.
4. Report the real `flutter create` output and any conflicts merging into existing Kotlin source -- the one step in this chain that could not be predicted without a real Flutter SDK.
