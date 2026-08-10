# Backup & Restore Plan

**CLOSES A REAL GAP** identified in the Master Completeness Audit: zero
backup/restore documentation existed — `RECOVERY_FLOW.md` covers app
crash recovery only, not database durability. This document is
grounded in what actually runs (`postgres:15-alpine` per
`docker-compose.yml`, Prisma migrations) — no infrastructure invented
that doesn't exist in this project.

## What needs backing up

| Data store | Contains | Loss impact |
|---|---|---|
| PostgreSQL (primary) | Everything — users, families, children, subscriptions, all Life Intelligence data, audit logs, organizations | **Total data loss** if unrecovered |
| Redis | Refresh token blocklist, rate-limit counters, pairing invitation codes (short-lived, single-use) | Low — sessions invalidate, pairing codes need re-issue; nothing here is the source of truth for anything durable |

**Redis is deliberately NOT backed up** — everything in it is either
derivable from Postgres or short-lived by design (a pairing invitation
that's lost simply needs re-issuing, which the existing
`InvitationService` already supports).

## Backup strategy (PostgreSQL)

This project has not chosen a hosting provider's managed backup
service yet (Railway is the current deploy target per
`PRODUCTION_DEPLOYMENT_GUIDE.md`) — this is deliberately a **real,
undecided operational choice**, not guessed at here. Two concrete,
equally valid paths depending on that decision:

1. **Managed provider backup** (Railway, RDS, Cloud SQL, etc.) — most
   providers offer automated daily snapshots with point-in-time
   recovery as a paid tier feature. If the hosting decision lands on
   a provider with this built in, prefer it over a custom script —
   less to maintain, professionally tested.
2. **`pg_dump` on a schedule** (if self-managing) — a cron job (or
   the hosting platform's scheduled-job feature) running:
   ```bash
   pg_dump "$DATABASE_URL" --format=custom --file="backup-$(date +%Y%m%d-%H%M%S).dump"
   ```
   uploaded to object storage (S3-compatible) immediately after.

## Recommended schedule (a real decision, not a guess — flagged as needing sign-off)

| Tier | Frequency | Retention |
|---|---|---|
| Daily snapshot | Once per day, off-peak | 30 days |
| Point-in-time recovery (if provider supports it) | Continuous WAL archiving | 7 days |

**HONEST NOTE:** these numbers are a reasonable industry-standard
starting point, not a number derived from this project's own
traffic/growth data (which doesn't exist yet — zero production
traffic has occurred). Revisit once real usage patterns exist.

## Restore procedure (PostgreSQL, `pg_dump`/`pg_restore` path)

```bash
# 1. Provision a fresh Postgres instance (or use the existing one if
#    the goal is restoring INTO a clean state, e.g. after corruption)
# 2. Restore the dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL" backup-YYYYMMDD-HHMMSS.dump
# 3. Verify migration state matches what the backup expects
npx prisma migrate status
# 4. Run the app's own readiness check to confirm connectivity
curl https://<your-deployment>/health/ready
```

## What this plan does NOT cover (real, separate decisions)

- **Actual backup automation being turned on** — this document
  describes the mechanism; someone with deploy access needs to
  actually schedule it on the real hosting provider once chosen.
- **Disaster recovery for a full regional outage** (multi-region
  failover) — no evidence this project has multi-region requirements
  yet; would be over-engineering to plan for now.
- **Backup encryption-at-rest specifics** — depends on which object
  storage provider is chosen; most (S3, GCS) encrypt by default, but
  this needs explicit confirmation once decided, not assumed here.
- **Testing this restore procedure against a real backup** — this
  document has NOT been executed end-to-end (no real database
  available in this sandbox, same standing limitation documented in
  `docs/release/SPRINT13_BLOCKED_BY_PRISMA.md`). The commands above
  are the standard, correct Postgres/Prisma commands for this
  scenario, but "written correctly" is not the same claim as "tested
  successfully" — that test is real, required work once a real
  database and a real backup exist.
