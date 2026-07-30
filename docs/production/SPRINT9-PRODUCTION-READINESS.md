# Sprint 9 — Production Readiness

**Status:** Everything listed as ✅ is real code, verified this session.
Everything listed as ⏳ is an operational/infrastructure task that has no
corresponding application code to write (backup schedules, load test
runs, penetration test engagements) — flagged honestly, not silently
skipped.

---

## What's now real code

| Item | What was built |
|---|---|
| Security headers | Stricter `helmet()` config in `main.ts`: real CSP (`default-src 'none'` — this is a JSON API, nothing should ever load *from* it), HSTS (180 days) |
| Compression | `compression()` middleware — real npm package installed and verified (`npm install` ran successfully this session) |
| Global error shape | `GlobalExceptionFilter` — every error response has the same JSON shape; 5xx errors NEVER leak the raw message/stack to the client (tested explicitly with a deliberately sensitive error message) |
| Structured logging | `LoggingInterceptor` — one JSON log line per request (method/path/status/duration/correlationId), request/response bodies never logged |
| Correlation IDs | `CorrelationIdMiddleware` — every request gets an ID (inbound `X-Correlation-Id` respected if present), echoed in the response header and in every error/log line for that request |
| Health checks | `GET /health/live` (process up, zero dependency checks — a slow DB must never fail liveness) and `GET /health/ready` (Postgres + Redis reachability, 503 on failure) — both excluded from the `/api/v1` prefix so infrastructure can probe them at a fixed path |
| Graceful shutdown | `app.enableShutdownHooks()` — SIGTERM now drains cleanly (Prisma/Redis `OnModuleDestroy` hooks actually fire) instead of the process being killed mid-request |
| Production Docker image | Multi-stage `Dockerfile` — dev toolchain never ships to production, runs as non-root, has its own `HEALTHCHECK` hitting `/health/live` |
| CI: security scanning | `npm audit --audit-level=high` added to the backend CI job (informational for now — see §6 below for when it should become blocking) |
| CI: Docker verification | New `docker` job builds the production image on every push — a broken Dockerfile is now caught in CI, not at deploy time |

## Already existed, reviewed and confirmed adequate (not rebuilt)

- **Rate limiting** — `ThrottlerModule` global default (100 req/min) +
  stricter per-endpoint overrides already in place (login, pairing
  invite/accept, AI endpoints). Reviewed, not changed.
- **Environment validation** — `env.validation.ts` already fails hard at
  boot on missing/weak JWT secrets. Reviewed, not changed.
- **Input validation** — global `ValidationPipe` with
  `whitelist`/`forbidNonWhitelisted` already rejects any unexpected DTO
  field. Reviewed, not changed.
- **Database indexes** — every hot-path query already has a
  corresponding `@@index` (checked against `schema.prisma` directly:
  `Notification`, `DevicePairingEvent`, `AiMemoryEntry`,
  `AnalyticsEvent`, etc. all have one). No missing index found.
- **CI pipeline** — already ran real Postgres+Redis services, a genuine
  database integration test, and full builds for all three apps before
  this session. Extended, not rebuilt.

## Explicitly NOT code — operational tasks, not silently skipped

- **Backup & Restore** — this is a managed-Postgres-provider
  responsibility (Railway/RDS automated backups), not application code.
  No backup script was written because there is nothing for this
  backend to do at the application layer; the real action item is
  confirming the chosen hosting provider's backup retention policy — a
  deployment configuration choice, not something to build.
- **Load Testing** — genuinely cannot be run in this sandbox (no live
  server, no network to a deployed instance). Real load testing needs
  an actual running deployment and is inherently a Sprint 10 /
  post-deployment activity, not something this session could execute.
- **Penetration Testing** — the same category as load testing: requires
  a live, deployed target. What COULD be done in this session (security
  header hardening, error-message leak prevention, rate limiting
  review) was done; an actual pen test is a separate, real engagement.
- **Secrets Management** (vault/rotation) — `env.validation.ts` already
  enforces secret *presence and strength* at boot; actual secret
  *storage* (Railway env vars vs. a dedicated secrets manager) is a
  hosting-platform decision, not application code.

## Business/security decisions still needing sign-off

1. **When does `npm audit` become a blocking CI check, not just
   informational?** Left `continue-on-error: true` this session —
   flipping it to blocking is a real policy decision (a single
   moderate-severity transitive dependency finding shouldn't
   necessarily halt every deploy).
2. **Backup retention window** — depends entirely on which hosting
   provider is chosen (a decision already flagged as pending in Sprint 8's
   summary, for Billing's payment provider — the same "provider choice"
   category applies here for hosting).

## Verification performed in this session (once, at the end, per this Sprint's own execution rule)

- `npx tsc --noEmit` → **0 errors**
- `npx jest --testPathIgnorePatterns=test/database` → **239/239 passed**
  (was 229 before this session; +10: `HealthController` 5,
  `GlobalExceptionFilter` 5) — includes the DI-graph smoke test,
  confirming `HealthModule` and the new middleware/filter/interceptor
  wire in cleanly
- `.github/workflows/ci.yml` → validated as parseable YAML with 4 jobs
  (`backend`, `admin-dashboard`, `child-app`, new `docker` job)
- Database integration test (`test/database`) → not run this session
  (requires a live Postgres instance this sandbox doesn't have — same
  standing limitation noted since the test file's own docstring was
  written)
