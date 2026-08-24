# Promptwatch Scheduler (Node.js / TypeScript / PostgreSQL)

A rewrite of the original Python version (kept as a backup in `Promptwatch Scheduler Main`)
in Node.js + TypeScript + Next.js, with a real PostgreSQL database instead of a JSON file —
built for running on a server long-term, not just locally.

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
| `db` | PostgreSQL |

The **app** and **worker** are two processes sharing one database — restarting the web app
never interrupts the automatic scheduling, and vice versa. This is different from the Python
version, which ran both in a single process; splitting them is the more standard pattern for
a real server deployment.

## Run with Docker (recommended)

This is the easiest path — one command spins up the database, the app, and the worker together.

```bash
cp .env.example .env        # edit if you want a different super admin password
docker compose up --build
```

Open **http://localhost:3000**. Log in with the email/password from `.env`
(`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`) — that value only matters the first time; after
that the real password is a hash in the database, changeable from Settings → Account.

To stop: `docker compose down` (your data stays in the `pgdata` Docker volume — add `-v` to
also wipe it).

## Run without Docker (local development)

Requires Node.js 20+ and a running PostgreSQL (`brew install postgresql@16` on a Mac, or use
any hosted Postgres and point `DATABASE_URL` at it).

```bash
npm install
cp .env.example .env                 # set DATABASE_URL to your local Postgres
npx prisma db push                   # creates the tables
npm run dev                          # dashboard at http://localhost:3000

# in a second terminal — the scheduler loop
npm run worker
```

## Deploying to a real server

1. Push this folder to a private GitHub repo (`git init && git add . && git commit -m "initial"`,
   then create a repo on GitHub and `git push`). `.env` and `node_modules` are already
   gitignored, so secrets and dependencies won't be committed.
2. On the server: install Docker, clone the repo, create `.env` with real values, run
   `docker compose up --build -d`.
3. Put a reverse proxy in front (Caddy or nginx) for HTTPS — point it at `localhost:3000`.
   Caddy is the simplest option for a non-technical setup: point a domain at the server, then
   a two-line Caddyfile (`yourdomain.com { reverse_proxy localhost:3000 }`) gets you automatic
   HTTPS with no manual certificate work.
4. Most managed platforms (Railway, Render, Fly.io, DigitalOcean App Platform) can also just
   read this repo's `Dockerfile`/`docker-compose.yml` directly if you'd rather not manage a
   VM yourself.

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
| `scripts/worker.ts` | Entry point for the background worker process |
| `prisma/schema.prisma` | Database schema |
| `public/` | The dashboard UI (unchanged from the Python version) |
| `Dockerfile`, `docker-compose.yml` | Container setup |

## Environment variables

See `.env.example`. `DATABASE_URL` points at Postgres; `SUPER_ADMIN_EMAIL` /
`SUPER_ADMIN_PASSWORD` seed the first login (once a user exists in the database, these stop
being used); `PROMPTWATCH_BASE_URL` overrides the Promptwatch API host (used for testing).

## What's different from the Python version

- **Database**: PostgreSQL via Prisma, instead of a JSON file — safe for concurrent access,
  proper indexing, and a real basis to grow on.
- **Sessions**: stored in the database instead of in memory, so restarting the app no longer
  logs everyone out.
- **Password hashing**: Node's built-in `scrypt` instead of Python's `PBKDF2` — same idea
  (salted, slow, one-way), different algorithm, no extra dependency either way.
- **Scheduler**: a separate worker process instead of a background thread in the web server —
  standard practice for a real deployment, and it means a web app restart/deploy never
  interrupts scheduled activations.
