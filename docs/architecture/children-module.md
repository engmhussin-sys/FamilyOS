# Architecture Notes — Children Module

**Location:** `apps/backend/src/modules/children/`
**Depends on:** `Child` table (already in the schema — no migration needed).
**Consumed by:** `AuthModule`'s `PairingService` (new dependency added in this step).

---

## 1. Scope

Family-scoped CRUD for child profiles: create, list, get one, update, soft-delete.
All four mutating/reading operations resolve `familyId` from the caller's
own verified access token (`@CurrentUser()` → `IJwtPayload.familyId`) —
**never** from a request body or query param — so there is no way for one
family to read or edit another family's children by guessing an ID.

## 2. The core pattern: `getChildOrThrow`

```ts
async getChildOrThrow(childId: string, familyId: string): Promise<Child> {
  const child = await this.childRepository.findOneScopedToFamily(childId, familyId);
  if (!child) throw new ChildNotFoundException(childId);
  return child;
}
```

The repository query itself is `WHERE id = childId AND familyId = familyId AND deletedAt IS NULL`
— ownership is enforced **in the query**, not as a separate check after a
generic `findById`. This means there is no code path where a child record
briefly exists in memory before an ownership check "remembers" to run.

`findOneScopedToFamily` returning `null` is deliberately the same outcome
whether the child doesn't exist, is soft-deleted, or belongs to a different
family. A 404 that also implicitly meant "and it's not yours" would leak
which child IDs are valid to an attacker probing IDs across families — see
`child.errors.ts`'s docstring.

Every other module that will eventually accept a `childId` from a client
(Screen Time, Location, future modules) is expected to route through
`ChildrenService.getChildOrThrow` / `assertChildBelongsToFamily` rather
than querying Prisma directly — this is the one place that pattern lives.

## 3. Closing the previously documented gap

`docs/architecture/auth-module.md` §4 flagged: *"`DevicePairingController.initiate`
does not yet verify that `childId` belongs to the caller's family."*

This step closes it. `AuthModule` now imports `ChildrenModule`, and
`PairingService.initiate` calls `childrenService.assertChildBelongsToFamily(...)`
as its first step — **before** a pairing code is generated or written to
Redis. A request for a `childId` outside the caller's family now fails
with `ChildNotFoundException` and never reaches the code-generation step.
Tested explicitly in `test/auth/pairing.service.spec.ts` (new case: rejects
before touching Redis).

This creates a one-directional module dependency, `AuthModule → ChildrenModule`.
`ChildrenModule` does not import anything from `AuthModule` beyond the
shared `JwtAuthGuard` (which lives under `auth/presentation/guards` but has
no dependency back into auth's services) — so there's no cycle.

## 4. New test: whole-app DI graph smoke test

`test/app.module.spec.ts` compiles the **entire** `AppModule` (every
module, every provider) via `Test.createTestingModule({ imports: [AppModule] }).compile()`.
This is a cheap, fast (~1s) test that catches an entire class of bugs —
missing provider, wrong DI token, accidental circular import — the moment
a new module is wired in, without needing a real database or Redis
instance (`PrismaService`/`RedisService` are overridden with no-op
stand-ins for this test specifically; live-infra checks stay in
`test/database/`).

## 5. Known follow-ups

1. **Admin Dashboard's `PairingCard` still has a manual `childId` text
   field** (see `docs/architecture/admin-dashboard.md` §5). This module
   now makes the real fix straightforward: add `GET /children` to the
   dashboard's API layer and swap the text field for a `<select>`. Not
   done in this step to keep it backend-scoped and reviewable on its own.
2. **No `PATCH /children/:id/avatar` upload endpoint** — `avatarUrl` is
   currently just a validated URL string field, not a file upload. File
   upload (S3/equivalent) is a Phase 1 follow-up once storage
   infrastructure is decided.
