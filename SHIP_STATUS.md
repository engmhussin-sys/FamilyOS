# ABNY / ابني — SHIP STATUS

**Branch** `abny/sprint-f1-unblock` · **74 commits ahead of `main`** · working tree clean
**Measured** 2026-08-14 by execution on this machine. No number below is quoted from a report.

Evidence vocabulary: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `CODE REVIEWED` · `BLOCKED` · `NOT TESTED`

---

## Gate

| Area | Status | Evidence |
|---|---|---|
| Backend | **PASS** | 3,351 tests / 163 suites / 0 failing · `tsc --noEmit` PASS — `RUNTIME VERIFIED` |
| Database | **PASS** | 19/19 migrations from an empty DB → 100 tables, deterministic — `RUNTIME VERIFIED` |
| Security | **PASS** | tenant-guard 0 violations · event-emission 0 violations · RBAC sweep green — `RUNTIME VERIFIED` |
| Smart Notifications | **PASS** | wired from production producers; `notification_decisions` populated by real flows — `RUNTIME VERIFIED` |
| Golden E2E | **PASS** | 11 scenarios, real PostgreSQL + Redis + booted HTTP app — `RUNTIME VERIFIED` |
| Admin | **PASS** | 134/134 · `tsc` PASS · `vite build` 375 kB — `BUILD VERIFIED` |
| API contract | **PASS** | every client call site resolves to a real route — `STATIC VERIFIED` |
| FCM / push delivery | **DELEGATED** | Claude #1 — no commits from that workstream present on this branch |
| Staging (Railway) | **NOT DEPLOYED** | no URL, no deploy. Package prepared only — do not read as green |
| Flutter | **BLOCKED** | no SDK; `pub.dev`/`dl.google.com`/`storage.googleapis.com`/`services.gradle.org` all blocked |
| Android APK / AAB | **BLOCKED** | no artifact exists. Release path now produces `aab`, unmeasured |
| iOS | **BLOCKED** | no `ios/` directory exists at all |

---

## Smart Notification Engine

| | Status | Evidence |
|---|---|---|
| Producers wired | `RUNTIME VERIFIED` | 6 inline producers routed through `handleEvent`; decision row reconciles from the same 6 HTTP calls |
| Bypass guard | `RUNTIME VERIFIED` | 13 tests, 7 producer patterns, 8-entry `SYSTEM`/`TRANSACTIONAL` allow-list with per-entry reason. Negative control: a rogue `prisma.notification.create` was added, failed by file+line, removed. A permanent synthetic control keeps the guard from rotting |
| Child path | `RUNTIME VERIFIED` | Arabic, band-appropriate, from the copy catalogue, `PENDING` behind the parent gate, keyed `evt:…:child` |
| Parent path | `RUNTIME VERIFIED` | contextual, not templated; first completion and third-in-a-week differ |
| Decision log | `RUNTIME VERIFIED` | `trigger` · `score` · `reason` · `decision` · component raw/weight/contribution, asserted to reconcile |
| Scoring coverage | `RUNTIME VERIFIED` | test discovers every producible type and fails if one has no scoring row or cannot clear the floor from a bare household |
| Dynamic surfaces | `CODE REVIEWED` | notification / in-app / timeline separated from the decision; full-page composition not built |

## Rewards

Quran · Sport · Science quiz · Programming · Screen-time — all `RUNTIME VERIFIED` end to end, each with replay proven to add zero grants, zero notifications, zero timeline rows. Screen-time genuinely moves the effective allowance 90 → 120 minutes and does not move it twice.

## Payments

| Provider | Status | Evidence |
|---|---|---|
| Apple StoreKit 2 | server-authoritative, `RUNTIME VERIFIED` against mocked Apple HTTP | ES256 JWS over the x5c chain pinned to Apple Root CA G3, bundle-id check, all 7 checks run as written |
| Google Play Billing | `RUNTIME VERIFIED` against mocked Google HTTP | 19/19 tests: token → entitlement; duplicate and 8-concurrent → one transaction; renewal correctly not a duplicate; tampered amount, swapped currency, cross-tenant token, invented token all rejected |
| Paymob · Fawry · Moyasar | `BLOCKED` | adapters present and fail loudly unconfigured. HMAC field order marked **VERIFY BEFORE GO-LIVE** — doc hosts unreachable |
| Real sandbox (Apple/Google) | `BLOCKED` | no credentials. Nothing fabricated |

`VerifyPurchaseDto` carries no amount, currency, tier or `familyId` — the client has nowhere to lie.

## Subscription

Plans, prices per country/currency, trial, grace, renewal, cancellation, refund, entitlement — `RUNTIME VERIFIED`. Feature access resolves through `Entitlement`, never through which provider paid. Store billing and direct checkout are separate, clearly-sourced paths behind one abstraction; **which one the business uses is not decided.**

## Growth

Saudi Arabia and Egypt tracked separately with their own currency; a currency never renders without its country. 22 KPIs with a single enforced definition. Referral fraud closed at the database (self-referral, duplicate, concurrent, velocity). Activation is `CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL` behind four gates, none of which a child can self-declare. `FORECAST` / `TARGET` / `ACTUAL` visually distinct including in greyscale. Unmeasurable metrics render **NOT MEASURED**, never `0`.

---

## Defects closed this sprint

| ID | Severity | What it was |
|---|---|---|
| `PG-001` | **CRITICAL** | The child-safety filter was six **English** regexes. It returned `isSafe: true` for «أنت كسول ولم تنجز شيئًا اليوم» and nine other banned-content families. The earlier fix was a *flag*, so it protected only the engine path. The child policy now runs as the last statement before persistence, on the exact bytes to be stored, at the child's own band; refusal throws and writes nothing. Removing the gate fails 20 of 37 tests and leaves 17 green — that asymmetry *is* the defect |
| `PG-002` | HIGH | Child quiet-hours digest was 11 words against band `6-8`'s limit of 8, with western digits. Found by the new gate |
| `PF-E-001` | HIGH | The engine had no production producer at all |
| `PF-E-006` | HIGH | The child half was silent behind a generator with no caller |
| `PF-E-002` | HIGH | `users.locale` defaulted to `en`, so a household registered exactly as the mobile app does received *"محمد completed the سورة الملك goal"* |
| `PF-E-003` | MEDIUM | `GOAL_COMPLETED_PARENT` scored ~23 against a floor of 25 and was silently suppressed — its type was in no scoring table |
| `PF-E-004` | LOW | Analytics `REWARD_GRANTED` tripled under redelivery |
| — | HIGH | `acknowledge` existed and nothing called it. Google auto-refunds unacknowledged purchases after 3 days |
| — | HIGH | Safety alerts lost `CRITICAL`; the quiet-hours penalty sank *every* DEFER-class type below the floor; `DELIVERY_ERROR` was swallowed instead of failing the outbox message |

Six defects were also found **in the tests and checkers themselves** — a hardcoded Cairo UTC offset, an ordering that degraded to random-UUID order under a frozen clock, an AI flag left off that made a scenario vacuous, and four checker bugs. Each would have been green for the wrong reason.

---

## Remaining blockers

1. **No APK/AAB, no `flutter` command ever executed** — `ENVIRONMENT BLOCKER` + `MOBILE GAP`. 0.5 d to measure; 3–12 d unknown to fix. `scripts/setup-windows-dev.ps1` (11 repo-derived pins) is `NOT TESTED` — no PowerShell here.
2. **74 commits unpushed** — the sandbox git proxy refuses credentials for this repository. `ENVIRONMENT BLOCKER`, 0 engineering days, and it blocks #1 entirely.
3. **No `ios/` directory** — `MOBILE GAP` + `USER DECISION`. The child app cannot reach parity: `AccessibilityService`, `UsageStatsManager` and overlays have no iOS equivalent and `DeviceActivity` data cannot leave Apple's sandbox. iOS must ship as *"supervision requires an Android device"* or not at all.
4. **Staging not deployed** — no Railway project, no URL. `INFRASTRUCTURE BLOCKER`.
5. **Paymob/Fawry HMAC unverified** and merchant onboarding is **4–8 calendar weeks** — the only pure wall-clock item in the project. Start it today.

## Exact next action

**`git push origin abny/sprint-f1-unblock`**, then let CI run once. That single step converts the mobile layer from estimate to measurement and is the only thing standing between this repository and knowing its real state.

## Human decisions

`google-services.json` / Firebase project · App Store Connect account · Google Play Console account · Paymob / Fawry / Moyasar contracts · store billing vs direct checkout · Bundle ID and `com.aifamilycoach.child_app` · subscription pricing · refund window (14 d assumed) · quiz-bank authoring · crisis/helpline directory review · MSA vs Egyptian colloquial · the nine `growth_settings` items flagged `humanDecision: true`. **None decided here.**

## Evidence

Backend 3,351/163/0 · Admin 134/134 + `vite build` · Golden E2E 11 scenarios on real PostgreSQL + Redis + HTTP · 19/19 migrations → 100 tables from empty · `tsc` PASS · both CI guards 0 violations · 74 focused commits · tree clean.

**Not claimed:** production readiness, staging green, mobile build, real payment sandbox.
