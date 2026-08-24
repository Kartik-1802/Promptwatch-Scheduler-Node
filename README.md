# Promptwatch Scheduler (Node.js / TypeScript)

A rewrite of the original Python version (kept as a backup in `Promptwatch Scheduler Main`)
in Node.js + TypeScript + Next.js — built for running on a server long-term, not just locally.

Currently uses **SQLite** (a real database, stored as a single file at `data/app.db`) instead
of the Python version's JSON file — no server process or Docker required to run it. Postgres +
Docker are set up and ready (`Dockerfile`, `docker-compose.yml`) for whenever you want to move
to that; switching later is a one-line change (see "Moving to Postgres later" below).

Same features, same tested dashboard (the frontend — `public/index.html`, `style.css`,
`app.js` — is copied over unchanged from the Python version and talks to identically-shaped
API endpoints, so nothing about how it looks or behaves changed):

- Automatic weekly activation windows per monitor, with overnight-wrap and all-day support
- Bulk select, bulk schedule, bulk activate/deactivate
- Auto-discovery of inactive monitors (via `/prompts` pagination, since `/monitors` only
  returns active ones)
- Login with roles (`viewer` / `editor` / `admin` / `super-admin`), team invites restricted
  to `@contentninja.in`, per-role permission enforcement server-side
- Logs with user attribution and green/red activate/deactivate coloring
- API usage-per-hour chart

## Architecture

| Piece | What it is |
|---|---|
| `app` | Next.js app — serves the dashboard and all `/api/*` routes |
| `worker` | A separate background process running the scheduler tick loop |
| `db` | SQLite (`data/app.db`), or Postgres if you switch later |

The **app** and **worker** are two separate processes sharing one database — restarting the
web app never interrupts automatic scheduling, and vice versa. This is different from the
Python version, which ran both in a single process; splitting them is the more standard
pattern for a real server deployment.

## Run it (no Docker needed)

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
that value only matters the first time; after that the real password is a hash in the
database, changeable from Settings → Account.

For a production-style run instead of `npm run dev`: `npm run build && npm run start` (plus
`npm run worker` in parallel, same as above).

## Committing to Git (local only, step by step)

The repo is already initialized with one commit. To make a new commit whenever you've changed
something:

```bash
cd "/Users/contentninja/Downloads/Promptwatch Scheduler Node"
git status                     # see what changed
git add -A                     # stage everything
git commit -m "describe what changed"
```

`.env` and `data/app.db` are already in `.gitignore`, so your API key, passwords, and database
never get committed — only the code does.

To see your commit history: `git log --oneline`.

**This is all local** — nothing has been uploaded anywhere yet. See below for pushing to a
private GitHub repo when you're ready.

## Pushing to a private GitHub repo (when you're ready)

1. On github.com: **New repository** → name it → set visibility to **Private** → don't
   initialize with a README (this folder already has one) → **Create repository**.
2. GitHub will show you a repo URL like `https://github.com/yourname/promptwatch-scheduler.git`.
   Run:
   ```bash
   cd "/Users/contentninja/Downloads/Promptwatch Scheduler Node"
   git remote add origin https://github.com/yourname/promptwatch-scheduler.git
   git branch -M main
   git push -u origin main
   ```
3. To give `harshsingh94@gmail.com` access to the **code repo**: on GitHub, go to your repo →
   **Settings → Collaborators → Add people** → enter their GitHub username or the email their
   GitHub account uses.

   Note: this is different from giving them a **login to the running app**. The app's own Team
   tab only allows inviting `@contentninja.in` addresses — a `gmail.com` address can't be
   invited there as-is. If you want them logging into the dashboard itself, either give them a
   `@contentninja.in` address, or let me know and I can loosen that restriction.

## Deploying to a real server later

1. Push to GitHub (above).
2. Simplest path without Docker: install Node.js on the server, clone the repo, `npm install`,
   `npx prisma db push`, then run the app and worker persistently (a process manager like `pm2`
   keeps them alive across reboots/crashes: `pm2 start npm --name app -- run start` and
   `pm2 start npm --name worker -- run worker`).
3. With Docker instead (already set up): `docker compose up --build -d` starts Postgres, the
   app, and the worker together.
4. Either way, put a reverse proxy in front for HTTPS — Caddy is the simplest option for a
   non-technical setup: point a domain at the server, then a two-line Caddyfile
   (`yourdomain.com { reverse_proxy localhost:3000 }`) gets you automatic HTTPS with no manual
   certificate work.

## Moving to Postgres later

Only worth it once you have real concurrent traffic or want managed backups. To switch:

1. In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"` in the
   `datasource` block.
2. Change `Schedule.days` back to `Int[]` and `Monitor.models` back to `Json` (Postgres
   supports both natively — SQLite doesn't, which is why they're JSON-encoded strings today).
3. Point `DATABASE_URL` at a real Postgres connection string, then `npx prisma db push`.
4. Use `docker compose up --build` for a one-command Postgres + app + worker setup, or point at
   a managed Postgres (Railway, Supabase, RDS, etc).

## Roles

Identical to the Python version — enforced server-side in every API route, not just hidden in
the UI:

| Role | View | Toggle/schedule monitors, sync | API key / scheduler settings | Manage team |
|---|---|---|---|---|
| Viewer | ✅ | – | – | – |
| Editor | ✅ | ✅ | – | – |
| Admin | ✅ | ✅ | ✅ | – |
| Super admin | ✅ | ✅ | ✅ | ✅ |

## Files

| Path | Purpose |
|---|---|
| `src/app/api/**` | API routes — one folder per endpoint |
| `src/lib/auth.ts` | Password hashing, sessions, roles, team management |
| `src/lib/promptwatch.ts` | Promptwatch API client |
| `src/lib/scheduler.ts` | Window math + the tick loop |
| `src/lib/sync.ts` | Pulls projects/monitors from Promptwatch |
| `src/lib/state.ts` | Builds the dashboard's `/api/state` response |
| `src/lib/json.ts` | JSON encode/decode helpers for SQLite's list fields |
| `scripts/worker.ts` | Entry point for the background worker process |
| `prisma/schema.prisma` | Database schema |
| `public/` | The dashboard UI (unchanged from the Python version) |
| `data/app.db` | The SQLite database file — gitignored, never committed |
| `Dockerfile`, `docker-compose.yml` | Container setup, ready for the Postgres move |

## Environment variables

See `.env.example`. `DATABASE_URL` points at the SQLite file (or Postgres, once you switch);
`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` seed the first login (once a user exists in the
database, these stop being used — the real password is only a hash, and only you know it);
`PROMPTWATCH_BASE_URL` overrides the Promptwatch API host (used for testing).

## What's different from the Python version

- **Database**: a real SQLite database via Prisma, instead of a JSON file — proper schema,
  ready to move to Postgres with a one-line config change when you need it.
- **Sessions**: stored in the database instead of in memory, so restarting the app no longer
  logs everyone out.
- **Password hashing**: Node's built-in `scrypt` instead of Python's `PBKDF2` — same idea
  (salted, slow, one-way), different algorithm, no extra dependency either way.
- **Scheduler**: a separate worker process instead of a background thread in the web server —
  standard practice for a real deployment, and it means a web app restart/deploy never
  interrupts scheduled activations.
