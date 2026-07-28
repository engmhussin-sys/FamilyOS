# Sprint 2 — Trust & Risk Intelligence Foundation (Services 4 & 5)

**Status:** Implemented and tested. No controllers — per explicit
instruction, these services are ready for Step 2.2.3 to call, not yet
wired to any HTTP surface.

---

## 1. The core instruction, made structural: "not closed Logic, but a data source for AI"

Both services implement a dedicated **Signal Provider interface**
(`ITrustSignalProvider`, `IRiskSignalProvider` — `domain/trust.types.ts`,
`domain/risk.types.ts`), bound in `pairing.module.ts` via
`TRUST_SIGNAL_PROVIDER`/`RISK_SIGNAL_PROVIDER` tokens using `useExisting`
(same instance, dependency-inverted access path). **A future AI Core
Engine consumer will depend on these tokens, never on
`TrustEvaluationService`/`RiskEvaluationService` directly** — this is
the concrete mechanism behind "prepare architecture so future AI Core
Engine can consume these signals," not just a naming convention.

## 2. Service 4 — Trust Evaluation Service

- **Derivation** (`trust-levels-framework.md` §2/§3, unchanged from that
  ADR): `L1_REGISTERED` at registration, `L2_VERIFIED`/`L3_ATTESTED` at
  verification depending on attestation, `L4_ENTERPRISE` independent of
  stage when Device Owner is provisioned.
- **Trust is static** (Decision-043): `evaluateAndApply` is a no-op
  (no write, no event) when the derived level equals the current one —
  this isn't just an optimization, it's the structural enforcement of
  "Trust changes rarely" from that decision.
- **Every actual change is explainable**: `DEVICE_TRUST_CHANGED` events
  carry a `reason` string in `metadata`, and `getTrustHistory` reads it
  back — directly satisfying the reviewer's example ("سبب انخفاض الثقة").
- **Reuses the existing pairing event ledger**, not a new table — trust
  changes are `DevicePairingEvent` rows like everything else, keyed on
  `childId` (Decision-066), queryable via the new generic
  `findByEventType` method on `IPairingEventRepository`.

## 3. Service 5 — Risk Evaluation Service

- **Exact scoring formula from `risk-score-framework.md` v2** — nine
  Security-category signals, confidence-weighted (High/Medium/Low
  multipliers), Missing-Attestation suppression when Root/Emulator is
  already flagged, capped at 100.
- **Overall Risk = max(categories)**, not an average — the other five
  categories (privacy/compliance/stability/connectivity/behavioral)
  are structurally present in every result but score 0 today, honestly,
  since no dependency step (Permission Manager, Policy Engine,
  Observability, Sync Engine, on-device `IRiskDetector`) exists yet to
  feed them real signals.
- **"Risk Engine → AI Context Layer → Recommendation Engine," made
  concrete**: `IRiskSignalProvider` never exposes a bare number —
  `getLatestRiskAssessment`/`getRiskHistory` always return the full
  `{ overallRisk, overallLevel, categoryScores, reasons }` shape, which
  is exactly what a Recommendation Engine consuming this later would
  need to generate an explained recommendation, not just a score to
  react to blindly.
- **Every assessment is persisted**, including `LOW` ones — the
  trend/timeline (`risk-score-framework.md` §7) only exists if every
  point is kept, not just the noteworthy ones.

## 4. Independence from external AI providers (requirement #3)

Neither service imports anything from `ai-core/` or
`@anthropic-ai/sdk`. Both are pure domain logic + Postgres/pairing-event
persistence — the AI Core Engine will *consume* their output later
(via the signal-provider tokens), but nothing in `pairing/` depends on
`ai-core/` in the other direction. This keeps the dependency graph
one-way (`ai-core` → `pairing`, if/when Sprint AI-2 wires that up), not
circular.

## 5. Verification performed in this session

- `npx tsc --noEmit` → 0 errors across the full backend.
- `test/pairing/trust-evaluation.service.spec.ts` → **9/9 tests**
  (derivation rules for all four levels, no-op-when-unchanged, explainable
  event emission, both `ITrustSignalProvider` methods).
- `test/pairing/risk-evaluation.service.spec.ts` → **14/14 tests**
  (weight verification per confidence tier, the anti-double-counting
  suppression rule from both trigger conditions, the 100-point cap,
  max-not-average category derivation, all four level-band boundaries,
  persistence-even-when-LOW, both `IRiskSignalProvider` methods).
- Full `test/pairing/*` → **53/53 passed**.
- Full backend suite → **106/106 passed**, including the DI-graph smoke
  test confirming `PairingModule`'s five services and two new signal-provider
  tokens all wire cleanly with no missing dependency.

## 6. Explicitly not built in this sprint

- No controllers (Step 2.2.3, next).
- No actual AI Core Engine consumer of these tokens yet — Sprint AI-2's
  first real job, once it exists, is to be that consumer.
- No wiring of `TrustEvaluationService.evaluateAndApply` /
  `RiskEvaluationService.assessAndRecord` into the pairing flow itself
  (e.g. calling them from a future `/pairing/verify` controller) — that
  integration is Step 2.2.3's job, not this one's.

## 7. Patch: Decision-070 compliance check (consolidated instruction)

A follow-up message consolidated Sprint 2's requirements with
Decision-070 (Intelligence Module Integration Rule) and asked for
verification against it. Checked line-by-line; **two real gaps found and
closed as patches, not redesigns:**

1. **`confidence` field** — the consolidated instruction's example output
   included a numeric `confidence` alongside `trustLevel`/`riskLevel`,
   which the original Sprint 2 delivery didn't have. Added via
   `getSignals()` (below), not by changing `ITrustSignalProvider`/
   `IRiskSignalProvider`'s existing methods — those keep their original,
   already-tested shapes.
2. **`IIntelligenceSignalProvider`** — the unifying cross-domain contract
   requested explicitly ("لا يتم بناء Logic مؤقت فقط... يجب تجهيز
   IIntelligenceSignalProvider"). Added at
   `ai-core/domain/intelligence-signal.types.ts` — a **type-only**
   export, so implementing it (both services now do, alongside their
   existing domain-specific interfaces) adds zero runtime dependency on
   `AiCoreModule`, preserving §4's "independence from external AI
   providers" claim intact.

**Design choices worth stating explicitly:**
- Trust's `subjectId` in `getSignals()` is **childId** (Decision-066's
  timeline key); Risk's is **deviceId** (assessments are inherently
  per-device). Both documented directly on `IIntelligenceSignal.subjectId`.
- Trust's `confidence` is a graded scale (0 → 1, by level) reflecting
  genuine identity-verification uncertainty. Risk's `confidence` is fixed
  at `1` — deliberately, since a risk score is an exact calculation from
  concrete boolean inputs, not an inference; what's incomplete today is
  category *coverage* (5 of 6 categories unpopulated), which is already
  visible in `categoryScores` and is a different concern from confidence
  in the number itself. This distinction is documented on both methods,
  not left implicit.

**Updated verification** (supersedes §5's counts): `test/pairing/*` →
**57/57 tests** (was 53, +4 new `getSignals()` tests). Full backend suite
→ **110/110 passed** (was 106, +4), DI graph still clean.
