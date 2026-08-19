# ABNY — STAGING DEPLOY PROCEDURE

**This is the only staging procedure.** Numbered, in order. If another document disagrees with this one about staging, this one wins. (`WINDOWS_RUN.md` is the only build procedure for the Android APK; the two do not overlap.)

Goal: the backend, its PostgreSQL and its Redis running on a host you own, reachable over HTTPS, with the schema migrated before the first request is served — and the admin dashboard talking to it.

**What is already done, and what is not.** Everything in this repository that a staging deploy needs is written, checked in and readable: the image, the migration step, the health probes, both host configurations, the variable list and the pipeline. `STATIC VERIFIED`. What is missing is an account: no cloud project exists, so nothing here has ever been built by a real builder or run by a real host. Every step below is written to be executed by you, once, in your own account.

---

## STEP 0 — What you must create in your own account, before STEP 1

Nothing here can be created from this repository. Do these first; each takes minutes except where noted.

| # | What | Where | Why it is needed |
|---|---|---|---|
| 1 | A **Railway account** and one **project**, named for staging | railway.com | The host. See §2 for why this one. |
| 2 | A **PostgreSQL** database inside that project | Railway → New → Database → PostgreSQL | `DATABASE_URL`. Managed, backed up by the vendor, not by you. |
| 3 | A **Redis** instance inside that project | Railway → New → Database → Redis | `REDIS_URL`. Not optional — the throttler store, the scheduler's job leases and the readiness probe all use it. |
| 4 | A **Railway project token** | Railway → project → Settings → Tokens | The pipeline deploys with it. A *project* token, never a personal account token. |
| 5 | **Two JWT secrets**, generated locally | `openssl rand -hex 32`, twice | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`. Must differ from each other and from production's. |
| 6 | **One location key**, generated locally | `openssl rand -base64 32` | `LOCATION_ENCRYPTION_KEY`. Generate once and keep it: changing it makes already-encrypted rows unreadable. |
| 7 | **One internal admin key**, generated locally | `openssl rand -hex 32` | `INTERNAL_ADMIN_API_KEY`. You will paste it into the dashboard's unlock screen at runtime; it is never built into the bundle. |
| 8 | *(optional)* A **Sentry** project → its DSN | sentry.io | Without it you learn about a staging crash from a person, not from a tool. |
| 9 | *(optional)* A **Firebase** service-account JSON | Firebase console | Without it push sends are logged no-ops and a push test on staging proves nothing. |
| 10 | GitHub repository **secrets and variables** | GitHub → Settings → Secrets and variables → Actions | `RAILWAY_TOKEN` (secret); `RAILWAY_SERVICE_NAME`, `STAGING_HEALTH_URL` (variables). |

Payments (Paymob, Fawry, Moyasar, Apple, Google) are **not** on this list. Leave every one of those variables empty: each adapter reports "not configured", throws a typed 503 rather than calling anything, and never returns `verified: true` for a signature it could not check. Empty is the safe state.

The complete variable list, with what each does when it is missing, is **`.env.staging.example`**. Read it once before STEP 3.

---

## §1 — The files this procedure uses

| File | What it is |
|---|---|
| `apps/backend/Dockerfile` | The production image. Multi-stage; the final layer has no TypeScript, no Nest CLI, no test tooling; runs as a non-root user; `NODE_ENV=production`. **Build context is the repository root.** |
| `.dockerignore` | Keeps the two Flutter apps, the dashboard, every `node_modules` and every build output out of that context. |
| `railway.json` | The primary host's configuration: Dockerfile build, the pre-deploy migration, the health probe, one replica, restart on failure. |
| `render.yaml` | The alternative host, complete, so the choice in §2 has an exit. |
| `.env.staging.example` | Every variable the backend actually reads, each marked `OPERATOR MUST SUPPLY` or `SAFE DEFAULT`. |
| `.github/workflows/deploy-staging.yml` | The only automated way to deploy. Runs the whole CI pipeline first and refuses to deploy unless it passed. |

---

## §2 — The host, chosen: **Railway**. And the one alternative.

Railway is also what this repository already assumed — `docker-compose.yml` and `main.ts` both name it — so this is a decision confirmed, not a decision reopened.

| Criterion | Railway (chosen) | Render (alternative, `render.yaml`) | Fly.io (rejected) |
|---|---|---|---|
| **Managed PostgreSQL** | Yes, one click, in the same project. Its user is a superuser, which matters here: migration `0004` executes `CREATE ROLE abny_app` and `GRANT`s to it. A restricted managed user cannot do that and the deploy stops on the migration. | Yes. Whether its default user may `CREATE ROLE` is **not verified** — if it cannot, §5's fallback applies. | Postgres on Fly is *unmanaged* — you run and back it up yourself. Wrong shape for a two-person team. |
| **Managed Redis** | Yes, same project, one click. | Yes (Key Value). | No first-party managed Redis; you attach a third party. |
| **Persistent worker** | The Outbox relay and the scheduler run **inside** the API process (`main.ts` starts both), so no separate worker service is needed on any host — but the host must not sleep the container. Railway does not idle a service with a health check. | Same, with the same caveat; a free instance sleeps and must not be used. | Fly scales machines to zero by default — the relay would stop with it. |
| **Cost at pilot scale** | Usage-based on top of a small monthly minimum; one small API container, one small Postgres, one small Redis. | Fixed monthly per instance and per database. | Cheapest raw compute, but the operational cost of self-run Postgres dwarfs it. |
| **Region latency to Egypt / Saudi Arabia** | **No vendor here has a region in Egypt or the Gulf.** Railway's EU West (Amsterdam) is the closest available. | Frankfurt — equivalent in practice. | Frankfurt/Paris; also no Gulf region. |
| **Handing over to a real ops team** | The whole deployment is four files in this repository; a team that wants to leave takes the same Dockerfile to ECS, Cloud Run or Kubernetes unchanged. `railway.json` is the only Railway-specific file. | Same property; `render.yaml` is the only Render-specific file. | Fly's `fly.toml` plus self-run Postgres is the hardest of the three to hand over. |

**The latency sentence, honestly.** Neither vendor has a Middle East region. Amsterdam and Frankfurt are the closest available to Cairo and Riyadh, and the actual round-trip from a phone on an Egyptian or Saudi mobile network is **`NOT TESTED`** — measure it in STEP 9 rather than believing a number. If it turns out to matter, the exit is the same either way: the image is portable, and a move to a provider with a Gulf region changes one config file.

**Why keep `render.yaml` at all.** So "we are on Railway" stays a choice. It is complete, it is reviewed, and it is `STATIC VERIFIED` — no Render account exists to parse it. Read its header before the first sync: two things in it (the Key Value service type name, and `preDeployCommand` needing a paid instance type) are the ones most likely to differ from your account.

---

## STEP 3 — Create the service and set the variables

1. Railway → your staging project → **New → GitHub Repo** → this repository → branch `abny/sprint-f1-unblock` (or `main` once merged).
2. **Leave the service's Root Directory empty.** The Dockerfile builds from the repository root; `railway.json` names it. Setting a root directory breaks that.
3. Service → **Settings → Region → EU West (Amsterdam)**.
4. Service → **Variables**. Add every variable marked `OPERATOR MUST SUPPLY` in `.env.staging.example` §1–§2. For the two connection strings use Railway's own reference picker (the "Add a Reference" button) rather than pasting a URL by hand — it writes `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`, which keep working when the vendor rotates the credential.
5. Do **not** set `PORT`. Railway injects it; `main.ts` falls back to 3000 when it is absent.
6. Leave `CORS_ALLOWED_ORIGINS` until STEP 8 — you will not know the dashboard's origin before then. An empty value allows **no** browser origin, which is safe and is why the dashboard cannot reach the API until you set it.

---

## STEP 4 — First deploy

From your machine, at the repository root:

```bash
npm i -g @railway/cli
railway login
railway link            # pick the staging project and the service you just created
railway up              # uploads this checkout, builds it with apps/backend/Dockerfile
```

Watch the build log to the end. The image build is the first real proof that any of this works.

After it is live, take the public domain Railway assigns (Settings → Networking → Generate Domain) and keep it; every URL below is `https://<that domain>`.

---

## STEP 5 — Migrations: where they run, and why there

`prisma migrate deploy` runs as the **pre-deploy step**, from the *same image* as the code, and it must exit zero before the new version receives any traffic. That is `railway.json`:

```json
"preDeployCommand": ["npx prisma migrate deploy"]
```

and, on the alternative host, `render.yaml`'s `preDeployCommand`.

**Why not in the container's start command.** Three reasons, in order of how much they cost when ignored:

1. **A migration that races the app is a data problem, not a convenience problem.** With migrations in the entrypoint, every replica starts migrating at boot. Prisma's advisory lock serialises them so they do not corrupt each other — but the instance that *loses* the race starts serving HTTP against a schema that is only partly applied, and the requests it answers wrongly are already gone by the time the migration finishes.
2. **A failed migration must fail the deployment, not the process.** In the entrypoint, a bad migration is a crash-loop: the platform restarts the container, the migration fails again, and the previous good version is already gone. As a pre-deploy step, a non-zero exit fails the deploy and **leaves the previous version serving**.
3. **The migration must be the one that belongs to the code.** The image carries `prisma/` and the Prisma CLI (copied from the builder, pinned, never fetched at deploy time), so the schema applied is exactly the schema the compiled code was generated against.

**If Railway's config-as-code rejects `preDeployCommand`:** set the same command — `npx prisma migrate deploy` — as the service's **Pre-Deploy Command** in Settings. Do not move it into the start command to make it run.

**The privilege it needs.** Migration `0004_tenant_rls_defence_in_depth` runs `CREATE ROLE abny_app` (inside an `IF NOT EXISTS` guard) and `GRANT`s to it. The database user in `DATABASE_URL` must be allowed to create a role. Railway's `postgres` user is. If a different provider's user is not, the migration stops with `permission denied to create role`; the fix is to have a privileged user create the role once —

```sql
CREATE ROLE abny_app NOLOGIN;
```

— after which the migration's guard skips that statement and the rest applies. Do not edit the migration.

---

## STEP 6 — The health endpoints (already wired; verify, do not build)

Two routes, both served by `HealthController`, both **deliberately excluded from the `api/v1` prefix** (`src/common/http/global-pipeline.ts`), so they sit at the root and do not move when the API version does.

| Route | Answers | Auth | Body |
|---|---|---|---|
| `GET /health/live` | "the process is up" — never touches PostgreSQL or Redis, so a slow database cannot get a healthy process killed | none | `{"status":"ok"}` |
| `GET /health/ready` | "this instance can serve" — checks PostgreSQL and Redis, **503** when either is down | none | `{"status":"ok"\|"degraded","database":bool,"redis":bool}` |

`railway.json` and `render.yaml` point the platform probe at **`/health/ready`**, so a container that cannot reach its database never receives traffic. The Docker `HEALTHCHECK` inside the image uses `/health/live` — the two are asking different questions on purpose.

**Anonymous, and it leaks nothing.** `CODE REVIEWED`: the controller has no guard, so a probe that cannot authenticate can reach it; and the response bodies contain no version, no environment name, no build, no connection string, no stack trace — two booleans and a status word.

> **Reported, not fixed, because it is another owner's file:** `GET /api/v1/system/diagnostics` is also anonymous and *does* return the version, the commit, `NODE_ENV`, uptime, memory and the feature-flag list. That is a hardening decision for whoever owns `apps/backend/src/`; it does not affect the health probes above.

**One thing to keep in mind:** the global throttler allows 100 requests per minute per IP. A probe every 10–30 seconds is nowhere near it. A probe every second is.

---

## STEP 7 — Deploying from the pipeline afterwards

After the first manual `railway up`, deploy through GitHub so that nothing reaches staging without passing the gates.

1. GitHub → Actions → **Deploy — staging** → *Run workflow*.
2. Type `staging` in the confirmation box.

What that run does, in order: refuses to continue unless you typed the word; checks that every secret name it uses is documented in `.env.staging.example` and that the deploy configs parse and point at files that exist; **calls the entire CI workflow** — backend suites, tenant-isolation and event-emission guards, admin dashboard, both Flutter apps, the production image — and deploys only if it concluded `success`; then polls `STAGING_HEALTH_URL` until it answers 200, and fails the run if it never does.

The gates are *called*, not copied. A second copy of them would drift, and the drifting copy is always the one guarding the deploy.

---

## STEP 8 — Point the admin dashboard at staging

The dashboard is a static bundle and does not have to be hosted to test it.

```bash
cd apps/admin-dashboard
echo "VITE_API_BASE_URL=https://<your-staging-domain>/api/v1" > .env.local
npm ci
npm run build
npm run preview           # serves on http://localhost:4173
```

**The `/api/v1` suffix is required.** Every route except the two health routes is served under that prefix.

Then, in Railway, set `CORS_ALLOWED_ORIGINS` to the origin the dashboard is served from — `http://localhost:4173` for the command above — and redeploy the service so it picks the value up. An empty value allows no origin at all; a wrong value shows up as a browser CORS error, never as a silent success.

The dashboard's growth pages will additionally ask for the internal admin key. Paste the `INTERNAL_ADMIN_API_KEY` you generated in STEP 0 into the unlock screen. It is held in memory only — never `localStorage`, never a cookie, never the URL, and never built into the bundle.

---

## STEP 9 — Verify staging is actually up

Run all four. Nothing below is "probably fine".

**1. Liveness and readiness**

```bash
curl -i https://<your-staging-domain>/health/live
curl -i https://<your-staging-domain>/health/ready
```

Expect `200` and `{"status":"ok"}` from the first. Expect `200` with `"database":true,"redis":true` from the second. A `503` here names which dependency is missing — that is the answer, not a failure of the check.

**2. A real account, created and used**

```bash
curl -s -X POST https://<your-staging-domain>/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"<your-test-email>","password":"<your-test-password>","fullName":"<your name>"}'

curl -s -X POST https://<your-staging-domain>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<your-test-email>","password":"<your-test-password>"}'
```

A token pair in the second response means the schema is applied, PostgreSQL is writable and Argon2 works in the Alpine image — three separate things proven by one call.

On a fresh database no pilot cohort exists, so the controlled-pilot gate evaluates to "pilot disabled" and registration is allowed. Once you enable a cohort, registration requires an invite and this call returns a typed refusal instead — that is the gate working, not a regression.

**3. The dashboard, in a browser.** Sign in at `http://localhost:4173` with the account above. Panels render, and no request in the network tab is a CORS error or a 404 on a path missing `/api/v1`.

**4. Latency, measured rather than assumed** — from a device on an Egyptian or Saudi network, not from your laptop:

```bash
curl -o /dev/null -s -w 'connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  https://<your-staging-domain>/health/live
```

Write the number down. It is the first real data point about the region choice in §2.

---

## STEP 10 — Demo data on staging: the deliberate answer

`npm run seed:demo` **refuses any database whose host is not obviously local**, by design, before it opens a connection. That refusal is correct and must not be worked around casually — the seed writes roughly five thousand synthetic rows, there is no delete phase, and four of the tables it touches are append-only by database privilege. Seeding the wrong database is the one unrecoverable mistake available here.

So staging needs a different, deliberate answer. In order of preference:

**A. Do not seed staging at all.** Register a handful of real households through the app, the way a pilot family will. This is the only option that proves the registration path, and it is the recommended default. The dashboard's empty state is honest, not broken.

**B. If you need the demo dataset, restore it — do not re-run the seed against staging.** Seed a local database (where the guard is satisfied honestly), then move the result:

```bash
# locally, with docker-compose up running
cd apps/backend && npm run seed:demo
pg_dump --no-owner --no-acl "postgresql://afdc:afdc_dev_password@localhost:5432/afdc_dev" > /tmp/demo.sql
psql "<staging DATABASE_URL>" -f /tmp/demo.sql
```

The guard is never bypassed and the data is identical.

**C. Only if B is impractical**, the escape hatch the script itself provides, typed out in full and run with `DATABASE_URL` set to staging:

```bash
cd apps/backend && npm run seed:demo -- --force-non-local
```

Before you press enter, confirm all three: the URL is staging and not production; the database contains no real household; and staging's `INTERNAL_ADMIN_API_KEY` and JWT secrets are different values from production's. The script prints the host it is about to write to and warns that there is no undo. That warning is the point of the flag.

**Never do this:** tunnel the staging database to `localhost` so the guard sees a local host. That defeats a safety check by making it lie, and the next person to do it will be doing it to production.

**And treat a seeded staging as disposable.** The demo accounts use a published password and `@demo-seed.invalid` addresses, on an internet-reachable host. Drop and recreate the staging database before any real pilot cohort touches it.

---

## §11 — What is still unknown until a real deploy runs

Stated plainly, because the rest of this document is confident and this part is not:

- **The image has never been built.** No Docker daemon exists in the environment this was written in. Paths, stages, the non-root user and the entrypoint are `STATIC VERIFIED` by reading. CI's `docker` job builds it on every push — that job is where `BUILD VERIFIED` will come from, not from here.
- **`npx prisma generate` is broken in that same sandbox** by an offline WASM shim. It is correct for a real builder and was deliberately left alone rather than worked around.
- **No migration has ever run against a managed PostgreSQL.** `CREATE ROLE` in migration `0004` is the first statement likely to meet a permission a local Postgres never enforced.
- **`railway.json` and `render.yaml` have never been parsed by their vendors.** Both are valid JSON/YAML and every path in them exists; whether `preDeployCommand` is accepted in the exact shape written is unverified. §5 gives the fallback.
- **Region latency to Egypt and Saudi Arabia is `NOT TESTED`.** STEP 9's fourth check is the first measurement.
- **Redis under real concurrency is `NOT TESTED`** — the throttler store and the scheduler's job leases have only ever run against a local Redis.
- **Push delivery is `NOT TESTED`** and stays that way until a real Firebase service account is set.
- **Payments are `BLOCKED — HUMAN DECISION`.** Nothing on staging changes that; merchant onboarding is 4–8 weeks and starts with a human, not a deploy.
- **Uploaded evidence is ephemeral** unless `EVIDENCE_STORAGE_ROOT` points at a mounted volume. On a container host, every child-uploaded file disappears on the next deploy.

No percentage is given here, and none should be. The list above is the whole of what a first deploy will teach you.
