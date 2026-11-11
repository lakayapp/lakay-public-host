# Lakay public host — deploy guide

Public HTTPS home for Lakay so Pouchon's friend can open it with a link.
No Play testing needed for the link. The Play Store download is a separate
later step.

## What this is

- `src/actions.ts` — Lakay's own server actions, copied verbatim from the
  Muse artifact (2026-11-11) with only the `@hatch/space-sdk` import
  rewritten to the local shim. All 96 actions, all Lakay rules intact:
  no outbound links in news, source credit as plain non-tappable text,
  safe-source pictures only, bad words blurred, 5 languages, admin lock
  unchanged (admin code + bound owner account, verified server-side).
- `src/shim.ts` — local replacement for `@hatch/space-sdk`.
- `src/ctx.ts` — the runtime: drizzle-orm over Turso (libSQL over HTTP),
  Gemini REST for translations, disk storage for uploaded photos/videos,
  RSS journalist instead of a Muse agent task.
- `src/journalist.ts` — RSS-only news rounds. No X/Twitter lane. Feeds:
  Google News "Haiti" RSS, The Haitian Times, Le Nouvelliste. Dedupes
  against posts already in the app, rewrites with Gemini, pictures from
  Wikimedia Commons or one of Lakay's own images only.
- `src/server.ts` — plain Node server. Serves the Lakay client
  (`public/`, the already-built client bundle), `POST /actions` (the RPC
  the client already speaks), `GET /blobs/*`, `/healthz`, `/healthz/db`,
  and `POST|GET /cron/news` (needs the cron secret).
- `migrate.mjs` — applies `drizzle/*.sql` to Turso in order, tracked in
  `_lakay_migrations`.
- `public/` — the built Lakay client (copied from the artifact 2026-11-11).

## Status (2026-11-11, updated ~07:30 EST)

Token FIXED and migration DONE — see below. The server was tested
end-to-end locally against the real Turso database and passed
(sign-up, sign-in, story post, news list, cron auth, journalist round
saved 3 real news posts). The code is committed to a local git repo
(branch `main`, commit `c0425c5`) with no remote yet.

**What changed since the first build:** the tables first created in
Turso came from a hand-written `schema.sql` whose columns did not
match the server code (`members.password_hash` vs `pw_hash`,
`created_at` TEXT vs INTEGER, `stories` with different columns, and
5 tables missing entirely: `hidden_news`, `lakay_articles`,
`message_comments`, `supporters`, `trivia_translations`). Every
database call failed. Fix 2026-11-11: the (empty — 0 rows everywhere)
database was dropped and the real drizzle migrations 0001–0027 were
applied with `migrate.mjs` using the working token. Result: exactly
the 32 tables in `src/schema.ts`, plus `_lakay_migrations` (27 rows);
re-running `migrate.mjs` skips everything. Do NOT re-apply the old
`schema.sql` — it is the wrong shape.

NOT live yet. One thing blocks going live:

1. **No git remote yet, so Render has nothing to deploy.** Render
   deploys from a git repository, and there is no GitHub account
   connected to Muse and no Render credential stored. Pouchon must
   create the GitHub repo and the Render service (exact steps in
   Step 2–3 below, ~15 minutes, free tier, no card).

Gemini is verified working: `gemini-3.5-flash` generates correctly
("Welcome home" -> "Byenveni lakay"). Do NOT use `gemini-2.5-flash`
(404 for new users).

## Step 1 — Turso token (DONE 2026-11-11)

The working credential is **`custom.turso-lakay`**, host
`lakay-lakay.turso.io`. The old `custom.turso` credential is dead
(InvalidToken) — do not use it or its old Secure Vault link. Verify
from the VM:

```sh
python3 ~/workspace/custom-connectors/custom.turso-lakay/bin/turso-lakay.py db-query --sql "SELECT 1 AS ok"
```

must return rows, not `InvalidToken`.

## Step 2 — Put the code in a repo (DONE locally, remote pending)

Local repo exists: branch `main`, commit `c0425c5`, 50 files, no
secrets committed (`.env` / `node_modules/` / `dist/` / `data/` are
git-ignored; `.env.example` holds placeholders only).

Still needed — Pouchon, in his own browser:

1. Create a GitHub account if he has none, then create an **empty
   public repo** named `lakay-public-host` (public so Render can read
   it without extra setup; the code holds no secrets).
2. Push this folder to it. From the VM, once the repo exists, Muse
   can push with a remote added — or Pouchon can do it from the
   GitHub web upload. The push needs his GitHub login; Muse cannot
   log in as him and `gh` on the VM is not logged in.

## Step 3 — Create the Render service (Pouchon, ~10 minutes)

Render dashboard (signed in as lakayapp@gmail.com) -> New -> Web Service
-> pick the repo. Settings:

- Name: `lakay` (this gives `https://lakay.onrender.com`)
- Region: Oregon (free tier default) — any region works
- Branch: main
- Runtime: Node
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Plan: Free
- Health check path: `/healthz`

Environment variables (dashboard -> Environment):

| Key | Value |
| --- | --- |
| `TURSO_URL` | `https://lakay-lakay.turso.io` |
| `TURSO_AUTH_TOKEN` | the fresh Turso database token (paste it here, never in chat) |
| `GEMINI_API_KEY` | the Gemini API key from Google AI Studio, project Lakay |
| `GEMINI_MODEL` | `gemini-3.5-flash` |
| `PUBLIC_URL` | `https://lakay.onrender.com` |
| `CRON_SECRET` | pick a long random value; copy it for the cron setup below |
| `BLOB_DIR` | `./data/blobs` |
| `NODE_ENV` | `production` |

`render.yaml` in this folder holds the same settings for Blueprint deploys.

## Step 4 — Create the tables (DONE 2026-11-11)

The tables are already created in Turso: the 32 tables in
`src/schema.ts`, applied by the real drizzle migrations 0001–0027
via `migrate.mjs` with the working `custom.turso-lakay` token.
Re-running it only skips what is already applied (verified). No
migrate step is needed on Render — the database is ready. Do NOT
re-apply the old hand-written `schema.sql`; its columns do not match
the server code.

## Step 5 — Test the live link

1. Open `https://lakay.onrender.com/healthz` — expect `{"ok":true,...}`.
   First load after idle can take about a minute (free plan sleeps).
2. Open `https://lakay.onrender.com/healthz/db` — expect `{"ok":true,"db":"ok"}`.
3. Open the app, sign up a test account, post a story, check the news
   section. Sign in as the owner account and check Settings -> Database
   shows the tables.
4. Trigger one news round by hand:
   `curl -X POST "https://lakay.onrender.com/cron/news?secret=<CRON_SECRET>"`
   then check News for a new post within a few minutes.

## Step 6 — cron-job.org (7 news rounds a day)

In cron-job.org (lakayapp@gmail.com, America/New_York), create one job
per round, all calling the same URL with the cron secret:

`https://lakay.onrender.com/cron/news?secret=<CRON_SECRET>`

| Job | Time (America/New_York) |
| --- | --- |
| Lakay news 06:30 | 06:30 daily |
| Lakay news 11:30 | 11:30 daily |
| Lakay news 15:00 | 15:00 daily |
| Lakay news 17:00 | 17:00 daily |
| Lakay news 19:00 | 19:00 daily |
| Lakay news 21:00 | 21:00 daily |
| Lakay news 00:00 | 00:00 daily |

Method: GET or POST. No cronjob exists yet — do not create them until
the public URL answers `/healthz`.

## Known limits (tell Pouchon plainly)

- The public host starts EMPTY. Members, stories, news posts and the
  owner's welcome message that live in the Muse app today are not
  copied over yet. Migrating them is a separate step once Turso works
  (read them out through the artifact's own actions, insert them into
  Turso). The two member accounts would need to be recreated or have
  their password hashes migrated.
- Uploaded photos/videos live on Render's disk on the free plan, which
  is ephemeral: a redeploy or a host move can lose them. A durable
  store (e.g. an S3-compatible bucket) is a later upgrade, not needed
  for the friend test.
- Free Render sleeps after 15 minutes idle: the first visitor waits
  about a minute while it wakes up.
- Gemini free tier has quotas; if a translation call fails the app
  shows the original language instead of failing the page.
- News rounds are RSS-only now (no X/Twitter lane) and pictures come
  from Wikimedia Commons or Lakay's own images only.

## Troubleshooting

- `/healthz/db` returns an error: the Turso token is wrong, expired, or
  for a different database. Re-do Step 1.
- Actions return "Failed query ... table does not exist": run Step 4.
- News round saves nothing: check the Render logs for
  `[lakay] journalist ...`. An empty round is normal when nothing new
  and verified turned up.
- Translations slow on first use: the first translation of a post is
  made on demand and stored forever; the second time it is instant.
