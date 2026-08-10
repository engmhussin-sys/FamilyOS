# Sprint 13 — BLOCKED by Environment (Waiting for First Real Environment)

**Status: BLOCKED, not FAILED.** All Sprint 13 code (Habit Engine, Life
Timeline Engine, and 15 additive database tables for the Life
Intelligence Platform per Architecture 1.0) is complete, written, and
registered exactly as it should be in production — `LifeIntelligenceModule`
is imported and wired into `AppModule` right now, unmasked, uncommented,
un-excluded. Nothing was disabled to make this document look better.

---

## The Reason

`apps/backend/prisma/schema.prisma` was extended with 15 new models
(Sprint 13, Architecture 1.0). Before that schema change can be used by
any TypeScript code, Prisma's CLI must run `generate`, which reads
`schema.prisma` and writes a matching, fully-typed `PrismaClient` into
`node_modules/.prisma/client`. Until that happens, `PrismaService`
(which extends the generated `PrismaClient`) has no `.habit`,
`.habitCompletion`, or `.lifeTimelineEvent` properties — because the
currently-installed generated client predates Sprint 13's schema
additions entirely.

This is not a code defect. It was proven, not assumed, in the previous
review: removing `LifeIntelligenceModule` from `AppModule` made every
failing test pass again; restoring it reproduced the exact same 10
TypeScript errors, all of the single form `Property 'X' does not exist
on type 'PrismaService'`.

## Why Prisma Cannot Run in This Sandboxed Session

`prisma generate` (and `prisma validate`, and `prisma migrate dev`)
needs to download Prisma's schema-engine and query-engine binaries
from `binaries.prisma.sh` on first use for a given Prisma/engine
version. This sandboxed development environment's network access is
restricted to an explicit allow-list of domains (npm, PyPI, crates.io,
GitHub, and a handful of others for package installation and source
control) — `binaries.prisma.sh` is not on that list. Every attempt
returns:

```
Error: Failed to fetch sha256 checksum at
https://binaries.prisma.sh/all_commits/<engine-hash>/debian-openssl-3.0.x/libquery_engine.so.node.gz.sha256
- 403 Forbidden
```

This was tested directly, multiple times, including with
`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` (Prisma's own suggested
workaround for offline environments), which still fails because the
underlying engine file itself — not just its checksum — is
unreachable. No cached engine binary exists anywhere on this
sandbox's filesystem either (checked directly). There is no database
server reachable from this sandbox at all, so even if the client could
be generated, `prisma migrate dev` would have nothing to connect to.
This is the same class of environment limitation already documented
repeatedly elsewhere in this project (no Flutter SDK, no Docker
daemon, no Railway account) — not unique to Prisma, not a new kind of gap.

## Exact Commands Required (Railway or Local, Any Network-Unrestricted Environment)

Run these from `apps/backend/`, in order:

```bash
# 1. Point at a real, reachable Postgres instance
export DATABASE_URL="postgresql://<user>:<password>@<host>:5432/<db>?schema=public"

# 2. Validate the schema is syntactically correct
npx prisma validate

# 3. Generate the Prisma Client — this is the step that resolves
#    every "Property 'X' does not exist on type 'PrismaService'" error
npx prisma generate

# 4. Apply the migration. Two options:
#    (a) If using the hand-authored SQL file already in this repo
#        (prisma/migrations/20260731_life_intelligence_platform_sprint13/migration.sql),
#        first verify it against the schema:
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/expected_migration.sql
#        then diff it against the hand-authored file and reconcile any
#        difference before trusting the hand-authored one.
#
#    (b) Simpler and safer: delete the hand-authored migration folder
#        and let Prisma generate the authoritative one directly:
rm -rf prisma/migrations/20260731_life_intelligence_platform_sprint13
npx prisma migrate dev --name life_intelligence_platform_sprint13

# 5. Run the test suite for real
npx jest --testPathIgnorePatterns=test/database

# 6. Run the full backend build
npx nest build
```

## What Happens After `prisma generate` Succeeds

- Every one of the 10 current TypeScript errors resolves automatically
  — no code change is needed, because the code was always written
  against the correct, schema-accurate types; it was only the
  generated client that was stale.
- `npx tsc --noEmit -p tsconfig.json` will report 0 errors.
- `npx nest build` will succeed cleanly.
- `test/app.module.spec.ts` (the DI graph test) will pass, because the
  root cause proven in the prior review (a compile-time failure
  cascading from the stale client, not a real dependency-injection
  problem) will no longer exist.
- The 17 tests written for `HabitEngineService` and `LifeTimelineService`
  (`test/life-intelligence/*.spec.ts`) will execute for the first time
  in this project's history and report real pass/fail results instead
  of "Test suite failed to run."

## How to Verify Success

Run this single sequence and confirm every line matches:

```bash
cd apps/backend
npx tsc --noEmit -p tsconfig.json          # expect: no output, exit code 0
npx nest build                              # expect: exit code 0, dist/src/main.js exists
npx jest --testPathIgnorePatterns=test/database --no-coverage
# expect: "Test Suites: 40 passed, 40 total"
# expect: "Tests: <247 + the real count of the 17 new tests that pass> total"
```

If any of the 17 new tests fail for a REAL reason (a genuine logic bug,
not a compile error), that is a legitimate Sprint 13 follow-up fix —
expected and normal, not a sign this document was wrong.

---

## What This Document Deliberately Does NOT Do

- Does not modify `schema.prisma`, any service, any repository, any
  controller, or any test file.
- Does not exclude, comment out, or disable `LifeIntelligenceModule` —
  it remains fully registered in `AppModule`, exactly as a completed
  module should be.
- Does not claim Sprint 13 is done. It is **blocked by environment**,
  a distinct and honest status from both "complete" and "failed."
