# Architecture Notes — Screen Time Module

**Location:** `apps/backend/src/modules/screen-time/`
**Depends on:** `ScreenTimePolicy` table (already in the schema), `ChildrenModule` (ownership checks).
**Routes:** `GET|POST /children/:childId/screen-time-policy` — nested under
`children` deliberately, so the ownership relationship is visible in the
URL itself, not just enforced invisibly server-side.

---

## 1. This is the pattern's first real reuse

`docs/architecture/children-module.md` §2 predicted: *"Every other module
that will eventually accept a `childId` from a client... is expected to
route through `ChildrenService.getChildOrThrow` / `assertChildBelongsToFamily`
rather than querying Prisma directly."*

`ScreenTimeService` is the first module built after that was written, and
it follows the prediction exactly — both `getPolicy` and `setPolicy` call
`childrenService.assertChildBelongsToFamily` as their first line, before
touching `IScreenTimePolicyRepository` at all. Tested explicitly: three of
the four `ScreenTimeService` tests assert that the repository is **never
called** when ownership fails.

## 2. Versioned policies, not in-place updates

`setPolicy` soft-deletes the previous active policy (`deactivate`) and
creates a brand-new row, rather than `UPDATE`-ing the existing one. This
is a deliberate small piece of forward design: Phase 2's AI Parenting
Assistant will need to answer questions like *"my son's screen time went
up last month, why?"*, which requires a history of what the policy
actually was at any point in time — not just its current value. Building
that in now (row-per-change, `effectiveFrom` on each row, soft-delete
instead of overwrite) costs almost nothing extra today and avoids a data
migration later to reconstruct history that was never captured.

## 3. `weekdaySchedule` is intentionally an opaque JSON blob

Validated only as "is it an object" (`@IsObject()`) rather than a strict
per-weekday schema. The exact shape (per-day limits vs. per-day time
windows vs. something else) is a product decision better made once the
Parent App's UI for this exists — locking a rigid DTO schema now would
mean a breaking API change later. This is a deliberate, documented
YAGNI call, not an oversight.

## 4. Verification performed in this session

- `npx tsc --noEmit` → 0 errors.
- `npx jest test/auth test/children test/screen-time test/app.module.spec.ts`
  → **32/32 tests passed**, including the whole-app DI graph smoke test
  (confirms `ScreenTimeModule → ChildrenModule` wires in without a
  circular dependency).
