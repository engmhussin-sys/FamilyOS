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
