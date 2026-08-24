# Promptwatch Scheduler

A dashboard for automatically activating and deactivating Promptwatch monitors on a weekly
schedule — pick the days and hours, and each monitor turns on when its window opens and off
when it closes, every week, on its own. Built with Node.js, TypeScript, and Next.js, with a
built-in database (SQLite) — no external services required to run it.

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
| database | SQLite — a single file at `data/app.db`, no separate database server needed |

The **app** and **worker** are two independent processes sharing one database file. That
separation means restarting or updating the web app never interrupts the automatic scheduling
running in the worker, and vice versa.

## Run it locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env          # edit SUPER_ADMIN_PASSWORD if you want a different one
npx prisma db push            # creates data/app.db and its tables
npm run dev                   # dashboard at http://localhost:3000

# in a second terminal — the scheduler loop
npm run worker
```

Log in with the email/password from `.env` (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`) —
that value only matters the first time the app ever starts; after that, the real password is a
one-way hash stored in the database, changeable anytime from **Settings → Account**, and not
recoverable by anyone, including whoever built or hosts this app.

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

`.env` and `data/app.db` are in `.gitignore`, so your API key, passwords, and database never
get committed — only the code does. See your history with `git log --oneline`.

## Deploying so someone else can try it

SQLite plus a background worker process means this needs a host that keeps a real server
running (not a "serverless functions" platform like plain Vercel, which doesn't keep a
persistent disk or a long-running background process between requests).

**Railway** is a straightforward option that supports both:

1. Push this repo to GitHub (private is fine — Railway just needs read access).
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → select
   this repo.
3. Add a **Volume**, mounted at `/app/data` — this is what makes the database survive restarts
   and deploys.
4. In the service's **Variables**, set:
   - `DATABASE_URL` = `file:/app/data/app.db` (an absolute path, since the volume is mounted there)
   - `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` — the first login
   - `PROMPTWATCH_BASE_URL` (optional — only needed if not using the default Promptwatch API host)
5. In the service's **Settings → Deploy**, set the **Start Command** to:
   ```
   npx prisma db push --accept-data-loss && npm run start:all
   ```
   (`db push` sets up the database tables on first deploy; `start:all` runs the web app and
   the scheduler worker together.)
6. Deploy. Railway gives you a public URL (like `yourapp.up.railway.app`) — share that with
   whoever needs to try it, and they log in the same way as locally.

Once it's live, invite additional people from **Team** in the app itself (super admin only) —
that's separate from GitHub access, and controls who can log into the running app.

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
| `src/lib/json.ts` | Encode/decode helpers for the list fields SQLite can't store natively |
| `scripts/worker.ts` | Entry point for the background worker process |
| `prisma/schema.prisma` | Database schema |
| `public/` | The dashboard's HTML/CSS/JS |
| `data/app.db` | The SQLite database file — gitignored, never committed |
| `Dockerfile`, `docker-compose.yml` | Optional container setup, useful if moving to Postgres |

## Environment variables

See `.env.example`. `DATABASE_URL` points at the SQLite file (or a Postgres server, if you
move to that later); `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` seed the very first login
(once any user exists in the database, these two stop being used); `PROMPTWATCH_BASE_URL`
overrides which Promptwatch API host to talk to.

## Moving to Postgres later

Worth doing once there's real concurrent traffic or a need for managed backups — SQLite is
plenty for a small team.

1. In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
2. Change `Schedule.days` back to `Int[]` and `Monitor.models` back to `Json` — Postgres
   supports both natively (SQLite doesn't, which is why they're JSON-encoded strings today).
3. Point `DATABASE_URL` at a real Postgres connection string, then run `npx prisma db push`.
4. `docker compose up --build` brings up Postgres, the app, and the worker together in one
   command, using the `Dockerfile`/`docker-compose.yml` already in this repo.
