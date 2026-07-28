# Step 2.2.1 — Database Entities for Secure Pairing

**Status:** Schema written (`schema.prisma`), not yet migrated against a
real database (this sandbox cannot reach `binaries.prisma.sh` — same
standing limitation as every prior schema step). No controllers, no
services, no Auth module changes — exactly per this step's constraints.

---

## 1. Entity-to-storage mapping (the key decision this step made)

The brief named five entities. Three of them are **not** new Postgres
tables — implemented instead as what the project's existing patterns
already call for:

| Named entity | Actual implementation | Why |
|---|---|---|
| `PairingInvitation` | **Redis** (unchanged from the existing `PairingService` pattern) | One-time, 10-min TTL — the exact shape Decision-029 already specified; a Postgres row would need its own expiry-sweep job to achieve what Redis's TTL gives for free |
| `RegistrationToken` | **Redis**, same pattern | Single-use by design (Decision-054) — identical reasoning |
| `PairingSession` | **Derived read**, not stored | Already specified in `pairing-backend-domain-architecture.md` §1.5 as "most recent `DevicePairingEvent` row + still-valid Redis invitation" — storing it separately would be a second source of truth for the same fact |
| `DeviceTrustRecord` | **Fields on `Device`** (`publicKey`, `attestationChain`, `trustLevel`) | Not an independent entity — these are attributes *of* a device, not a separate relationship |
| `PairingAuditEvents` | **✅ New table: `DevicePairingEvent`** | The one genuinely new append-only entity this step required |

This mapping was presented before editing `schema.prisma`, per this
step's explicit "provide schema changes and rationale before applying
migrations" instruction.

## 2. What was actually added to `schema.prisma`

**4 new enums:** `TrustLevel`, `RiskLevel`, `PairingState`,
`PairingEventType` — values taken directly from
`docs/specifications/enumerations.md` and
`pairing-backend-domain-architecture.md` §5 (the event list), with no
new values invented here that aren't already documented elsewhere.

**2 new tables** (both append-only, no `updatedAt`/`deletedAt` — per
Decision-039's category rule, restated in `docs/database/README.md` §6.2):
- `DevicePairingEvent` — CR-2. Indexed on `(deviceId, occurredAt)` for the
  two query patterns that matter: "this device's full history, in order"
  (support/investigation) and "this device's most recent event" (the
  `PairingSession` derived read from §1 above).
- `DeviceRiskAssessment` — CR-3's table half. Indexed the same way, for
  the same two reasons — plus this is exactly what powers
  `risk-score-framework.md` §7's trend view.

**5 new nullable/defaulted fields on `Device`** (CR-1, CR-3's column
half, CR-4, CR-5) — zero impact on existing rows, matching the "additive
only" promise made when these CRs were originally proposed.

## 3. Audit considerations (required per this step's constraints)

- Both new tables are themselves the audit mechanism for pairing — there
  is no separate "audit log for the audit log."
- `DevicePairingEvent.actorType`/`actorId` reuse the existing `ActorType`
  enum (`USER | DEVICE | SYSTEM`) already defined for `AuditLog` — no
  duplicate enum introduced for the same concept.
- Neither new table has a `deletedAt` — consistent with every other
  append-only table in this schema (`AuditLog`, and `LocationEvent`'s
  hard-delete-on-expiry pattern), soft-delete would contradict the
  category rule these tables exist under.
- `Device`'s own soft-delete (`deletedAt`) is unaffected — deleting a
  `Device` row (`onDelete: Cascade`) cascades to both new tables' rows
  via their foreign key, meaning a hard-deleted device's pairing/risk
  history is deleted with it. **Flagging this as worth reviewing before
  Step 2.2.4 (Security)**: for a device that's `REVOKED` (soft-deleted)
  vs. one an admin might eventually hard-delete for GDPR erasure
  (`compliance-module.md`'s deferred "right to erasure" follow-up), the
  cascade behavior may need to differ — not resolved here, since
  `Device` hard-deletion isn't part of any flow built so far.

## 4. Verification performed in this session

- Manual brace/paren balance check across the full `schema.prisma` (40/40
  matched) — same method used since `prisma validate` was first found
  unreachable in this sandbox.
- Manual relation-naming review: no ambiguous relations introduced (each
  new table has exactly one relation to `Device`; `Device`'s two new
  back-relations — `pairingEvents`, `riskAssessments` — don't collide
  with any existing relation name).
- `npx tsc --noEmit` across the full backend: **0 errors** (nothing in
  existing code references the new fields yet, so this mainly confirms
  the schema change didn't break the existing Prisma Client type stub
  used in this sandbox).
- Full existing backend test suite: **48/48 passed**, unchanged — this
  step added zero application logic, only schema, so this is a
  regression check, not new coverage.

## 5. Explicitly not done in this step (per its own constraints)

- No `PairingModule`, no controllers, no services (Steps 2.2.2/2.2.3).
- No Auth module changes — confirmed unnecessary, since `TokenService`
  is already exported from `AuthModule` and available to any future
  module that imports it.
- No actual `prisma migrate dev` run — requires a real environment
  (§"Status" above).
