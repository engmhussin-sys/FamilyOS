# ABNY — SHIP BOARD

**CODE FREEZE — 2026-08-19.** Branch `abny/sprint-f1-unblock` · 263 commits ahead of `main` · tree clean.

The application codebase is **feature frozen**. Code changes from here are permitted only for: compilation · build · installation · startup · authentication · pairing · notifications · deep-link navigation · a crash · a security issue · an actual build failure. Everything else goes to `POST_PILOT_BACKLOG.md`.

States: `CLOSED` · `READY FOR BUILD` · `BLOCKED — ENVIRONMENT` · `BLOCKED — HUMAN DECISION` · `DELEGATED` · `POST-PILOT`

---

## Status

| Area | State | Evidence |
|---|---|---|
| **Backend** | `CLOSED` | 223 suites · 5,383 tests · 0 failing · 1 suite / 6 tests skipped. `RUNTIME VERIFIED` against real PostgreSQL, real Redis, a real booted HTTP app — and identical on a second consecutive run against the reused database. `tsc --noEmit` clean |
| **Database** | `CLOSED` | 29 migrations (0001–0030, no 0012) → 101 tables from `CREATE DATABASE` with no seed. The full suite runs against exactly that database |
| **Security** | `CLOSED` | Tenant-scoping guard 0 violations; event-emission guard 0 violations. Cross-tenant probe accounts for every route — probed or classified with a per-entry reason. Audience boundary asserted on every deep-link surface read from the registry at test time, including the existence-oracle shape on all id-bearing routes. `RUNTIME VERIFIED` |
| **Child Safety** | `CLOSED` | Checked bytes == shipped bytes. Fail-closed on unknown age and unknown band, proven by four in-process mutants each asserting its red set **and its green complement**. Reject writes nothing — 90 tables derived from `information_schema` and searched as `row_to_json(x)::text`, plus a full Redis `SCAN` with a planted canary proving the scan is not vacuous. A critical escalation is never suppressed by quiet hours. `RUNTIME VERIFIED` |
| **Smart Notifications** | `CLOSED` | Every PRODUCIBLE key has one producer, an audience, Arabic copy in every tone band it renders in, a quiet-hours class, a safety class, provenance, and a destination the Flutter router actually answers. Both defect ledgers empty and asserted non-vacuously. `RUNTIME VERIFIED` |
| **Deep Links** | `CLOSED` (server + routers) · `READY FOR BUILD` (device) | No dead destination. Both Android manifests declare `abny://`; both apps have a cold-start handler routing through the existing resolver. The checker reads the scheme from the backend at check time so a rename cannot pass. `STATIC VERIFIED` on device — step 15 of the smoke test is its first runtime proof |
| **Admin** | `CLOSED` | 184 tests · `vite build` clean (`BUILD VERIFIED`). Operator key held in memory only — never `localStorage`, cookie or URL — compared server-side by HMAC then `timingSafeEqual`. **No secret in React** |
| **Parent App** | `READY FOR BUILD` | 9 static checkers, 0 problems. **No Dart has ever been compiled** — `NOT TESTED` at runtime |
| **Child App** | `READY FOR BUILD` | Same. Five evidence packages declared and pinned; `pubspec.lock` deliberately absent |
| **Android Build** | `READY FOR BUILD` | `MOBILE_BUILD_HANDOFF.md` carries all 19 required values, each read from a named repository file. `release-doctor` classifies 31 checks `PASS`/`WARN`/`BLOCKED` and ends in the literal line `SHIP BLOCKED` when a required dependency is missing. **The debug APK needs no Firebase and no keystore** |
| **Subscriptions** | `CLOSED` | Trial, active, past-due, grace period, cancelled, expired — every transition explicit and tested, including that a grace-period household can cancel. `RUNTIME VERIFIED` |
| **Payments** | `BLOCKED — HUMAN DECISION` | Paymob / Fawry merchant onboarding, 4–8 calendar weeks. HMAC field order verified against their live sandbox before go-live — never faked here. **The only item that gets worse purely by waiting** |
| **FCM** | `DELEGATED` | ABNY emits the payload with `data.deepLink`, an idempotency key and the audience. Token acquisition and transport belong to another engineer; `pushTokenRegistrationServiceProvider` waits in the child app with zero consumers |
| **Firebase** | `BLOCKED — HUMAN DECISION` | One project, two Android apps. `google-services.json` goes in `apps/parent-app/android/app/` — **the child app does not need it**. Nothing fabricated |
| **iOS** | `POST-PILOT` | Product decision, not an omission: full supervision needs `AccessibilityService` and `UsageStatsManager`, which have no iOS equivalent. iOS Child ships as *"supervision requires an Android device"* or not at all |
| **Pilot** | `BLOCKED — HUMAN DECISION` | `PILOT_TEST_PLAN.md` is written and exercises only what exists. Needs a real cohort id, the EG/SA household split, and a backend you host |
| **Paymob / Fawry** | `BLOCKED — HUMAN DECISION` | See Payments. Start the merchant application today |

---

## What is stopping the first APK

Nothing external. `git push` is `BLOCKED — ENVIRONMENT` (the sandbox proxy refuses credentials for this repository, which is a session setting, not a code failure) and the toolchain is `BLOCKED — ENVIRONMENT` here but present on your machine.

Firebase, keystore, Play Console, Paymob and Fawry are **not** on the path to a debug APK. They gate the signed release, not the first artifact.

---

## Credential scan — clean

Searched the whole tree outside `node_modules` and `.git`: no private keys, no `.jks`, no `.keystore`, no `signing.properties`, no `google-services.json`, no committed `.env`.

One finding, classified: `test1@example.com` / `SecurePass123!` appeared in `docs/roadmap/PRODUCTION_VERIFICATION_ROADMAP.md` as literal `curl` bodies against a live domain — **credential-bearing documentation, not harmless demo data**, because the account was really created. Replaced with `<your-test-email>` / `<your-test-password>`. It had already been removed from `scripts/verification-script*.ps1`, which now take `-BaseUrl`/`-Email`/`-Password` with no defaults.

**History was not rewritten. Rotate that account before the repository is shared.**

The demo seed's accounts (`demo.<slug>.parent1@demo-seed.invalid` / `DemoSeed!2026`) are local-development only and the seed refuses any non-localhost database. They must never appear in a production configuration.

---

## Documents, and which one wins

| Document | For |
|---|---|
| **`WINDOWS_RUN.md`** | **The only build procedure.** Eight steps. If another document disagrees, this one wins |
| `MOBILE_BUILD_HANDOFF.md` | Every version, path, command and expected output, each traced to the repository file it came from |
| `GOLDEN_DEVICE_SMOKE_TEST.md` | Seventeen steps on two real phones. The first time this code runs on hardware |
| `PILOT_TEST_PLAN.md` | مصر / السعودية controlled pilot. A test plan, not a feature request |
| `POST_PILOT_BACKLOG.md` | Everything known, recorded, and deliberately not being worked on |
| `RELEASE_CANDIDATE_CHECKLIST.md` | 25 executable release gates |
| `بيانات-الدخول.md` | Local demo credentials and the operator key you generate yourself |

---

## Not claimed

No APK exists. **No `flutter` command has ever run in this environment and no Dart test has ever executed** — every mobile result is `STATIC VERIFIED` by nine Python checkers. Staging is not deployed. Apple, Google, Paymob and Fawry sandboxes are unverified. Push delivery to a real device is untested. No readiness percentage is given, here or anywhere.
