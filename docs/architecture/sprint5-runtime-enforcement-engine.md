# Sprint 5 — Runtime Enforcement Engine

**Status:** Implementation exists across Native/Flutter/Backend/Dashboard.
**Native lifecycle code (AccessibilityService, Foreground Service, Boot
Receiver, Overlay) has NOT been validated on any physical device** — no
compiler, no emulator, no device access in this sandbox. This document
follows the directive's own Transparency section: reporting what exists,
not what documentation claims.

---

## 1. What's actually implemented, by layer

### Native (Kotlin) — the real enforcement loop
- `NativePolicyStore.kt` — SharedPreferences-backed policy cache, independent of Flutter/flutter_secure_storage
- `PolicyEnforcer.kt` — pure decision function (bedtime window, blocked packages, daily limit)
- `DailyUsageTracker.kt` — real `UsageStatsManager` integration (closes a gap flagged and left open in the previous message's draft)
- `OverlayManager.kt` — the actual blocking screen via `WindowManager`
- `ChildGuardAccessibilityService.kt` — listens for foreground-app changes, evaluates policy, shows/hides the overlay
- `ChildGuardForegroundService.kt` — persistent notification + a watchdog that detects Accessibility being disabled
- `BootReceiver.kt` — restarts the Foreground Service after reboot
- `AndroidManifest.xml` + `accessibility_service_config.xml` + `strings.xml` — registration, permissions, required resources

### Flutter (Dart) — coordination only, zero enforcement decisions
- `RuntimeCoordinator` — fetch policy → cache locally → push to native → read status back
- `HeartbeatService` extended with an optional telemetry provider (backward-compatible — existing callers unaffected)
- `DeviceHomeScreen` — Runtime Status tile

### Backend — real endpoints, tested
- `HeartbeatDto` extended: `accessibilityServiceEnabled`, `enforcementActive`
- `IDeviceSummary.runtimeStatus` — surfaced in `GET /pairing/devices`, read from cached telemetry (no new table — same Decision-019 caching pattern as capability/trust)

### Dashboard — real UI, built and tested
- `DeviceStatusCard` — a "Protection status" badge per device (Active / Accessibility disabled / Not yet confirmed)

## 2. NOT included in this delivery — stated directly, per the directive's own rule

- **Notification Manager** beyond the Foreground Service's mandatory status notification — no separate alerting/notification system.
- **Service Recovery / Permission Recovery** beyond the watchdog's passive detection — nothing actively attempts to fix a disabled permission (no API allows that; only escalation exists).
- **Runtime Alerts, Runtime Timeline, Runtime Diagnostics** (Dashboard) — only the status badge was built.
- **AI Core integration of Runtime signals** — not wired this session. `AiDiagnosticsService` (Sprint 4 Track A) does not yet include enforcement status in its context.
- **Native heartbeat/networking** — if the Flutter engine isn't running (app fully killed), heartbeats stop; local enforcement continues from the cached policy regardless (`ChildGuardForegroundService`'s own docstring states this directly).

## 3. A critical gap found and fixed mid-delivery

The first draft of `ChildGuardAccessibilityService` hardcoded
`minutesUsedToday = 0`, silently disabling the daily-limit rule while
bedtime/blocked-package rules worked. Flagged explicitly in the previous
partial response rather than shipped silently, then closed for real this
turn with `DailyUsageTracker.kt` (`UsageStatsManager`-based, read-only).
Documented limitation: `INTERVAL_DAILY` bucketing doesn't align exactly
to local midnight on every OEM/API level (an Android platform quirk,
not a bug here) — acceptable precision for a parental daily limit, not
presented as exact.

## 4. Validation — measurable results only

### Backend
- `npx tsc --noEmit`: **0 errors**
- Full suite (`test/auth`, `test/children`, `test/screen-time`,
  `test/ai-assistant`, `test/ai-core`, `test/compliance`,
  `test/pairing`, `test/common`, `test/app.module.spec.ts`):
  **140/140 passed** (was 138 before this sprint; +2 new
  `runtimeStatus` tests)
- DI graph: passed (no missing dependency, no circular import)

### Dashboard
- `npx tsc --noEmit`: **0 errors**
- `npx vitest run`: **14/14 passed** (unchanged — no new component
  tests, consistent with this project's existing coverage philosophy)
- `npx vite build`: **succeeds**, 117 modules, 231KB bundle (73.7KB gzip)

### Flutter (Dart)
- **No Flutter SDK available in this sandbox — `flutter analyze` and
  `flutter test` were NOT run.** This is a standing limitation, not new
  to this sprint.
- Manual verification performed instead: full-codebase brace/paren
  balance sweep (`find lib test -name "*.dart"`) — one flagged mismatch,
  confirmed to be a false positive (a literal `'{{{'` malformed-JSON
  test string), same as the previous session's finding, re-verified.
- New/changed test files (not run, written to the same standard as
  every other test in this project): `runtime_coordinator_test.dart`
  (5 tests), plus 3 existing fakes updated for the extended
  `PairingApi.heartbeat()` signature (`device_registration_service_test.dart`,
  `heartbeat_service_test.dart`, `runtime_telemetry_collector_test.dart`).

### Native (Kotlin) — exactly what could and could not be validated
- **Could validate:** brace/paren balance (full sweep, all matched),
  AndroidManifest.xml/accessibility_service_config.xml/strings.xml
  parsed as valid XML via Python's `xml.etree.ElementTree` (a real
  parser, not a heuristic).
- **Could NOT validate:** whether this compiles (no Gradle/Kotlin
  compiler in this sandbox — no `build.gradle` even exists here, since
  `flutter create .` was never run), whether
  `ChildGuardAccessibilityService` actually receives
  `TYPE_WINDOW_STATE_CHANGED` events correctly on any real device,
  whether the overlay renders correctly across OEM skins, whether
  `DailyUsageTracker`'s `INTERVAL_DAILY` query behaves as expected on
  the specific Android versions this will run on, whether
  `BootReceiver` actually fires on every manufacturer, or ANY runtime
  behavior whatsoever.

**This is precisely the gap the 3-device manufacturer testing exit
criterion (from the earlier Track A/B split) exists for.** Nothing in
this delivery changes that requirement — it makes the requirement more
urgent to actually run, not less, since there is now real code sitting
behind it waiting to be tested rather than an architecture document.
