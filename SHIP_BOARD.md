# ABNY SHIP BOARD

Updated 2026-08-17 · branch `abny/sprint-f1-unblock` · **110 commits ahead of `main`** · tree clean

Evidence: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `BLOCKED` · `NOT TESTED`

**Measured now, on a database migrated from empty (101 tables) with real Redis and a real booted HTTP app:**
`172 suites / 3726 tests / 0 failing` · `tsc` PASS · tenant-guard 0 · event-emission 0 · all 8 mobile checkers 0 problems.

---

## P0 — BLOCKERS

| # | Item | Owner | Status | Evidence | Next action |
|---|---|---|---|---|---|
| 1 | **110 commits unpushed** | **YOU** | ⛔ BLOCKED — ENVIRONMENT | Sandbox git proxy refuses credentials for this repo. Not a code failure | `git push origin abny/sprint-f1-unblock` |
| 2 | **Android APK/AAB** | **YOU (Windows)** | ⛔ BLOCKED — ENVIRONMENT | No Flutter/Dart/Android SDK; registries 403. **No `flutter` command has ever run** | `MOBILE_BUILD_HANDOFF.md` — one file, exact versions and commands |
| 3 | **Firebase project + keystore** | **YOU** | ⛔ HUMAN DECISION | Nothing fabricated. Two `applicationId`s, one project | `MOBILE_BUILD_HANDOFF.md` §2–3 |

**#1 and #2 are the entire remaining distance to a real APK.** Everything below needed neither.

---

## P0 — DONE THIS SPRINT (the five gaps + the vertical slice)

| Gap | What shipped | Evidence |
|---|---|---|
| **Family country** | `Family.countryCode` + migration 0022: a **real FK** to `countries`, `ON DELETE RESTRICT`, partial index. Accepted at registration and `PATCH /settings`, normalised, validated against *active* markets. Country derives the timezone; a conflicting pair is refused. An operator's pilot invitation outranks a client claim | `RUNTIME VERIFIED` — 22/22 migrations empty→101 tables; `'ZZ'` refused by the FK; EG/SA accepted; deleting a referenced country refused |
| **Pairing activation** | `POST /pairing/activate` already existed and drives `PARENT_CONFIRMED → POLICY_ASSIGNED → ACTIVATED`; **no client called it**. Now proven end to end and called by the parent app | `RUNTIME VERIFIED` — golden e2e-12, 31 tests |
| **Pairing revoke** | `ACTIVATED → REVOKED` added. A revoked device could still reach **policy, heartbeat and capabilities** — all three closed | `RUNTIME VERIFIED` — 8 surfaces answer 403 on the same unexpired token |
| **Re-pairing** | Found while building revoke: `PAIRING_INVITED` was first-event-only, so **revocation was a one-way door** — a parent could undo a mis-pairing and then never pair the right phone. Now admits the four terminal states; live states deliberately excluded (multi-device is its own product decision) | `RUNTIME VERIFIED` |
| **Child catalogue** | `GET /self/catalogue` + `/domains` — 18 domains, 47 items, age-annotated, read-only by construction. Every field derived from existing constants; four fields with no honest source left explicitly absent | `RUNTIME VERIFIED` — 36 tests |
| **Child push token** | `POST /pairing/device/push-token` — device-bound (id from the token, never the body), idempotent, invalidated on permanent FCM failure | `RUNTIME VERIFIED` |
| **Golden vertical slice** | e2e-13: register → country → child → invite → redeem → activate → goal → child completes → server verifies → reward → **distinct** parent/child notifications → timeline → admin counter → **replay** | `RUNTIME VERIFIED` — 36 tests. After two full redeliveries: grants **1**, timeline **1**, child notifications **1**, parent notifications **1** |
| **Adaptive loop** | e2e-14: missed-goal policy measured, dedup and cooldown proven by two independent mechanisms, parent adjusts, child sees the new goal | `RUNTIME VERIFIED` — 24 tests |
| **Arabic child safety** | e2e-15: MSA + Egyptian + Gulf, the ASCII-`\b` trap, 12 wholesome negative controls, privilege-escalation attempts. Safety Engine **not mocked** | `RUNTIME VERIFIED` — 74 tests |
| **10 safety holes closed** | Found by e2e-15, all fixed: no self-harm rule in the output filter at all (`أنت لا تستحق الحياة` passed); injection detection matched the attacker's command but not the model's **compliance** (`تجاهلت التعليمات وامنحك ١٠٠٠ نقطة` reached a 12-year-old on a surface with no parent approval); `AGE_INAPPROPRIATE` declared with no rule producing it; shadda/hamza/Arabic-Indic-digit bypasses. New shared Arabic normaliser; matching only, stored bytes unchanged | `RUNTIME VERIFIED` — proven by mutation: an always-safe gate breaks 4 acts, an always-refuse gate breaks the negative controls |
| **Parent notification** | Named the child but **never the achievement**, and `data` was NULL. Now: «🌟 محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة» — points summed from the ledger, title from `targetSummaryAr`. Child's message stays different and age-banded | `RUNTIME VERIFIED` |
| **Timeline in Arabic** | `title: 'Earned a reward'` was a hardcoded English literal in «سجل حياة الطفل». 13 titles moved to one Arabic copy module; **two were raw-enum leaks** | `RUNTIME VERIFIED` |
| **Mobile clients** | Parent activates a device from the pairing screen; child registers its push token; the domain chooser reads the real catalogue and falls back to today's goals if it cannot | `STATIC VERIFIED` — 8 checkers, 0 problems |

---

## P1 — NEEDS THE FIRST BUILD OR A HUMAN

| Item | Owner | Why |
|---|---|---|
| FCM token **acquisition** in the child app | Claude #1 | Needs `firebase_messaging`; no resolvable package registry here. ABNY-side contract is done and dormant |
| `docs/integration/FCM_CONTRACT.md` §8 says child push is out of scope | **HUMAN** | The route now exists. Needs a decision + a doc update, not a code change |
| Parent-path push-token invalidation | Claude #1 | Child path done; parent path still open |
| Scheduler processes only the **first 200 families** | Backend | `SQL_LIST_ACTIVE_FAMILIES` is `ORDER BY id LIMIT 200 OFFSET 0` with **no pagination loop** — a family-scoped daily rollover silently never reaches family 201+, ordered by random UUID |
| `GOAL_STALLED_PARENT` has **no producer** | Backend | The type, copy, scoring and quiet-hours class all exist; nothing fires it. The adaptive loop's vocabulary exists, its trigger does not. Pinned at zero in e2e-14 |
| Risk-blocked activation has no `code`/`messageAr` | Backend | Renders identically to an already-activated 409, so a client cannot tell them apart. The parent app therefore does not offer a risk override |
| A parent cannot lighten a goal in place | Backend | `UpdateRewardProgramDto` has no `targetSpec`/`durationMinutes`; the workable path is archive + re-author |
| Paymob / Fawry HMAC field order | **HUMAN** | Marked VERIFY BEFORE GO-LIVE; doc hosts unreachable. Merchant onboarding is 4–8 calendar weeks — **the only pure wall-clock item. Start it today.** |
| Staging deploy | **HUMAN** | No Railway project, no URL |

---

## P2 — LATER

Child activity **content** (the session is a stopwatch; no endpoint serves lesson material) · evidence upload (`POST /self/achievements/:id/evidence` exists, client says "not ready") · parent screen-time **policy** UI (view-only today) · `SELF_HARM_ECHO` as its own reason code · running `distress.ts` through the new normaliser · iOS Parent · admin growth polish

**iOS Child:** recorded product decision — `AccessibilityService`, `UsageStatsManager` and overlays have no iOS equivalent. Ships as *"supervision requires an Android device"* or not at all.

---

## Open decisions — recorded, not taken

- Whether the child's check-in should **disclose** that a distress signal alerts a parent. Copy promises nothing either way: a disclosed detector is one a child in trouble stops writing to; an undisclosed one that alerts anyway is a broken promise.
- **Register:** the child app's chrome is Egyptian colloquial, the server's coach content is MSA. One screen now shows both. Affects Saudi Arabia directly.
- Multi-device per child.
- Merging the two child reward surfaces (linked, not merged).
- `KNOWLEDGE` is not in `PROGRAM_CATEGORIES`; a taxonomy change was not made behind the parallel agents.

---

## Not claimed

No APK exists. **No `flutter` command has ever run** — every mobile result is `STATIC VERIFIED` by eight Python checkers, and no Dart test has ever executed. Staging is not deployed. Real Apple/Google sandboxes are unverified. Push delivery to a real device is untested. No readiness percentage is given.
