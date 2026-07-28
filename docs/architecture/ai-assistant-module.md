# Architecture Notes — AI Parenting Assistant (Phase 2, Feature 1)

**Location:** `apps/backend/src/modules/ai-assistant/`
**Route:** `POST /ai-assistant/ask` (protected, heavily rate-limited: 15/min)
**Depends on:** `ChildrenModule`, `ScreenTimeModule` (now exports `ScreenTimeService`), `@anthropic-ai/sdk`.

---

## 1. Why this approach, not a full RAG pipeline

Per this project's AI-engineering standard: *"check whether a deterministic
approach... would solve the problem just as well... only proceed with an
AI-based approach when there's a real need for language understanding,
generation, or reasoning."* Answering an open-ended parenting question
genuinely needs an LLM — but grounding it doesn't need vector search. The
child's context (age, current screen time policy) is small, structured,
and already lives in our own Postgres tables. `AiAssistantService` simply
**fetches it directly and injects it into the prompt** — no embeddings, no
vector DB, no retrieval step. This is the simplest thing that could
possibly work, and it's enough: the "knowledge base" being grounded
against is a handful of fields per child, not a large unstructured corpus.

If a future feature needs grounding against a large, unstructured
knowledge base (e.g. a parenting-research article library), that would be
the point to introduce real RAG — not before.

## 2. The provider-agnostic port

`AiAssistantService` depends on `ILlmClient` (`application/ports/llm-client.port.ts`),
not on `@anthropic-ai/sdk` directly. `AnthropicLlmClient`
(`infrastructure/anthropic-llm.client.ts`) is the only file in the entire
module that imports the SDK. This means:
- Every test in `test/ai-assistant/ai-assistant.service.spec.ts` mocks
  `ILlmClient` and never makes a real network call — fast, free, deterministic.
- Swapping providers, or adding a second (cheaper/faster) model for
  simpler questions later, is a new adapter behind the same port, not a
  rewrite of the service.

## 3. Failure handling (per this project's AI-engineering standard)

- **Ownership errors are NOT LLM errors.** `buildChildContext` calls
  `ChildrenService.getChildOrThrow` outside the `try/catch` that wraps the
  actual LLM call, so a child-not-found 404 propagates as itself, not as a
  masked "assistant unavailable" 503. Tested explicitly.
- **Every LLM failure mode collapses to one client-safe exception**
  (`AiAssistantUnavailableException`, 503) — timeouts, API errors, and an
  empty/malformed response are all treated as "the assistant isn't
  available right now," with the real cause logged server-side
  (`this.logger.error`) but never leaked to the API response.
- **The response shape is validated before use** — `AnthropicLlmClient`
  explicitly finds a `text`-type content block rather than assuming
  `response.content[0]` is always what's expected.
- **Rate limiting is tighter than typical CRUD endpoints** (15/min vs. the
  app default of 100/min) since every call is a real, billed API request —
  see the `@Throttle` decorator and its comment in the controller.

## 4. What the DI-graph smoke test caught, live, in this session

While building this module, `test/app.module.spec.ts` (from the Children
module step) failed with a real, correct error: `ScreenTimeService` was
never exported from `ScreenTimeModule`, so `AiAssistantModule` couldn't
inject it. This is exactly the class of bug that test exists to catch —
fixed by adding `exports: [ScreenTimeService]` to `screen-time.module.ts`.
Left here as a concrete example of the smoke test earning its keep, not
just theoretical value.

## 5. Known follow-ups

1. **No conversation history/persistence.** Each `/ai-assistant/ask` call
   is stateless — no `AiConversation` table, no multi-turn context. Fine
   for the "ask a one-off question" MVP use case; a persisted-history
   version is a natural Phase 2 follow-up once there's a UI for it.
2. **`ANTHROPIC_API_KEY` is optional at boot**, not validated in
   `env.validation.ts` — the app starts fine without it, and the endpoint
   fails clearly (logged) on first real use if it's missing. This was a
   deliberate choice so a missing AI feature key can never block the rest
   of the backend from running.
3. **No per-family/day request cap beyond the per-minute throttle** — a
   determined user could still rack up many calls across a day. A daily
   quota (e.g. tied to `SubscriptionPlan`) is a reasonable Phase 2/3
   follow-up once billing exists.

## 6. Verification performed in this session

- `npx tsc --noEmit` → 0 errors.
- Full backend suite (`test/auth`, `test/children`, `test/screen-time`,
  `test/ai-assistant`, `test/common`, `test/app.module.spec.ts`) →
  **41/41 tests passed**.
