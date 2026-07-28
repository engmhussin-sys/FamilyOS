# Step 2.2.2 (Service 1) — Pairing State Machine Service

**Status:** Implemented and tested. First of five planned Domain
Services — no controllers, no Invitation/Registration Token/Trust/Risk
services yet (those are Services 2–5).

---

## 1. The gap this step resolved: pre-registration correlation

`DevicePairingEvent.deviceId` was originally specified as required
(Step 2.2.1). Building this service surfaced the real problem flagged at
the start of that step but not yet resolved: **the first several pairing
events happen before a `Device` row can exist at all** (`Device.platform`
is non-nullable and is only known once `/pairing/device/register` runs).

**Resolution, applied directly to `schema.prisma`:** `DevicePairingEvent.deviceId`
is now nullable, with a second nullable `childId` correlation key added
alongside it. Every row has at least one of the two set — `childId` from
the very first event (`PAIRING_INVITED`), `deviceId` from
`DEVICE_REGISTERED` onward. `findLatest()` prefers `deviceId` once one
exists, falling back to `childId` for the pre-registration window. This
makes `DevicePairingEvent` the single source of truth for the **entire**
pairing lifecycle, not just the device-registered-onward portion — a
better outcome than the scope-limitation I flagged at the start of this
step, achieved with a two-column schema change rather than a workaround.

**Consequence for the `PairingState` enum:** two new terminal values were
needed — `REJECTED` and `EXPIRED` — since reusing `REVOKED` for "this
pairing attempt never actually succeeded" would have falsely implied the
device was once trusted and later untrusted, when in fact it was never
trusted at all. This distinction matters for any future reporting/telemetry
that asks "how many pairing attempts fail vs. how many trusted devices
get revoked later" — conflating the two would corrupt that metric.

## 2. What this service does (and deliberately doesn't)

Three responsibilities only, per this step's brief:
1. **Valid transitions** — `PAIRING_TRANSITIONS` (`domain/pairing-transitions.table.ts`)
   is the single, inspectable source of truth for every legal
   `(event, currentState) → toState` combination — not scattered
   conditional logic.
2. **State validation** — `getCurrentState` always reads fresh from
   `IPairingEventRepository`, never trusts a caller-supplied "current
   state" value.
3. **Event generation** — every successful `transition()` call writes an
   append-only row via the repository, unconditionally (Decision-059).
   An *invalid* transition writes nothing — an audit row only exists for
   something that actually happened.

Explicitly not built here: Redis invitation/registration-token handling,
trust/risk computation, policy assignment. Those remain Services 2–5.

## 3. `ACTIVATION_BLOCKED_HIGH_RISK` — an audited non-transition

One transition rule maps `CAPABILITIES_UPLOADED → CAPABILITIES_UPLOADED`
(same state in, same state out) for this event specifically — the
concrete mechanism behind `risk-score-framework.md` §4's "does not
auto-activate" rule: the block itself is audited (Decision-059 requires
this), but no state change occurs, since nothing was actually activated.

## 4. Verification performed in this session

- `npx tsc --noEmit` across the full backend → **0 errors**.
- `test/pairing/pairing-state-machine.service.spec.ts` → **17/17 tests
  passed**, covering: correlation-key enforcement, the full 8-step happy
  path in sequence, three classes of invalid-transition rejection, the
  broadened rejection flow (Decision-056) across all 4 valid entry
  states, revocation from any of its 3 valid states, the
  REVOKED-before-REMOVED ordering rule, and `canTransition`'s
  side-effect-free check.
- Full backend suite (`test/auth`, `test/children`, `test/screen-time`,
  `test/ai-assistant`, `test/compliance`, `test/pairing`, `test/common`,
  `test/app.module.spec.ts`) → **65/65 passed**, including the DI-graph
  smoke test confirming `PairingModule` wires into `AppModule` without a
  missing dependency.
- Manual schema brace-balance check (unchanged method, `prisma validate`
  still unreachable in this sandbox): 19 real models, balanced braces.

## 5. Next

Service 2 (Invitation Service) — owns the Redis-backed
`PairingInvitation` lifecycle and will be the first caller of this
service's `transition()` method with a real `childId` for
`PAIRING_INVITED`/`PAIRING_ACCEPTED`.
