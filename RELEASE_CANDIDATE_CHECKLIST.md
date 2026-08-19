# ABNY — RELEASE CANDIDATE CHECKLIST

Branch `abny/sprint-f1-unblock` · updated 2026-08-19

Every gate below is **executable**: a command you can run, or a named external action. Status is one of `PASS` · `BLOCKED` · `HUMAN DECISION` · `NOT TESTED`. Nothing here is a percentage and nothing here says "production ready".

---

## Gates that run in this repository

| # | Gate | Command | Status | Evidence |
|---|---|---|---|---|
| 1 | **Backend test suite** | `cd apps/backend && npx jest --runInBand` | `PASS` | 223 suites · 5,383 tests · 0 failing · 1 suite / 6 tests skipped. Identical on a second consecutive run against the reused database — the check that catches a suite which only passes on a clean one |
| 2 | **Database migrates from empty** | `npx prisma migrate deploy` on a fresh database | `PASS` | 29 migrations (0001–0030, no 0012) → 101 tables, from `CREATE DATABASE` with no seed. The full suite above runs against exactly that database |
| 3 | **Type check** | `cd apps/backend && npx tsc --noEmit` | `PASS` | Exit 0 |
| 4 | **Tenant isolation** | `npm run ci:tenant-guard` | `PASS` | 0 violations. Backed by a cross-tenant probe that accounts for **all** routes — probed, or classified with a per-entry reason — so a new unprobed route fails by name |
| 5 | **Event emission** | `npm run ci:event-emission` | `PASS` | 0 violations. Every domain-state writer emits through the Outbox or is explicitly listed as not yet wired |
| 6 | **Admin dashboard** | `cd apps/admin-dashboard && npm test && npm run build` | `PASS` | 184 tests · `vite build` clean (`BUILD VERIFIED`) |
| 7 | **Notification producer / consumer integrity** | `npx jest test/architecture/notification-producer-chain.guard.spec.ts` | `PASS` | Every PRODUCIBLE key has exactly one producer, a declared audience, Arabic copy in every tone band it renders in, a quiet-hours class, a safety class, provenance, and **a destination the Flutter router actually answers**. `PRODUCERLESS_DEFECT_LEDGER` and `DEAD_DESTINATION_LEDGER` are both empty, and the guard asserts emptiness non-vacuously |
| 8 | **Safety invariant** | `npx jest test/ai-core test/golden/e2e-16-safety-escalation.golden.spec.ts` | `PASS` | Checked bytes == shipped bytes; fail-closed on unknown age and unknown band, proven by four in-process mutants each with its red set **and its green complement**; reject writes nothing — 90 tables derived from `information_schema` and searched as `row_to_json(x)::text`, plus a full Redis `SCAN` with a planted canary proving the scan is not vacuous; a critical escalation is never suppressed by quiet hours, and now leaves a decision record |
| 9 | **Achievement idempotency** | `npx jest test/rewards test/life-intelligence/health-goal-badge-doors.e2e.spec.ts` | `PASS` | One legitimate event → one grant → one XP award, proven by replaying the event AND by deleting the code-level marker so the chain re-runs and the DATABASE constraint is what refuses. Both doors (app button, device event) share one idempotency key. `reward-rule-collision.spec.ts` fails if two seeded rules can ever pay one crossing |
| 10 | **Deep-link registry** | `npx jest test/authz/deep-link-audience.e2e.spec.ts` and `python3 scripts/verify_notification_permission.py` | `PASS` | No dead destination. Audience boundary asserted on every surface read from the registry at test time, including the existence-oracle shape on all id-bearing routes. The Android manifests declare `abny://`, and the checker reads the scheme from the backend at check time so a rename cannot pass |
| 11 | **Mobile static checkers** | `python3 scripts/dart_preflight.py` and the 8 siblings | `PASS` | 9 checkers, 0 problems. `dart_preflight_selftest.py` proves they can fail: 28 mutation controls, 7 probes, 6 scheme controls, each asserting both the report and the revert |

---

## Gates that need the Windows machine

| # | Gate | Command | Status | What it needs |
|---|---|---|---|---|
| 12 | **Android build environment** | `powershell scripts/setup-windows-dev.ps1` then `scripts/release-doctor.ps1` | `NOT TESTED` | Flutter 3.24.5 · Dart ≥3.3 <4.0 · JDK 17 · Gradle 8.3 · AGP 8.1.1 · Kotlin 1.9.10 · compileSdk/targetSdk 34 · minSdk 21 · build-tools 34.0.0. All pins verified against the repo (`STATIC VERIFIED`); none executed |
| 13 | **APK debug build** | `scripts/mobile-build.ps1` | `NOT TESTED` | Needs only #12. **No Firebase, no keystore** — debug builds do not require them. This is the first artifact to aim for |
| 14 | **AAB release build** | `scripts/mobile-build.ps1 -Release` | `BLOCKED` | Needs #15 and #16. The script now runs a RELEASE PREFLIGHT **before any stage**, naming the exact file, directory and command that is missing, and refuses to sign a release with debug keys |
| 15 | **Firebase** | `flutterfire configure` | `HUMAN DECISION` | One project, two Android apps: `com.aifamilycoach.parent_app`, `com.aifamilycoach.child_app`. Place `google-services.json` in `apps/parent-app/android/app/`. **The child app does not need it** — it declares no `firebase_core`/`firebase_messaging`. Nothing was fabricated |
| 16 | **Release keystore** | `keytool` line in `signing.properties.example` | `HUMAN DECISION` | Two upload keystores, per-app alias, 4096-bit, PKCS12; one `signing.properties` per app. `.gitignore` covers the filename; nothing is committed |
| 17 | **Package resolution** | `flutter pub get` (both apps) | `BLOCKED` | pub.dev returns 403 in the sandbox. Five evidence-upload packages are declared, imported and pinned inside the Flutter 3.24.5 window: `record 5.1.2`, `image_picker 1.1.2`, `file_picker 8.1.2`, `path_provider 2.1.4`, `http_parser ^4.0.2`. **No `pubspec.lock` was invented** |

---

## Gates that are commercial, not technical

| # | Gate | Status | What it needs |
|---|---|---|---|
| 18 | **Play Console** | `HUMAN DECISION` | Developer account, app listing, data-safety form. The AAB from #14 is the upload |
| 19 | **Apple decision** | `HUMAN DECISION` | Recorded product decision: full parental supervision needs `AccessibilityService` and `UsageStatsManager`, which have no iOS equivalent. **iOS Child ships as "supervision requires an Android device", or not at all.** iOS Parent is a separate, later question |
| 20 | **Payment provider onboarding** | `HUMAN DECISION` | Paymob / Fawry merchant contract, 4–8 calendar weeks. **The only item that gets worse purely by waiting.** Verify HMAC field order against their live sandbox before go-live — it was never faked here |
| 21 | **Push delivery to a device** | `BLOCKED` | Token acquisition is owned by another engineer. ABNY emits the payload with `data.deepLink`, an idempotency key and the audience; `pushTokenRegistrationServiceProvider` waits in the child app with zero consumers |

---

## Pilot configuration

| # | Gate | Status | What it needs |
|---|---|---|---|
| 22 | **Pilot cohort** | `HUMAN DECISION` | `pilot_invites` exists and the demo seed uses cohort `demo-pilot-2026`. Decide the real cohort id, the market split (EG / SA), and how many households |
| 23 | **Operator key** | `HUMAN DECISION` | `openssl rand -hex 32` → `INTERNAL_ADMIN_API_KEY` in the backend `.env`, same value pasted into the dashboard. Held in memory only; re-entered after every page refresh, deliberately |
| 24 | **Staging URL** | `BLOCKED` | No Railway project exists. `docker compose up -d` runs the whole stack locally today |
| 25 | **Rotate a leaked test account** | `HUMAN DECISION` | `test1@example.com` / `SecurePass123!` were hardcoded in `scripts/verification-script*.ps1`. Removed; the scripts now take `-BaseUrl`/`-Email`/`-Password` with no defaults. **History was not rewritten — rotate the account** |

---

## The next action

Gates 1–11 pass here and will keep passing without a machine. Gate 13 — the first debug APK — needs nothing external at all. That is the next thing to do:

```powershell
git fetch <bundle> abny/sprint-f1-unblock:abny/sprint-f1-unblock
git checkout abny/sprint-f1-unblock
powershell scripts\setup-windows-dev.ps1
powershell scripts\release-doctor.ps1
powershell scripts\mobile-build.ps1
```

Everything after that — AAB, store, pilot — waits on #15, #16, #18 and #20, and #20 is the one to start today because it is the only one measured in weeks rather than hours.
