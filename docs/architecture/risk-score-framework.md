# ADR — Risk Score Framework

**Status:** Proposed. Formalizes Decision-032.
**Depends on:** `trust-levels-framework.md` §5 (explicitly independent axis),
`schema-change-proposal-pairing.md` CR-3 (`DeviceRiskAssessment` table).
**Enum reference:** `docs/specifications/enumerations.md` — "Risk Level."

---

## 1. Purpose and relationship to Trust Level

Trust Level (previous document) asks "is this device who it claims to
be." Risk Score asks a structurally different question: **"given what we
can observe about this device's current state, how much should we worry
before activating enforcement on it."** A device can have high identity
confidence and still be in a risky state (e.g. Developer Mode enabled on
an otherwise-attested device) — the two scores are computed
independently and never substitute for each other.

## 2. Signals and weights

All nine signals from Decision-032, with a concrete point value each
(0–100 scale, higher = riskier), computed once at `CAPABILITIES_UPLOADED`
(pairing-state-machine.md §4) and re-computed on any subsequent
Capability Engine re-scan (Decision-019):

| Signal | Points if present | Rationale |
|---|---|---|
| Emulator detected | +30 | Strongest single signal that this isn't a real family device at all |
| Root detected | +20 | Root access defeats most of the enforcement model's assumptions (Android enforcement ADR §10) |
| Missing Attestation | +15 | Correlated with, but distinct from, root/emulator — see note below |
| Unsupported device (below `minSdkVersion` 26, per Android enforcement ADR §9) | +15 | Enforcement mechanisms may not function as designed |
| Mock Location enabled | +10 | Directly undermines the Location & Safety module specifically |
| Developer Mode enabled | +5 | Weak signal alone (many legitimate power users enable this) but contributes to the composite |
| USB Debugging enabled | +5 | Same reasoning as Developer Mode — correlated, not independently strong |
| Old Android version (below current `targetSdkVersion`, but above `minSdkVersion`) | +5 | Weaker than "unsupported" — still functional, just less current |
| Tamper indicators present (any `TamperSignal` from `IAntiTamper`, Step 9) | +25 | Direct evidence of active interference, weighted accordingly |

**Missing Attestation is intentionally NOT double-counted with Root/Emulator:**
a rooted or emulated device will almost always also fail attestation, so
counting both independently would compound the same underlying fact into
an inflated score. **Rule:** if Root or Emulator is already flagged,
Missing Attestation contributes 0 additional points (its signal is
already captured); Missing Attestation's +15 only applies when it is the
*only* contributing factor (a legitimate older device with no attestation
hardware, otherwise clean).

Maximum possible score is capped at 100 (not a literal sum that could
exceed it if multiple signals fire).

## 3. Risk Level bands (per `enumerations.md`)

| Band | Score | 
|---|---|
| `LOW` | 0–24 |
| `MODERATE` | 25–49 |
| `ELEVATED` | 50–74 |
| `HIGH` | 75–100 |

## 4. Response tiers (Decision-032's three stated outcomes, made exact)

| Risk Level | System behavior |
|---|---|
| `LOW` | Pairing proceeds automatically through to `ACTIVATED` with no additional friction. |
| `MODERATE` | Pairing proceeds, but the risk factors are surfaced to the parent at the `PARENT_CONFIRMED` step (not hidden) — the parent is confirming *with that information visible*, not blind. |
| `ELEVATED` | **Does not auto-activate.** Pairing pauses at `CAPABILITIES_UPLOADED` and requires an explicit, separate parent confirmation step beyond the normal `PARENT_CONFIRMED` action — a distinct "this device shows elevated risk, confirm you want to proceed anyway" prompt, not the same click as normal approval. |
| `HIGH` | Pairing pauses the same way as `ELEVATED`, **and** certain features are restricted even after parent override — specifically: no Enhanced Mode eligibility (§4 of the Trust Levels doc) regardless of Device Owner status, and the device's Trust Level is capped at `L2` regardless of what attestation would otherwise indicate (a `HIGH` risk device does not get to claim `L3`'s confidence even if some attestation data is technically present — a genuinely rooted device can sometimes still present misleading attestation-adjacent data, so `HIGH` risk overrides the trust calculation defensively). |

**Explicit non-goal:** this framework never silently blocks pairing
outright. Every tier above eventually reaches `ACTIVATED` if the parent
explicitly proceeds — the point is informed friction, not a wall. A
family whose only available device is an older or rooted phone is a real
scenario and must have a path forward, with appropriate transparency,
not a dead end.

## 5. Storage and audit (per Decision-039's append-only rule)

Every computed Risk Score is a new row in `DeviceRiskAssessment` (CR-3) —
`{ deviceId, riskScore, signals (JSON snapshot of which of the 9 fired),
assessedAt }`. `Device`'s own fast-read cache reflects only the *latest*
assessment; the full history remains queryable for the exact reasons
`pairing-state-machine.md` §0 established for every security-adjacent
table (an investigation later into "why was this device flagged" must
not depend on data already overwritten).

## 6. Re-assessment triggers

Risk Score is not computed once and forgotten:
1. At `CAPABILITIES_UPLOADED` (pairing time) — the primary trigger.
2. On every subsequent full Capability Engine re-scan (Decision-019's
   cache-invalidation trigger) — a device that develops Developer Mode
   or gets rooted *after* pairing must be re-scored, not permanently
   judged only by its state at pairing time.
3. On any `TamperSignal` detection (Step 9) — an immediate, out-of-cycle
   re-assessment, not waiting for the next scheduled Capability re-scan.

A Risk Level escalation *after* a device is already `ACTIVATED` does not
retroactively un-pair it — per §4's non-goal, this framework governs the
pairing gate, not ongoing operation. What happens to an already-active
device whose risk escalates is governed by the Anti-Tamper Framework's
own response (Step 9, not yet built) and the pairing state machine's
`SUSPENDED` transition (`TamperCritical` event, `pairing-state-machine.md`
§4's transition table) — this document does not duplicate that logic,
only feeds it a score.
