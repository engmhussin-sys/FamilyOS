# AI Family Digital Coach

> Smarter Parenting. Safer Children. Better Future.

An AI-powered family digital assistant — not a spyware application.
Privacy-first, consent-driven, AI-mediated (parents see conclusions and
alerts, not raw surveillance data).

## Project Status

## Project Execution Plan v1.0 — 10 Sprint Accelerated Plan

| Sprint | Status |
|---|---|
| 1 — Project Foundation & Core Infrastructure | ✅ |
| 2 — AI Core + Trust & Risk Foundation | ✅ |
| 3 — Device Pairing & Child Agent Foundation | ✅ Closed — backend vertical (`pairing-sprint3-backend-vertical.md`) + Flutter vertical (`pairing-sprint3-flutter-vertical.md`) |
| 4 — Real Child Agent Enforcement (Android Native Layer) | 🔄 Track A complete (Backend + AI Diagnostics + Dashboard, 138/138 tests, real security fix — see `docs/architecture/sprint4-track-a-completion.md`) |
| — | Child Runtime Engine (CRE) architecture | ✅ 16-component contract pass complete — see `docs/architecture/child-runtime-engine.md` (includes an in-session self-correction: Runtime Telemetry was mistakenly marked done in an earlier draft while its folder was empty — found via a full-codebase brace-balance sweep and built for real) |
| 5 — Runtime Enforcement Engine | 🔄 Implementation exists (AccessibilityService/Overlay/Foreground Service/Boot Receiver/Backend/Dashboard) — see `docs/architecture/sprint5-runtime-enforcement-engine.md`. Backend 140/140 tests + Dashboard 14/14 tests + build all pass. **Native code is UNVALIDATED on any physical device** — the 3-manufacturer real-device test from the Track A/B split remains required before this is production-ready. |
| — | Child Runtime Engine (architecture + lower-risk components) | ✅ Done — Event Bus extended, Anti-Tamper (7/14 signals, real), Device Capability Engine (expanded matrix), Local Policy Engine (cache + default offline policy), Local AI Runtime (1 real deterministic engine + 5 declared interfaces), Keyboard Monitoring (interfaces only, per explicit instruction); see `docs/architecture/child-runtime-engine.md`. **Track B pending** (Accessibility Manager, Foreground/Overlay/Boot Runtimes — requires real-device testing on 3+ manufacturers before Sprint 4 closes). |
| 5 — Parental Control Engine | ⏳ |
| 6 — AI Behavioral & Digital Safety Engine | ⏳ |
| 7 — Health & Habit Coach | ⏳ |
| 8 — Education & Character Development | ⏳ |
| 9 — Security, Compliance & Monetization | ⏳ |
| 10 — Production Launch | ⏳ |


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
| 2.2.1 | Secure Pairing — Database Entities | ✅ Done — `apps/backend/prisma/schema.prisma` extended (2 new tables, 4 new enums, 5 new `Device` fields, all additive); see `docs/architecture/pairing-step-2-2-1-database-entities.md` |
| 2.2.2.1 | Secure Pairing — Domain Service 1: Pairing State Machine | ✅ Done — corrected per Decision-065/066 (`childId` required, `deviceId` optional secondary reference); Cases 1–4 covered |
| 2.2.2.2 | Secure Pairing — Domain Service 2: Invitation Service | ✅ Done — Redis-backed, family-ownership-checked, drives `PAIRING_INVITED`/`PAIRING_ACCEPTED` |
| 2.2.2.3 | Secure Pairing — Domain Service 3: Registration Token Service | ✅ Done — Decision-054's single-use-forever token, hashed at rest |
| 2.2.2.4 | Secure Pairing — Domain Services 4 & 5: Trust/Risk Evaluation | ✅ Done — `TRUST_SIGNAL_PROVIDER`/`RISK_SIGNAL_PROVIDER` + `IIntelligenceSignalProvider` (Decision-070) ready for future AI Core consumption; see `docs/architecture/pairing-sprint2-trust-risk-intelligence.md` |
| 2.2.3 | Secure Pairing — Controllers (Sprint 3 backend vertical) | ✅ Done — 8 endpoints under `/pairing` (invite/accept/register/verify/activate/reject/revoke/status) + heartbeat; see `docs/architecture/pairing-sprint3-backend-vertical.md` |
| — | Full backend test suite | **124/124 passing**, DI graph clean |
| — | Sprint 3 (Flutter/Kotlin half: device registration flow, heartbeat) | ✅ Done — Device Identity (Keystore keypair), Device Registration flow, Heartbeat foundation; see `docs/architecture/pairing-sprint3-flutter-vertical.md` (⚠️ not compiled/tested — standing sandbox limitation) |
| — | Full backend test suite | **80/80 passing**, DI graph clean |

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
| 1 | AI Parenting Assistant (backend) | ✅ Done — migrated onto shared `ai-core` module (Decision-068), see below |
| 2 | AI Parenting Assistant UI (Admin Dashboard) | ⏳ Next |

## AI Core Engine (Decision-068/069, Sprint AI-1: Foundation)
| Item | Status |
|---|---|
| AI Module Boundary + Provider abstraction (`IAIProvider`) | ✅ Done — `apps/backend/src/modules/ai-core/` |
| Context Manager (shared, extracted from AI Parenting Assistant) | ✅ Done |
| AI Event Schema (`IAIEvent`) — structural, Sprint AI-2 | ✅ Declared, not yet consumed |
| AI Parenting Assistant migrated onto the shared foundation | ✅ Done — zero API-level change, `docs/architecture/ai-core-engine-boundary.md` |
| Sprint AI-2 (Behavioral Engine) | ⏳ Next |

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
