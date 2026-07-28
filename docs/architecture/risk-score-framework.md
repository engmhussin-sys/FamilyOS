# ADR — Risk Score Framework

**Status:** Proposed (v2 — incorporates Decisions 043–048 on top of the
originally-approved v1). Formalizes Decision-032, refined by 043–048.
**Depends on:** `trust-levels-framework.md` §1a (Trust is static, Risk is
dynamic — the rule this entire document is built around),
`schema-change-proposal-pairing.md` CR-3 (`DeviceRiskAssessment` table).
**Enum reference:** `docs/specifications/enumerations.md` — "Risk Level"
(updated in this revision to add `UNKNOWN`).

---

## 1. Purpose and relationship to Trust Level

Trust Level asks "is this device who it claims to be" and changes rarely
(`trust-levels-framework.md` §1a). Risk Score asks "how much should we
worry about this device's *current* state" and — per Decision-043 — is
expected to change on nearly every heartbeat. The two are computed
independently; neither is derived from the other.

## 2. Risk Level bands, with `UNKNOWN` (Decision-043's amendment)

| Band | Score | When assigned |
|---|---|---|
| `UNKNOWN` | — (no score yet) | The device's **first** assessment, before enough signal has been gathered. Never skipped straight to `LOW` — a device with zero data is not the same claim as a device confirmed clean. |
| `LOW` | 0–24 | |
| `MEDIUM` | 25–49 | |
| `HIGH` | 50–74 | |
| `CRITICAL` | 75–100 | |

(Renamed from v1's `MODERATE`/`ELEVATED` to `MEDIUM`/`HIGH` plus a new
`CRITICAL` top band, to leave room for `UNKNOWN` below and match the
reviewer's explicit ordering `UNKNOWN → LOW → MEDIUM → HIGH → CRITICAL`.)

**Rule:** a device stays `UNKNOWN` until its first full Capability +
Risk assessment completes (`CAPABILITIES_UPLOADED` state,
`pairing-state-machine.md` §4) — this is a single well-defined point, not
an ambiguous "not enough data yet" judgment call left to implementation.

## 3. Risk Categories (Decision-044)

Score is no longer a single number. **Six independent category scores
(0–100 each) plus one Overall Risk value derived from them:**

| Category | Signals (concrete today) | Signals (structurally defined, not yet measurable — see §3a) |
|---|---|---|
| **Security Risk** | Emulator, Root, Missing Attestation*, Unsupported device, Old Android version, Developer Mode, USB Debugging, Mock Location | — |
| **Privacy Risk** | — | Permissions Revoked (needs Step 5's Permission Manager reporting a revocation event) |
| **Compliance Risk** | — | Policy Disabled / not actually enforcing despite being assigned (needs Step 8's Policy Engine self-reporting enforcement status) |
| **Stability Risk** | — | Crash count, unexpected service restarts (needs Step 10's Observability/crash reporting) |
| **Connectivity Risk** | — | Extended offline duration, repeated sync failures (needs Step 7's Sync Engine) |
| **Behavioral Risk** | — | "Suspicious usage" (needs Phase 2's on-device `IRiskDetector` — this category has no defined signal at all yet, deliberately, per that interface's own docstring: a real on-device model is a substantial follow-on project) |

*Missing Attestation is suppressed (contributes 0) when Root or Emulator
is already flagged in the same assessment — see §4's confidence/dedup rule,
carried over from v1.

**§3a — honesty about what's actually computable today:** only **Security
Risk** has concrete, measurable signals right now. The other five
categories are **structurally defined** (they have a name, a place in the
schema, and a place in the Overall Risk formula) but score `0`
(not `UNKNOWN`, `0` — "no negative signal observed" is the correct
default, distinct from "we don't know," which is what the `UNKNOWN`
*level* — not category score — is for) until their respective
dependency steps (5, 7, 8, 9/10) ship. This is stated explicitly so the
category framework isn't mistaken for six fully-implemented risk engines
today — it is one implemented, five reserved.

## 4. Signal weights and Confidence (Decision-046)

Each Security Risk signal has a base weight (unchanged from v1) **and** a
Confidence Level, per Decision-046 — the effective contribution is
`base weight × confidence multiplier`:

| Signal | Base weight | Confidence | Effective | Why this confidence level |
|---|---|---|---|---|
| Emulator detected | 30 | High | 30 | Emulator detection APIs are reliable and well-understood |
| Root detected | 20 | High | 20 | Standard root-detection checks are mature |
| Tamper indicators (any, Step 9) | 25 | High | 25 | Direct evidence by definition |
| Unsupported device | 15 | High | 15 | `Build.VERSION.SDK_INT` is exact, not inferred |
| Missing Attestation* | 15 | Medium | 10.5 | Some legitimate devices lack hardware support for reasons unrelated to risk (§2's honesty note) |
| Mock Location enabled | 10 | Medium | 7 | Detection reliability varies meaningfully by OEM (Android enforcement ADR §6's vendor-restriction concern applies here too) |
| Developer Mode enabled | 5 | Medium | 3.5 | Common among legitimate power-user parents, not just risk cases |
| USB Debugging enabled | 5 | Low | 2 | Frequently left on incidentally by technically-inclined users with no relation to tampering intent |
| Old Android version | 5 | High | 5 | Version number itself is exact; only the *implication* is soft, not the measurement |

Category score = sum of effective contributions, capped at 100.

## 5. Overall Risk derivation

**Overall Risk = the highest of the six category scores**, not an
average. A single severely risky category (e.g. Security Risk = 90, all
others at 0) must surface as high Overall Risk — averaging would dilute
a critical single-category problem into a falsely-comfortable composite.
This is a deliberately conservative, safety-biased choice, and it is what
makes §6's explainability trivial: "why is this HIGH" always has a
single, clear answer — whichever category is driving the max.

## 6. Explainability (Decision-047)

Every computed assessment stores, and every consumer (parent-facing UI,
support tooling) can retrieve, a `reasons` list — the specific signals
that fired, in the exact style requested:

```text
Overall Risk: HIGH (driven by: Security Risk)

Reasons:
• Root Detected
• USB Debugging Enabled
• Accessibility Disabled  [Privacy Risk — once Step 5 exists]
```

**Rule:** an Overall Risk value must never be shown without its
contributing category and reasons alongside it — a bare score with no
explanation is exactly the "black box" Decision-047 rejects. This is a
UI/API contract requirement, not just a data-availability nicety: any
future endpoint returning a risk level must return the reasons in the
same response, not as a separate optional call.

## 7. Risk History / Trend (Decision-045)

`DeviceRiskAssessment` (already append-only per Decision-039) is the
timeline itself — no new table needed. Each row now carries the fuller
shape this revision requires:
`{ deviceId, overallRisk, overallLevel, categoryScores (JSON: one entry
per category), reasons (string list), assessedAt }`.

A trend view (`10:01 LOW → 10:25 MEDIUM → 11:40 HIGH → 12:15 LOW`, per
the reviewer's own example) is a query over this table ordered by
`assessedAt` — not a separately maintained structure. This is the same
"telemetry needs no new schema, just queries over the append-only table"
reasoning already established for Decision-036 in the Schema Change
Proposal.

## 8. Re-assessment triggers (unchanged from v1, restated)

1. First assessment at `CAPABILITIES_UPLOADED` — result is `UNKNOWN`
   only in the sense of §2; the assessment itself still runs and produces
   real category scores from whatever signals are available at that
   moment (the `UNKNOWN` *level* label is what's shown before this first
   result exists — once it exists, the device has a real level, even if
   that first real level happens to be `LOW`).
2. Every Capability Engine re-scan (Decision-019's cache-invalidation).
3. Immediately on any `TamperSignal` (Step 9) — out-of-cycle.

## 9. Future: AI Feedback Loop (Decision-048) — explicitly deferred

Not built in this document. Recorded so the schema/history design above
(§7) is already shaped to support it later: a future on-device or
backend AI component would consume the `DeviceRiskAssessment` **trend**
(not just latest value), alongside Capability-change events, Tamper
events, Heartbeats, and Sync failures, to generate a Parent
Recommendation. Nothing in §3–§7 needs to change to support this later —
the append-only, category-scored, reason-explained shape already
produces exactly the training/input signal such a component would need.
This is why the schema was designed this way now rather than retrofitted.

## 10. Non-goal, restated from v1 (unchanged)

Even `CRITICAL` risk never silently blocks pairing. The parent is always
given the information (§6), the category driving it, and the decision —
consistent with the reviewer's own stated principle: *"we are not a
security system that prevents the user from using their device — we give
the parent the information, the recommendation, and the final decision."*
