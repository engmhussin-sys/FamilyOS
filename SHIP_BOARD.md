# ABNY SHIP BOARD

Updated 2026-08-17 · branch `abny/sprint-f1-unblock` · **86 commits ahead of `main`** · tree clean

Evidence vocabulary: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `CODE REVIEWED` · `BLOCKED` · `NOT TESTED`

---

## P0 — BLOCKERS

| # | Item | Owner | Status | Evidence | Next action |
|---|---|---|---|---|---|
| 1 | **Android APK/AAB build** | **YOU (Windows)** | ⛔ BLOCKED — ENVIRONMENT | `release-doctor.sh` run here: **5 PASS / 0 WARN / 14 BLOCKED**, exit 1. No Flutter, no Dart, JDK 21 vs pinned 17, no Android SDK, no `pubspec.lock`, no Firebase, no keystore | `.\scripts\setup-windows-dev.ps1` → `.\scripts\release-doctor.ps1` until 0 BLOCKED → `.\scripts\mobile-build.ps1 -App both` |
| 2 | **86 commits unpushed** | **YOU** | ⛔ BLOCKED — ENVIRONMENT | Proxy refuses to inject credentials for this repo. Not a code failure | `git push origin abny/sprint-f1-unblock` from your machine |
| 3 | **Firebase project + keystore** | **YOU** | ⛔ HUMAN DECISION | `docs/mobile/REQUIRED-CREDENTIALS.md` lists exactly what is needed. Nothing fabricated | Create the Firebase project, generate the release keystore |

**#1 and #2 are the entire remaining distance to a real APK.** Everything below needed neither.

---

## P0 #4 — MOBILE MVP SURFACE vs Parent-15 / Child-15 — ✅ CLOSED THIS ROUND

Both lists were traced against the real navigation graph (`main.dart` route table, `ChildHomeShell` tabs, every `Navigator.push`) and every client call was cross-checked against `apps/backend/src/**/*.controller.ts`. "A screen file exists" was not accepted as present — it had to be **reachable** and wired to a **real** route.

### Was MISSING, now built

| Item | What was wrong | Commit |
|---|---|---|
| **Child 13 — AI Assistant** | `/self/coach/*` shipped complete (4 guarded routes, age-banded human-written content, safety filter per line, distress escalation) with **zero** Flutter consumers. No screen, no widget, no API class | `896c5ec` |
| **Child 5 — domain chooser** | `category` existed only as a read-only label on a card. A child could not say what they felt like doing | `f1260e1` |
| **Child 4 — reward store unreachable** | The coins store — the only place a child can SPEND — was reachable only via settings → the device diagnostics console. Same defect PA-M-041 named | `f1260e1` |
| **Parent 2 — family timezone dropped** | `create_family_screen` collected a country and sent only `name`. `timezone` was never sent, and `FamilyDateService` derives every streak, daily limit and reward idempotency key from it | `1a68264` |
| **Parent 4 — pairing never confirmed** | The invite screen showed a code and stopped. The parent never learned whether the device paired, and could not revoke | `152db31` |

### Defects found by doing the work, not by reading

| ID | Severity | What it was |
|---|---|---|
| `GAP-M-03` | **HIGH** | `generateSmartTasks()` was `post(...)` then `result['data'] as List`. `ApiClient.post` casts the body to a Map; the route returns a bare **array** — so it threw a `TypeError` on every call, before `['data']` (which does not exist on that route either) was reached. The one caller wrapped it in `catch (_)`, so smart-task cards silently never appeared on any device |
| `GAP-M-05` | **HIGH** | And it did not fail alone. `my_growth_screen` fetched five sections through ONE `Future.wait` in ONE `catch (_)` — directly under a comment claiming "one section's failure never blocks another". `Future.wait` rejects on first error, so health, learning, rewards **and** coaching never rendered either. Fixing the cast alone would have quietly restored four sections and left the basket for the next failure |
| `GAP-M-04` | LOW | `AppRoutes.digitalTwin` / `AppRoutes.lifeTimeline` were declared but absent from the route table, and both screens need constructor arguments. `pushNamed` on either could only throw. Deleted rather than registered |

### Backend gaps this surfaced — recorded, not invented

1. **Family `country` cannot be persisted.** No `country` column on `model Family`, no `country` on `UpdateSettingsDto`, and `forbidNonWhitelisted: true` — so sending it is a **400**. Country is currently only an input to the timezone.
2. **Nothing calls `POST /pairing/activate`.** A device that redeems a code registers, verifies, uploads capabilities, then sits at `PENDING_PAIRING` forever; only the admin dashboard has device actions. The new confirmation says "connected", and says "active" only when the server reports `ACTIVE` — it does not claim an activation that never happens.
3. **`ACTIVATED → REVOKED` is not in `PAIRING_TRANSITIONS`.** Revoking a device that activated but has not yet heartbeat returns 409.
4. **No child-facing catalogue or activity-proposal route.** `reward-programs` is parent-guarded; the only `self/*` controllers are `self/achievements` and `self/coach`. The brief's "child picks a domain → the engine proposes an activity" cannot be built without one. The chooser therefore filters real goals and proposes nothing.
5. **No child push-token route.** The only one is `POST /pairing/parent-device/push-token` — parent-only. The child app has no FCM dependency, no Firebase config, and no way to register a token.

### Open product decisions, recorded not taken

- Whether the child's check-in should **disclose** that a distress signal alerts a parent. The copy promises nothing either way: it does not say "nobody will read this" (a signal does alert a parent, generically, quoting nothing), and it does not say "we will tell your parent" (a disclosed detector is one a child in trouble stops writing to).
- **Register mismatch:** the child app's chrome is Egyptian colloquial («النهاردة», «جوايزي»); the server's coach content is MSA («أكملت مهمتك اليوم»). One screen now shows both. Matching the existing app copy was the consistent choice; MSA-vs-colloquial remains on the human-decision list and affects Saudi Arabia directly.
- Merging the two child reward surfaces (`/self/achievements/rewards` and `/life-intelligence/self/rewards/*`). Linked, not merged.

### Still PARTIAL on the two lists — non-blocking, recorded

Child 6 (session is a stopwatch, no activity content is served by any endpoint) · Child 9 (`POST /self/achievements/:id/evidence` exists, client renders "upload not ready" — Quran/upload-verified goals cannot be completed with evidence) · Child 8 (the learning button posts a hardcoded `subject:'study', 20min`) · Child 14 / Parent 12 (no push until Firebase exists — blocker #3) · Parent 6 (Home answers "is my child OK" from device liveness and risk, not from today's behaviour) · Parent 7 (screen time is view-only; the whole `screen-time-policy` / `app-block-rules` module has zero parent-app consumers, so a parent cannot set a limit or block an app)

---

## P0 — DONE EARLIER

| Item | Evidence |
|---|---|
| Smart Notification Engine wired to production producers | `notification_decisions` populated from real flows — `RUNTIME VERIFIED` |
| Bypass guard | Rogue producer added → failed by file+line → removed. Permanent synthetic control — `RUNTIME VERIFIED` |
| `PG-001` child-safety boundary | Safety runs on the exact bytes before persistence; removing the gate fails 20 of 37 tests — `RUNTIME VERIFIED` |
| `POST_NOTIFICATIONS` requested in both apps | The child arm was literally `break` — notifications could never appear on Android 13+ — `STATIC VERIFIED` |
| Golden E2E — 11 scenarios incl. full chain + replay | Real PostgreSQL + Redis + booted HTTP app — `RUNTIME VERIFIED` |
| Reward loops: Quran · Sport · Science · Programming · Screen-time | Replay adds zero grants / notifications / timeline rows — `RUNTIME VERIFIED` |
| Play Billing server verification | 19/19 incl. duplicate, concurrent, tampered, cross-tenant — `RUNTIME VERIFIED` |
| Apple StoreKit 2 verification | ES256 JWS, x5c → Apple Root CA G3, bundle-id — `RUNTIME VERIFIED` (mocked Apple HTTP) |
| Release signing guard + AAB path | 52/52 checks; debug signing cannot reach a release build — `RUNTIME VERIFIED` |
| Pilot cohorts SA + EG, flag off by default | Uninvited family refused with no account created — `RUNTIME VERIFIED` |
| Backend · Admin · migrations | 3,403 / 165 / 0 · 134/134 + `vite build` · 20/20 migrations from empty → 101 tables |

---

## P1 — AFTER FIRST BUILD

Real-device pairing · `POST /pairing/activate` from the parent app · FCM delivery (Claude #1) · a child push-token route · staging deploy · Paymob/Fawry HMAC verification · subscription lifecycle on device

## P2 — LATER

Child activity content · evidence upload · parent screen-time policy UI · iOS Parent · Admin growth polish · AI coach depth

**iOS Child:** product decision recorded — `AccessibilityService`, `UsageStatsManager` and overlays have no iOS equivalent. Ships as *"supervision requires an Android device"* or not at all.

---

## BACKLOG (non-blocking, recorded not fixed)

`sendToDevice` takes a `data` arg nobody passes · no deep-link URI scheme · PERMANENT delivery failure never clears `Device.pushToken` · `acceptedTerms` sent with no terms text · zero p95 measurement · no independent pentest · `POST /events/batch` (`@ChildSurface`) has no client · `FamilyGrowthApi.logActivity()` exists with no caller · `GET /life-intelligence/self/smart-tasks` unused (only `POST .../generate` is called)

---

## Not claimed

No APK exists. **No `flutter` command has ever run in this project** — every mobile result above is `STATIC VERIFIED` by the eight Python checkers (`dart_preflight`, `verify_dart_imports`, `verify_l10n_parity`, `verify_notification_permission`, `verify_accessibility_check`, `verify_gradle_syntax`, `verify_network_security`, `verify_release_signing`), all reporting **0 problems** after this round. Nothing here was compiled, and no Dart test in this round was executed. Staging is not deployed. Real Apple/Google sandbox is unverified. No readiness percentage is given.
