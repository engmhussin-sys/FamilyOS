# ABNY SHIP BOARD

Updated 2026-08-18 · branch `abny/sprint-f1-unblock` · **152 commits ahead of `main`** · tree clean

Evidence: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `BLOCKED` · `NOT TESTED`

**Measured now, on a database migrated from empty (22 migrations → 101 tables), flushed Redis, real booted HTTP app:**
`181 suites / 4177 tests / 0 failing` · `tsc` PASS · tenant-guard 0 · event-emission 0 · all 8 mobile checkers 0 problems.

---

## P0 — BLOCKERS (all external)

| # | Item | Owner | Evidence | Next action |
|---|---|---|---|---|
| 1 | **152 commits unpushed** | **YOU** | Sandbox proxy refuses credentials for this repo. Not a code failure | `git push origin abny/sprint-f1-unblock` |
| 2 | **Android APK/AAB** | **YOU (Windows)** | No Flutter/Dart/Android SDK; registries 403. **No `flutter` command has ever run** | `MOBILE_BUILD_HANDOFF.md` — pinned versions, exact commands |
| 3 | **Firebase project + keystore** | **YOU** | Nothing fabricated. Two `applicationId`s, one project | `MOBILE_BUILD_HANDOFF.md` §2–3 |
| 4 | **5 evidence packages unresolved** | ENVIRONMENT | `record`, `image_picker`, `file_picker`, `path_provider`, `http_parser` declared and wired; `pub.dev` 403 so never resolved, no `pubspec.lock` invented | Resolves on first `flutter pub get` |
| 5 | **Admin `InternalAdminGuard`** | **HUMAN DECISION** | Growth UI blocked on an architecture call | Your decision |
| 6 | **FCM token acquisition** | **Claude #1** | ABNY-side contract done and dormant | Not ours |

---

## P0 — DONE THIS SPRINT

**Notification producers — the ledger went 14 → 5.** Closed with deterministic triggers, database-level idempotency and family-timezone correctness: `PAYMENT_FAILED`, `SUBSCRIPTION_EXPIRING`, `HYDRATION_REMINDER`, `STUDY_REMINDER`, `EXERCISE_ENCOURAGEMENT`, `STREAK_AT_RISK`, `STREAK_ACHIEVED`, `ACHIEVEMENT_VERIFIED`, `ACHIEVEMENT_REJECTED`. The expiry sweep runs inside `FamilyDailyRolloverJob` — a lead-time fact judged on the family's own clock, so it shares the job that already owns that moment rather than a second `scheduled_jobs` row.

**Two missing parent screens built.** Safety (`GET /notifications`, safety-class filter transcribed from the server's own `notification-class.ts`) and Child detail (`GET /children/:childId`). 3 of 5 dead deep-link surfaces closed; `progress` and `coach` stay honest fallbacks because a link with no id names no child, and picking one would be client-side authority.

**Defects found by doing the work:**

| Severity | What it was |
|---|---|
| **SECURITY** | `GET /children` and `/children/:childId` returned the raw Prisma model, so **`pinCodeHash` — a 4-digit child PIN, trivially brute-forced offline — crossed the wire** on every fetch, into caches, logs and crash reports. Now an explicit `select` boundary with the view type derived from it, so a new column defaults to *not exposed*. Verified the new test fails 6/7 when the field is re-added |
| **HIGH** | `CHILD_WELLBEING_CHECKIN` — the distress-escalation alert, the most important message this product sends — resolved to a destination the app answers `unavailable`, so **the tap was dead**. Link now attached at the single writer, not the call sites, so a third producer cannot forget. Payload pinned to `['deepLink']` only: no child text, no distress code |
| **HIGH** | A childless notification could not reach PostgreSQL at all — `''` is not a uuid, so three DB boundaries raised `22P02`. Also broke the quiet-hours digest |
| **HIGH** | The reward door collapsed every specific cause into `REWARD_GRANTED`, so four written-and-tested copy variants were unreachable and a streak and a learning goal read identically |
| **MEDIUM** | Parent copy mixed Latin and Arabic-Indic digits in one sentence. One rule now, mirroring the child surface; six byte-pins updated, each quoting the old string |
| **TEST** | The new pagination guard asserted foreign families exist — so it passed on a reused database and failed on a clean one. Caught by running the suite twice |

Earlier this sprint: family country as a real FK · pairing activation, revocation and re-pairing · child catalogue · child push-token route · deep links end to end · keyset pagination replacing a silent `LIMIT 200` · `GOAL_STALLED_PARENT` producer · 10 Arabic child-safety holes · error UX across 16 screens · evidence upload.

---

## P1 — OPEN

| Item | Why it is not done |
|---|---|
| `LEARNING_GOAL_ACHIEVED` | One line away, but that line adds a child notification to a path that has never sent one — **your decision**, not a repair |
| `GOAL_COMPLETED_PARENT` | `weekCount` **is** computable; on the paid path it would be a second parent notification for a cause already served, which `e2e-01`/`e2e-13` forbid. Its niche is the unpaid completion, which changes "no grant ⇒ no notification" (CONTEXT §5) — **your decision** |
| `GOAL_DEADLINE_NEAR` | Deterministic and built, **withheld**: it shares a fact slot with `GOAL_ALMOST_DONE`, so shipping it alone would mark that key producible and erase a real defect entry |
| `GOAL_ALMOST_DONE` | **Missing data** — no partial-progress column exists for any goal, and `unitNoun` has no server source |
| `DAILY_GOAL_COMPLETED` | **Missing data** — no server-owned Arabic name for a daily goal |
| GRACE_PERIOD households cannot cancel | Behaviour change, not a copy fix |
| `RuntimeAlertService.deviceRevoked` puts a raw `deviceId` in `data` | Pinned by `e2e-12`; needs a deliberate change |
| Paymob / Fawry HMAC field order | **HUMAN** — VERIFY BEFORE GO-LIVE; merchant onboarding is 4–8 calendar weeks. **The only pure wall-clock item. Start it today.** |
| Staging deploy | **HUMAN** — no Railway project, no URL |

## P2 — LATER

Child activity **content** (the session is a stopwatch; no endpoint serves lesson material) · parent screen-time **policy** UI (view-only today) · `GET /notifications?category=SAFETY` so the safety class is decided server-side · a parent-facing `AiAlert` route · iOS Parent · admin growth polish

**iOS Child:** recorded product decision — `AccessibilityService`, `UsageStatsManager` and overlays have no iOS equivalent. Ships as *"supervision requires an Android device"* or not at all.

---

## Open decisions — recorded, not taken

Whether the child's check-in should **disclose** that a distress signal alerts a parent · the Egyptian-colloquial vs MSA register split (child chrome vs server coach content; affects Saudi Arabia directly) · multi-device per child · merging the two child reward surfaces.

---

## Not claimed

No APK exists. **No `flutter` command has ever run** — every mobile result is `STATIC VERIFIED` by eight Python checkers, and no Dart test has ever executed. Staging is not deployed. Real Apple/Google sandboxes are unverified. Push delivery to a real device is untested. No readiness percentage is given.
