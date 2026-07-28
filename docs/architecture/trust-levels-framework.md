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

## 1a. Trust is Static, Risk is Dynamic (Decision-043)

**Formal rule, binding on every future decision:** Trust Level changes
**rarely**, only on these specific events:
- Pairing (initial `L0 → L1` and progression through `L2`/`L3`)
- Device Replacement (`pairing-state-machine.md` §7 — the new device
  starts its own fresh Trust Level; it is never inherited from the old
  device)
- A Key Attestation re-check specifically (not every Capability
  re-scan — only the attestation-specific check)
- Device Owner provisioning completing (`L4`)

**Trust Level is never recomputed on a routine Heartbeat.** This is a
hard rule, not a performance optimization suggestion: heartbeats run
every sync cycle (potentially every 30 seconds to a few minutes,
depending on Decision-009's transport); recomputing an identity-confidence
value that frequently would make it behave like a volatile metric, which
is exactly the conceptual error Decision-043 exists to prevent. Anything
that changes frequently (§5's Risk Score) is deliberately kept in a
separate document/table for this reason.

## 1b. Capability Confidence (Decision-046) — flagged delta, not built here

Decision-046 requires every capability signal (not just risk signals) to
carry a Confidence Level (`High` / `Medium` / `Low`) reflecting how
reliable that signal is across OEM variations. This affects the
`CapabilityProfile`/`PermissionProfile` contracts already defined in
`apps/child-app/lib/core/contracts/i_capability_provider.dart` — those
data classes do not yet carry a confidence field per property.
**Flagged as a required follow-up to that file** (Step 4 implementation),
not made here, since this document is about Trust Level derivation, and
the actual field addition belongs with the Capability Engine's own step.
The Risk Score Framework (next document) applies confidence weighting to
its own signals as a worked example of the same principle.



| Level | Name | Derivation rule (mechanical, not judgment-based) |
|---|---|---|
| `L0` | Unknown Device | Default state for any `Device` row before Device Registration (Step 3) completes. No device reaches any other level without first being `L0`. |
| `L1` | Registered Device | `DEVICE_REGISTERED` state reached (`pairing-state-machine.md` §4) — a public key (CR-1) has been received and stored, nothing more. |
| `L2` | Verified Device | `DEVICE_VERIFIED` state reached — the Attestation check (§3 below) has run, **regardless of its result**. A device that ran the check and has no attestation support is still `L2`, not stuck at `L1` — verification means "we checked," not "it passed." |
| `L3` | Attested Device | `L2` **and** a valid Key Attestation chain was present and cryptographically verified server-side. This is the only level gated on an actual pass/fail result, not just "the step ran." |
| `L4` | Device Owner / Enterprise | Device was provisioned via the Android Enterprise "Enhanced Mode" path (Android enforcement ADR §4) — `DevicePolicyManager` confirms Device Owner status. Independent of `L3` — an `L4` device may or may not also have attestation support; both facts are recorded, `L4` does not imply `L3`. |
| `L5` | High Trust (future MDM) | **Not assigned by any current logic.** Reserved explicitly for a future decision once real MDM/Android-Enterprise-fleet integration exists (Phase 3's Enterprise/School scope). No code path in this project currently sets this value — listed here only so the enum is complete per Decision-040's registry, not because it's reachable today. |

**Update cadence — Decision-043 (Trust is Static, Risk is Dynamic):**
Trust Level is reassessed **only** on these four triggers: (1) initial
Pairing, (2) Device Replacement (`pairing-state-machine.md` §7), (3) a
fresh Keystore Attestation check, (4) a Device Owner status change. **It
is never recomputed on a routine Heartbeat**, and it is never demoted by
a tamper signal (root detection, Accessibility disabled, etc.) — those
are Risk signals (`risk-score-framework.md`), not identity signals. An
earlier draft of this document incorrectly proposed demoting Trust Level
on tamper detection; that was a conflation of the two axes this whole
framework exists to separate (§5), corrected here per Decision-043. A
rooted, formerly-`L3` device remains `L3` for identity-confidence
purposes — what changes is its Risk Score, which is exactly why §4 of
`risk-score-framework.md` includes a defensive Trust-Level-*display*
cap at `HIGH` risk (a presentation/policy safeguard) rather than this
document silently mutating the stored Trust Level itself.

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
