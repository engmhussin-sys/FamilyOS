# Architecture Notes — Compliance Module (Phase 3, Feature 1)

**Location:** `apps/backend/src/modules/compliance/`
**Routes:** `GET|POST /children/:childId/consents`, `GET /children/:childId/data-export`
**Depends on:** `ChildrenModule`, `ScreenTimeModule`.

---

## 1. A real gap this closes

The `ParentalConsent` table has existed in the schema since the very first
step of this project (`docs/database/README.md` §3.2 describes it as *"the
technical backbone of the project's privacy-first principle"*) — but until
this module, there was **no API for it at all**. Every AI/monitoring module
built so far has been *designed* to respect consent, but nothing could
actually read or write a consent record. This module is that missing piece.

## 2. Consent upsert semantics

`ParentalConsent` has `@@unique([childId, consentType])` in the schema —
granting or revoking a consent type is always an **upsert**, never an
insert. `PrismaConsentRepository.upsert` uses Prisma's compound-unique
input (`childId_consentType`) so re-granting an already-revoked consent
updates the same row (fresh `grantedAt`, `revokedAt: null`) rather than
creating a second history-less row. `granted: false` sets `revokedAt` to
now; `granted: true` clears it — the row's current state and its own
timestamp fields agree by construction, not by convention callers have to
remember.

## 3. Data export composes services, not raw queries

`DataExportService` explicitly does **not** query Prisma directly. It
calls `ChildrenService.getChildOrThrow`, `ScreenTimeService.getPolicy`, and
`ConsentService.listConsents` — the same methods every other module uses.
This was a deliberate choice over a single denormalized multi-table query:
- No duplicated ownership-check logic.
- Tests mock the same three ports every other test in this codebase mocks
  — no new mocking strategy needed for this one feature.
- If any of those three services' business rules change (e.g. what counts
  as an "active" screen time policy), the export reflects it automatically
  without a second place to update.

The tradeoff: three sequential-ish service calls instead of one JOIN.
Acceptable — this endpoint is a parent-initiated, infrequent read (a
compliance/export action), not a hot path.

## 4. Scope: per-child, not whole-family

Export is scoped to one child at a time
(`GET /children/:childId/data-export`), matching how GDPR/COPPA "right to
access" requests are actually scoped in practice — a specific data
subject, not an undifferentiated account dump. A parent with multiple
children calls this once per child.

## 5. Known follow-ups (explicitly deferred, not silently skipped)

1. **No full account/family deletion endpoint** ("right to erasure").
   This is a genuinely higher-risk operation — cascading a soft-delete
   across Family → Children → Devices → Consents → RefreshTokens, plus an
   audit trail and (almost certainly) a re-authentication/confirmation
   step — and deserves its own carefully reviewed step rather than being
   rushed in alongside consent management. Deliberately not built in this
   pass.
2. **Export returns JSON only**, not a downloadable file (PDF/CSV). Fine
   for an API-first MVP; a dashboard "download my data" button can wrap
   this response into a file client-side without a backend change.
3. **No export of `AuditLog` entries** for the child yet — would be a
   reasonable addition once audit logging is actually being written to
   by other modules (currently the `AuditLog` table exists in the schema
   but, like `ParentalConsent` before this module, has no writer yet).

## 6. Verification performed in this session

- `npx tsc --noEmit` → 0 errors.
- Full backend suite → **48/48 tests passed**.
