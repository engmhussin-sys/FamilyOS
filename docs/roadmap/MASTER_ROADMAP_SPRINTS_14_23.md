# Ebni — Master Roadmap to Completion (Sprints 14–23)

**Status: PLANNING DOCUMENT. No code written this turn.** Grounded in
this project's actual current state — every "done" claim below is
backed by a real test count, file, or prior session's verified result;
every "not done" claim is stated plainly, not hedged.

---

## Sprint 14 — Deployment Unlock (Infrastructure, not code)

**Goal:** Make Sprint 13's already-written code (and every sprint
after it) verifiable for the first time. This is the true blocker
behind everything else on this roadmap.

| Task | Owner | Deliverable |
|---|---|---|
| Provision Railway: Postgres + Redis + Backend service | Team (not Claude — no Railway account exists in this environment) | Live URL |
| `prisma migrate deploy` + `prisma generate` against real Postgres | Team, using `SPRINT13_BLOCKED_BY_PRISMA.md`'s exact commands | Real, non-hand-authored migration history |
| Run the full backend test suite for real, including the 17 Sprint 13 tests | Team | Real pass/fail numbers, not "failed to compile" |
| Execute `docs/release/E2E_ACCEPTANCE_TEST_SCENARIOS.md` for the first time | Team | Every NOT TESTED row converted to real PASS/FAIL |
| Deploy Admin Dashboard | Team | Live URL |

**Exit criterion:** `SPRINT13_BLOCKED_BY_PRISMA.md`'s own verification
sequence passes for real. Only then does Sprint 15 start.

---

## Sprint 15 — Life Intelligence: Health Engine + Faith Engine

Both independent, both additive, both follow the Future-Engine
Contract (Architecture 1.0 §2) exactly like Habit/Timeline did.

- **Health Engine**: merges Nutrition/Hydration/Sleep/Activity logging
  + `HealthScoreDaily` computation. `ActivitySocialContext` field
  (already in schema) wired for the Social Score input.
- **Faith Engine**: `FaithPractice`/`FaithPracticeLog` — Quran
  memorization/review, azkar, salah tracking.
- Both feed their slice into `ChildDigitalTwinProjection` (schema
  already has `healthSlice`/`faithSlice` columns, unused until now).

**Exit criterion:** Same bar as Habit Engine — real service, real
repository, real tests, `tsc`/`nest build`/tests genuinely green (this
time verifiable, since Sprint 14 unblocked Prisma).

---

## Sprint 16 — Life Intelligence: Learning & Education + Smart Tasks

- **Learning & Education Engine**: `LearningGoal`/`LearningSession`/
  `LearningAssessment` — school study, languages, reading, homework.
  Quran explicitly excluded (Faith Engine's, per Architecture 1.0).
- **Smart Tasks Engine**: `SmartTask` — AI-generated dynamic
  suggestions, explicitly distinct from Habit Builder's static list.
  This is the first LIP engine that meaningfully exercises the AI
  Provider (phrasing suggestions) and Safety Engine (validating them)
  end-to-end.

---

## Sprint 17 — Life Intelligence: Rewards Engine + Family Communication Engine

- **Rewards Engine**: Wallet, Ledger, Badge/Achievement system, Family
  Store (`RewardCatalogItem`), Redemption approval flow, **Reward
  Rules** (automatic grants — the rule-evaluation component explicitly
  scoped in Architecture 1.0 §5).
- **Family Communication Engine**: parent/child/broadcast delivery +
  **AI Conversation** with the schema-enforced approval gate
  (`ChildMessage.approvalStatus`) already designed — no AI-authored
  content reaches a child without a parent's explicit approval.

**This is the highest-product-risk sprint** — real money-adjacent
logic (coin economy) and real child-facing AI content. Recommend a
dedicated review pass before merging, beyond the standard test bar.

---

## Sprint 18 — Life Intelligence: Coaching + Family Insight + Digital Twin Completion

- **Coaching Engine**: Parent/Child/Family tracks (Architecture 1.0 §9).
- **Family Insight Engine**: weekly cross-domain rollups, mirroring
  `DashboardMetricsService`'s existing aggregation pattern.
- **Digital Twin**: with all 8 engines now live, this sprint wires
  every engine's slice into `ChildDigitalTwinProjection` for real, and
  implements the Growth Score composite (Architecture 1.0 §6.2) —
  the LAST piece of the backend-side Life Intelligence Platform.

**Exit criterion:** All 10 engines from Architecture 1.0 exist and are
registered. Backend-side Life Intelligence Platform is feature-complete.

---

## Sprint 19 — Dashboard + Parent App: Life Intelligence UI

Every engine built in Sprints 15–18 needs a face. New components,
following each app's own established pattern exactly (no new
architecture):
- Dashboard: `LearningProgressCard`, `FamilyStoreManagerCard`,
  `DigitalTwinCard` (explainable, non-ranking), `LifeTimelineCard`,
  `HealthTrendCard`, `FaithProgressCard`.
- Parent App: Learning tab, Family Store management, Broadcast
  composer, Digital Twin detail view, Habit/Health/Faith logging screens.

---

## Sprint 20 — Child App: Life Intelligence UI + First Real Build

- New `plugins/family_growth/` (habit check-off, health/faith quick-log,
  the new `ChildMessage` read-only inbox — the one genuinely new
  child-facing surface in this whole platform).
- **`flutter create . --platforms=android` runs for the first time**,
  reconciled against the 17 existing, real, reviewed Kotlin files
  (per `BUILD_GUIDE.md`'s own documented step).
- First real `flutter build apk` for both Parent App and Child App.

**Exit criterion:** Two real, installable APKs exist for the first
time in this project's history.

---

## Sprint 21 — Real Device Validation

Execute `docs/release/DEVICE_VALIDATION_MATRIX.md`'s procedure for
real, converting every NOT TESTED cell:
- Minimum: Samsung + Xiaomi + Pixel (the matrix's own documented
  highest-risk/highest-coverage combination).
- Every item: Accessibility, Foreground Service, Battery Optimization,
  Auto Start, Boot Receiver, Notifications, Heartbeat, Offline Mode,
  Pairing, Runtime Recovery.
- **Any bug found here gets fixed before Sprint 22 starts** — this
  project's own established rule (fix real bugs immediately, don't
  defer known-broken behavior).

---

## Sprint 22 — iOS Implementation

Only starts after Sprint 21 proves Android works on real hardware —
per the explicit prior decision to prove the platform once before
duplicating the investment. Follows `IOS_IMPLEMENTATION_PLAN.md`'s
6-step sequence exactly:
1. Xcode project + `DeviceActivityMonitor` extension target
2. `AuthorizationCenter` consent flow via platform channel
3. `ManagedSettings` policy application
4. `DeviceActivity` reporting → existing heartbeat endpoint
5. APNs integration into the already-provider-agnostic notification layer
6. TestFlight beta

---

## Sprint 23 — Production Hardening + Beta Launch Readiness

Closes every real, previously-documented gap rather than letting them
accumulate silently:
- Rate limit on `/billing/subscribe` (known since Sprint 10's security review)
- Wire the 7 real Anti-Tamper signals into backend risk scoring (known gap from `THREAT_MODEL.md`)
- Define `LocationEvent` retention policy (known gap from `DATA_CLASSIFICATION.md`)
- Real app icon + logo (known gap from the Product Design Review)
- Screenshot protection on Parent App (deferred from v1.1, revisit)
- Push notification real provider activation (FCM/APNs credentials)
- Final full security review + `RELEASE_ACCEPTANCE_CHECKLIST.md` re-run with real PASS results replacing every NOT TESTED
- Go/No-Go decision, backed by real data for the first time in this project's history

---

## What This Roadmap Deliberately Does Not Include

- Organization Platform (School/Company/Bank editions) — Architecture
  exists (`ORGANIZATION_PLATFORM_ARCHITECTURE.md`), deliberately frozen
  until Family edition is fully proven in the market, per this
  project's own standing decision.
- White Label, Enterprise MDM — same reasoning, same freeze.

## Sequencing Logic (Why This Order, Not Another)

Backend-first (15–18) before UI (19–20) because every UI component in
this project has always been a thin client over a real API — building
UI against unfinished engines would mean rebuilding it. Android device
proof (21) before iOS (22) because this project already spent one
investment building a real Android runtime; proving it works avoids
the iOS team inheriting an unvalidated architecture. Hardening (23)
last because closing known gaps against a moving target is wasted
effort — better once the shape is final.
