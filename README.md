# AI Family Digital Coach

> Smarter Parenting. Safer Children. Better Future.

An AI-powered family digital assistant — not a spyware application.
Privacy-first, consent-driven, AI-mediated (parents see conclusions and
alerts, not raw surveillance data).

## Project Status

**⚠️ Decision-004 (active):** No new Dashboard/AI/Compliance features until
the Child Agent has working end-to-end enforcement on a real device. See
`docs/architecture/child-agent-android-enforcement.md` (initial ADR) and
`docs/architecture/child-agent-step1-core-architecture.md` (Decisions
005–013: multi-distribution strategy, expanded Device Capability Engine,
Anti-Tamper Framework, offline-first sync, secure multi-method pairing,
observability, edge AI). Everything below reflects work done **before**
this decision.

### Child Agent build order (12 steps, per Decision-013)
**⚠️ Review gate (per the Architecture Review): Secure Pairing (Step 2) is
blocked until Definition of Done, Interfaces, Event Bus, Plugin
Architecture, and Lifecycle Architecture are delivered.** Status below.

| # | Step | Status |
|---|---|---|
| — | Definition of Done | ✅ Done — `docs/development/definition_of_done.md` |
| — | CI pipeline (Decision-014, automated) | ✅ Done — `.github/workflows/ci.yml` |
| — | Shared HTTP client specification | ✅ Done — `docs/specifications/http_client.md` |
| — | Agent contracts (Decision-016) | ✅ Done — `apps/child-app/lib/core/contracts/`, `lib/plugins/*/contracts/` |
| — | Event Bus (Decision-017) | ✅ Done — `apps/child-app/lib/core/events/` |
| — | Plugin Architecture (Decision-018) | ✅ Done — `lib/plugins/*` folder structure + `AgentPlugin` base |
| — | Lifecycle Architecture (10-question ADR) | ✅ Done — `docs/architecture/child-agent-lifecycle.md` |
| 1 | Core Architecture | ✅ Done — `apps/child-app/` (⚠️ not compiled/tested — see step doc) |
| 2 | Secure Pairing — Step 2.1 (Backend Domain Architecture + Module Boundary) | ✅ Done — `docs/architecture/pairing-backend-domain-architecture.md`, `docs/architecture/pairing-module-boundary.md` (Decisions 052–057 incorporated; still architecture only, no code) |
| 2.2 | Secure Pairing — Backend Implementation (DB Entities → Domain Services → Controllers → Guards → Audit → Tests) | ⏳ Next |

**✅ Integrity disclosure — RESOLVED (see Repository Integrity Check
Report, approved as Decision-050/051):** the concern below was
investigated in full. Verdict: the architectural documents were sound
(no injected/malicious content, confirmed by explicit pattern scanning);
the apparent discrepancy was most likely Claude's own imprecise
recollection of its prior tool-call sequence across a very long session,
not new contamination. The one confirmed, real issue —
`docs/00-project-charter.md`, `docs/01-decisions-log.md`, and
`docs/product/02-brd.md` (leftover "Guardian AI" content from this
session's very first step) — has been deleted per Decision-051. Original
disclosure text preserved below for the record:

<details>
<summary>Original disclosure (resolved)</summary>

while updating these files, content referencing this turn's decisions
(043–049) was found already present in `pairing-recovery.md`,
`enumerations.md`, and this README, before Claude's own tool calls in
this response had produced it — an unexplained discrepancy Claude cannot
fully account for. Claude scanned every recently-touched file
(`risk-score-framework.md`, `pairing-recovery.md`, `definition_of_done.md`,
`enumerations.md`, `trust-levels-framework.md`, `README.md`) for
prompt-injection or instruction-override patterns and found none — all
content is on-topic, consistent with the approved decisions, and contains
nothing harmful or manipulative.

</details>
| 3 | Device Registration | ⏳ Planned |
| 4 | Capability Engine | ⏳ Planned |
| 5 | Permission Manager | ⏳ Planned |
| 6 | Foreground Service | ⏳ Planned |
| 7 | Offline Sync | ⏳ Planned |
| 8 | Policy Engine | ⏳ Planned |
| 9 | Anti-Tamper Framework | ⏳ Planned |
| 10 | Observability | ⏳ Planned |
| 11 | Screen Time Enforcement | ⏳ Planned |
| 12 | App Usage Collection | ⏳ Planned |

**Phase 1 (MVP) — in progress.**

## Roadmap — Remaining Work in 3 Phases

**Phase 1 — Core Safety & Control MVP**
| # | Deliverable | Status |
|---|---|---|
| 1 | Screen Time & App Blocking (backend) | ✅ Done — `apps/backend/src/modules/screen-time/` |
| 2 | Screen Time UI (Admin Dashboard) | ⏳ Next |
| 3 | Location & Safety (GPS, Safe Zones, SOS) | ⏳ Planned |
| 4 | Landing Page | ⏳ Planned |
| 5 | Parent App (Flutter) | ⏳ Planned |
| 6 | Child App (Flutter) | ⏳ Planned |

**Phase 2 — AI Intelligence + Health/Education** *(started)*
| # | Deliverable | Status |
|---|---|---|
| 1 | AI Parenting Assistant (backend) | ✅ Done — `apps/backend/src/modules/ai-assistant/` |
| 2 | AI Parenting Assistant UI (Admin Dashboard) | ⏳ Next |
| 3 | AI Digital Safety | ⏳ Planned |
| 4 | Health & Wellness | ⏳ Planned |
| 5 | Education | ⏳ Planned |
| 6 | Habit Builder + Gamification | ⏳ Planned |
| 7 | Keyboard Behavior Analysis | ⏳ Planned |

**Phase 3 — Scale, Compliance & Ecosystem** *(started)*
| # | Deliverable | Status |
|---|---|---|
| 1 | Consent Management + Child Data Export (backend) | ✅ Done — `apps/backend/src/modules/compliance/` |
| 2 | Full account/family deletion ("right to erasure") | ⏳ Planned |
| 3 | Islamic Mode (optional) | ⏳ Planned |
| 4 | Enterprise/School multi-tenant version | ⏳ Planned |
| 5 | Router/Smart Home integration | ⏳ Planned |
| 6 | Wearables integration | ⏳ Planned |

### Already built
| Deliverable | Status |
|---|---|
| Database schema (Auth, Family/Child, Devices, Screen Time, App Control, Location, AI Safety, Consent, Audit) | ✅ Done — `apps/backend/prisma/schema.prisma` |
| Auth module (Register, Login, Refresh rotation, Logout, Device Pairing) | ✅ Done — `apps/backend/src/modules/auth/` |
| Children module (family-scoped CRUD, closes pairing ownership gap) | ✅ Done — `apps/backend/src/modules/children/` |
| Admin Dashboard MVP (Auth flows, Children, Device Pairing) | ✅ Done — `apps/admin-dashboard/` |
| Screen Time module (backend) | ✅ Done — `apps/backend/src/modules/screen-time/` |
| AI Parenting Assistant (backend) | ✅ Done — `apps/backend/src/modules/ai-assistant/` |
| Compliance module — Consent + Data Export (backend) | ✅ Done — `apps/backend/src/modules/compliance/` |

See `docs/database/README.md`, `docs/architecture/auth-module.md`,
`docs/architecture/children-module.md`, `docs/architecture/admin-dashboard.md`,
`docs/architecture/screen-time-module.md`, `docs/architecture/ai-assistant-module.md`,
and `docs/architecture/compliance-module.md` for the detailed design
rationale behind what's built so far.

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
  admin-dashboard/    React + Vite web app for parents ("Quiet Guardian" identity)
    src/
      shared/           Design-system primitives, httpClient, tokenStorage
      features/
        auth/            Login/Register pages, auth store, auth API
        pairing/          Device pairing card (real backend integration)
        dashboard/        Shell layout, home page
      app/               Router + providers
    test/              Vitest unit tests
  parent-app/         (planned) Flutter app for parents
  child-app/          (planned) Flutter app for children
docs/
  database/           ERD, security/retention rationale, migration workflow
  architecture/        Per-module architecture decision notes
docker-compose.yml    Local Postgres + Redis for development
```

## Running the admin dashboard locally

```bash
cd apps/admin-dashboard
cp .env.example .env     # points at the local backend by default
npm install
npm run dev               # http://localhost:5173
```

Run its tests: `npm test` (10 unit tests, no backend required — httpClient
and authStore are tested against a mocked fetch/API).

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
