# Run the ABNY admin dashboard locally

Windows or macOS. Copy-paste, top to bottom, once. About 10 minutes the first time.

You need: **Docker Desktop** (running) and **Node.js 20 or newer** (`node -v` to check).

Three terminals at the end: infrastructure, backend, dashboard.

---

## 1. Start PostgreSQL and Redis

From the repository root (`FamilyOS/`):

```bash
docker compose up -d postgres redis
```

Check both are healthy before continuing:

```bash
docker compose ps
```

Both rows should say `healthy`. If Postgres says `starting`, wait 10 seconds and run it again.

---

## 2. Configure the backend

Create `apps/backend/.env` from the template:

**macOS**

```bash
cp apps/backend/.env.example apps/backend/.env
```

**Windows (PowerShell)**

```powershell
Copy-Item apps\backend\.env.example apps\backend\.env
```

Now open `apps/backend/.env` and set these five values. Everything else in that
file can stay empty — the app boots without payment, AI or push credentials.

```ini
DATABASE_URL="postgresql://afdc:afdc_dev_password@localhost:5432/afdc_dev?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_ACCESS_SECRET="<paste secret 1 — at least 32 characters>"
JWT_REFRESH_SECRET="<paste secret 2 — different from secret 1>"
INTERNAL_ADMIN_API_KEY="<paste secret 3 — this is the operator key>"
```

The backend refuses to start if the two JWT secrets are missing, shorter than
32 characters, or identical. That is deliberate.

### Generating the three secrets

**macOS** — run three times, paste one value each:

```bash
openssl rand -hex 32
```

**Windows (PowerShell)** — run three times:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

> `INTERNAL_ADMIN_API_KEY` is the operator key you will type into the dashboard
> in step 6. Keep it somewhere you can copy from. Change it and every operator
> has to be told the new one — nothing else breaks.
>
> If you leave `INTERNAL_ADMIN_API_KEY` empty, every platform screen is refused
> for everyone. That is the intended behaviour: an unset secret means "closed",
> never "open to all".

---

## 3. Create the database tables

```bash
cd apps/backend
npm install
npm run prisma:generate
npx prisma migrate deploy
```

Run this again after any `git pull` that adds a migration.

---

## 4. Start the backend

Same folder (`apps/backend`), and **leave this terminal running**:

```bash
npm run start:dev
```

Wait for `Nest application successfully started`. Confirm it in a browser:
<http://localhost:3000/health/live>

---

## 5. Start the dashboard

A **second terminal**, from the repository root:

```bash
cd apps/admin-dashboard
npm install
```

Create `apps/admin-dashboard/.env.local` containing one line:

```ini
VITE_API_BASE_URL=http://localhost:3000
```

Then, leaving this terminal running:

```bash
npm run dev
```

Open <http://localhost:5173>.

---

## 6. Sign in, then unlock

1. **Create an account.** Go to <http://localhost:5173/register> and register.
   This is an ordinary parent sign-in and it is what gets you into the app.
2. **Open a business screen** — «النمو والتجارة» in the side rail, e.g.
   <http://localhost:5173/growth>.
3. **Enter the operator key.** The unlock screen asks for it: paste the exact
   value you put in `INTERNAL_ADMIN_API_KEY` in step 2, and press
   «فتح اللوحة».

About that key:

- It is held **in memory only**. It is never written to browser storage, never
  put in the URL, and it disappears the moment you reload the page or close the
  tab. Re-entering it is expected, not a bug.
- If the server refuses it, the dashboard discards it immediately and returns to
  the unlock screen. Check for a stray space or newline at the end of the value
  in `.env`, then restart the backend so it re-reads the file.
- «إقفال اللوحة» in the header wipes it on purpose.

---

## What you should see on a fresh database

Empty. **«لا توجد بيانات بعد» is the correct answer, not an error** — nothing
has registered, converted or paid yet, and this dashboard prints an em dash
rather than inventing a zero. Panels that show an amber
«لا يوجد endpoint لهذا الرقم بعد» box are naming a number no backend route
serves yet; that box is the truth, and it stays until the route exists.

---

## 7. Optional — fill the dashboard with demo data

An empty dashboard is honest but it cannot tell you whether anything *works*,
and you cannot show it to anyone. One command fills your local database with a
made-up but realistic set of families so every panel has real numbers in it.

**Only do this on your own machine.** In a third terminal, from `apps/backend`:

```bash
npm run seed:demo
```

It takes about a minute and a half and prints, line by line, everything it
creates and then everything that is actually in the database afterwards.
You do **not** need to stop the backend or the dashboard while it runs — just
reload the browser tab when it finishes.

### It refuses to run anywhere that is not your machine

Before it opens a single connection it reads `DATABASE_URL`, and if the host is
not `localhost` (or the `postgres` service inside Docker Compose) it stops and
prints why. That is deliberate: this command writes fabricated payments and
subscriptions, and there is no undo. If you ever genuinely need it elsewhere
you have to type `npm run seed:demo -- --force-non-local`, and it warns you
loudly first.

### Running it twice is safe

It is designed to be re-run. Every row it writes carries a `demo` marker and it
looks each one up before creating it, so a second run changes nothing and does
not create a second copy. It never deletes anything.

### What you will see afterwards

- **30 households** — 15 in Egypt, 12 in Saudi Arabia, and 3 with **no country
  recorded at all**. Those last three are there on purpose: they are counted in
  the platform total and in neither market, so «المنصة» minus «مصر» plus
  «السعودية» is the unattributable population. That is the dashboard behaving
  correctly, not a gap.
- **45 children** spread across all four age bands (6-8 / 9-11 / 12-14 / 15-17),
  75 paired devices, and enough recent activity that DAU / WAU / MAU, «الأسر
  النشطة» and the retention grid all show numbers.
- **20 subscriptions** across the whole lifecycle — trial, active, past due,
  grace period, cancelled, expired — priced in **EGP for Egypt and SAR for
  Saudi Arabia**. The two currencies are never added together anywhere; that is
  why the platform-wide column shows «—» for money instead of a total.
- **~14 weeks of history**, recomputed one reporting day at a time by the real
  aggregation job, so the trend charts and the quarterly view are curves rather
  than a single dot.
- Reward programmes across Quran, sport, science, programming, reading, maths
  and more; ~330 goal attempts in a spread of states (verified, waiting for a
  parent, in progress); the reward ledger, timeline, notifications and child
  messages that follow from them.
- Four ad campaigns with daily spend, quarterly targets, three forecast
  scenarios per market, nine pilot invitations (four taken up, five still open)
  and a handful of support requests.

### Two panels that will still look empty, and why

- **«التنبيهات» (alerts) stays at zero.** The alert rules are population-scale:
  one needs at least ten registrations in a country in a week, another at least
  ten payment attempts through one provider in 24 hours. A 30-household demo
  crosses none of those thresholds, so the scan runs and finds nothing wrong —
  which is the panel working. An empty alerts list means "no problems", and
  inventing a fake incident to fill it would be the one thing this dashboard is
  built not to do.
- **Anything with an amber «لا يوجد endpoint لهذا الرقم بعد» box.** No amount of
  data fixes those; they are naming a number no backend route serves yet.

If you seed late at night **UTC** (after about 9pm UTC), the newest notification
rows are dated tomorrow on Cairo/Riyadh time while the dashboard's default range
still ends today — so the notification panel may look thin for a few hours.
Widening the date range, or re-running the seed during the day, resolves it.

### Recognising demo data later

Everything is findable and nothing looks like a real customer:

- emails end in `@demo-seed.invalid` — a reserved domain that can never receive
  mail;
- family names begin `DEMO-EG-01 ·`, children carry the surname `DEMO`,
  campaigns are named `DEMO — …`.

The Arabic names are real Arabic names because a demo full of `Test User 1`
demonstrates nothing — but no row is findable without also finding the word
`demo`. To wipe it, drop the database and re-run step 3.

> The prices the seed writes are **placeholders**, not a pricing decision. The
> script says so every time it runs.

---

## If something goes wrong

| What you see | What it means |
| --- | --- |
| Backend exits with `Missing required environment variable(s)` | Step 2 — a value in `apps/backend/.env` is still empty. |
| Backend exits mentioning `JWT_ACCESS_SECRET` | The two JWT secrets must be different and at least 32 characters each. |
| Dashboard loads, but every panel errors | The backend is not running, or `VITE_API_BASE_URL` is wrong. Restart `npm run dev` after editing `.env.local` — Vite only reads it at startup. |
| The unlock screen keeps coming back | The key does not match `INTERNAL_ADMIN_API_KEY`. Restart the backend after editing `.env`. |
| `docker compose` says port 5432 is in use | Another Postgres is already running locally. Stop it, or change the host port in `docker-compose.yml`. |
| Login fails right after registering | The database has no tables — step 3 was skipped or failed. |
| `npm run seed:demo` prints `REFUSING: DATABASE_URL points at …` | Step 7 — it only runs against a local database, on purpose. Check `DATABASE_URL` in `apps/backend/.env`. |
| `npm run seed:demo` prints `DATABASE_URL is not set` | It is run from the wrong folder, or `apps/backend/.env` is missing. Run it from `apps/backend`. |

To stop everything: `Ctrl+C` in both terminals, then `docker compose down` from
the repository root. Add `-v` to that command to also delete the database.
