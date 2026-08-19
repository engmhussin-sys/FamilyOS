# ABNY — EXECUTION BOARD

Branch `abny/sprint-f1-unblock` · **259 commits ahead of `main`** · tree clean · updated 2026-08-19

Evidence vocabulary, used strictly: `RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `CODE REVIEWED` · `BLOCKED` · `DELEGATED` · `HUMAN DECISION`

## Measured state

| | |
|---|---|
| Backend | **221 suites · 5,339 tests · 0 failing** on a database built from empty by the 30 migrations (→ 101 tables), real Redis, real booted HTTP app — **and identical on a second consecutive run against the reused database** |
| `tsc --noEmit` | PASS |
| Tenant-scoping guard · event-emission guard | 0 violations · 0 violations |
| Admin dashboard | 184 tests pass · `vite build` clean (`BUILD VERIFIED`) |
| Mobile | 9 static checkers, 0 problems. **No Dart, Kotlin or Gradle has ever been compiled here** (`BLOCKED`) |

---

## P0 — MUST CLOSE BEFORE FIRST CONTROLLED PILOT

| ID | Description | Owner | Status | Evidence | Exact next action |
|---|---|---|---|---|---|
| **P0-1** | 259 commits exist only in this sandbox | **YOU** | `BLOCKED` | Git proxy: `engmhussin-sys/FamilyOS is not in this session's authorized repository set`. Not a code failure | `git fetch ABNY-commits.bundle abny/sprint-f1-unblock:abny/sprint-f1-unblock` then `git push origin abny/sprint-f1-unblock` |
| **P0-2** | No APK has ever existed | **YOU (Windows)** | `BLOCKED` | No Flutter, Dart, Android SDK or JDK in this sandbox; pub.dev returns 403 | Run `scripts/setup-windows-dev.ps1`, then `scripts/release-doctor.ps1`. It now names every missing file, directory and command instead of failing mid-Gradle |
| **P0-3** | Firebase project (parent app only) | **YOU** | `HUMAN DECISION` | Nothing fabricated. Child app declares no `firebase_core`/`firebase_messaging` — the earlier requirement on it was invented and has been removed | Create one project, two Android apps: `com.aifamilycoach.parent_app`, `com.aifamilycoach.child_app`. Place `google-services.json` in `apps/parent-app/android/app/`, run `flutterfire configure` |
| **P0-4** | Two upload keystores | **YOU** | `HUMAN DECISION` | `signing.properties.example` holds the exact `keytool` line (per-app alias, 4096-bit, PKCS12). `.gitignore` covers `signing.properties`; nothing is committed | Generate both, write `signing.properties` per app. The release build now refuses to fall back to debug keys |
| **P0-5** | Push delivery to a real device | **Claude #1** | `DELEGATED` | ABNY-side contract complete: payload shape, `deepLink` field, idempotency key, audience, stale-token semantics. Token *acquisition* is the other engineer's | Not ours. Hand over `MOBILE_BUILD_HANDOFF.md` |
| **P0-6** | `test1@example.com` / `SecurePass123!` are in git history | **YOU** | `HUMAN DECISION` | Removed from `scripts/verification-script*.ps1`; both now take `-BaseUrl`/`-Email`/`-Password` with no defaults. History is not rewritten | Rotate that account before the repository is shared |

---

## P1 — REQUIRED BEFORE PUBLIC RELEASE

| ID | Description | Owner | Status | Evidence | Exact next action |
|---|---|---|---|---|---|
| **P1-1** | Paymob / Fawry HMAC field order | **YOU** | `HUMAN DECISION` | Never faked. Merchant onboarding is 4–8 calendar weeks — **the only item that gets worse purely by waiting** | Start the merchant application today. Verify field order against their live sandbox before go-live |
| **P1-2** | Staging deploy | **YOU** | `BLOCKED` | No Railway project, no URL. `docker compose up -d` runs the whole stack locally | Create the project, then point `verification-script.ps1 -BaseUrl` at it |
| **P1-3** | Delivery channel is not on the decision ledger | ABNY | `BLOCKED` | `PushFanoutOutcome` is computed and discarded in `PrismaRuntimeAlertRepository.createForFamilyOwner`, below the layer that writes the ledger. **No column was added** — it would be NULL forever and would read to an operator as "no push problems", the exact defect `dormant-schema.guard.spec.ts` exists to prevent | Lift the outcome through `IRuntimeAlertRepository` → `INotificationOutcome`; needs the same owner as P0-5 |
| **P1-4** | Assessment-based reward strategy | ABNY | `CODE REVIEWED` | Nothing writes `LearningAssessment`, so the strategy scored every child null and blamed them three times before escalating. It is now **refused at creation** with a specific Arabic sentence | Build the assessment feature, or leave it refused. `assessment-score-producer.guard.spec.ts` takes the refusal down automatically the day a writer appears |
| **P1-5** | Ten dormant tables | ABNY | `CODE REVIEWED` | Each now carries a written reason from a closed vocabulary, checked by `dormant-schema.guard.spec.ts` across all 101 models. Location is dormant wholesale — no ingest module exists at all | Decide per table: build the writer, or drop it in a migration. The guard makes a new silent one impossible |
| **P1-6** | Four admin panels report NOT MEASURED | ABNY | `CODE REVIEWED` | Cohort retention, refunds, referral summary, AI sessions. They render the gap treatment naming the missing route — **never a zero** | Build the four routes, or accept the gap treatment |
| **P1-7** | `e2e-10`'s fixture family survives its run | ABNY | `CODE REVIEWED` | It leaves `notification_decisions` rows on `2026-01-15`. Two suites took absolute counts over that date and were made order-independent; a third could repeat the mistake | Have the fixture clean up, or make every analytics assertion delta-based |

---

## CLOSED THIS PHASE — defects that passed their tests and could never fire

Every one was found by asking *does anything run this?* rather than *is this tested?*, and every one is `RUNTIME VERIFIED` closed.

| ID | What it was |
|---|---|
| **I-1** | **A child could be scored an over-long unsafe sentence as SAFE.** `PROFILES[band] ?? PROFILES[SAFEST_AGE_BAND]` — `??` does not fall back on an *inherited* key, so `ageBandProfile('toString')` returned `Object.prototype.toString`, `.maxChars` was undefined, and every ceiling comparison was false. Now an own-property check |
| **I-2** | **Two seeded badges could never be earned through the app's own button.** `health-engine.service.ts` fired `DAILY_GOAL_COMPLETED` while `first_hydration_goal` / `first_activity_goal` were seeded against the contract names. Both doors now fire both, sharing one `composeIdempotencyKey` so the crossing cannot be paid twice |
| **I-3** | **A child was paid twice for one action.** Closing I-2 exposed two seeded XP rules matching one crossing with byte-identical Arabic labels — 30 XP where the catalogue says 15. Migration `0030` retires the duplicate by `is_active = false`, so a household that already banked 30 keeps it |
| **I-4** | **A once-ever badge lost to arrival order.** At `maxPerHour = 3` a busy hour suppressed the child's `first_activity_goal` message at score 17 **while the parent was told about the same badge at score 25**. `ONCE_EVER_TYPES` now exempts the two badge types from all three volume loads — by name, each entry citing the `child_badge_awards` UNIQUE constraint as its guarantee. Quiet hours still defer them: deferral is not loss |
| **I-5** | **The parent was never told about a second badge.** Parent notifications deduped on `(userId, childId, type, title)`, and `BADGE_EARNED_PARENT`'s title is the constant «وسام جديد» for every badge — so two different badges five minutes apart collapsed. The predicate now names the occurrence |
| **I-6** | **The most important notification this product sends was invisible to its operators.** A safety escalation is on `ENGINE_BYPASS_ALLOWLIST` and the ledger was only written from the engine door, so it produced no `notification_decisions` row. It now writes one with `provider_id='safety-bypass'` and `explanation=[]` — the evidence that nothing was weighed. **The bypass itself was not touched**; a critical escalation is still never scored |
| **I-7** | **An `abny://` link arriving from outside the app resolved to nothing.** Neither Android manifest declared the scheme, and neither app had a cold-start handler. Both now do, routing through the existing resolver — not a second one |
| **I-8** | `BADGE_EARNED` had a producer and no reader, on an unreachable branch. The emission was removed rather than given a consumer, because the announcement is already owned by `processTriggerEvent` — a reader would have been a second notification, not a missing one |

**And guards so none of it can recur silently.** `dormant-schema.guard.spec.ts` classifies all 101 models and ratchets — when a model becomes live its ledger entry turns red and must be deleted, which is how `AiAlert` and `AppCatalogEntry` left it. The producer-chain guard now requires a producer, an audience, a destination the app actually answers, Arabic copy in every tone band, a quiet-hours class, a safety class and provenance. `child-safety-mutation.spec.ts` states 11 safety invariants as predicates and builds four defective collaborators in-process, asserting each mutant's red set **and its green complement**. `reward-rule-collision.spec.ts` fails if two seeded rules can ever pay one crossing. `notification-audience-symmetry.ts` fails if a child loses every notification about an occurrence the parent was told about. `dart_preflight` gained identifier scope resolution after a real compile error was found sitting behind 300 green `t()` call sites — nine checkers reporting zero problems while the code could not compile.

---

## BLOCKED BY ENVIRONMENT

| ID | Description | Status | Evidence |
|---|---|---|---|
| **E-1** | Flutter / Dart / Android SDK / JDK / PowerShell | `BLOCKED` | Not installed and not installable here. Every mobile result on this board is `STATIC VERIFIED` by Python checkers. **No Dart test has ever executed** |
| **E-2** | `pub.dev` returns 403 | `BLOCKED` | Five evidence-upload packages — `record 5.1.2`, `image_picker 1.1.2`, `file_picker 8.1.2`, `path_provider 2.1.4`, `http_parser ^4.0.2` — are declared, imported and pinned inside the Flutter 3.24.5 / Dart ≥3.3 / compileSdk 34 window. **No `pubspec.lock` was invented.** Resolves on the first `flutter pub get` |
| **E-3** | Git push | `BLOCKED` | The proxy refuses credentials for this repository specifically. See P0-1 |
| **E-4** | Apple / Google / Paymob / Fawry sandboxes | `BLOCKED` | Nothing faked, nothing stubbed to look verified |

---

## DELEGATED

| ID | Description | Owner | Interface |
|---|---|---|---|
| **D-1** | FCM token acquisition and transport | Claude #1 | ABNY emits the payload with `data.deepLink`, an idempotency key, and the audience. Stale-token cleanup contract is written. `pushTokenRegistrationServiceProvider` exists in the child app with zero consumers, waiting for `firebase_messaging` |

---

## Not claimed

No APK exists. No `flutter` command has ever run in this environment and no Dart test has ever executed. Staging is not deployed. Apple, Google, Paymob and Fawry sandboxes are unverified. Push delivery to a real device is untested. No readiness percentage is given, here or anywhere.
