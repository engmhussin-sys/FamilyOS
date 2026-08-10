# ADR — Edge-First Intelligence Architecture (Digital Wellbeing Engine)

**Status: IMPLEMENTED.** Backend fully built and verified. Child App
(Dart) and native Android (Kotlin) written but NOT TESTED — no real
Flutter/Android environment available in the sandbox that built this.

---

## 1. The gap this closes

This was not new architecture invented from scratch. Three things
already existed, deliberately declared-not-implemented in prior
sprints, and this ADR is the pass that completes them:

| Component | Where it already existed | State before this ADR |
|---|---|---|
| `IAppUsageCollector` | `plugins/screen_time/contracts/` (Decision-016) | Contract only, zero implementation |
| `AppUsageLog` table | `prisma/schema.prisma` | Existed, zero backend code ever wrote to it |
| `IBehaviorPatternDetector` | `plugins/local_ai/contracts/` | Declared only — its own docstring named "Step 10's App Usage Collection pipeline" as the missing prerequisite |
| `DailyUsageTracker.kt` | Android native, Sprint 5 | Real, but only ever computed ONE total-minutes number for the bedtime rule — no per-app, no pickups |
| `RuntimeAlertService` | `pairing/` module, Sprint 6 | Real and working, but for exactly ONE event type (accessibility disabled) |
| `PlatformAntiTamper.startPolling()` | `plugins/anti_tamper/`, earlier sprint | Real detection logic, but never actually called anywhere in the app |

## 2. What was built

**Backend** (`life-intelligence/`, never touches `ai-core`):
- `DigitalWellbeingEngineService` — new engine, same Future-Engine
  Contract discipline as every other Life Intelligence engine.
- `DailyBehavioralSnapshot` table (additive) — the day-level counters
  (pickups, night usage, blocked attempts) `AppUsageLog`'s per-app
  design had no room for.
- Reuses `AppUsageLog` (existing) for per-app breakdown, and
  `RuntimeAlertService`'s repository (existing, generalized from one
  event type to five) for near-real-time critical alerts — zero
  duplicate notification mechanism.
- 6 endpoints under the existing `/self/*` device-authenticated
  convention.

**Child App** (Dart):
- `PlatformAppUsageCollector` — the first real implementation of
  `IAppUsageCollector`.
- `DigitalWellbeingService` — the local aggregation layer. This is
  the ONE class that decides what leaves the device.
- `CriticalEventCoordinator` — finally starts the anti-tamper polling
  that existed but was dormant, routing detected signals to the new
  critical-event channel.
- `OfflineQueue` gained a configurable storage key (backward-compatible
  default) so this feature's queue is genuinely isolated from
  `HeartbeatService`'s — a real bug found and fixed during this pass
  (see §4).

**Native Android** (Kotlin, NOT TESTED): two new method-channel
handlers using `UsageStatsManager`/`UsageEvents` — the same
already-aggregated Android APIs `DailyUsageTracker.kt` already used,
extended to per-app and pickup-count granularity.

**Digital Twin integration**: a new, independent `wellbeing` sub-score
(score = a directional function of blocked attempts only; screen
time/pickups/night-usage are honest context in `inputs`, never folded
into a score with no clinical consensus on "how much is too much").
Deliberately excluded from `growthScore`'s own average — a
conservative choice, not an oversight (verified by an explicit test
asserting the sub-score count is unchanged).

## 3. Privacy discipline (structural, not a promise)

Every data type in this pipeline (`IDailyUsageSummaryInput`,
`ICriticalWellbeingEventInput`) is structurally incapable of carrying
message content, notification text, keystrokes, or GPS — there is no
field for any of them to be smuggled through, even by a misbehaving
client. Raw events never leave the device; only daily aggregates and
five specific critical-event types do.

## 4. Real bugs found and fixed during this pass

1. `OfflineQueue`'s storage key was hardcoded. A second producer
   sharing the same queue instance would have collided with
   `HeartbeatService`'s own queued events, and each producer's
   `drain()` throwing on the other's unrecognized event type would
   have caused a producer's OWN events to also go undelivered
   whenever they landed after a foreign event in the queue. Fixed
   with an optional constructor parameter, default value matching the
   original hardcoded key exactly — zero behavior change for
   `HeartbeatService`'s existing usage.
2. A missing closing brace in `MainActivity.kt` (caught by this
   project's own established brace-balance verification habit).
3. A Parent App API bug: checking `result.isEmpty` for an absent
   wellbeing snapshot, when the client's own `_unwrap()` wraps a null
   body as `{'data': null}` — never actually empty.

## 5. What remains NOT TESTED

Every line of Kotlin and every line of Dart in this pass. This is
real, architecturally-sound code written against documented Android
APIs and existing project contracts — not placeholder code — but it
has never executed on a real device or emulator, because none exists
in the environment that built it.
