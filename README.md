# AI Family Digital Coach

> Smarter Parenting. Safer Children. Better Future.

An AI-powered family digital assistant — not a spyware application.
Privacy-first, consent-driven, AI-mediated (parents see conclusions and
alerts, not raw surveillance data).

## Project Status

**Phase 1 (MVP) — in progress.**

| Deliverable | Status |
|---|---|
| Database schema (Auth, Family/Child, Devices, Screen Time, App Control, Location, AI Safety, Consent, Audit) | ✅ Done — `apps/backend/prisma/schema.prisma` |
| Auth module (Register, Login, Refresh rotation, Logout, Device Pairing) | ✅ Done — `apps/backend/src/modules/auth/` |
| Children/Family management module | ⏳ Next |
| Screen Time & App Blocking module | ⏳ Planned |
| Parent App / Child App (Flutter) | ⏳ Planned |
| AI Engine (Behavior/Safety/Health/Learning) | ⏳ Planned (Phase 1 minimal → Phase 2 full) |

See `docs/database/README.md` and `docs/architecture/auth-module.md` for
the detailed design rationale behind what's built so far.

## Repository Structure

```
apps/
  backend/            NestJS API (this is where Phase 1 backend work lives)
    prisma/           Database schema & migrations
    src/
      common/          Cross-cutting infrastructure (Prisma, Redis, decorators)
      config/          Environment validation
      modules/
        auth/           Feature module: registration, login, tokens, device pairing
      app.module.ts
      main.ts
    test/              Unit + integration tests, mirrors src/ structure
  parent-app/         (planned) Flutter app for parents
  child-app/          (planned) Flutter app for children
docs/
  database/           ERD, security/retention rationale, migration workflow
  architecture/        Per-module architecture decision notes
docker-compose.yml    Local Postgres + Redis for development
```

## Running the backend locally

```bash
cd apps/backend
cp .env.example .env          # then fill in real secrets — see comments in the file
docker compose -f ../../docker-compose.yml up -d postgres redis
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run start:dev
```

Run the test suite:

```bash
npm test              # unit tests — no DB required
# for the database integration test specifically, ensure postgres is up and migrated first:
npx jest test/database/schema.spec.ts
```

## Development Principles

Clean Architecture, SOLID, DRY, KISS, YAGNI, Dependency Injection, Repository
Pattern, Feature-first module structure. Every module is organized as
`domain/ → application/ → infrastructure/ → presentation/`, with dependency
inversion enforced at the `application/ports` boundary — see
`docs/architecture/auth-module.md` §1 for a concrete example.

Privacy-by-design is a hard architectural constraint, not a policy
afterthought: see `docs/database/README.md` §3 for how consent, data
minimization, encryption, and retention are built into the schema itself.
