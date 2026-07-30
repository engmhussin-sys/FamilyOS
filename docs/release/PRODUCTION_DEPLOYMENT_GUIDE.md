# Production Deployment Guide

## Required environment variables

See `apps/backend/.env.example`. Validated at boot by
`StartupValidationReport` — the process refuses to start with
missing/weak `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`. Warnings (non-fatal) for `ANTHROPIC_API_KEY`,
`CORS_ALLOWED_ORIGINS`, `LOCATION_ENCRYPTION_KEY` — check
`GET /system/diagnostics` after boot to confirm which are active.

## Building the backend

```bash
cd apps/backend
docker build -t familyos-backend .
```

Multi-stage `Dockerfile`: dev toolchain excluded from the runtime
image, runs as non-root, has its own `HEALTHCHECK` against `/health/live`.

## Database migration

```bash
npx prisma migrate deploy
npx prisma db seed   # seeds PlanDefinition rows — PLACEHOLDER pricing, see seed.ts
```

## Health & readiness endpoints for your orchestrator

- `GET /health/live` — process up, zero dependency checks (liveness probes).
- `GET /health/ready` — Postgres + Redis reachability, 503 if either is
  down (readiness probes / load balancer health checks).
- `GET /system/readiness` — fuller checklist (LLM/billing provider
  status) — informational, not for orchestrator probes.

## Reverse proxy / TLS

This backend does not terminate TLS itself. Deploy behind a reverse
proxy/load balancer that does. HSTS is already set assuming HTTPS is
enforced upstream.

## Provider configuration (all optional — the system runs without them)

| Provider | Env var(s) | Effect if unset |
|---|---|---|
| Anthropic (AI phrasing) | `ANTHROPIC_API_KEY` | AI features degrade to deterministic fallback text |
| Stripe | `STRIPE_SECRET_KEY` | `PaymentProviderNotConfiguredException` if selected |
| Paymob | `PAYMOB_API_KEY` | Same |
| Fawry | `FAWRY_API_KEY` | Same |
| Apple IAP | `APPLE_IAP_SHARED_SECRET` | Same |
| Google Play | `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY` | Same |
| PostHog | `POSTHOG_API_KEY` | Silently no-ops; self-hosted analytics still works |

## Scaling notes

- Stateless process — horizontal scaling behind a load balancer is safe.
- Rate limiting is per-instance, not cluster-coordinated — a
  Redis-backed throttler storage is the standard fix if this matters at
  scale; not implemented in this codebase.

## What this guide does not cover (real, external decisions)

- Which cloud provider to deploy to.
- Backup schedule/retention (your managed Postgres provider's
  responsibility).
- CDN/static asset hosting for the Admin Dashboard's build output.
