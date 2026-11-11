# Lakay public host — working notes (2026-11-11)

## Verdict

No live URL yet. The code is built, compiles clean, and is tested as far
as it can be tested without a working Turso token. Two blockers remain,
both need Pouchon: (1) a valid Turso database token, (2) a git repo +
Render service creation.

## Verification results (all run 2026-11-11, America/New_York)

### Gemini — VERIFIED WORKING
- `gemini.py list-models`: HTTP 200, models listed including
  gemini-2.5-flash, gemini-2.5-pro.
- `gemini.py generate --model gemini-3.5-flash`: HTTP 200,
  "Welcome home" -> "Byenveni lakay" (correct Kreyol).
- `gemini-2.5-flash` generate: HTTP 404, "no longer available to new
  users". Server default is `gemini-3.5-flash`. Do not use 2.5-flash.

### Turso — FAILING, token invalid (verified twice)
- Platform API `GET /v1/organizations` with stored credential:
  HTTP 401 Unauthorized.
- libSQL pipeline `POST https://lakay-lakay.turso.io/v2/pipeline`
  with stored credential: HTTP 400 `{"error":"JWT error: InvalidToken"}`,
  twice (second attempt identical).
- Unauthenticated probe: `lakay-lakay.turso.io` answers (401, host
  exists, wants a token). `lakay-pouchon.turso.io` answers 404
  "Host not found" (host does not exist). The live database host is
  `lakay-lakay.turso.io`. The 06:31 Turso Secure Vault link registered
  the wrong host; do not reuse it. No fresh Turso submission arrived
  after it (only the Google key arrived, 07:05), so the stored value
  is still the earlier failing one.
- Conclusion: the stored value is not a valid database auth token for
  the Lakay database. It may be the wrong paste (URL, Gemini key, or a
  truncated token). Needs a fresh submission of the database token from
  Turso dashboard -> Lakay database -> Create token (read/write,
  never expires), registered against host `lakay-lakay.turso.io`.

### RSS feeds — VERIFIED
- Google News "Haiti" RSS: 200, valid RSS.
- The Haitian Times feed: 200, RSS.
- Le Nouvelliste feed.xml: 200, RSS (after 301 from /feed/).
- AyiboPost /feed/: returns the HTML homepage, no RSS. Not used.
- Miami Herald Haiti: no answer from this VM. AP: 403. Reuters: 401.
  None of them are used.
- Wikimedia Commons search API: 200, returns upload.wikimedia.org
  image URLs. Used for safe-source news pictures.

### Local server tests (placeholder token, so DB calls fail by design)
- `tsc -p tsconfig.json`: clean, zero errors.
- Server boots, `GET /healthz` -> 200 `{"ok":true}`.
- `GET /` -> 200, serves the Lakay client (722-byte index.html shell).
- `POST /actions` unknown action -> 400 `{"error":"action 'nope' is not defined"}`.
- `POST /actions listDailyArticles` with bad token -> 200
  `{"error":"Failed query: select ... from \"daily_articles\" ..."}` (clean
  error, no crash).
- `GET /healthz/db` with bad token -> `{"ok":false,"db":"error",...}`
  (fixed a false-positive: a bare `db.select()` with no `.from()` never
  executes in drizzle, so the check now uses `db.all(sql`SELECT 1`)`).
- `POST /cron/news` without secret -> 401. With secret -> started:true,
  journalist round ran in background, aborted cleanly at the DB read
  with the 400 InvalidToken error, server stayed up.

## What was built

`~/workspace/goals/lakay-app-for-the-haitian-diaspora/hidden_files/public-host/`
- `src/actions.ts` (verbatim Lakay actions, 96 actions, import rewritten
  to the shim), `src/schema.ts` (verbatim), `src/shim.ts`, `src/ctx.ts`,
  `src/journalist.ts`, `src/server.ts`, `migrate.mjs`, `package.json`,
  `tsconfig.json`, `render.yaml`, `.env.example`, `README.md`,
  `public/` (built client + Lakay's own images), `drizzle/` (28 SQL files
  copied from the artifact), `dist/` (compiled output).
- `npm install` works in the VM (25 packages). `npm run build` works.

## Design decisions

- Same action code, new runtime: drizzle-orm + @libsql/client/web
  (pure fetch, no native bindings) against Turso, so the 5,056-line
  actions file did not need a rewrite.
- Gemini replaces Muse inference for translations and news rewrites.
  Same zod schemas, same retry behaviour in the actions themselves.
- Blobs on local disk (`./data/blobs`, served at `/blobs/*`). Ephemeral
  on free Render; noted as a later upgrade.
- Journalist is RSS-only (Google News Haiti, Haitian Times,
  Le Nouvelliste). No X/Twitter lane. Pictures: Wikimedia Commons or
  Lakay's own citadelle image. Never a news-site photo.
- Admin lock, no-outbound-links, plain-text source credit, bad-word
  blurring: all unchanged, they live in actions.ts.

## Not done / next steps

1. Pouchon submits a fresh, correct Turso database token via a new
   Secure Vault link registered for host `lakay-lakay.turso.io`.
2. Verify with `libsql.py "SELECT 1 AS ok"`, then run `migrate.mjs`.
3. Put this folder in a git repo and create the Render web service
   (README.md has the exact dashboard steps and env vars).
4. Test the live link end to end (healthz, healthz/db, sign-up, post,
   news round by hand), then create the 7 cron-job.org jobs.
5. Migrate existing Lakay content (members, stories, news, owner
   message) from the Muse app into Turso; the public host starts empty
   otherwise. Needs the admin-verified read actions and the two member
   accounts handled (recreate or migrate password hashes).
6. Play .aab packaging is out of scope for this task; it waits on the
   live link plus the existing Play Console entry (com.lakay.app).

## Update 2026-11-11 ~07:30 EST — token works, real migration applied, local e2e passes

### Turso token — FIXED
- New credential `custom.turso-lakay` verified working: `SELECT 1 AS ok`
  returns ok=1 against `lakay-lakay.turso.io` (HTTP 200).
- Old `custom.turso` is dead (400 `JWT error: InvalidToken`) and marked
  SUPERSEDED in its CONNECTOR.md. Use `custom.turso-lakay` everywhere.

### Schema — the first tables were the WRONG SHAPE (found by local e2e test)
- The tables created earlier came from hand-written `schema.sql`
  (`~/workspace/lakay-public-host/schema.sql`), inferred from the
  actions, not from drizzle. Mismatches: `members.password_hash` vs
  `pw_hash`, `created_at` TEXT vs INTEGER, `stories` with different
  columns, and 5 tables missing entirely (`hidden_news`,
  `lakay_articles`, `message_comments`, `supporters`,
  `trivia_translations`). Every DB-backed action failed
  (`listDailyArticles`, `registerMember`, `listStories` all returned
  "Failed query"). The journalist round also aborted on
  `no such table: hidden_news`.
- Fix: the database was empty (0 rows in every table, only the
  `_lakay_migrations` marker rows), so all tables were dropped and
  the real drizzle migrations 0001–0027 were applied with
  `migrate.mjs` (token passed via the `custom.turso-lakay` surrogate,
  never written to a file/log). Exit 0, all 27 applied. Verified:
  exactly the 32 tables in `src/schema.ts` + `_lakay_migrations`
  (27 rows); re-running `migrate.mjs` skips everything (idempotent).
- Do NOT re-apply the old `schema.sql`. It is the wrong shape.

### Local end-to-end test (server on localhost, real Turso + Gemini) — PASSED
- `GET /healthz` 200 `{"ok":true}`; `GET /healthz/db` 200
  `{"ok":true,"db":"ok"}`; `GET /` 200 serves the client.
- `listDailyArticles` (en) returns `{"articles":[]}`.
- `registerMember` (test account) ok:true; `signInMember` ok:true.
- `addStory` returned id 1; `listStories` returned it with the
  member's name as author.
- `POST /cron/news` without secret: 401. With secret: started:true.
- Journalist round (RSS-only): 58 candidates, 3 posts saved
  ("President Bukele Eyes Haiti Gang Offensive Ahead of Election",
  "Will Mauricio Pochettino Coach the USMNT Against Haiti?",
  "McTominay Discloses Health Scare Ahead of Haiti Match"), round
  finished cleanly, server stayed up.
- Test member + test story deleted afterwards. DB now: 0 members,
  0 stories, 3 real news posts (kept as seed news for first visitors).

### Git repo — committed locally, NO remote yet
- `git init -b main`, commit `c0425c5` "Lakay public host: server,
  client, migrations, Render blueprint", 50 files. No secrets in the
  commit (grep clean; `.env`/`node_modules/`/`dist/`/`data/`
  git-ignored). No remote: `gh` on the VM is not logged in and the
  GitHub connector is not connected, so Muse cannot create the repo
  or push. BLOCKED on Pouchon: create empty public GitHub repo
  `lakay-public-host`, then the push + Render service creation.

## Update 2026-11-11 ~07:40 EST — push blocked, GitHub connector not connected

- Repo VERIFIED exists and empty: https://github.com/lakayapp/lakay-public-host
  (id 1453959545, public, owner lakayapp, default branch main, size 0,
  no branches, created 2026-11-11T12:36:36Z).
- Local code ready to push: branch main, commits c0425c5 + 6733007,
  50 files, clean tree, no remote, no secrets in commit.
- PUSH BLOCKED: GitHub connector `not_connected`
  (`/opt/hatch/bin/github status`), `gh` not logged in, no token
  available and none invented/asked for. Needs Pouchon to authorize
  the GitHub connector: https://agent.meta.ai/connectors/connect/github
  (pick lakayapp), then install the Muse GitHub App on
  lakay-public-host. After that, push + Render service creation can
  proceed immediately.
- Render service NOT created (repo is empty, so a deploy now would
  have nothing to build). Credential re-verified working:
  list-services HTTP 200, 0 services; owner
  tea-dbq3hh8ae00c73d77llg, lakayapp@gmail.com, "My Workspace".
- Turso re-verified: SELECT 1 ok=1 (custom.turso-lakay).
  Gemini re-verified: list-models HTTP 200 (custom.google-ai-studio).
- Live link NOT tested, cron jobs NOT created (both wait on a live
  URL + CRON_SECRET). Content migration untouched, still open.
- Caution for deploy: Render also needs its own GitHub connection
  (GitHub App) to pull the repo; for a public repo the API may accept
  the repo URL alone, for private it definitely needs linking first.
  Test at service-creation time.

## Update 2026-11-11 ~07:45 EST — push BLOCKED on GitHub App install (403)

- GitHub OAuth CONNECTED as lakayapp (id 355341300, verified via get_me).
  Repo searchable, exists and empty (409 "Git Repository is empty").
- Snapshot push FAILED at initialization, not at file validation:
  `failed to initialize repository: failed to create initial file:
  PUT .../contents/README.md: 403 Resource not accessible by integration`.
  Cause: the Muse GitHub App (meta-muse-ai) is NOT installed on
  lakay-public-host. OAuth alone is not enough.
- Unblock: Pouchon opens https://github.com/apps/meta-muse-ai/installations/new
  and installs the app on lakay-public-host (or All repositories), then
  the push can be retried. Render service NOT created (repo empty).
- Separate known issue for the retry: the full 50-file snapshot is
  rejected by the CLI validator because 4 .webp images are not UTF-8
  (`public/assets/citadelle-7r14sc6w.webp`, `public/assets/konpa-90r4w1d8.webp`,
  `public/citadelle.webp`, `public/konpa.webp`). A 46-file UTF-8-only
  manifest is ready at `../public-host-manifest-utf8.paths`; the 4 images
  need a separate upload path (create_or_update_file) or will be missing
  from the first deploy.
