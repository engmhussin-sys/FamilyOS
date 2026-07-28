# Schema Change Proposal — Pairing & Device Trust

**Status:** Proposed — requires explicit approval before any migration is
written, per the reviewer's explicit ordering. No SQL/Prisma code in this
document.
**Consolidates:** `pairing-state-machine.md` §10's 6 gaps + Decisions
031–034's new data requirements, reviewed together to avoid repeated
approval cycles on the same table.
**Governed by:** Decision-037 (State Machine Immutability) — none of these
changes alter `pairing-state-machine.md` itself; they implement what it
already specified as required deltas.

Each change request (CR) below follows the exact format requested:
Description, Justification, Impact on existing data, Migration required?,
Breaking change?, Rollback plan.

---

## CR-1: `Device.publicKey`, `Device.attestationChain`

**Description:** Two new nullable columns on `Device` — `publicKey`
(the device's Keystore-generated public key, registered at Device
Registration) and `attestationChain` (the Key Attestation certificate
chain, when the device's hardware supports it — null otherwise, per the
Trust Model's explicit non-blocking design for unattested devices).

**Justification:** Required by the Trust Model (`pairing-state-machine.md`
§1) — there is currently no field to store the cryptographic identity a
paired device presents.

**Impact on existing data:** None for currently-paired devices (from
before this proposal) — both columns default to `null`. Existing devices
are **not** retroactively required to re-attest; they simply have no
attestation data until they next go through a pairing-adjacent flow that
populates it (a future decision, not resolved here — flagging so it
isn't assumed silently).

**Migration required?** Yes — additive only (`ADD COLUMN ... NULL`).

**Breaking change?** No. Nullable additive columns; no existing query
shape changes.

**Rollback plan:** Drop both columns. Since nothing yet depends on them
being populated (Trust Score computation, per the state machine doc,
degrades gracefully when they're null), rollback has no cascading effect
on other features.

---

## CR-2: New `DevicePairingEvent` table (append-only)

**Description:** A new table recording every state transition from
`pairing-state-machine.md` §4/§5 — one immutable row per transition:
`{ id, deviceId, eventType, fromState, toState, actorType, actorId,
occurredAt, metadata (JSON) }`. `Device.status` (the existing 4-value
enum) is **retained**, not replaced — it becomes a fast-read summary
field that this new table's writer also updates, per the state machine
doc's §0 scale reasoning ("`Device.status` as a fast-read summary,
derived from the append-only table").

**Justification:** Required by Decision-030 (Audit Events) and directly
enables Decision-036 (Telemetry) — average pairing time, success/failure
rate by reason, and problematic-manufacturer analysis are all queries
against this table; none of them need new schema of their own once this
exists.

**Impact on existing data:** None — new table, no existing rows to
migrate. Existing `Device.status` values are preserved as-is; the first
event any currently-paired device gets in this new table is whatever
transition happens next after this migration ships (their pairing
history *before* this table existed is not retroactively reconstructed —
noted explicitly rather than implied).

**Migration required?** Yes — new table creation, no data migration.

**Breaking change?** No.

**Rollback plan:** Drop the table. `Device.status` continues functioning
exactly as it does today (it is not made dependent on this table's
existence for its own correctness — the summary field is still written
directly by application code, not derived via a database trigger/view
that would break if the table disappeared).

---

## CR-3: `Device.trustLevel` + new `DeviceRiskAssessment` table (append-only)

**Description:**
- `Device.trustLevel`: cached enum column (`L0_UNKNOWN` through
  `L5_HIGH_TRUST`, per Decision-031), recomputed periodically — a fast-read
  cache of a derived value, not a field multiple processes race to
  increment/decrement.
- `DeviceRiskAssessment`: new append-only table, one row per risk
  assessment (at pairing time, per Decision-032, and potentially
  re-assessed later): `{ id, deviceId, riskScore, signals (JSON: isEmulator,
  isRooted, developerModeEnabled, usbDebuggingEnabled,
  mockLocationDetected, missingAttestation, unsupportedDevice,
  oldAndroidVersion), assessedAt }`.

**Justification:** Required by Decision-031 (Trust Levels) and
Decision-032 (Risk Score during pairing). Kept as an append-only
assessment history (not a single mutable row) for the same reason as
CR-2 — a risk assessment is a point-in-time judgment that should remain
inspectable later ("why did we flag this device 3 weeks ago"), not
overwritten.

**Impact on existing data:** None — `Device.trustLevel` defaults to
`L1_REGISTERED` for existing paired devices (they are registered, by
definition, but have no attestation/risk data retroactively computed —
same non-retroactive principle as CR-1). `DeviceRiskAssessment` starts
empty.

**Migration required?** Yes — one additive column + one new table.

**Breaking change?** No.

**Rollback plan:** Drop `DeviceRiskAssessment` and the `trustLevel`
column. No other table has a foreign key into `DeviceRiskAssessment`
proposed at this stage, so this is a clean removal.

---

## CR-4: `Device.pairingProtocolVersion`

**Description:** One new column recording which version of the pairing
protocol (state-machine version, per Decision-037's versioning
requirement) a device paired under.

**Justification:** Decision-033 asked for three version fields: Pairing
Protocol Version, Agent Version, API Version. **Only this one is
actually a new field** — `Device.appVersion` already exists in the
schema (added in the original database step) and already serves as the
"Agent Version" Decision-033 asked for; no change needed there. "API
Version" is not resolved by a `Device` column at all — the backend has
no API versioning strategy yet (every route is hardcoded under
`/api/v1`), so storing a per-device "API version used" would have
nothing meaningful to vary yet. **Recommendation: defer the API Version
field until the backend actually has more than one API version** —
adding an unused column now would be speculative, not useful.

**Impact on existing data:** None — new nullable column, existing rows
`null` (meaning "paired before protocol versioning existed" — a
meaningful and honest value, not an error state).

**Migration required?** Yes — additive only.

**Breaking change?** No.

**Rollback plan:** Drop the column. Nothing else depends on it existing.

---

## CR-5: `Device.deviceFingerprint`

**Description:** One new column storing a hashed, privacy-respecting
device fingerprint, per Decision-034.

**Justification:** Needed to detect unusual device replacement and
support the Device Replacement flow (`pairing-state-machine.md` §7)
without relying on a single identifier.

**Critical constraint this must be built under, stated explicitly since
it affects what "fingerprint" can even mean:** Android has, since
Android 10, restricted app access to non-resettable hardware identifiers
(IMEI, hardware serial, MAC address) specifically to prevent
cross-app/cross-reset user tracking — and Google Play policy separately
prohibits using such identifiers for tracking without an approved,
narrow exception (none of which apply to this product). **The only
policy-compliant, realistic fingerprint source is a hash combining:**
`Settings.Secure.ANDROID_ID` (resets on factory reset, and is already
scoped per-app-signing-key since Android 8 — meaning it cannot be used
to track a device across other apps, which is the correct privacy
property here) **plus** the Keystore public key from CR-1 **plus** a few
stable-but-non-identifying hardware profile fields already collected by
the Capability Engine (manufacturer, model, API level). This is
sufficient for "did this device change" detection (Decision-034's stated
purpose) without being a persistent cross-app tracking identifier —
worth stating plainly since "fingerprint" is a term that can imply more
tracking capability than what's actually being built or than Android
permits.

**Impact on existing data:** None — new nullable column.

**Migration required?** Yes — additive only.

**Breaking change?** No.

**Rollback plan:** Drop the column.

---

## Explicitly NOT part of this proposal (and why)

| Item | Why it's excluded here |
|---|---|
| `FamilyRole` enum expansion (guardian types, Decision-025) | Explicitly deferred to its own decision in `pairing-state-machine.md` §2 — bundling an unrelated permissions-model redesign into this device/pairing-focused proposal would conflate two different reviews |
| Per-family rate limiting on `pairing/initiate` | Application/Redis logic, not a schema change — no new table/column needed, implemented in Step 2's service code |
| `PolicyCopy` capability for Device Replacement | Application logic (reading one device's last policy, writing it to another) — no schema change needed, the existing `ScreenTimePolicy`/`AppBlockRule` tables already support this without modification |
| `AuditLog` writer | Zero schema change — the table has existed since the first database step; this is purely an implementation task for Step 2 |
| Decision-036 Telemetry | Fully satisfied by querying CR-2's `DevicePairingEvent` table — no new schema needed, only future reporting/dashboard queries |

## Summary for approval

| CR | New columns | New tables | Breaking? | Migration? |
|---|---|---|---|---|
| CR-1 | 2 (`Device`) | 0 | No | Yes, additive |
| CR-2 | 0 | 1 (`DevicePairingEvent`) | No | Yes, new table |
| CR-3 | 1 (`Device`) | 1 (`DeviceRiskAssessment`) | No | Yes, additive + new table |
| CR-4 | 1 (`Device`) | 0 | No | Yes, additive |
| CR-5 | 1 (`Device`) | 0 | No | Yes, additive |

**Total: 5 new nullable columns on `Device`, 2 new append-only tables.**
Every change is additive-only — nothing here alters or removes an
existing column, enum value, or relation, so no existing query in the
already-built Auth/Children/Screen-Time/AI-Assistant/Compliance modules
is affected. All five CRs can be implemented as a single migration, as
requested ("ننفذ التعديلات دفعة واحدة"), once approved.
