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

## If something goes wrong

| What you see | What it means |
| --- | --- |
| Backend exits with `Missing required environment variable(s)` | Step 2 — a value in `apps/backend/.env` is still empty. |
| Backend exits mentioning `JWT_ACCESS_SECRET` | The two JWT secrets must be different and at least 32 characters each. |
| Dashboard loads, but every panel errors | The backend is not running, or `VITE_API_BASE_URL` is wrong. Restart `npm run dev` after editing `.env.local` — Vite only reads it at startup. |
| The unlock screen keeps coming back | The key does not match `INTERNAL_ADMIN_API_KEY`. Restart the backend after editing `.env`. |
| `docker compose` says port 5432 is in use | Another Postgres is already running locally. Stop it, or change the host port in `docker-compose.yml`. |
| Login fails right after registering | The database has no tables — step 3 was skipped or failed. |

To stop everything: `Ctrl+C` in both terminals, then `docker compose down` from
the repository root. Add `-v` to that command to also delete the database.
