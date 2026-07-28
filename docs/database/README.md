# Database Documentation — AI Family Digital Coach (Phase 1 / MVP)

**Schema file:** `apps/backend/prisma/schema.prisma`
**Engine:** PostgreSQL 15+
**ORM / Migration tool:** Prisma

---

## 1. Scope

This schema covers exactly the Phase 1 (MVP) modules defined in the project
master summary:

| Module | Tables |
|---|---|
| Identity & Family | `User`, `Family`, `FamilyMember` |
| Child Profiles & Consent | `Child`, `ParentalConsent` |
| Devices & Auth | `Device`, `RefreshToken` |
| Screen Time & App Control | `ScreenTimePolicy`, `AppCatalogEntry`, `AppUsageLog`, `AppBlockRule` |
| Location & Safety | `LocationSafeZone`, `LocationEvent` |
| AI Safety | `AiRiskScore`, `AiAlert` |
| Cross-cutting | `AuditLog`, `Notification` |

Explicitly **out of scope** for this migration (Phase 2/3 per the roadmap):
Nutrition/food-photo tables, Education/Study Planner, Islamic Mode, Habit
Builder, Gamification, Router/Smart Home integration. These will be added as
additive migrations later — nothing in this schema needs to change to support
them (they hang off `Child`/`Family` the same way).

---

## 2. Entity-Relationship Overview

```
Family 1───* FamilyMember *───1 User
  │                                │
  │ 1                              │ 1
  *                                *
Child                          RefreshToken
  │ 1
  ├──* ParentalConsent
  ├──* Device ──* RefreshToken
  │       ├──* AppCatalogEntry
  │       ├──* AppUsageLog
  │       └──* LocationEvent ──* LocationSafeZone
  ├──* ScreenTimePolicy
  ├──* AppBlockRule
  ├──* AiRiskScore
  ├──* AiAlert
  └──* Notification

AuditLog ──(actorUserId, entityType/entityId)──> any entity (soft FK, not enforced by DB FK to keep it append-only and resilient to entity deletion)
```

**Root of authorization:** every resource ultimately traces back to a
`Family`. The backend's `FamilyGuard` (NestJS guard, implemented in the auth
module) checks `familyId` (directly or via `childId → Child.familyId`) against
the authenticated user's `FamilyMember` rows before any read/write. This is
the single choke point for access control — see §5.

---

## 3. Key Design Decisions

### 3.1 Children do not have login credentials at the account level
`Child` has no `email`/`passwordHash`. The Child App authenticates via
**Device pairing** (a one-time pairing code hashed in `Device.pairingCodeHash`,
exchanged for a device-bound refresh token) plus an optional local PIN
(`Child.pinCodeHash`) for app-level lock. This directly implements the
project principle "minimize data collection" — no child email/password to
leak, phish, or require in the first place.

### 3.2 `ParentalConsent` is a first-class table, not a boolean flag
Each data-collection category (`ConsentType`) is its own row with
`grantedByUserId`, `grantedAt`, `revokedAt`. This gives us:
- Per-category granularity (a parent can enable Screen Time but not Location).
- An audit trail of who granted/revoked what and when (GDPR "records of
  processing" requirement).
- A single enforcement point: every AI/monitoring service checks this table
  before running — not scattered feature flags.

### 3.3 No raw content storage — aggregation over surveillance
- `AppUsageLog` stores **daily totals per app**, not per-event/per-tap logs.
- `AiRiskScore` / `AiAlert` store **AI-generated conclusions**
  (`overallScore`, `categoryBreakdown`, alert `description`), never the raw
  text/keystrokes that produced them. The Keyboard Behavior Analysis module
  (Phase 2) is designed to run analysis in-memory/on-device or in a
  short-lived processing pipeline and persist only the resulting alert —
  this schema has no `raw_message` or `keystroke_log` table by design.

### 3.4 Location data is encrypted and time-boxed
`LocationEvent.latitudeEnc` / `longitudeEnc` are `String` columns holding
AES-256-GCM ciphertext (encrypted/decrypted in the backend's `CryptoService`,
never in the database layer). `expiresAt` (indexed) drives a scheduled job
(`LocationRetentionJob`, runs daily) that hard-deletes rows past the
family's retention window (default 30 days, configurable per subscription
plan later). Location is the most sensitive data type in the system, so it
gets both encryption *and* minimal retention rather than relying on either
alone.

### 3.5 Soft delete vs. hard delete
- **Soft delete** (`deletedAt`) on all user-facing entities (`User`,
  `Family`, `Child`, `Device`, policies, rules): supports "undo",
  investigation of disputes, and GDPR-compliant staged deletion (soft
  delete → grace period → hard purge job, implemented at the service layer).
- **Hard delete / no `deletedAt`**: `AuditLog` (must be immutable/append-only
  to be trustworthy as an audit trail) and `LocationEvent` (privacy argues
  for actual deletion, not soft-hide, once `expiresAt` passes).

### 3.6 UUID primary keys everywhere
Prevents ID enumeration attacks (a real concern here — sequential integer
child IDs would let one family guess at another family's child count/IDs),
and makes multi-region/offline-first sync (child app can be offline) safe
since IDs can be generated client-side without central coordination.

---

## 4. Indexing Strategy

Every foreign key has an explicit `@@index`. Additional composite indexes:
- `AppUsageLog(childId, usageDate)` — the dashboard's primary query pattern
  ("show this child's usage for the last 7 days").
- `LocationEvent(childId, recordedAt)` — location history queries.
- `LocationEvent(expiresAt)` — supports the retention purge job scanning
  for expired rows without a full table scan.
- `AiAlert(childId, status)` — the parent dashboard's "unreviewed alerts"
  view.
- `AiAlert(severity)` — supports a cross-family ops/monitoring query
  ("show me all CRITICAL alerts system-wide") for the future admin console.
- Unique composite constraints double as indexes and as business-rule
  enforcement: e.g. `ParentalConsent(childId, consentType)` unique — a child
  can only have one active consent row per category (updated in place,
  not duplicated).

---

## 5. Security Implications

| Concern | Mitigation in this schema |
|---|---|
| Cross-family data leakage | Every child-scoped table has `childId`; every device-scoped table has `familyId` (denormalized onto `Device` on purpose, so the authorization guard can check family membership in one join instead of walking `Device → Child → Family`). |
| Credential exposure | `User.passwordHash`, `Device.pairingCodeHash`, `Child.pinCodeHash`, `RefreshToken.tokenHash` — nothing plaintext is ever stored. Hashing algorithm (Argon2id) is a backend concern, not a schema concern. |
| Token replay/theft | `RefreshToken` is bound to a `deviceId`, has `expiresAt` and `revokedAt`, and records `ipAddress`/`userAgent` at issuance for anomaly detection. |
| Location data exposure | Encrypted at rest (§3.4), time-boxed retention, never exposed via a generic "get all fields" endpoint — the API layer (next phase) will expose only decrypted, permission-checked DTOs. |
| Insider/DB-admin risk on sensitive fields | Location lat/lng and (Phase 2) any raw AI input are encrypted at the **application** layer, meaning a database backup leak alone does not expose GPS history or message content. |
| Audit / accountability | `AuditLog` is append-only and records `actorType`/`actorUserId`/`action`/`entityType`/`entityId` for every consent change, device pairing, policy change — required for GDPR Article 30 and for investigating any support/security incident. |
| Least privilege | The schema has no notion of a "super admin" role that bypasses family scoping — cross-family admin tooling (future Enterprise/School version) will be a **separate** service with its own explicitly-audited access path, not a bit flipped on `User`. |

---

## 6. Migration Workflow

```bash
# generate a new migration after editing schema.prisma
npx prisma migrate dev --name <change_description>

# apply migrations in CI/production (no schema drift allowed)
npx prisma migrate deploy

# regenerate the typed client after any schema change
npx prisma generate
```

Rules for this project (enforced in code review, not tooling):
1. **Never** edit a migration file that has already been merged/deployed —
   create a new migration instead (migrations are an append-only log, same
   philosophy as `AuditLog`).
2. Every migration that touches a table listed in §5 as security-sensitive
   requires a second reviewer.
3. `prisma migrate deploy` runs in the deploy pipeline; `prisma migrate dev`
   is local-only.

### 6.1 Schema Versioning (Decision-038)

Every migration going forward is traceable to *why* it exists, not just
*what* it does. Each migration's description/commit message must record:

```text
Schema Version: <major>.<minor>   (bumped per migration; minor for
                                    additive/nullable changes, major for
                                    anything touching §6.3's "no" answers)
Migration:       M-<sequential id, zero-padded, e.g. M-0007>
ADR:              <path to the architecture doc that motivated this, e.g.
                    docs/architecture/trust-levels-framework.md>
CR:                <change-request id from the relevant Schema Change
                     Proposal doc, e.g. CR-0003>
```

Retroactively applied to the pending pairing-related migration proposed
in `schema-change-proposal-pairing.md`:

| CR | Migration ID | Schema Version | ADR |
|---|---|---|---|
| CR-1 (`Device.publicKey`/`attestationChain`) | M-0001 | 1.1 | `pairing-state-machine.md` |
| CR-2 (`DevicePairingEvent`) | M-0002 | 1.2 | `pairing-state-machine.md` |
| CR-3 (`Device.trustLevel` / `DeviceRiskAssessment`) | M-0003 | 1.3 | `trust-levels-framework.md`, `risk-score-framework.md` |
| CR-4 (`Device.pairingProtocolVersion`) | M-0004 | 1.4 | `pairing-state-machine.md` |
| CR-5 (`Device.deviceFingerprint`) | M-0005 | 1.5 | `pairing-state-machine.md` |

(All five remain unimplemented pending final approval — this table
assigns their IDs now per Decision-038 so the eventual single combined
migration, per the earlier "دفعة واحدة" decision, can cite them
individually in its description even though they land in one migration
file.)

### 6.2 Append-Only tables — general rule (Decision-039)

**Any table representing Security, Trust, Pairing (state history), Audit,
Tamper, or Telemetry data is append-only by policy**, not just the
specific tables identified so far (`AuditLog`, and the proposed
`DevicePairingEvent` / `DeviceRiskAssessment`). Concretely: no `UPDATE` or
hard `DELETE` against a historical row in these categories — a new event
row is added instead. This is a *category* rule, applied to every future
table that falls into one of these six categories, not a per-table
special case decided individually each time one comes up.

### 6.3 Database Compatibility Policy (Decision-041)

Every schema change proposal must explicitly answer these four questions
— "unclear" on any of them blocks implementation until it's resolved, not
just documented as a caveat:

1. **Is it backward compatible?** (Can already-deployed application code,
   pre-change, keep running against the new schema without errors?)
2. **Does it need a data migration?** (Not just a schema migration — does
   existing data need to be transformed, not just new nullable columns added?)
3. **Can it be rolled back?** (Is there a clean `DOWN` path, or is this a
   one-way door — e.g. a destructive column drop with data loss?)
4. **Does it affect existing clients?** (Any consumer — Admin Dashboard,
   Child Agent, or a future integration — relying on the current shape?)

Every CR in `schema-change-proposal-pairing.md` was written to already
answer these implicitly via its "Impact on existing data" / "Migration
required?" / "Breaking change?" / "Rollback plan" fields — this section
formalizes that as the standing template for every future proposal, not
just that one.

### 6.4 Privacy Rule — banned identifiers (per Decision-034's fingerprint discussion, generalized)

No table, field, or Child Agent capability may rely on: IMEI, hardware
serial number, MAC address, or any other identifier Android restricts or
Google Play policy prohibits using for cross-app/cross-reset tracking.
Device identification and fingerprinting (see `schema-change-proposal-pairing.md`
CR-5) must be built exclusively from identifiers Android's current
privacy model actually permits for this use case (`ANDROID_ID`, an
app-generated Keystore public key, and non-identifying hardware profile
fields already collected by the Capability Engine). This is a hard
constraint on every future device-identity-adjacent feature, not
specific to the fingerprint field alone.

> **Environment note:** schema validation (`prisma validate` / `migrate dev`)
> could not be executed inside this sandboxed session because the Prisma
> engine binary download is blocked by network egress rules here. The schema
> was manually verified for brace/relation consistency (see the accompanying
> test in `apps/backend/test/database/schema.spec.ts`) — run
> `npx prisma validate` in your real dev environment as the first command
> after pulling this schema, before building anything on top of it.

---

## 7. What's Deliberately Not Here Yet

- **API layer** — this is a pure data-layer deliverable. NestJS
  modules/controllers/services consuming this schema are the next step.
- **Seed data** — will be added alongside the first API module so seeds
  exercise real service-layer logic (e.g. consent checks) instead of
  bypassing it via raw Prisma inserts.
- **Row-Level Security (Postgres RLS)** — being evaluated as a defense-in-depth
  layer on top of the application-level `FamilyGuard`; tracked as a
  follow-up architecture decision, not blocking Phase 1.
