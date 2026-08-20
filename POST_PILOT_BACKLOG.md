# ABNY — POST-PILOT BACKLOG

Everything here is **known, recorded and deliberately not being worked on.** The codebase is feature frozen; the next objective is an APK on a phone. Nothing below is allowed to interrupt that.

Only six classes of issue may interrupt the build path: **P0 SECURITY · P0 CHILD SAFETY · P0 DATA LOSS · P0 AUTHORIZATION · P0 CRASH · P0 BUILD BLOCKER.** Nothing on this page qualifies.

---

## Product gaps that are honest, not hidden

| # | Item | Why it is not a blocker |
|---|---|---|
| B-1 | **Delivery channel is not on the decision ledger** | `PushFanoutOutcome` is computed and discarded below the layer that writes the ledger. No column was added, deliberately — it would be NULL forever and would read to an operator as "no push problems". Belongs with the push owner |
| B-2 | **Assessment-based reward strategy** | Nothing writes `LearningAssessment`. The strategy is now refused at creation with a specific Arabic sentence rather than silently scoring every child null. A ratchet test removes the refusal the day a writer lands |
| B-3 | **Ten dormant tables** | Location wholesale (no ingest module exists), family challenges, per-child risk scores, physical measurements, and the migration-seeded reference tables. Each carries a written reason checked by `dormant-schema.guard.spec.ts`. Build the writer or drop the table — later |
| B-4 | **Four admin panels report NOT MEASURED** | Cohort retention, refunds, referral summary, AI sessions. They render the gap treatment naming the missing route, never a zero |
| B-5 | **Child activity content** | The study/exercise session is a stopwatch; no endpoint serves lesson material |
| B-6 | **`GET /notifications?category=SAFETY`** | The safety class is decided client-side in one place; moving it server-side is tidier, not safer |
| B-7 | **Parent "mark reviewed" for AI alerts** | Alerts stay `NEW` and re-raise once per family per business day until reviewed. Correct, just noisy |
| B-8 | **Unreferenced evidence cleanup** | Bounded by `EVIDENCE_RETENTION_DAYS`. Bounded is not a leak |
| B-9 | **`e2e-10`'s fixture family survives its run** | Leaves rows on `2026-01-15`. Two suites that took absolute counts over that date were made order-independent; a third could repeat the mistake |
| B-10 | **iOS** | Recorded product decision, not an omission. Full supervision needs `AccessibilityService` and `UsageStatsManager`, which have no iOS equivalent. iOS Child ships as *"supervision requires an Android device"* or not at all. iOS Parent is a separate, later question |

---

## Open product decisions — recorded, not taken

These are yours, and none of them blocks a build:

- Whether the child's check-in should **disclose** that a distress signal alerts a parent. Today it does not, so a child cannot learn what the classifier reacts to — that is a real tradeoff, not an oversight.
- The Egyptian-colloquial vs Modern Standard Arabic register split: child chrome versus server coach content. Affects Saudi Arabia directly.
- Multi-device per child. The pairing state machine deliberately excludes live states from re-invitation; widening it silently becomes multi-device.
- Merging the two child reward surfaces.
- The `applicationId` naming question raised by the build handoff.

---

## The rule

If the smoke test turns up something that is not one of the six P0 classes, it is added here and the pass continues. A pilot that ships with ten known, written-down gaps is in better shape than one that ships with three unknown ones.
