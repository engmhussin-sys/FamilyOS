# Release Architecture Freeze

**Effective now, through the end of Sprint 10 and v1.0.** No new NestJS
modules. New features extend an existing module below. Any integration
not yet built (a new payment gateway, MDM platform, LLM provider) is
added as a Plugin/Adapter implementing an existing port — never a Core change.

## AI Freeze audit — performed this session, real grep-based verification

```
Files importing @anthropic-ai/sdk directly:        1 (anthropic-ai-provider.ts)
Files injecting AI_PROVIDER:                        4 (+2 structural: the port
                                                     definition itself, the module
                                                     registration file)
  - AiCoreOrchestratorService   (Assistant Q&A — phrasing)
  - AiDiagnosticsService        (device-health summary — phrasing)
  - RecommendationEngineService (recommendation wording — phrasing only,
                                  never chooses the recommendation)
  - ReadinessCheckService       (liveness ping only)
Files NOT injecting AI_PROVIDER (confirmed zero LLM dependency):
  - RuleEngineService, DecisionEngineService, SafetyEngineService,
    BehavioralIntelligenceEngineService, MemoryEngineService,
    KnowledgeEngineService
```

**Result: PASS.** No engine makes a security or policy decision based
on an LLM call. Every place `AI_PROVIDER` is touched is either
phrasing-only (rephrasing an already-decided recommendation, answering
a free-form assistant question) or a liveness check. Two incidental
grep matches (`stripe.adapter.ts`, `environment-validator.ts`) were
checked line-by-line and are comments/config-key-name references only,
not actual coupling.

### Authorized, scoped exception (post-freeze, explicit user permission)

The user explicitly authorized a **partial, scoped unfreeze for AI
Cost Tracking only** — not a general reopening of `ai-core`. Changes
made under this exception, exhaustively listed:

- `domain/ai-provider.port.ts`: added one OPTIONAL field
  (`sourceFeature`) to `IAIProviderRequest` — backward-compatible,
  no existing caller broke.
- `infrastructure/ai-cost-calculator.ts` (NEW): pure cost-calculation
  function, real Anthropic pricing (sourced via web search, August
  2026 — see the file's own docstring for the exact figures and their
  expiry date).
- `infrastructure/ai-usage-tracking.service.ts` (NEW): writes to a
  new `AiUsageLog` table (additive schema change, zero modification
  to any existing table).
- `infrastructure/anthropic-ai-provider.ts`: `trackCost()` now ALSO
  writes to real storage via the above (previously log-line only —
  that gap was explicitly flagged in this same file's own prior
  docstring as "a real follow-up if per-family AI cost attribution is
  ever needed").
- Four call sites (`recommendation-engine.service.ts`,
  `ai-core-orchestrator.service.ts`, `ai-diagnostics.service.ts`,
  `readiness-check.service.ts`) each gained one line passing
  `sourceFeature` — no logic change.
- One new `InternalAdminGuard`-protected endpoint
  (`GET /ai-core/usage-summary`) — same protection discipline as
  `GET /analytics/dashboard-metrics`, since AI spend is operational
  business data, never a per-family concern.

**What did NOT change, explicitly:** every Rule/Decision/Safety/
Behavioral/Knowledge/Memory engine, the AI Freeze audit's own PASS
result above (re-verifiable — none of those six engines gained an
AI_PROVIDER dependency), the Circuit Breaker, request timeout/retry
behavior, and the actual `complete()` request/response contract with
Anthropic itself.

## Stable Public Contracts — frozen as of this document, changes require a v2 ADR

| Interface | Status | Real implementations today |
|---|---|---|
| `IAIProvider` | ✅ Frozen | `AnthropicAIProvider` |
| `IPaymentProviderAdapter` | ✅ Frozen | `ManualPaymentAdapter` (real), `StripeAdapter`/`PaymobAdapter`/`FawryAdapter`/`AppleIAPAdapter`/`GooglePlayBillingAdapter` (interface-complete, config-pending) |
| `IAnalyticsProviderAdapter` | ✅ Frozen | `SelfHostedAnalyticsAdapter` (real), `PostHogAdapter` (config-pending) |
| `IFeatureFlagRepository` | ✅ Frozen | `PrismaFeatureFlagRepository` |
| `IRbacEngine`, `IPolicyEngine`, `IOrganizationRepository` | ✅ Frozen (as of the Organization Platform decision) | **None yet — interfaces only, no implementation exists.** Frozen now specifically so a future implementation has zero risk of needing an interface change. |

### Named in the request, honestly not real yet — not invented to fill the table

- **`IOrganizationProvider`** — the actual contract is `IOrganizationRepository`
  (data access) + `IRbacEngine`/`IPolicyEngine` (business logic), per this
  project's own Repository Pattern discipline (a "Provider" naming
  doesn't fit a first-party data model the way it fits an external
  integration like payments/AI). Frozen under those three names instead
  of inventing a fourth that would duplicate them.
- **`INotificationProvider`** — does not exist. `NotificationsModule`
  (Sprint 8) is a first-party in-app notification store with no
  external delivery provider integrated (no APNs/FCM adapter exists
  yet — this is the same honest gap `ReadinessCheckService` already
  reports as `NOT_APPLICABLE`). Not frozen because there is nothing to freeze.
- **`IStorageProvider`** — does not exist. No file/object storage
  integration exists anywhere in this codebase. Not frozen.
- **`IAuditProvider`** — the real class is `AuditService` (Sprint 9),
  a first-party service, not a provider-swappable adapter — this
  project has exactly one audit trail implementation (Postgres via
  `AuditLog`), by design, not by omission (an audit trail's whole point
  is being one unimpeachable source of truth, not one of several
  interchangeable options). Not given a port interface for that reason.
- **`ITelemetryProvider`** — telemetry is currently two separate,
  real things with no unifying interface: `RuntimeTelemetryCollector`
  (Dart, device-side, Sprint 4) and `AnalyticsEvent`/`EventCollectorService`
  (backend, Sprint 8). Documented as a real future unification
  opportunity, not frozen as an interface that doesn't exist yet.

**This honesty is itself part of the freeze's value**: a stable-contracts
document listing four real, load-bearing interfaces a future engineer
can build against safely is more useful than eight names, half of which
would need to be invented from nothing and could easily be designed wrong
without a real second implementation to validate the shape against.

## Database Freeze

Effective after Sprint 10: `Family`, `User`, `Device`, `Child`,
`ScreenTimePolicy`, `RefreshToken` (Session), `DevicePairingEvent`
(Pairing), `AuditLog`, `Organization` (and its four satellite tables)
change only via a reviewed Prisma migration, never an inline schema
edit. This project has followed this discipline already — every schema
change across Sprints 1–9 was additive (new tables/columns/enum values,
zero renames or drops of existing fields) — this section makes that
existing practice an explicit, permanent rule rather than an emergent
pattern.

## API Freeze

Already true, not a new change: every controller in this backend has
been under `app.setGlobalPrefix('api/v1', ...)` since Sprint 1
(`main.ts`). Documented here as a frozen commitment: a future breaking
change gets `/api/v2`, existing `/api/v1` clients are never broken
in place.

## Plugin Architecture Freeze

Already the pattern for every external integration built this project
(Payment adapters, Analytics adapters, the one AI provider) — this
section makes it mandatory going forward, not optional: **Jamf, Stripe,
Paymob, OpenAI, Claude, Gemini, Apple, Google** — any future one of
these is a new class implementing an existing port
(`IPaymentProviderAdapter`, `IAIProvider`, the still-unimplemented
`IMdmProviderAdapter` from `ENTERPRISE_MDM_ARCHITECTURE.md`), registered
in that port's existing registry. None of them touch business logic
(`SubscriptionService`, the six non-LLM AI engines, etc.) — the same
guarantee `RecommendationEngineService`'s own docstring already states
for the AI case, generalized to every future integration.

## No New Modules

New features extend one of the modules that already exist:
`auth`, `children`, `screen-time`, `ai-assistant`, `ai-core`,
`compliance`, `pairing`, `notifications`, `billing`, `feature-flags`,
`profile`, `settings`, `reports`, `search`, `analytics`, `health`,
`audit`, `system-diagnostics`, `data-retention`, `organization`.
A "Rewards" feature is `PartnerCampaign`-shaped data inside
`organization` or a new `PlanDefinition.features` entitlement inside
`billing` — not a new `RewardsModule`.
