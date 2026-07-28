# ADR — Trust Levels Framework

**Status:** Proposed. Formalizes Decision-031.
**Depends on:** `pairing-state-machine.md` §1 (Trust Model), `schema-change-proposal-pairing.md`
CR-1 (`Device.publicKey`/`attestationChain`) and CR-3 (`Device.trustLevel`).
**Enum reference:** `docs/specifications/enumerations.md` — "Trust Level."

---

## 1. Purpose

Decision-031 rejected a binary Trusted/Not-Trusted model. This document
answers the two questions that model left open: **exactly** what moves a
device from one level to the next, and **exactly** what each level
unlocks — without either of those being left to implicit judgment at
implementation time.

## 2. Level definitions and exact derivation rules

| Level | Name | Derivation rule (mechanical, not judgment-based) |
|---|---|---|
| `L0` | Unknown Device | Default state for any `Device` row before Device Registration (Step 3) completes. No device reaches any other level without first being `L0`. |
| `L1` | Registered Device | `DEVICE_REGISTERED` state reached (`pairing-state-machine.md` §4) — a public key (CR-1) has been received and stored, nothing more. |
| `L2` | Verified Device | `DEVICE_VERIFIED` state reached — the Attestation check (§3 below) has run, **regardless of its result**. A device that ran the check and has no attestation support is still `L2`, not stuck at `L1` — verification means "we checked," not "it passed." |
| `L3` | Attested Device | `L2` **and** a valid Key Attestation chain was present and cryptographically verified server-side. This is the only level gated on an actual pass/fail result, not just "the step ran." |
| `L4` | Device Owner / Enterprise | Device was provisioned via the Android Enterprise "Enhanced Mode" path (Android enforcement ADR §4) — `DevicePolicyManager` confirms Device Owner status. Independent of `L3` — an `L4` device may or may not also have attestation support; both facts are recorded, `L4` does not imply `L3`. |
| `L5` | High Trust (future MDM) | **Not assigned by any current logic.** Reserved explicitly for a future decision once real MDM/Android-Enterprise-fleet integration exists (Phase 3's Enterprise/School scope). No code path in this project currently sets this value — listed here only so the enum is complete per Decision-040's registry, not because it's reachable today. |

**Regression rule:** Trust Level can move backward, not just forward. If
`IAntiTamper` (Step 9) detects `rootDetected` or `apkReinstalled` on a
previously `L3` device, the device is demoted — the exact demotion target
is not "back to L0" (that would be a false statement — it *is* still a
registered, previously-attested device) but a distinct annotation
alongside the level: the level itself reflects "how the device was last
verified," while current tamper state is tracked separately (§4's Risk
Score is where an actively-compromised-but-formerly-attested device
actually gets flagged) — Trust Level is not overloaded to carry both
"identity confidence" and "current safety state" in one value, which is
exactly the ambiguity a single Trusted/Not-Trusted boolean had and this
framework exists to remove.

## 3. What "the Attestation check" actually verifies (L2 → L3 gate)

Per `pairing-state-machine.md` §1, Key Attestation, where the device's
hardware supports it, returns a certificate chain rooted in a
Google-controlled key. The `L2 → L3` gate specifically checks:
1. The chain validates cryptographically up to Google's known root.
2. The attested key matches the public key registered at `L1`.
3. The attestation's reported security level (`TrustedEnvironment` or
   `StrongBox`, in Android's own terminology) is recorded but does **not**
   gate `L3` itself — both count as attested; the specific level is
   additional data available to future risk-scoring logic (§ of
   `risk-score-framework.md`), not a further trust sub-tier here.

A device without hardware attestation support (older device, some
budget OEM builds, emulators) fails step 1 by definition (no chain to
validate) and simply remains at `L2` — this is the expected, non-error
outcome for a meaningful fraction of real devices, not a failure state.

## 4. What each level unlocks

This is the actual point of having levels at all — they must gate real
behavior, not just be a label:

| Level | Unlocked |
|---|---|
| `L0` | Nothing — no policy is ever sent to a device at this level |
| `L1` | Pairing flow may continue (`DEVICE_VERIFIED` is the next step); **no policy enforcement authority** |
| `L2` | Same as `L1` — verification alone (without attestation) does not by itself unlock enforcement; `PARENT_CONFIRMED` and `POLICY_ASSIGNED` still gate actual `ACTIVATED` status per the state machine, independent of trust level |
| `L3` | Nothing *additional* is gated purely on reaching `L3` in this initial framework — attestation feeds the Risk Score (lower baseline risk) and is a strong positive Trust Score signal (`pairing-state-machine.md` §1's scoring table), rather than unlocking a distinct capability by itself |
| `L4` | Unlocks true OS-level enforcement (`setPackagesSuspended`, uninstall-blocking) per the Android enforcement ADR §4/§8 — this is the one level with a genuinely different *capability*, not just a different confidence score |
| `L5` | Reserved — no behavior defined; must not be referenced by any conditional logic until a future decision defines what it unlocks |

**Explicit design choice worth stating:** Trust Level, for `L1`–`L3`,
is currently an **informational/scoring input**, not a hard gate on
whether enforcement runs at all — the state machine's own progression
(`PARENT_CONFIRMED` → `POLICY_ASSIGNED` → `ACTIVATED`) is what actually
gates enforcement for the non-Enterprise path. This avoids a design where
an unattested-but-otherwise-legitimate `L2` device (a real, common case —
an older family phone) is silently denied service. `L4` is the one place
Trust Level itself changes *what's possible*, because Device Owner mode
is a genuinely different technical capability, not just a confidence
adjustment.

## 5. Interaction with Risk Score (forward reference)

Trust Level answers "how confident are we this device is who it claims
to be." Risk Score (`risk-score-framework.md`, next in the approved
order) answers a different question: "how risky is this specific
device's current state, regardless of identity confidence." A device can
be `L3` (strongly attested identity) and still have an elevated Risk
Score (e.g. Developer Mode enabled) — the two are independent axes,
not one derived from the other. This is stated here explicitly so the
Risk Score framework doesn't accidentally re-derive Trust Level instead
of building the orthogonal concept Decision-032 actually asked for.
