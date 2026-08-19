# ABNY SHIP BOARD

Updated 2026-08-19 · branch `abny/sprint-f1-unblock` · **189 commits ahead of `main`** · tree clean

Evidence: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `BLOCKED` · `NOT TESTED`

**Measured now, on a database migrated from empty (24 migrations → 101 tables), flushed Redis, real booted HTTP app:**
`193 suites / 4569 tests / 0 failing` · `tsc` PASS · tenant-guard 0 · event-emission 0 · all 8 mobile checkers 0 problems · admin dashboard 168 tests + build.

---

## P0 — BLOCKERS (all external)

| # | Item | Owner | Evidence | Next action |
|---|---|---|---|---|
| 1 | **189 commits unpushed** | **YOU** | Sandbox proxy refuses credentials for this repo. Not a code failure | `git push origin abny/sprint-f1-unblock` |
| 2 | **Android APK/AAB** | **YOU (Windows)** | No Flutter/Dart/Android SDK; registries 403. **No `flutter` command has ever run** | `MOBILE_BUILD_HANDOFF.md` — pinned versions, exact commands |
| 3 | **Firebase project + keystore** | **YOU** | Nothing fabricated. Two `applicationId`s, one project | `MOBILE_BUILD_HANDOFF.md` §2–3 |
| 4 | **5 evidence packages unresolved** | ENVIRONMENT | `record`, `image_picker`, `file_picker`, `path_provider`, `http_parser` declared and wired; `pub.dev` 403 so never resolved, no `pubspec.lock` invented | Resolves on first `flutter pub get` |
| 5 | **FCM token acquisition** | **Claude #1** | ABNY-side contract done and dormant | Not ours |

---

## P0 — DONE THIS SPRINT

**THE DEFECT LEDGER IS EMPTY.** It held 14 notification keys with full copy, scoring and a destination that **nothing produced** — the same defect class as `PF-E-001`, where the whole engine was built, tested 168 ways green, and never called. All 14 now have deterministic producers, database-level idempotency and family-timezone correctness. The guard asserts emptiness *and* that every key is producible, so it cannot pass vacuously.

The last three needed judgement rather than code. `GOAL_ALMOST_DONE` looked like it needed a new progress column — but a column with **no writer** would have been NULL forever and the condition false in production, so it is derived from `max_per_day` instead. `GOAL_DEADLINE_NEAR` had been deliberately withheld because it shared a fact slot with that key. `DAILY_GOAL_COMPLETED` is now named from `HealthEngineService`, the only thing in `src/` that ever emitted it — device-supplied `metadata` was refused, because client prose must never render as if the server wrote it.

**Also closed:** the operator now enters the admin key at runtime (in memory only — never storage, cookie or URL), which unblocked the growth dashboard; four per-market endpoints turned NOT MEASURED panels into real numbers; a demo seed fills a local database through the **real services and outbox**, so the numbers obey production invariants; two missing parent screens (Safety, Child detail); and a design pass across both apps.

**A full read-only review of the whole repository then found 13 more — all closed.** The two that mattered most were the same shape as each other, and neither was in the heavily-worked code:

| Severity | What it was |
|---|---|
| **HIGH** | `GET /feature-flags` returned the raw model, so **every parent received the UUID list of every family** each flag was enabled for — the tenant key used across the whole API — plus unreleased feature names. A parent now gets `{ key, isEnabledForMe }` and nothing else; the server takes the decision |
| **HIGH** | The cross-tenant probe **read as exhaustive and covered a third of the surface**: it filtered to routes whose every param was in a six-name whitelist, excluded collection routes entirely, and asserted only `fillable.length >= 20`. That is why the leak above survived. Now 246/246 routes are accounted for — probed, or classified with a per-entry reason — and a new unprobed route fails **by name** |
| **HIGH** | Widening that probe immediately found another: `POST /organizations/invitations/:invitationId/accept` answered 404 for an unknown id but 403/400 for a real one — an **existence oracle** over every organization's invitations, sitting in front of the email check that was the whole control |
| **MEDIUM** | `GET /billing/subscription` shipped the store **purchase token** to the device — the credential the server uses to decide purchase ownership |
| **MEDIUM** | The paywall sentence a parent hits at the upsell moment was **English and named a database flag**; promo redemption was English on an RTL screen with a UTC date; search returned «Child profile» and «Device · ANDROID» |
| **MEDIUM** | A Cairo parent opening «رؤى» between midnight and 3 a.m. got **yesterday's** insight — UTC used where the family's own calendar was meant, at two sites the family-date module was built to eliminate |
| **MEDIUM** | No index on `devices.last_seen_at`, which **every** "active" number filters on — the dashboard home page seq-scanned it three times per load. Measured on 140k devices: 41.3 ms → 2.7 ms |
| **MEDIUM** | `distinct` was applied **in Node, not SQL** at two sites, so every matching device row crossed the wire to be de-duplicated in JavaScript |
| **MEDIUM** | The admin dashboard **white-screened on any unknown URL** — no `*` route, and no error boundary anywhere, so a render throw blanked the document identically |
| **LOW** | The child data export omitted messages, rewards, habits, health and learning; the operator key was compared with `!==` |

**Defects found by doing the work:**

| Severity | What it was |
|---|---|
| **SECURITY** | `GET /children` returned the raw Prisma model, so **`pinCodeHash` — a 4-digit child PIN, trivially brute-forced offline — crossed the wire** on every fetch, into caches, logs and crash reports. Now an explicit `select` boundary with the view type derived from it, so a new column defaults to *not exposed* |
| **HIGH** | For **ten hours every night**, every reward and badge notification to the child was **silently dropped**: the deferral unique key had no audience column, so the child's row lost to `ON CONFLICT DO NOTHING`. Found only because a test that pinned its arguments but not its clock started failing after dark |
| **HIGH** | `CHILD_WELLBEING_CHECKIN` — the distress-escalation alert, the most important message this product sends — resolved to a destination the app answers `unavailable`, so **the tap was dead** |
| **HIGH** | A childless notification could not reach PostgreSQL at all — `''` is not a uuid, so three DB boundaries raised `22P02`. Also broke the quiet-hours digest |
| **HIGH** | The reward door collapsed every specific cause into `REWARD_GRANTED`, so four written-and-tested copy variants were unreachable and a streak read identically to a learning goal |
| **MEDIUM** | Parent copy mixed Latin and Arabic-Indic digits in one sentence; 22 RTL bugs in the apps; five hardcoded English sentences on the child's home hero, invisible to the parity checker because they were literals, not `t()` calls |
| **TEST** | The pagination guard asserted foreign families exist — so it passed on a reused database and failed on a clean one. Caught by running the suite twice |

Earlier this sprint: family country as a real FK · pairing activation, revocation and re-pairing · child catalogue · child push-token route · deep links end to end · keyset pagination replacing a silent `LIMIT 200` · 10 Arabic child-safety holes · error UX across 22 screens · evidence upload.

---

## P1 — OPEN

| Item | Why it is not done |
|---|---|
| Paymob / Fawry HMAC field order | **HUMAN** — VERIFY BEFORE GO-LIVE; merchant onboarding is 4–8 calendar weeks. **The only pure wall-clock item. Start it today.** |
| Staging deploy | **HUMAN** — no Railway project, no URL |
| `progress` and `coach` deep links | Still fall back to the inbox: a link with no id names no child, and picking one would be client-side authority |
| Six tables with no reader and no writer | `ai_risk_scores`, `app_catalog_entries`, `family_broadcast_messages`, `family_challenges`, `location_safe_zones`, `physical_measurement_logs` — migrated, indexed, backed up and permanently empty. `FeatureFlagService.isEnabled()` likewise gates no behaviour anywhere. Either build them or drop them; leaving them is the `PF-E-001` shape |
| Admin panels still NOT MEASURED | Cohort retention, refunds, referral summary, AI sessions. They render the gap treatment naming the missing route — never a zero |

## P2 — LATER

Child activity **content** (the session is a stopwatch; no endpoint serves lesson material) · parent screen-time **policy** UI (view-only today) · `GET /notifications?category=SAFETY` so the safety class is decided server-side · a parent-facing `AiAlert` route · iOS Parent · admin growth polish

**iOS Child:** recorded product decision — `AccessibilityService`, `UsageStatsManager` and overlays have no iOS equivalent. Ships as *"supervision requires an Android device"* or not at all.

---

## Open decisions — recorded, not taken

Whether the child's check-in should **disclose** that a distress signal alerts a parent · the Egyptian-colloquial vs MSA register split (child chrome vs server coach content; affects Saudi Arabia directly) · multi-device per child · merging the two child reward surfaces.

---

## Not claimed

No APK exists. **No `flutter` command has ever run** — every mobile result is `STATIC VERIFIED` by eight Python checkers, and no Dart test has ever executed. Staging is not deployed. Real Apple/Google sandboxes are unverified. Push delivery to a real device is untested. No readiness percentage is given.
