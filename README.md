# Promptwatch Scheduler

A dashboard for automatically activating and deactivating Promptwatch monitors on a weekly
schedule — pick the days and hours, and each monitor turns on when its window opens and off
when it closes, every week, on its own. Built with Node.js, TypeScript, Next.js, and PostgreSQL.

## What it does

- **Automatic scheduling** — set a weekly activation window per monitor (e.g. weekdays
  09:00–17:00). Supports overnight windows that wrap past midnight, and all-day windows.
  A background process checks continuously and activates/deactivates monitors through the
  Promptwatch API exactly when their window opens or closes.
- **Bulk actions** — select multiple monitors at once to schedule, activate, deactivate, or
  clear schedules together.
- **Finds every monitor, not just active ones** — Promptwatch's own API only lists active
  monitors by default; this app cross-references prompts to discover inactive monitors too, so
  nothing is missing from the dashboard.
- **Logins and roles** — a login screen gates the whole app. Four roles (`viewer`, `editor`,
  `admin`, `super-admin`) control what each person can do, enforced on the server, not just
  hidden in the UI. The super admin can invite teammates from a restricted email domain,
  assign roles, reset passwords, and deactivate accounts.
- **Activity log** — every schedule change, sync, manual toggle, and login is recorded with
  who did it and when, with activations shown in green and deactivations in red.
- **API usage chart** — see how many calls are being made to Promptwatch per hour, and where
  they're going.

## Architecture

| Piece | What it is |
|---|---|
| `app` | The Next.js web app — serves the dashboard and every `/api/*` route |
| `worker` | A background process that runs the scheduling loop |
| `db` | PostgreSQL — a separate database server, shared by `app` and `worker` |

The **app** and **worker** are two independent processes sharing one database. That
separation means restarting or updating the web app never interrupts the automatic scheduling
running in the worker, and vice versa.

## Run it locally with Docker (recommended)

Requires Docker and Docker Compose.

```bash
cp .env.example .env          # edit SUPER_ADMIN_PASSWORD if you want a different one
docker compose up --build     # dashboard at http://localhost:3000
```

This brings up three services: `db` (Postgres, with its data in a named volume so it survives
restarts and rebuilds), `app` (the dashboard, on port 3000), and `worker` (the scheduling loop).
`app` runs `prisma db push` against `db` on startup to keep the schema in sync; `worker` waits
for `app` to be healthy before starting, so it never races `app` to set up the schema.

Log in with the email/password from `.env` (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`) —
that value only matters the first time the app ever starts; after that, the real password is a
one-way hash stored in the database, changeable anytime from **Settings → Account**, and not
recoverable by anyone, including whoever built or hosts this app.

To stop the stack without losing data: `docker compose stop`. `docker compose down` also stops
it and is safe too (the database lives in the `pgdata` named volume, not in the containers) —
just don't add `-v`, which deletes volumes.

## Run it locally without Docker

Requires Node.js 20+ and a Postgres server. The easiest way to get one is to start just the
`db` service from Docker Compose and run the app on the host:

```bash
docker compose up db          # Postgres only, on localhost:5432

npm install
cp .env.example .env          # DATABASE_URL already points at localhost:5432 by default
npx prisma db push            # creates the tables
npm run dev                   # dashboard at http://localhost:3000

# in a second terminal — the scheduler loop
npm run worker
```

For a production-style local run instead of `npm run dev`:
```bash
npm run build
npm run start:all     # runs the web app and the worker together, one command
```

## Committing to Git

```bash
git status              # see what changed
git add -A               # stage everything
git commit -m "describe what changed"
```

`.env` is in `.gitignore`, so your API key and passwords never get committed — only the code
does. See your history with `git log --oneline`.

## Deploying so someone else can try it

A Postgres database plus a background worker process means this needs a host that keeps a
real server running (not a "serverless functions" platform like plain Vercel, which doesn't
keep a long-running background process between requests).

**Railway** is a straightforward option that supports both, and can host the Postgres database
too:

1. Push this repo to GitHub (private is fine — Railway just needs read access).
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → select
   this repo, then **+ New → Database → Add PostgreSQL** in the same project.
3. In the app/worker services' **Variables**, set:
   - `DATABASE_URL` = reference Railway's Postgres plugin variable (usually
     `${{Postgres.DATABASE_URL}}`)
   - `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` — the first login
   - `PROMPTWATCH_BASE_URL` (optional — only needed if not using the default Promptwatch API host)
4. In the service's **Settings → Deploy**, set the **Start Command** to:
   ```
   npx prisma db push --accept-data-loss && npm run start:all
   ```
   (`db push` sets up the database tables on first deploy; `start:all` runs the web app and
   the scheduler worker together.)
5. Deploy. Railway gives you a public URL (like `yourapp.up.railway.app`) — share that with
   whoever needs to try it, and they log in the same way as locally.

Any other host that can run this repo's `Dockerfile`/`docker-compose.yml` and provide a
Postgres database works too — the app just needs `DATABASE_URL` pointing at it.

Once it's live, invite additional people from **Team** in the app itself (super admin only) —
that's separate from GitHub access, and controls who can log into the running app.

### Carrying over an existing monitor inventory

A fresh deploy starts with an empty database — normally that's fine, since setting the API key
and hitting **Sync** in Settings rediscovers every monitor from Promptwatch on its own (including
inactive ones — see `src/lib/sync.ts`'s two-pass discover/refresh design). If you'd rather not
wait on that, `db/seed/monitors-seed.sql` is a point-in-time export of just the `Project` and
`Monitor` tables (no API key, no users, no schedules) that can be applied to a fresh database
before or after the first Sync — every row uses `ON CONFLICT DO NOTHING`, so it's safe to run
more than once and won't clobber anything Sync has already fetched:

```bash
psql "$DATABASE_URL" -f db/seed/monitors-seed.sql
```

It's a snapshot, not a live feed — run Sync afterward (or just let the worker's next tick happen)
to refresh every monitor's actual current active/inactive state from Promptwatch.

## Roles

Enforced on the server for every action, not just hidden in the interface:

| Role | View | Toggle/schedule monitors, sync | API key / scheduler settings | Manage team |
|---|---|---|---|---|
| Viewer | ✅ | – | – | – |
| Editor | ✅ | ✅ | – | – |
| Admin | ✅ | ✅ | ✅ | – |
| Super admin | ✅ | ✅ | ✅ | ✅ |

Team invites are restricted to a specific email domain by default (configured in
`src/lib/auth.ts` as `INVITE_DOMAIN`), so only people with an approved address can be added.

## Files

| Path | Purpose |
|---|---|
| `src/app/api/**` | API routes — one folder per endpoint |
| `src/lib/auth.ts` | Password hashing, sessions, roles, team management |
| `src/lib/promptwatch.ts` | The Promptwatch API client |
| `src/lib/scheduler.ts` | Window math (is a monitor inside its active window right now?) and the tick loop |
| `src/lib/sync.ts` | Pulls projects and monitors in from Promptwatch |
| `src/lib/state.ts` | Builds the dashboard's main `/api/state` response |
| `src/lib/json.ts` | Encode/decode helpers for the list fields stored as JSON-encoded strings |
| `scripts/worker.ts` | Entry point for the background worker process |
| `prisma/schema.prisma` | Database schema (PostgreSQL) |
| `public/` | The dashboard's HTML/CSS/JS |
| `Dockerfile` | Builds the app/worker image (Node 20 + OpenSSL, needed by Prisma's engine) |
| `docker-compose.yml` | Runs `db` (Postgres), `app`, and `worker` together |

## Environment variables

See `.env.example`. `DATABASE_URL` points at the Postgres server (`docker compose up` sets this
automatically for the `app`/`worker` containers — see `docker-compose.yml`); `SUPER_ADMIN_EMAIL`
/ `SUPER_ADMIN_PASSWORD` seed the very first login (once any user exists in the database, these
two stop being used); `PROMPTWATCH_BASE_URL` overrides which Promptwatch API host to talk to.
