# ADR — AI Core Engine Boundary (Sprint AI-1: Foundation)

**Status:** Implemented. Formalizes Decision-068 (AI Core Engine
Architecture) and Decision-069 (AI Privacy First).

---

## 1. What already existed vs. what this sprint actually built

The Parenting Assistant (`ai-assistant-module.md`, Phase 2) was already
built with a provider-agnostic port (`ILlmClient`) — no module imported
`@anthropic-ai/sdk` except one adapter file. Decision-068's core
requirement ("external providers are adapters only") was **already true
for that one feature**. What this sprint actually added:

1. **Generalized the pattern from feature-scoped to platform-shared.**
   The old `ILlmClient` port and `AnthropicLlmClient` adapter lived
   *inside* `ai-assistant/`, usable only by that one feature. They're now
   `IAIProvider` / `AnthropicAIProvider` inside a new shared `ai-core/`
   module — anything Sprint AI-2 builds (Behavioral, Safety,
   Recommendation engines) reuses the same provider adapter without
   duplicating it or writing its own.
2. **Extracted the Context Manager** (`AiContextManagerService`) from
   what used to be a private method on `AiAssistantService` — now an
   independently testable, independently reusable service any future
   engine can call for the same "ground this request in real child data"
   need.
3. **Declared the AI Event Schema** (`IAIEvent`) — structurally, for
   Sprint AI-2, not consumed by any code yet (see §3).
4. **Migrated the existing feature onto the new foundation** —
   `AiAssistantService` is now an 8-line delegate to
   `AiCoreOrchestratorService`, not a reimplementation sitting next to it.

## 2. Module boundary

```
ai-core/                    (this sprint)
  domain/
    ai-provider.port.ts       IAIProvider — the ONE seam to any LLM
    ai-event.types.ts          IAIEvent — structural, Sprint AI-2
    ai-context.types.ts         IChildAIContext — Knowledge Layer, MVP scope
    ai-core.errors.ts             AiCoreUnavailableException
  application/services/
    ai-context-manager.service.ts   Layer 1: Context Manager
    ai-core-orchestrator.service.ts  Layer 1: AI Core Orchestrator
  infrastructure/
    anthropic-ai-provider.ts          The only @anthropic-ai/sdk import in the backend

ai-assistant/                (existing, refactored)
  presentation/ (controller, DTO — UNCHANGED, zero API-level change)
  application/services/ai-assistant.service.ts  (now 8 lines, delegates to ai-core)
```

**Binding rule, per Decision-068's directive:** no feature module may
import `@anthropic-ai/sdk`, `IAIProvider`'s concrete implementation, or
any future provider SDK directly. Every AI capability is built by adding
a method to (or, once there's a second real use case, a generic
dispatcher on) `AiCoreOrchestratorService`, backed by the same
`AI_PROVIDER` binding. This is the AI-domain equivalent of
`pairing-module-boundary.md`'s rule for backend modules — same
discipline, different layer.

## 3. What Sprint AI-1 deliberately did NOT build

Per this project's established practice of declaring a schema/contract
before its consumer exists (see `IRiskDetector`'s identical framing in
the Child Agent):

- **No generic event dispatcher.** `IAIEvent`/`AIEventType` are declared;
  nothing routes on them yet. `AiCoreOrchestratorService.askParentingQuestion`
  is a named method, not `processEvent()`, because there is exactly one
  real capability today — a generic dispatcher for one case would be
  speculative, not foundational.
- **No Behavioral/Safety/Recommendation/Health/Education engines**
  (Decision-068's Layers 2–6) — Sprint AI-2 onward, each its own step.
- **No AI Memory System** (insights/recommendations/feedback history) —
  no schema exists for it yet; would need its own Schema Change Proposal
  first, per this project's established governance (§6.3 of
  `docs/database/README.md`).
- **No expanded Knowledge Layer fields** (sleep pattern, study schedule,
  behavioral history) — `IChildAIContext` only includes what
  Children/ScreenTime modules actually produce today. Adding placeholder
  fields with no real data behind them was considered and rejected (see
  that type's own docstring).

## 4. Decision-069 (AI Privacy First) — how it's satisfied today, and where it isn't yet

**Satisfied:** `AiContextManagerService.buildChildContext` only ever
sends four fields to the provider — first name, age, screen-time limit,
focus-mode flag. No raw app usage, no location, no message content, no
family-wide data — this was already true of the original implementation
and remains true here. "تنظيف البيانات" / "إرسال Context محدود فقط" is
the *default and only* behavior, not an opt-in filter someone could
forget to apply — there is no code path in `AiContextManagerService`
that assembles a larger payload.

**Not yet built:** Decision-069's "حفظ النتيجة داخليًا" (persist the
result internally) — `AiCoreOrchestratorService.askParentingQuestion`
returns the answer to the caller but doesn't persist it anywhere (no AI
Memory System yet, per §3). A parent re-asking the same question today
re-queries the provider from scratch — acceptable for Sprint AI-1's
scope, flagged as a real follow-up once the Memory System is designed.

## 5. Verification performed in this session

- `npx tsc --noEmit` → 0 errors across the full backend, including the
  migration touching `ai-assistant` and the new `ai-core` module.
- `test/ai-core/*` + `test/ai-assistant/*` → **11/11 tests passed**
  (context manager: 3, orchestrator: 6 — migrated unchanged in intent
  from the old `ai-assistant.service.spec.ts`, now against the shared
  orchestrator — plus 2 new thin-delegation tests for `AiAssistantService`).
- Full backend suite → **85/85 passed**, including the DI-graph smoke
  test confirming `AiCoreModule` wires in transitively through
  `AiAssistantModule` with no missing dependency — the same class of bug
  that test caught for real once already (`screen-time-module.md`'s
  export-fix incident) would have been caught here too, had this
  refactor introduced one.

## 6. Next

Sprint AI-2 (Behavioral Engine) is the first real second consumer of
`AiCoreOrchestratorService` — building it is also what will determine
whether a generic `processEvent()` dispatcher is actually warranted, per
§3's YAGNI reasoning (two real cases is when that decision should be
made, not before).
