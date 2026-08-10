# Sprint 12 — AI Family Growth Platform: Architecture Review

**Status: REVIEW ONLY. No code written. Awaiting approval per explicit instruction.**

Every claim below about "what exists" is grounded in reading the real
files this session — not assumed. File paths and method signatures are
copy-real, not paraphrased from memory.

---

## 0. The One Finding That Must Be Decided Before Anything Else

**The instruction says "use the existing Rule Engine / Decision Engine /
Recommendation Engine." Read literally and applied naively, this is not
actually possible without modifying frozen code — and forcing it would
be bad architecture even if allowed.** This is the single most
important finding in this review.

### Why

```
RecommendationEngineService.recommend(childId, familyId, deviceId): Promise<IRecommendationResult>
  -> KnowledgeEngineService.buildSnapshot(childId, familyId, deviceId): IKnowledgeSnapshot
  -> DecisionEngineService.decide(snapshot)
  -> RuleEngineService.evaluate(snapshot)
```

`IKnowledgeSnapshot` (`modules/ai-core/domain/knowledge.types.ts`) is
concretely shaped for Digital Safety only:

```ts
export interface IKnowledgeSnapshot {
  childId: string; familyId: string; ageYears: number;
  trustLevel: string | null; riskLevel: string; riskReasons: string[];
  dailyLimitMinutes: number | null; focusModeEnabled: boolean;
  accessibilityServiceEnabled: boolean | null; enforcementActive: boolean | null;
  recentViolationCount: number;
}
```

There is no field here for a nutrition score, a habit streak, or an
activity minute count — and `recommend()`'s third parameter is
literally `deviceId`, because the entire pipeline was built around "is
this device's screen time policy working." `RECOMMENDATION_COPY` (the
table `finalize()` looks up `decision.recommendationType` against) is
similarly a fixed, safety-specific vocabulary.

**Two ways to honor "use the existing engine," and only one is honest:**

- ❌ **Bloat `IKnowledgeSnapshot` with 20 new optional fields** (nutrition
  score, hydration ml, habit streak, activity minutes...) so the one
  interface "supports" every domain. This is technically additive
  (backward compatible) but is the exact anti-pattern this project has
  avoided everywhere else — a God-interface no single engine actually
  uses in full, and every new domain touches a file 8 other domains
  also depend on, recreating the coupling this project's Repository
  Pattern discipline exists to prevent.
- ✅ **Reuse the PATTERN, not the class instances.** Every new Growth
  Engine gets its own `I<Domain>Snapshot`, its own tiny Rule
  component, its own Decision step — mirroring `RuleEngineService`/
  `DecisionEngineService`'s shape exactly, as NEW files, never touching
  the existing two. What's genuinely domain-agnostic gets reused
  DIRECTLY, not re-implemented (see §1).

**This review proceeds on the ✅ path.** It is additive (zero existing
file touched), matches this project's own established pattern more
faithfully than the ❌ path would, and is what "don't redesign, build
on top" actually means once you look at the real interfaces instead of
the engine names alone.

---

## 1. What Genuinely Reuses Directly (Verified, Not Assumed)

| Component | Real signature | Reusable as-is? | Why |
|---|---|---|---|
| `SafetyEngineService.validate()` | `validate(recommendationType: string \| null, title: string, body: string): ISafetyCheckResult` | ✅ **Yes, directly** | Pure text-safety validation, zero domain coupling — a nutrition tip's copy gets validated exactly like a screen-time recommendation's |
| `MemoryEngineService.setPreference/getPreference` | `(childId, key, value): Promise<void>` / `(childId, key)` | ✅ **Yes, directly** | Already generic key-value per child — no schema change needed to store "favoriteRewardCategory" or "bestStudyTime" here |
| `MemoryEngineService.recordRecommendation/getDecisionHistory` | Generic `Record<string, unknown>` payloads | ✅ **Yes, directly** | Already accepts arbitrary JSON — a Nutrition Engine recommendation records the same way a Safety one does |
| `AiMemoryEntry.category` (schema) | `String` (not an enum) — **its own comment says**: *"meant to grow new categories (Health/Education engines, later) without a schema migration per category"* | ✅ **Yes, directly, zero migration** | This is the single strongest piece of evidence this project's own prior design anticipated exactly this expansion |
| `IAIProvider` (Anthropic adapter) | Domain-agnostic phrasing interface | ✅ **Yes, directly** | A nutrition tip gets AI-phrased through the identical circuit-broken, cost-tracked provider a safety recommendation uses |
| Child App `EventBus` (`event_bus.dart`) | `Stream<AgentEvent>`, `.on<T extends AgentEvent>()` | ✅ **Yes, directly** | Generic typed event stream — new event subclasses (`HabitCompletedEvent`, `HydrationLoggedEvent`) flow through the SAME bus, zero change to `EventBus` itself |
| `NotificationsService` + `Notification` model | Generic title/body/category delivery | ✅ **Yes, directly** | A habit reminder is still just a `Notification` row — no new delivery mechanism needed |
| Audit/Retention/PrivacyFilter infra | Generic, category-driven | ✅ **Yes, directly** | New tables follow the same soft-delete + retention pattern already established |

## 2. What Requires New (Additive) Components — Not Reuse, Not Modification

| Component | Why it can't be the existing one | New component (parallel, same pattern) |
|---|---|---|
| `RuleEngineService` | `evaluate(snapshot: IKnowledgeSnapshot)` is safety-typed | New `NutritionRuleService`, `HydrationRuleService`, etc. — same "pure function, zero I/O" discipline, new files |
| `DecisionEngineService` | `decide()` returns a safety-shaped `IExplainableDecision` keyed to `RECOMMENDATION_COPY` | New per-domain decision steps, OR one new `GrowthDecisionEngineService` genuinely generic across growth domains (recommended — see §3) |
| `RecommendationEngineService` | Hard-coded to `deviceId` + safety copy table | New `FamilyGrowthOrchestratorService` — mirrors its shape, composes the NEW rule/decision components + the REUSED Safety/Memory/AI Provider |
| `BehavioralIntelligenceEngineService.computeTrend(deviceId,...)` | Coupled to `deviceId`, i.e. screen/device behavior specifically | New `GrowthTrendService` for nutrition/activity/habit trend detection — same trend-math pattern, different input series |

---

## 3. Proposed New Module: `family-growth` (Additive Bounded Context)

Mirrors `modules/ai-core`'s own internal shape — `domain/`,
`application/`, `infrastructure/`, `presentation/` — as a **sibling**
module, never touching `modules/ai-core/*`.

```
apps/backend/src/modules/family-growth/
  domain/
    growth-snapshot.types.ts       (NEW — one per sub-domain, small, focused)
    growth-decision.types.ts
  application/services/
    nutrition-engine.service.ts    (NEW)
    hydration-engine.service.ts    (NEW)
    activity-engine.service.ts     (NEW)
    habit-builder.service.ts       (NEW)
    rewards-engine.service.ts      (NEW)
    parenting-coach.service.ts     (NEW — composes the above + REUSED MemoryEngineService)
    smart-notification-timing.service.ts (NEW — decides timing, still calls the REUSED NotificationsService to actually send)
    family-insight.service.ts      (NEW — read-side aggregator)
    growth-decision-engine.service.ts (NEW — the generic decision step referenced in §2)
  infrastructure/
    prisma-*.repository.ts         (one per new table, §5)
  presentation/controllers/
    family-growth.controller.ts    (NEW — see §8 for routes)
```

**Family Digital Twin is explicitly NOT a new engine or a new stored
"profile blob."** It is a read-side composition: `family-insight.service.ts`
queries `AiMemoryEntry` (new categories) + the new domain tables +
existing `DevicePairingEvent`/`DeviceRiskAssessment` history, and
assembles the twin view on demand. Storing a separate denormalized
"twin" table risks becoming a second, driftable source of truth for
data that already lives somewhere real — a materialized/cached read
model is the honest pattern here, not a new canonical entity.

---

## 4. Per-Engine Review (existing / gap / new)

### 4.1 Parenting Coach Engine
- **Exists & reusable:** `MemoryEngineService` (preference + recommendation storage), `SafetyEngineService`, `IAIProvider`, `NotificationsService`
- **Gap:** no aggregation across sleep/study/behavior/screen-time exists today as a single feed
- **New:** `parenting-coach.service.ts` — reads from the new domain tables (§5) + existing `ScreenTimePolicy`/`DevicePairingEvent` history, composes via the new `growth-decision-engine.service.ts`, phrases via the reused `IAIProvider`

### 4.2 Nutrition Engine
- **Exists & reusable:** `AiMemoryEntry` for the computed daily score (category `NUTRITION_SCORE`), Safety/AI Provider for tip copy
- **Gap:** no meal/nutrient logging exists anywhere in this codebase today
- **New:** `NutritionLog`, `NutritionScoreDaily` tables; `nutrition-engine.service.ts` computing the score via a new, small deterministic Rule component (protein/calcium/iron/sugar/vitamin thresholds by age band)

### 4.3 Hydration Engine
- **Exists & reusable:** same memory/safety/AI pattern
- **Gap:** no hydration data exists; daily target calculation (age/weight/activity) is new domain logic
- **New:** `HydrationLog` table; `hydration-engine.service.ts`

### 4.4 Activity Engine
- **Exists & reusable:** same pattern; `BehavioralIntelligenceEngineService`'s trend-detection MATH is a reusable reference pattern (not the class itself, per §2)
- **Gap:** no activity logging exists
- **New:** `ActivityLog`, `ActivityScoreDaily` tables; `activity-engine.service.ts`

### 4.5 Habit Builder Engine
- **Exists & reusable:** Child App's `EventBus` for on-device completion events; `NotificationsService` for reminders
- **Gap:** no task/habit concept exists anywhere (`AiMemoryEntry` could store a habit's CURRENT streak count as a preference-like value, but the habit DEFINITION and its daily completion log need real relational tables — a streak history isn't a good fit for the memory table's key-value shape)
- **New:** `Habit`, `HabitCompletion` tables; `habit-builder.service.ts`

### 4.6 Rewards Engine
- **Exists & reusable:** `AuditLog` pattern for the ledger's audit trail
- **Gap:** zero gamification concept exists in this codebase
- **New:** `RewardsAccount`, `RewardsLedgerEntry`, `BadgeDefinition`, `ChildBadgeAward`, `RewardCatalogItem`, `RewardRedemption` tables; `rewards-engine.service.ts`

### 4.7 Smart Notification Engine
- **Exists & reusable:** `NotificationsService`/`Notification` model **directly, unmodified** — this engine only decides WHEN and HOW to phrase, then calls the existing send path
- **Gap:** no "best time to notify" logic exists — today's notifications are triggered by events, not scheduled by a timing model
- **New:** `smart-notification-timing.service.ts` — reads the child's schedule context (school hours, prayer time if configured, sleep window from Habit data) and calls the EXISTING `NotificationsService.create()` at the decided time; **no change to the Notification entity or delivery path**

### 4.8 Family Insight Engine
- **Exists & reusable:** `DashboardMetricsService`'s aggregation pattern (Sprint 8) is a direct structural reference; Admin Dashboard's existing `FamilyInsightsCard` UI pattern
- **Gap:** no cross-domain (nutrition + activity + habits + screen time) weekly rollup exists
- **New:** `family-insight.service.ts` — read-only aggregator, no new source-of-truth table

### 4.9 Family Digital Twin
- **Exists & reusable:** everything above, composed
- **Gap:** none structurally — this is explicitly a VIEW, not new storage (§3)
- **New:** a query service only, no new persistent entity

---

## 5. Database Changes (Additive Only — Zero Migration to Any Existing Table)

| New table | Purpose | Notes |
|---|---|---|
| `NutritionLog` | Per-meal entries | `childId` FK, cascades like every other child-scoped table |
| `NutritionScoreDaily` | Computed daily score + breakdown JSON | |
| `HydrationLog` | Per-intake entries | |
| `ActivityLog` | Per-session entries | |
| `ActivityScoreDaily` | Computed daily score | |
| `Habit` | Habit definitions (built-in + parent-custom) | `isCustom: boolean`, `createdByUserId` |
| `HabitCompletion` | Daily completion records | |
| `RewardsAccount` | XP/coins/stars/level, one per child | |
| `RewardsLedgerEntry` | Append-only earn/redeem log | Mirrors `AuditLog`'s append-only discipline |
| `BadgeDefinition` | Achievement criteria (JSON) | |
| `ChildBadgeAward` | Earned badges | |
| `RewardCatalogItem` | Parent-defined real-world rewards | |
| `RewardRedemption` | Redemption requests + approval state | |

**Zero changes to:** `Child`, `Family`, `User`, `Device`,
`ScreenTimePolicy`, `AiMemoryEntry`'s schema (only new `category`
string VALUES, no column change), or any existing table. Every new
table follows the existing soft-delete + `@@index([childId, ...])`
convention already established throughout `schema.prisma`.

---

## 6. Event Flow (New Event Types on the EXISTING Bus)

```
Child App (on-device)
  HabitCompletedEvent / HydrationLoggedEvent / ActivityLoggedEvent
    -> EXISTING EventBus.emit()  [zero change to EventBus itself]
    -> new HeartbeatService payload extension (additive field, not a new endpoint)
       OR a new dedicated sync endpoint if payload size warrants it (see \u00a78)
Backend
  new family-growth module ingests -> writes new tables (\u00a75)
    -> new Rule components compute scores
    -> new GrowthDecisionEngineService composes a decision
    -> REUSED SafetyEngineService validates copy
    -> REUSED IAIProvider phrases (optional)
    -> REUSED NotificationsService delivers
    -> REUSED MemoryEngineService records the outcome under a new AiMemoryEntry category
```

## 7. AI Flow

Identical shape to the existing Digital Safety flow (Knowledge \u2192 Rule
\u2192 Decision \u2192 Safety \u2192 Recommend), reimplemented per growth domain
as NEW small components, converging on the SAME reused Safety Engine
and AI Provider — meaning the "AI Freeze" guarantee (deterministic
core, LLM only for phrasing) extends to every new engine automatically,
by construction, not by a new promise.

## 8. New APIs (Additive — New Routes Only, Zero Existing Route Touched)

All under a new `/api/v1/family-growth/*` prefix, following the exact
Guard/Validation/Application/Repository layering every existing module uses:

```
POST   /family-growth/nutrition/logs
GET    /family-growth/nutrition/score/:childId
POST   /family-growth/hydration/logs
GET    /family-growth/hydration/target/:childId
POST   /family-growth/activity/logs
GET    /family-growth/activity/score/:childId
GET    /family-growth/habits/:childId
POST   /family-growth/habits                     (parent creates)
POST   /family-growth/habits/:id/complete
GET    /family-growth/rewards/:childId
POST   /family-growth/rewards/redeem
GET    /family-growth/insights/:childId/weekly
GET    /family-growth/digital-twin/:childId
```

## 9. Dashboard Components (New, Additive — Reusing Existing Card/Chart Primitives)

New cards following the exact pattern of `FamilyInsightsCard`/
`ReportsCard`: `NutritionTrendCard`, `ActivityTrendCard`,
`HabitStreakCard`, `RewardsLedgerCard`, `DigitalTwinCard` — no change
to `DashboardShell` routing pattern, just new routes registered the
same way `/settings` was added in a prior sprint.

## 10. Parent App Components (New — Same Riverpod/Provider Pattern)

New `features/family-growth/` folder mirroring `features/pairing/`'s
shape exactly: `api/`, `application/`, `presentation/`. New screens:
Habit management (create/assign), Rewards catalog management, Weekly
Insight view. Zero change to existing `core/` providers — new feature
providers registered in `providers.dart` the same way every existing
one was.

## 11. Child App Components (New — Same Plugin Pattern)

New `plugins/family_growth/` folder alongside `plugins/policy/`,
`plugins/telemetry/`: habit-completion UI (child-facing, simple
checklist), activity/hydration quick-log UI. Emits new `AgentEvent`
subclasses through the EXISTING `EventBus` — zero change to
`core/events/event_bus.dart` itself.

---

## Summary Table

| Dimension | Verdict |
|---|---|
| Reusable directly, zero new code | Safety Engine, Memory Engine (preference/recommendation methods), `AiMemoryEntry` (new category values only), AI Provider, EventBus, Notifications, Audit/Retention |
| Needs new, parallel components (NOT modifying frozen files) | Rule/Decision/Recommendation pattern per growth domain, Behavioral trend pattern for growth data |
| Needs new database tables | 13 tables, all additive, zero existing table touched |
| Needs new API surface | One new `/family-growth/*` prefix, zero existing route touched |
| Needs new Dashboard/Parent/Child UI | Yes, all additive, following each app's own established folder/provider pattern exactly |
| Real architectural risk if ignored | Treating `IKnowledgeSnapshot`/`RecommendationEngineService` as literally reusable would force either a Code Freeze violation or a God-interface anti-pattern — this review's central recommendation is the parallel-pattern approach in §3 |

**Awaiting approval on the §0/§3 architectural direction before any
interface, migration, or code is written**, per the explicit
instruction this review responds to.
