# Load Testing Plan

**CLOSES A REAL GAP** identified in the Master Completeness Audit:
zero load testing plan existed. This is a **plan**, stating what to
test and how — actually RUNNING it needs a real deployed environment
(staging/production), which does not exist in this sandbox. No load
test has been executed; none is claimed to have been.

## Why this matters now, concretely

This backend has real, identifiable hot paths already built:
- `POST /pairing/*` — device registration, heartbeats (frequent, per-device)
- `POST /life-intelligence/self/wellbeing/*` — daily summary uploads (once/device/day, but synchronized around similar times)
- `GET /analytics/dashboard-metrics` — now `InternalAdminGuard`-protected, low-traffic by design
- `POST /organizations/campaigns/redeem` — already rate-limited (5/min) specifically because of brute-force risk; load testing should confirm the limit holds under concurrent load, not just sequential requests

## Tooling recommendation (not yet chosen — a real decision, flagged)

k6 or Artillery are the standard choices for a Node/NestJS backend —
both support scripting realistic multi-step flows (register → pair
device → send heartbeats) rather than single-endpoint hammering.
Neither is installed or configured in this repository yet; this is a
genuine tooling decision for whoever runs the first real test, not
guessed at here.

## What to test (grounded in this backend's real architecture)

| Scenario | Target | Why |
|---|---|---|
| Concurrent device heartbeats | Pairing heartbeat path | Every paired device calls this periodically — this is the highest-volume real traffic pattern the app will ever see |
| Concurrent registration | `POST /auth/register` | Rate-limited already; confirm the limit holds under real concurrency, not just sequential calls |
| Database connection pool saturation | Any endpoint, high concurrency | Prisma's connection pool has a real, finite size — this is the most likely first bottleneck, not application code |
| Redis under load | Rate-limiting + pairing invitation lookups | Redis is the shared state behind rate limiting itself — if Redis is slow, rate limiting silently degrades |

## Success criteria (a real, testable target — not guessed at)

- p95 latency stays under 500ms for read endpoints, 1000ms for write endpoints, at the concurrency level matching realistic expected device count
- Zero 500-level errors under sustained load at that concurrency
- Rate limiting (`ThrottlerModule`, currently 100/min global + tighter per-endpoint limits) correctly rejects excess requests rather than silently failing open

**HONEST NOTE:** "realistic expected device count" is not filled in
here with a specific number — this project has zero production users
yet, so there is no real traffic baseline to target. This number needs
to come from actual business projections (expected family count times
devices per family), not guessed at by this document.

## What this plan does NOT do

Run the actual test. That requires a real staging/production
deployment (not this sandbox), the chosen tool actually installed and
scripted, and a real target concurrency number from the business side.
