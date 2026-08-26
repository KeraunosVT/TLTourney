# TLTourney

A tournament site for *Throne & Liberty*: a double-elimination bracket fed by a live snake draft,
with per-player stats tracked across the whole tournament.

**Built so far: signups.** Players sign in with Discord and file what they're bringing; organizers
approve or reject from a queue. The draft, the bracket and the stats pages come next — see
[What's next](#whats-next).

---

## ⚠️ This is not the guild app

TLTourney is standalone. It has **its own Discord server, its own Discord application, and its own
Supabase project**, none of them shared with the Gear-Gap guild app. Do not copy IDs, secrets or a
database URL from that project into this one: the role IDs are meaningless in a different server,
the OAuth redirect points at a different site, and pointing this app at that database would mix two
unrelated things together.

What *is* borrowed from Gear-Gap is code, deliberately: the weapon→class table
([`shared/weaponClasses.json`](shared/weaponClasses.json)), the shape of the Discord OAuth flow, and
the visual language. That's reuse, not a shared deployment.

## Stack

- **Frontend** — React + Vite + Tailwind
- **Backend** — Node + Express
- **Database** — Supabase (Postgres)
- **Login** — Discord OAuth2, gated to the tournament server

One process serves both: `backend/server.js` serves `frontend/dist` statically alongside `/api`, so
there's one thing to deploy and no CORS in production.

Requires **Node 22.x** — that comes from `@supabase/supabase-js`, which declares `engines.node >=22`.
Nothing in this repo's own code needs anything newer, so on a host that offers a Node version
picker, plain "22" is the right selection.

## Setup

### 1. Discord application

At <https://discord.com/developers/applications> → **New Application**. This is a *new* application
for the tournament, not the guild's.

- **OAuth2 → Redirects**: add `http://localhost:3000/api/auth/discord/callback` (and your
  production URL later). It must match `DISCORD_REDIRECT_URI` exactly.
- **Bot → Reset Token**: copy it, and invite the bot to the tournament server with the `bot` scope.
  The bot is optional but worth having — without it, sessions are never re-checked against Discord
  and approval/rejection DMs don't send.

Turn on Discord's **Developer Mode** (Settings → Advanced) to copy the server ID and role IDs.

### 2. Supabase

Create a **new** project. Open the SQL editor and run, in order:

1. [`migrations/001_signups.sql`](migrations/001_signups.sql) — the schema, plus a first tournament
   row so the app has something to point at.
2. [`migrations/verify.sql`](migrations/verify.sql) — every row should read `true`.

From **Project Settings → API**, take the URL and the **service** key (not the anon key — it
bypasses row-level security and must never reach the browser).

### 3. Configure

```bash
cp backend/.env.example backend/.env
```

Fill it in; every variable is documented in the file. The two easy ones to get wrong:

- `DISCORD_ADMIN_ROLE_IDS` — empty means **nobody** can reach the approval queue. Set it to the
  organizer role in the tournament server. Once the app is running you can read role IDs from
  `/api/organizer/roles` rather than hunting through Discord.
- `JWT_SECRET` — any long random string:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

### 4. Run

```bash
npm install          # installs backend + frontend

# two terminals, for hot reload:
cd backend && npm start      # API on :3000
cd frontend && npm run dev   # UI on :5173, proxying /api to :3000
```

Vite proxies `/api` to the backend, so dev is same-origin and the session cookie works without
touching `CORS_ORIGINS`.

For a production-shaped run: `npm run build`, then `npm start` and open `:3000`.

## Deploying to tnltourneystats.com (Hostinger)

This is a persistent Node process, not PHP — it needs a plan that runs Node: **Business** or **Cloud
Startup** shared hosting (Hostinger added Node app support to those), or a **VPS**. Pick Node **22**
in the version selector.

Build and start:

```
Build   : npm install && npm run build
Start   : node backend/server.js
```

`npm install` installs both halves and `npm run build` produces `frontend/dist`, which
`backend/server.js` then serves alongside `/api`. One process, one port — set nothing else up.

### Environment variables on the live site

Set these in hPanel (Node app → Environment variables), **not** in a committed file.

| Variable | Live value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://tnltourneystats.com` |
| `DISCORD_REDIRECT_URI` | `https://tnltourneystats.com/api/auth/discord/callback` |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | from the Discord application |
| `DISCORD_GUILD_ID` | the tournament server's ID |
| `DISCORD_ADMIN_ROLE_IDS` | the organizer role ID — **empty means nobody can approve anything** |
| `DISCORD_ALLOWED_ROLE_IDS` | leave empty so any server member can sign in |
| `DISCORD_BOT_TOKEN` | the bot token |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | from the Supabase project |
| `JWT_SECRET` | a long random string, **different from the local one** |
| `CORS_ORIGINS` | leave empty — production is same-origin |
| `PORT` | whatever the host injects; leave unset if it provides one |

Three that bite if you skip them:

- **`NODE_ENV=production`** is what turns on `secure` session cookies and `trust proxy`. Behind
  Hostinger's HTTPS proxy without it, the login cookie is issued without the Secure flag and the
  rate limiter counts every request against the proxy's IP instead of the caller's.
- **`DISCORD_REDIRECT_URI` must be registered on the Discord application**, character for character,
  alongside the localhost one. Discord refuses anything it hasn't been told about, and the error it
  shows doesn't say which part didn't match.
- **`DISCORD_ADMIN_ROLE_IDS`** empty means the approval queue is unreachable by everyone, including
  you. Once the app is up you can read role IDs from `/api/organizer/roles`.

### The www vs apex trap

The session cookie is scoped to the exact host that served the request, so
`tnltourneystats.com` and `www.tnltourneystats.com` do **not** share a login: sign in on one and
you're anonymous on the other. Pick whichever you put in `DISCORD_REDIRECT_URI` as canonical and
301 the other to it in Hostinger's domain settings.

### On a VPS instead

Same variables, in a `.env` file or the systemd unit. Run the process under **PM2**
(`pm2 start backend/server.js --name tltourney && pm2 save && pm2 startup`) so it survives crashes
and reboots, put **nginx** in front proxying `:3000`, and get the certificate with **certbot**.
Point nginx at the app rather than at `frontend/dist` — Express serves the static files itself, and
splitting them would leave `/api` unrouted.

## Tests

```bash
npm test
```

`node:test`, built into Node — no dependency, no runner, no database. The suite is deliberately
narrow: it covers the logic where a mistake produces a **plausible wrong answer** rather than an
error, which is the only kind of bug that survives being looked at.

- [`classify.test.js`](backend/test/classify.test.js) — all 45 weapon pairs resolve, order doesn't
  matter, no class name is reused. A wrong answer here is a real class name in the wrong row.
- [`validateSignup.test.js`](backend/test/validateSignup.test.js) — mostly about gear level. `''`,
  `'   '` and `'abc'` must all be **refused**, never coerced: `Number('')` is `0`, and a silent zero
  drops a player to the bottom of every captain's board with nobody told why. This test caught that
  exact bug on the whitespace case while it was being written.

## How signups work

**Two states matter.** A signup is `pending` until an organizer decides on it, and only an
`approved` one is on the board captains draft from. Nothing a player writes is visible to captains
before that.

**The class is derived, never asked for.** You pick two weapons; the class follows. Both halves use
the same [`shared/classes.cjs`](shared/classes.cjs) — the browser so it can show the class as you
pick, the server because a `class_name` arriving in a request body is a claim, not a fact. One copy
of that table, because two would drift and the drift would be silent.

**Identity comes from the session.** No route accepts a `discord_id`, which is what makes "file a
signup as someone else" not a thing this app can be asked to do.

**Editing doesn't send you back to the queue.** An approved player who switches a weapon stays
approved — the organizer approved the person, not the loadout, and bouncing people back for every
edit means nobody updates their entry, which leaves captains drafting on stale information. The
queue flags a row edited after it was decided. A *rejected* or *withdrawn* signup that comes back
does re-enter the queue, or "rejected" would be a suggestion rather than a decision.

**Closing signups freezes the pool.** `PUT /api/organizer/tournament {status:'draft'}` — after
that, nothing can be filed or edited. A roster that changes underneath a running draft is how a
captain ends up having drafted somebody who no longer exists.

**Two organizers can work the queue at once.** Each decision is applied conditionally on the row
still being in the state the organizer saw, so the second click reports "someone else decided this
one first" instead of silently overwriting an approval with a rejection.

**A rejection needs a reason**, and it's DMed. One that vanishes without a reason just gets
resubmitted unchanged, and the organizer does the same work twice.

## API

| | |
|---|---|
| `GET /api/health` | public — config status |
| `GET /api/tournament` | public — name, status, whether signups are open |
| `GET /api/auth/login` · `/discord/callback` · `/me` · `POST /logout` | Discord OAuth |
| `GET /api/signup/mine` · `PUT /api/signup/mine` · `DELETE /api/signup/mine` | your own signup |
| `GET /api/signup/pool` | counts and weapon demand — numbers only, never the roster |
| `GET /api/signup/options` | the weapon and night lists the validator checks against |
| `GET /api/organizer/signups` | the full queue |
| `POST /api/organizer/signups/:id/decision` | `{decision:'approved'\|'rejected', note}` |
| `POST /api/organizer/signups/approve-all` | bulk, each still individually guarded |
| `PUT /api/organizer/tournament` | name, status, roster size, close date |
| `GET /api/organizer/roles` | the tournament server's roles, for setup |

Everything under `/api` except health, tournament and auth requires a session; everything under
`/api/organizer` additionally requires an organizer role.

## Project structure

```
backend/     Express API, Discord OAuth, Supabase access
  test/      node:test suites — no database, no runner
frontend/    React app (Vite)
shared/      the weapon→class table, read by both halves
migrations/  numbered .sql, applied in the Supabase SQL editor
```

## What's next

Planned, in order — each phase runs on its own:

1. **Teams & captains** — organizers designate captains; a team is a captain plus a drafted roster.
2. **Draft** — snake order by seed reversing each round, a server-owned pick clock with auto-pick,
   live on the site over SSE.
3. **Bracket** — the double-elimination skeleton generated up front, with bracket reset in the
   grand final.
4. **Results & stats** — scoreboard screenshots read by Gemini (Gear-Gap's `ingest.js`, borrowed
   whole), reviewed, then committed to both advance the bracket and file per-player stats.

There is no Discord bot beyond DMs in v1.
