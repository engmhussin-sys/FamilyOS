# ABNY — STAGING DEPLOY PROCEDURE

**This is the only staging procedure.** Numbered, in order. If another document disagrees with this one about staging, this one wins. (`WINDOWS_RUN.md` is the only build procedure for the Android APK; the two do not overlap.)

Goal: get the current build onto the **staging** service, prove it is actually serving, and be able to put it back if it is not.

---

## READ THIS FIRST — THE INFRASTRUCTURE ALREADY EXISTS

Earlier versions of this document opened with "create a Railway account and a project". **That was wrong and it has been deleted.** The account exists, the project exists, PostgreSQL and Redis exist and are attached, and a service has been serving traffic for days.

What that changes for you:

| Previously said | Actually true |
|---|---|
| Create a Railway account | You have one |
| Create a project | It exists |
| Add PostgreSQL and Redis | Both exist and are reachable — measured, see §D |
| Nothing has ever been deployed | A service has been up for roughly 40 hours |
| Staging is the only environment | **A production service exists and is live** |

So this procedure is no longer "stand something up". It is: **point the pipeline at the staging service, and make certain it is not the production one.** That second half is the part with consequences, and it is why §3 exists and why the workflow refuses to run without it.

**The one thing still missing is a name.** The staging service's name and its URL have not been supplied. Everywhere below they appear as `<STAGING_SERVICE_NAME>` and `<STAGING_HOST>`. Nothing in this repository invents either one; you fill them in from your own Railway project.

---

## §D — WHAT WAS MEASURED ON PRODUCTION, AND WHEN

Recorded so the next reader knows the state of the live host **without probing it again**. All of it was observed over HTTPS on **2026-08-20**. Nothing here is inferred.

| Probe | Result |
|---|---|
| Host | `https://familyos-production-74ca.up.railway.app` |
| `GET /health/live` | `200` — `{"status":"ok"}` |
| `GET /health/ready` | `200` — `{"status":"ok","database":true,"redis":true}` — **PostgreSQL and Redis are both attached and reachable** |
| `GET /api/v1/system/diagnostics` | `200`, **answered anonymously** |
| — reported `version` | `0.1.0` |
| — reported `commit` | `null` — nobody could tell which build was running |
| — reported `environment` | `production` |
| — reported `uptimeSeconds` | `144753` (~40 h) |
| — reported unset config keys | `LOCATION_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `SENTRY_DSN`, `FIREBASE_SERVICE_ACCOUNT_JSON` |
| `GET /api/v1/system/readiness` | `503`, **also anonymous** |

**The owner has confirmed this host is PRODUCTION.** Nothing in this repository may deploy to it.

Four things follow from that table, and each is worth knowing before you touch anything:

1. **`commit: null` is now fixed going forward.** `apps/backend/Dockerfile` accepts `ARG GIT_COMMIT_SHA` and re-exports it as a runtime `ENV`; the deploy workflow additionally sets it as a Railway service variable from `github.sha`. Both reach the `process.env.GIT_COMMIT_SHA` that `SystemDiagnosticsController` already read. Production itself will keep reporting `null` until something deploys to it — which is not this pipeline's job.
2. **The `503` on `/api/v1/system/readiness` is not an outage.** `ANTHROPIC_API_KEY` is unset, so `ReadinessCheckService` marks the LLM Provider `NOT_READY`, and any `NOT_READY` component makes that route answer `503`. `/health/ready` — the route that actually gates traffic — is `200`. `CODE REVIEWED`.
3. **Those two `/api/v1/system/*` routes answered anonymously, but the source in this repository guards both** with `InternalAdminGuard` + `@PlatformAdminSurface()`. The only reading consistent with both facts is that **production is running an older build than `HEAD`**. Nothing is done about that here — `apps/backend/src/` is another owner's — but do not read the live host's behaviour as this codebase's behaviour.
4. **`SENTRY_DSN` is unset on production**, so no one is being paged for anything there. See `.env.staging.example` §4.

---

## §1 — The files this procedure uses

| File | What it is |
|---|---|
| `.github/workflows/deploy-staging.yml` | The only automated way to deploy. Runs the production interlock first, then the whole CI pipeline, and refuses to deploy unless both passed. |
| `apps/backend/Dockerfile` | The production image. Multi-stage; the final layer has no TypeScript, no Nest CLI, no test tooling; runs as a non-root user; `NODE_ENV=production`; accepts `ARG GIT_COMMIT_SHA`. **Build context is `apps/backend` — its own directory** (§7b). |
| `apps/backend/.dockerignore` | The deny list for that context: every `node_modules`, every build output, the test material, local state and secrets. It sits in the context because that is the only directory Docker reads it from. |
| `apps/backend/railway.json` | The backend service's host configuration: Dockerfile build, the pre-deploy migration, the `/health/ready` probe, one replica, restart on failure. Inside `apps/backend/` so that it configures the backend service and no sibling (§7b). |
| `render.yaml` | A complete alternative host, kept so "we are on Railway" stays a choice with a stated exit. `STATIC VERIFIED` only — no Render account exists. |
| `.env.staging.example` | Every variable the backend actually reads, each marked `OPERATOR MUST SUPPLY` or `SAFE DEFAULT`, each with what happens when it is missing. |

---

## §2 — What you set in GitHub

**Names only. No value from this table is ever written into this repository, echoed in a workflow log, or pasted into an issue.**

### Secrets — GitHub → Settings → Secrets and variables → Actions → *Secrets*

| Name | What it must be |
|---|---|
| `RAILWAY_TOKEN` | A Railway **project** token, scoped to the project holding the staging service. Never a personal account token — a personal token can reach every project you own, including the production one. |

### Variables — same page → *Variables*

| Name | What it must be |
|---|---|
| `RAILWAY_SERVICE_NAME` | The exact name of the **staging** service as it appears in your Railway project. Not the production service. Blank is not "safe" — blank makes `railway up` fall back to the project default, and the interlock refuses on blank for exactly that reason. |
| `STAGING_HEALTH_URL` | The absolute URL of the staging liveness probe: `https://<STAGING_HOST>/health/live`. It is polled after the deploy **and** it is half of the interlock's identity check, so it must name the same target as `RAILWAY_SERVICE_NAME`. |

### Application variables — Railway → the staging service → Variables

Everything marked `OPERATOR MUST SUPPLY` in `.env.staging.example` §1–§2. Read that file once before you start; it states, per variable, whether a missing value is `FATAL` (the process refuses to boot) or `WARNING` (it boots and is wrong in a specific named way).

Two notes that catch people:

- For `DATABASE_URL` and `REDIS_URL` use Railway's own **Add a Reference** picker rather than pasting a URL. It writes `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`, which keep working when the vendor rotates the credential.
- **Staging's `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `INTERNAL_ADMIN_API_KEY` must be different values from production's.** A token minted on staging must be worthless on the live host. Since a live host exists, this is no longer hypothetical hygiene.

Payments are **not** on any of these lists. Leave every payment variable empty: each adapter reports "not configured", throws a typed `503` rather than calling anything, and never returns `verified: true` for a signature it could not check. Empty is the safe state.

### The dashboard and the backend — why no line joins them, and what still must be set

Railway draws a line between two services when one **references the other's variables**. The backend references PostgreSQL and Redis, so those lines exist. **The dashboard has no line to the backend, and that is correct:** the dashboard is a React bundle. It never talks to the backend server-to-server — the *operator's browser* does, over the public internet, after the bundle is delivered to it.

So the absence of a line is not a missing connection. But two settings still have to be right, and **neither of them draws a line either**, which is exactly why they get missed:

| Where | Variable | Value |
|---|---|---|
| **Dashboard** service → Variables | `VITE_API_BASE_URL` | `https://<STAGING_BACKEND_HOST>/api/v1` |
| **Backend** service → Variables | `CORS_ALLOWED_ORIGINS` | `https://<STAGING_DASHBOARD_HOST>` |

Three things about that pair are worth stating, because each has its own failure that looks like something else:

1. **`/api/v1` is part of the URL, not decoration.** Without it every call 404s while the dashboard loads perfectly — a fault that reads like a broken backend and is a missing suffix. `apps/admin-dashboard/RUN.md` records this as the most common form of wrong.
2. **`VITE_API_BASE_URL` is read at BUILD time, not run time.** Vite substitutes `import.meta.env.*` into the bundle when it compiles. Changing it later does nothing until the dashboard is **redeployed** — the running bundle already has the old value baked in.
3. **An empty `CORS_ALLOWED_ORIGINS` means "no origin is allowed", not "all".** `main.ts` reads `process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? []` — the default is the empty list. The browser then blocks every call and the dashboard shows errors on every panel while the backend is entirely healthy. Use the dashboard's **origin only** — scheme and host, no path, no trailing slash.

**A better way to set the first one:** instead of pasting the backend's host, use a Railway reference so it cannot go stale:

```
VITE_API_BASE_URL = https://${{FamilyOS.RAILWAY_PUBLIC_DOMAIN}}/api/v1
```

That makes the dashboard genuinely reference the backend — so Railway **will** draw the line — and it keeps working if the backend's domain ever changes. Substitute your backend service's actual name for `FamilyOS` if it differs.

---

## §3 — CONFIRM THE TARGET IS STAGING, BEFORE THE FIRST RUN

**Do this before you press anything.** The pipeline will also check it, and will refuse — but the pipeline checks a value you typed, and this section is where you find out you typed the wrong one while it is still free.

### 3.1 — Read back what you actually set

In GitHub → Settings → Variables → Actions, read the two values **out loud**:

- `RAILWAY_SERVICE_NAME` — is this the staging service, character for character, as Railway spells it?
- `STAGING_HEALTH_URL` — is this host `familyos-production-74ca.up.railway.app`? **If yes, stop.** That is production. It is measured in §D and it is serving real traffic.

### 3.2 — Ask the host what it thinks it is

```bash
curl -s https://<STAGING_HOST>/health/ready
```

`200` with `"database":true,"redis":true` means *something* is there and healthy. It does **not** yet tell you which something. For that:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<STAGING_HOST>/api/v1/system/diagnostics
```

- **`401` / `403`** — the guard is in place; this host is running a build at or near `HEAD`. To read the body, send the `x-internal-admin-key` header with that host's own `INTERNAL_ADMIN_API_KEY`.
- **`200` with a body** — this host is running an older build (see §D note 3). Read `environment` and `uptimeSeconds` in the response. An `environment` of `production`, or an uptime measured in days on a service you believe you just created, means **you are looking at production**.

### 3.3 — Two different hosts, confirmed side by side

The single most reliable check is that staging and production are **not the same box**:

```bash
curl -s https://<STAGING_HOST>/health/ready
curl -s https://familyos-production-74ca.up.railway.app/health/ready
```

If `<STAGING_HOST>` is blank, unknown, or resolves to the production host, **you do not yet have a staging target and you must not run the deploy.** Get the staging service's name and generated domain out of the Railway project first.

### 3.4 — What the pipeline will do if you get it wrong

The workflow's first job is `interlock`, and it runs **before** the contract check, **before** CI, **before** the image is built, and therefore before `apps/backend/railway.json`'s `preDeployCommand` can execute a single migration. It refuses when:

| Rule | Fires when |
|---|---|
| `EMPTY_SERVICE` / `EMPTY_HEALTH_URL` | Either variable is unset or blank. Absence is never read as "not production". |
| `UNPARSEABLE_HEALTH_URL` | `STAGING_HEALTH_URL` is not an absolute `http(s)` URL with a hostname. |
| `KNOWN_PRODUCTION_HOST` | The health URL's host **is** `familyos-production-74ca.up.railway.app`. Compared after lowercasing and after stripping any port, trailing slash and trailing dot. |
| `KNOWN_PRODUCTION_LABEL` | The host's first DNS label is `familyos-production-74ca` — catches a custom domain pointed at the same deployment. |
| `SERVICE_IS_PRODUCTION` | `RAILWAY_SERVICE_NAME` contains that same production label. |
| `PRODUCTION_WORD_IN_SERVICE` / `PRODUCTION_WORD_IN_HEALTH_URL` | Either value contains `prod`, `prd`, `production` or `live` as a whole token. A secondary net, never the only one. |
| `TARGET_MISMATCH` | The service name and the health URL host do not describe the same target — so a green probe could not prove anything about the deploy that was just made. |

Then, inside the deploy job, it asserts once more that the values visible under `environment: staging` are **identical** to the ones it approved. A GitHub environment can define variables that shadow the repository-level ones, and that is precisely how a production value gets into a workflow that was checked against a staging one.

**Two traps worth knowing in advance:**

- **Railway names its default environment `production`** even for a service you think of as staging, so a generated domain can read `...-production-....up.railway.app` and trip `PRODUCTION_WORD_IN_HEALTH_URL`. From the pipeline's side that is indistinguishable from the real thing, so it refuses. **The fix is a Railway environment named `staging`, or a staging domain — not the override.**
- **A custom domain** whose first label does not contain the service name will trip `TARGET_MISMATCH`. Point `STAGING_HEALTH_URL` at the staging service's own generated `*.up.railway.app` domain, which always exists.

### 3.5 — The override, and why you should not be reading this line

There is an exit, because an interlock with no exit gets deleted by the first person who genuinely needs to deploy to production — and a deleted interlock protects nothing. It is deliberately awkward:

- The `override_production_interlock` input has **no default**, so nothing can carry it — not a re-run, not a saved form, not an inherited setting.
- The phrase must be `DEPLOY TO PRODUCTION <the exact hostname this run is pointed at>`. It is case-sensitive and whitespace-exact, so it cannot be copied from a colleague, from this document, or from a previous run against a different target. **You have to read the host you are about to overwrite and type it out.**
- `confirm` must simultaneously say `production` instead of `staging`. Two boxes have to agree that this is not a staging deploy.
- Supplying it when nothing was blocked is itself a failure, so it can never be left in the box "just in case".

If you are filling that box in to make a *staging* deploy work, **the target is wrong and the override is the wrong tool.** Fix the variables.

---

## §4 — The deploy

1. GitHub → **Actions** → **Deploy — staging** → *Run workflow*.
2. Type `staging` in the confirmation box.
3. Leave `override_production_interlock` **empty**.
4. Run it.

What happens, in order:

| # | Job | What it does |
|---|---|---|
| 1 | `interlock` | Refuses if the target looks like production (§3.4). Nothing has been built or touched yet. |
| 2 | `contract` | Checks that every secret and variable name the workflow uses is documented in `.env.staging.example`; that `apps/backend/railway.json` and `render.yaml` parse, name the same build context, and point at files that exist; and that the Dockerfile still accepts and exports `GIT_COMMIT_SHA`. |
| 3 | `ci` | **Calls** `ci.yml` — backend suites, the tenant-isolation and event-emission guards, the admin dashboard, both Flutter apps, the production image. Called, not copied: a second copy of the gates would drift, and the drifting copy is always the one guarding the deploy. Deploys only if it concluded `success`; a skipped or cancelled gate answered nothing. |
| 4 | `deploy` | Re-asserts the interlock against the environment-scoped values, stamps `GIT_COMMIT_SHA` onto the service, runs `railway up --detach`, then polls `STAGING_HEALTH_URL` for up to ten minutes and fails the run if it never answers `200`. |

**Where migrations run.** `prisma migrate deploy` runs as Railway's **pre-deploy step**, from the *same image* as the code, and must exit zero before the new version receives traffic — `apps/backend/railway.json`'s `preDeployCommand`. Not in the container's `CMD`, for three reasons in order of what they cost when ignored:

1. **A migration that races the app is a data problem.** In the entrypoint, every replica migrates at boot; Prisma's advisory lock keeps them from corrupting each other, but the instance that *loses* the race starts serving HTTP against a partly-applied schema, and the requests it answers wrongly are already gone by the time the migration finishes.
2. **A failed migration must fail the deployment, not the process.** In the entrypoint a bad migration is a crash-loop and the previous good version is already gone. As a pre-deploy step, a non-zero exit fails the deploy and **leaves the previous version serving**.
3. **The migration must be the one that belongs to the code.** The image carries `prisma/` and the Prisma CLI, copied from the builder and never fetched at deploy time, so the schema applied is exactly the one the compiled code was generated against.

**The privilege it needs.** Migration `0004_tenant_rls_defence_in_depth` runs `CREATE ROLE abny_app` (inside an `IF NOT EXISTS` guard) and `GRANT`s to it, so the user in `DATABASE_URL` must be allowed to create a role. Railway's `postgres` user is. If a provider's user is not, the migration stops with `permission denied to create role`; have a privileged user run `CREATE ROLE abny_app NOLOGIN;` once, after which the guard skips that statement and the rest applies. **Do not edit the migration.**

**If Railway rejects `preDeployCommand` from config-as-code:** set the same command — `npx prisma migrate deploy` — as the service's **Pre-Deploy Command** in Settings. Do not move it into the start command to make it run.

---

## §5 — Verify it actually worked

Run all four. Nothing below is "probably fine", and a green workflow run only proves the first one.

### 5.0 — The one command that runs 5.1 and 5.2 for you

```bash
scripts/deploy-doctor.sh   https://<STAGING_HOST> --key "$INTERNAL_ADMIN_API_KEY"   # macOS / Linux / CI
```
```powershell
.\scripts\deploy-doctor.ps1 https://<STAGING_HOST> -Key $env:INTERNAL_ADMIN_API_KEY  # Windows
```

Read-only. Prints `PASS` / `WARN` / `BLOCKED` per check and, when it is not `PASS`, one actionable line. Its last line is `DEPLOY VERIFIED` or `DO NOT SHIP`, so `| tail -1` is a usable gate.

**It answers one thing the manual curls below cannot: WHICH BUILD is serving, without a key.** `GET /api/v1/system/diagnostics` is behind `InternalAdminGuard` in the current code and was anonymous before it, so an unauthenticated call is a build fingerprint — `401` is current code, and `200`/`500`/`503` all mean an older build whose operator console is open to the internet. Measured on staging on 2026-08-21: `500` and `503`. See `حالة-النشر.md`.

**And one the deploy log cannot: WHICH SCHEMA.** `schema.appliedCount` / `schema.latestName` / `schema.unfinishedCount` come from `_prisma_migrations` on every call, so "the `preDeployCommand` never ran" and "a migration died half-way" both become rows in the output instead of a 500 three days later. `/health/ready` cannot see this — it asks whether Postgres answers `SELECT 1`, which a schema thirty migrations behind answers just as cheerfully.

The manual steps below remain the reference for what each check means, and 5.3/5.4 are not covered by the doctor.

### 5.1 — The health probes

```bash
curl -i https://<STAGING_HOST>/health/live
curl -i https://<STAGING_HOST>/health/ready
```

Expect `200` and `{"status":"ok"}` from the first; `200` with `"database":true,"redis":true` from the second. A `503` on `/health/ready` names which dependency is missing — that is the answer, not a failure of the check.

Both routes are deliberately excluded from the `api/v1` prefix (`src/common/http/global-pipeline.ts`), so they sit at the root and do not move when the API version does. The platform probe (`apps/backend/railway.json`) points at `/health/ready`; the Docker `HEALTHCHECK` inside the image uses `/health/live`. They ask different questions on purpose.

### 5.2 — Confirm you deployed what you think you deployed

```bash
curl -s -H "x-internal-admin-key: <STAGING_INTERNAL_ADMIN_API_KEY>" \
  https://<STAGING_HOST>/api/v1/system/diagnostics
```

`commit` should now be the sha the workflow ran on — **this is the check that was impossible before**, and it is the fastest way to catch "the deploy succeeded but the old image is still serving". If it is `null`, the stamping step logged a warning rather than failing the deploy; set `GIT_COMMIT_SHA` by hand in the service's variables.

`uptimeSeconds` should be small. A large value means nothing restarted, i.e. nothing deployed.

### 5.3 — A real account, created and used

```bash
curl -s -X POST https://<STAGING_HOST>/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"<your-test-email>","password":"<your-test-password>","fullName":"<your name>"}'

curl -s -X POST https://<STAGING_HOST>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<your-test-email>","password":"<your-test-password>"}'
```

A token pair in the second response proves three separate things in one call: the schema is applied, PostgreSQL is writable, and Argon2 works in the Alpine image.

On a fresh database no pilot cohort exists, so the controlled-pilot gate evaluates to "pilot disabled" and registration is allowed. Once you enable a cohort, registration requires an invite and this returns a typed refusal instead — that is the gate working, not a regression.

### 5.4 — The admin dashboard reaching it

```bash
cd apps/admin-dashboard
echo "VITE_API_BASE_URL=https://<STAGING_HOST>/api/v1" > .env.local
npm ci
npm run build
npm run preview           # serves on http://localhost:4173
```

**The `/api/v1` suffix is required** — every route except the two health routes is served under it.

Then set `CORS_ALLOWED_ORIGINS` on the staging service to the origin the dashboard is served from (`http://localhost:4173` for the command above) and redeploy so it picks the value up. An empty value allows **no** browser origin at all, which is safe: mis-setting it closes the dashboard out rather than opening a hole, and a wrong value shows up as a browser CORS error, never as a silent success.

Sign in with the account from §5.3. Panels render, and no request in the network tab is a CORS error or a `404` on a path missing `/api/v1`. The growth pages will additionally ask for the internal admin key — paste staging's `INTERNAL_ADMIN_API_KEY` into the unlock screen. It is held in memory only: never `localStorage`, never a cookie, never the URL, never built into the bundle.

---

## §6 — Rollback

### 6.1 — Read this before you roll anything back

**Redeploying the previous image does not undo a migration.** `prisma migrate deploy` is forward-only; it has no `down` step. If the failed deploy applied a schema change, rolling the *code* back leaves the *new* schema in place, and the older code then runs against a schema it was never compiled for.

So decide which of these you are in **before** you touch anything:

| Situation | Rollback |
|---|---|
| The deploy failed **during** the pre-deploy migration | Nothing to roll back. The migration failed, so the new version never received traffic and the previous one is still serving. Read the Railway deploy log, fix forward. |
| The deploy succeeded and **no migration ran** in it | §6.2 is clean and complete. |
| The deploy succeeded and **a migration did run** | §6.2 restores the code but **not** the schema. Read §6.3 first. |

To find out which, open the Railway deployment's log and look at the pre-deploy step: `prisma migrate deploy` prints either `No pending migrations to apply.` or the name of each migration it applied.

### 6.2 — Put the previous version back

**Preferred — redeploy the previous deployment in Railway.** Railway keeps deployment history for the service; select the last known-good deployment and redeploy it. This reuses an image that already built and already booted, so it is the fastest path back and it does not depend on GitHub.

**Alternative — re-run the pipeline on a known-good commit.** GitHub → Actions → **Deploy — staging** → *Run workflow*, and select the tag or branch pointing at the last good commit. Slower, because it re-runs every CI gate, but it goes through the same interlock and leaves the same audit trail as any other deploy. Use this when you want the rollback itself gated.

Then re-run §5.1 and §5.2. `commit` in the diagnostics response must be the sha you rolled back **to** — that is how you know the rollback took, and it is the second thing the build stamp bought you.

### 6.3 — When a migration is in the way

Do **not** hand-edit `_prisma_migrations` and do **not** hand-write a reverse migration under pressure. In order of preference:

1. **Fix forward.** Almost always correct on staging. A new migration that corrects the previous one keeps the history linear and keeps every environment reproducible.
2. **Restore the database from the vendor's backup**, then redeploy the matching image. This is the only option that genuinely returns both schema and data to a known state. It loses everything written since the snapshot — acceptable on staging, and the reason §5.3 uses a disposable test account.
3. **Recreate the staging database from empty** and let `prisma migrate deploy` build it from the full history. Staging holds no data worth keeping unless you deliberately put some there.

Options 2 and 3 are staging answers. Neither is written here as a production procedure, and this pipeline cannot reach production anyway.

---

## §7 — Demo data on staging

`npm run seed:demo` **refuses any database whose host is not obviously local**, by design, before it opens a connection. That refusal is correct and must not be worked around casually: the seed writes roughly five thousand synthetic rows, there is no delete phase, and four of the tables it touches are append-only by database privilege. Seeding the wrong database is the one unrecoverable mistake available here — and a production database now exists to make that mistake against.

In order of preference:

**A. Do not seed staging at all.** Register a handful of households through the app the way a pilot family will. It is the only option that proves the registration path, and the dashboard's empty state is honest, not broken.

**B. If you need the demo dataset, restore it — do not re-run the seed against staging.**

```bash
# locally, with docker-compose up running
cd apps/backend && npm run seed:demo
pg_dump --no-owner --no-acl "postgresql://afdc:afdc_dev_password@localhost:5432/afdc_dev" > /tmp/demo.sql
psql "<staging DATABASE_URL>" -f /tmp/demo.sql
```

The guard is never bypassed and the data is identical.

**C. Only if B is impractical**, the escape hatch the script itself provides, typed out in full with `DATABASE_URL` set to staging:

```bash
cd apps/backend && npm run seed:demo -- --force-non-local
```

Before you press enter, confirm all three: the URL is staging and **not** the production one; the database contains no real household; and staging's `INTERNAL_ADMIN_API_KEY` and JWT secrets are different values from production's. The script prints the host it is about to write to and warns there is no undo. That warning is the point of the flag.

**Never do this:** tunnel the staging database to `localhost` so the guard sees a local host. That defeats a safety check by making it lie, and the next person to do it will be doing it to production.

**Treat a seeded staging as disposable.** The demo accounts use a published password and `@demo-seed.invalid` addresses on an internet-reachable host. Drop and recreate the staging database before any real pilot cohort touches it.

---

## §7b — TROUBLESHOOTING: build failures seen on a real Railway build

### THE LAYOUT THIS EXPECTS

The backend is **self-contained in `apps/backend`**. Its build context is that directory, its host config is `apps/backend/railway.json`, and its context filter is `apps/backend/.dockerignore`. Every `COPY` in `apps/backend/Dockerfile` is relative to that directory — `COPY src ./src`, not `COPY apps/backend/src ./src`. Nothing outside `apps/backend/` is needed to build the image.

Settings on the **backend** service (Railway → the service → Settings), with the environment picker on **staging**:

| Setting | Value |
|---|---|
| Source → **Root Directory** | `apps/backend` |
| Build → **Config-as-code** | `railway.json` — it resolves *inside* the Root Directory, i.e. `apps/backend/railway.json` |
| Builder | Dockerfile. `railway.json` says `"dockerfilePath": "Dockerfile"` — the file beside it |

Sibling services (`familyos-dashboard` and anything added later) keep their own Root Directory and their own config. A config file inside `apps/backend` cannot be picked up as any other service's config by accident, which is the whole point of putting it there.

**The short history, so nobody re-does it.** A `railway.json` at the **repository root**, naming `apps/backend/Dockerfile`, was tried first. A root config is not service-specific: the `familyos-dashboard` service (Root Directory `apps/admin-dashboard`) picked it up on 2026-08-20, loaded the backend's Dockerfile, and failed every `COPY` — six builds, because `apps/backend/src` does not exist inside `apps/admin-dashboard/`. The config was moved into `apps/backend/` and the Dockerfile rewritten for that context. If the dashboard service still has a config-as-code path pointing at the old root file: Settings → **Config-as-code** → clear it (or point it at one of its own). It stayed `Online` and serving throughout — a failed build never replaces a running deployment.

---

### THE DIAGNOSTIC TELL — worth memorising

```
[inf]  load build definition from …/Dockerfile     <- SUCCEEDS
[err]  COPY package.json …                         <- fails
[err]  COPY prisma  ·  COPY src                    <- fails
Build Failed: failed to compute cache key: "/src": not found
```

**A Dockerfile that loads while every one of its COPYs misses means the Dockerfile and the context came from two different directories.** It is never a fault in the COPY lines, and never a missing source file. Note also that the named path *changes between attempts* (`src`, then `prisma`, then back): buildkit evaluates COPY steps in parallel and reports whichever lost the race, so "one path is missing" is really "all of them are".

When you see it, check in this order:

1. **Root Directory** — Settings → Source. It must be `apps/backend`. If it is `/`, the context is the repository root and the COPYs miss by one path segment in the other direction.
2. **Config-as-code** — Settings → Build. The path is resolved inside the Root Directory. A path that reaches outside it (`../`, or a leading `/`) is the failure this migration removed.
3. **Which service you are actually editing** — the build log does not name it. A misconfigured sibling produces exactly this signature.
4. **Whether the migration step runs at all.** A successful build that never runs `npx prisma migrate deploy` means `railway.json` was not read — the build fell back to auto-detection. A build that succeeds while the schema is never applied is worse than a clean failure.

**Do not answer this by rewriting COPY paths.** One context is named in five places that agree — `apps/backend/Dockerfile`, `apps/backend/railway.json`, `apps/backend/.dockerignore`, `render.yaml` (`dockerContext: ./apps/backend`), `docker-compose.yml` — plus CI's `docker build … apps/backend`. Reshaping the Dockerfile for a different context breaks all of them at once. Change the setting, or change all six deliberately.

### If the log does not tell you enough: the probe

`apps/backend/Dockerfile.context-probe` copies the **whole context** and lists it, instead of failing on one path. Point the service's Dockerfile path at `Dockerfile.context-probe`, deploy (it fails on purpose, which is how the output survives in the log), read the blocks, then set the path back to `Dockerfile`. Its header explains how to read every outcome.

### Which service did that build run against?

The build log does not name the service. **Before redeploying, confirm the target** — §3 above is how to prove it is not production (`familyos-production-74ca.up.railway.app`). A failed build is harmless: nothing deployed, no migration ran, the live host kept serving. But the next attempt will succeed, and it should succeed against staging.

---

## §8 — What is still unknown until a real deploy runs

Stated plainly, because the rest of this document is confident and this part is not.

- **The subdirectory layout is `STATIC VERIFIED`, not `BUILD VERIFIED`.** `apps/backend` as the single build context is named identically in `apps/backend/Dockerfile`, `apps/backend/railway.json`, `render.yaml`, `docker-compose.yml` and CI, and every COPY source was listed and confirmed to exist inside `apps/backend/`. What no one here can prove is how Railway resolves the config file and the Dockerfile path against a service's Root Directory — that takes one real build. If it comes back wrong, §7b's tell says which of the two moved.
- **The image has never been built here.** No Docker daemon exists in the environment this was written in. Paths, stages, the non-root user, the entrypoint and the new `GIT_COMMIT_SHA` argument are `STATIC VERIFIED` by reading. CI's `docker` job builds it on every push — that job is where `BUILD VERIFIED` comes from, not from here.
- **The interlock's logic is `STATIC VERIFIED` by execution, its wiring is `NOT TESTED`.** The decision script was extracted and run against twenty crafted inputs — blank variables, a trailing slash, a trailing dot, a port, uppercase, a renamed service, a custom domain over the production label, a mismatched pair, and six override permutations — and refused every one it should. What has never run is the *workflow* around it: that `vars.*` arrive as expected and that the environment-scope assertion behaves on a real `environment: staging`. The first run is the proof.
- **`railway variables --set` is `NOT TESTED`.** The commit-stamping step is `continue-on-error` on purpose: a deploy must not be lost because a diagnostic label could not be written. If the CLI in use does not support that flag, the step warns and `commit` stays `null` until you set the variable by hand.
- **No migration has ever run against this managed PostgreSQL from this pipeline.** `CREATE ROLE` in migration `0004` is the first statement likely to meet a permission a local Postgres never enforced.
- **`render.yaml` has never been parsed by Render.** Valid YAML, every path in it exists; whether `preDeployCommand` is accepted in the exact shape written is unverified, and it needs a paid instance type or Render ignores it — which would mean migrations silently never run.
- **Region latency to Egypt and Saudi Arabia is `NOT TESTED`.** No vendor here has a Middle East region; Amsterdam is the closest available. Measure it from a device on a real Egyptian or Saudi network rather than believing a number:
  ```bash
  curl -o /dev/null -s -w 'connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
    https://<STAGING_HOST>/health/live
  ```
- **Redis under real concurrency is `NOT TESTED`** — the throttler store and the scheduler's job leases have only ever run against a local Redis.
- **Push delivery is `NOT TESTED`** and stays that way until a real Firebase service account is set. `FIREBASE_SERVICE_ACCOUNT_JSON` is unset on production, so no push has ever left that host either.
- **Payments are `BLOCKED — HUMAN DECISION`.** Merchant onboarding is 4–8 weeks and starts with a human, not a deploy.
- **Uploaded evidence is ephemeral** unless `EVIDENCE_STORAGE_ROOT` points at a mounted volume. On a container host every child-uploaded file disappears on the next deploy.
- **The production host is running an older build than `HEAD`** (§D note 3), so its behaviour is not this codebase's behaviour. Bringing it up to date is not this pipeline's job and this pipeline cannot do it.

No percentage is given here, and none should be. The list above is the whole of what a first deploy will teach you.
