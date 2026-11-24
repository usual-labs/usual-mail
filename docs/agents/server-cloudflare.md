# Server on Cloudflare

**All seven steps of the build plan are built (2026-11-21); step 7 is the docs, with a Deploy button that can't work
until the repository is public under a licence.** Step 3's
`mail/` changes landed in `mail/` ([mail.md](mail.md)); steps 4 and 5, the host's limits, start-up, pictures and site
icons, are in [server-cloudflare-limits.md](server-cloudflare-limits.md); step 6, the front Worker, the address, the
Google client, the owner's code, the per-address count, the variables and the time zone, in
[server-cloudflare-access.md](server-cloudflare-access.md). Step 1 keeps every
statement within 100 parameters ([decisions.md](decisions.md)); step 2 is the Worker, its Durable Object, the root
`wrangler.jsonc` and `package.json` and the workerd tests ("Built: step 2", next). Built and tested in local workerd;
**first deployed to a real account on 2026-11-23** ("Checks still open", "Seen on the first deploy"); no request to
Google yet.
The rest is the design (2026-11-21, revised after an independent review; the owner decided its four questions the
same day): how the server in [server.md](server.md) runs in a person's own Cloudflare account, deployed with a "Deploy
to Cloudflare" button. Each fact is labelled **docs** (Cloudflare's or Google's documentation, read 2026-11-21),
**local** (checked in local workerd, in the spike or step 2's tests) or **unverified**; **Proposal** is still to be
built, **Settled** marks the coordinator's engineering decisions of 2026-11-21 and **Decided** the owner's (below,
"Decided by the owner"). "The spike" ran in scratch folders outside the repository.

## The recommendation in short

- **One Worker and one SQLite-backed Durable Object for the whole server.** The Worker forwards every request to the
  object named `server`, which holds one `MailServer` as the Node process does. Not one object per inbox: Home,
  counts, search and the triage queue span inboxes, and `Ctx` keeps state in memory that one process must own.
- **Durable Object SQLite, not D1,** through Drizzle's `durable-sqlite` driver (in Drizzle 0.45.4) and the same
  `server/migrations/`. Bodies stay in SQLite; the picture cache is a table of the same store, not R2.
- **The shared code needs SQL fixes first** (the 100-parameter limit, eager raw statements), then a `src/cloudflare/`
  host. **Gmail only** (Settled), with two small `mail/` changes: a `./gmail` export and oversized-message handling.
- **Live updates stay server-sent events**, served from the object. Timers stay in memory as on Node; the object's
  one alarm restarts the server after an eviction or a deploy.
- **Deployed from this repository's root** (Decided): a root `package.json` and `wrangler.jsonc` the button reads.
- **Workers Paid is required.** A one-person server should cost the $5 minimum a month for a year or two.

## Built: step 2 (2026-11-21)

**Files.** At the root: `package.json` (private, `usual-mail-cloudflare`; exact dev dependencies wrangler 4.158.0,
miniflare 5.20261104.0-beta (wrangler's own line), `@cloudflare/workers-types` 5.20261104.1, typescript 7.0.2,
`@types/node` 22.20.5 and `@types/sanitize-html` 2.16.2), `package-lock.json`, `wrangler.jsonc`. In `server/`:
`src/cloudflare/` (`worker.ts` the front Worker, `object.ts` the Durable Object `UsualMailServer`, `database.ts` the
adapter and migrator, `timers.ts`, `owner-code.ts`, `secret-key.ts`, `parts.ts`, `env.ts`; `migrations.generated.ts`
written, gitignored), `scripts/cloudflare-prepare.mjs`, `tsconfig.cloudflare.json`, and `test/cloudflare/`
(`harness.ts`, four `*.test.ts`, `worker/entry.ts` the test entry, `tsconfig.json`). `tsconfig.json` and
`tsconfig.node.json` leave `src/cloudflare` (and the node one `test/cloudflare`) out. `server/package.json`, the
Dockerfile and `.dockerignore` are unchanged; `.gitignore` gained `.wrangler/`, `.dev.vars*` and the generated module.

**Install and deploy:** from a clone with no `node_modules` anywhere, `npm ci` then `npx wrangler deploy` (or `npm run
deploy`). `cloudflare-prepare.mjs` runs as the root's `postinstall` and `build`, as `wrangler.jsonc`'s `build.command`
before every bundle, and first in `check:cloudflare`: it installs each part the server names as `file:../` (core, mail,
dashboard, mcp) and the server from their own lockfiles with `npm ci --omit=dev`, as the Dockerfile does, **only where
`node_modules` is missing** (a developer's installs are never replaced), then writes `migrations.generated.ts` from
`server/migrations/` (the journal and each file's SQL as `m<idx>`). **Local proof:** the files a clone would have
(`git ls-files -co --exclude-standard`) copied to a scratch folder; `npm ci` installed the root and all five folders
(about 4 s with npm's cache); `npx wrangler deploy --dry-run --outdir …` built it; `npm run check:cloudflare` there
passed too. Docker didn't answer on this Mac; the Dockerfile's build stage, run by hand on a copy of what
`.dockerignore` lets in (no root files), bundled and its `smoke-bundle.mjs` passed.

**`wrangler.jsonc`:** `main` `server/src/cloudflare/worker.ts`; compatibility date 2026-11-04 (workerd 1.20261104.1);
`nodejs_compat` and `global_fetch_strictly_public`; `workers_dev: true`, `preview_urls: false`; binding `SERVER` to the
SQLite class `UsualMailServer`, migration tag `v1`; `observability` on with `logs.invocation_logs: false`;
`limits.subrequests: 1000000` (the maximum is 10 million; docs) and no `cpu_ms`; no `vars`, no secrets, no
`.dev.vars.example`. `wrangler deploy --dry-run`: **5,358.70 KiB, 1,212.04 KiB gzipped**, one module importing only
`node:*` (and `fs`, `path`, `url`) and `cloudflare:workers`; `wrangler check startup`: 63 to 112 ms of CPU active over
two local runs (limit 1 s).

**What runs:**
- **The front Worker** refuses any URL that isn't `https:` with 403 and core's error shape (`forbidden`, "only over
  HTTPS") before anything reads `Authorization`, drops `X-Forwarded-Host`, and forwards everything else to
  `getByName("server")`. Step 6 added the rest ([server-cloudflare-access.md](server-cloudflare-access.md)).
- **The object:** every request and alarm waits on its start (`start.ts`, from step 4): the migrations
  (durable-sqlite migrator, one transaction), the host's tables, the alarm read, the Host, `MailServer.create`,
  `start()`, the REST app (the connector at `/mcp`, the dashboard at the root), the start line, `keepOwnerCode` with
  the table's code as `kept`, then the alarm. A failed start answers 503 with core's `internal` error and resets the
  object; repeated failures back off ([server-cloudflare-limits.md](server-cloudflare-limits.md)). An instance whose
  first event is an alarm logs that its alarm started it.
- **The adapter** (`openDatabase`): `batch` runs every statement inside one `transactionSync` (a builder through its
  prepared query's `execute().sync()`); `db.run/all/get/values(sql…)` return a statement that runs when awaited or when
  its batch runs, as libSQL's do. It is cast to the existing `Database` type; `src/db/index.ts` is unchanged.
- **The Host:** `systemClock`, `webRandom`, `MemoryEventBus` (SSE served from the object), `consoleLog`, AES-GCM with
  the Worker secret `USUAL_MAIL_SECRET_KEY` when set (empty counts as unset), else a key made at the first start and
  kept in the object's synchronous KV storage as `usual-mail-secret-key`. The limits, pictures and site icons are
  steps 4 and 5's ([server-cloudflare-limits.md](server-cloudflare-limits.md)); the time zone, Google sign-in and the
  first sync's window step 6's ([server-cloudflare-access.md](server-cloudflare-access.md)).
- **Timers** (`timers.ts`): `setTimeout` clamped to 2^31−1 ms; the alarm is kept at most 60 s ahead **while the
  server has an inbox** (not "or queued work": mail work belongs to an inbox; without one, timers such as the owner's
  code's expiry or a gateway cost lookup wait for the next start), so an unpaired server isn't woken every minute. Setting a timer arms it only when none is set (connecting the first inbox); each start and each alarm calls
  `keep()`. The alarm is read before the server sets any timer, and a set alarm (even one due now) is never
  overwritten: overwriting the alarm being delivered cancels its handler (known-issues.md). The REST event stream's
  keep-alive uses plain timers.
- **Parts:** Gmail only, from `@usualmail/mail/gmail` with `GMAIL_SMALL_MEMORY`'s 2 MiB size limit and **one gate**
  (`createGate(2)`) that every Gmail provider in the object shares, made once per object instance (not at module scope,
  so a reset object never inherits turns its predecessor held): all inboxes sync at once in the one object, so the bound
  on messages in memory is the object's. No `fetch` is passed (the global one). No ImapFlow or SMTP client in the
  bundle.
- **The owner's code:** `owner_pairing_code (id INTEGER PRIMARY KEY CHECK (id = 1), code, expires_at)`, plain text;
  written when a code is made (a new one replaces it), read back at every start as `kept`, deleted when a person
  pairs. The log never holds the code: "An owner's pairing code is waiting, until …; it isn't written to the log." (or
  "made at an earlier start is still waiting"), then where to read it (Durable Objects, this Worker's namespace for
  `UsualMailServer`, Data Studio, the object `server`, the table) and `POST /v1/pair`.

**Types:** `tsconfig.cloudflare.json` checks `src/cloudflare` and the test entry with `@cloudflare/workers-types`
**and** `@types/node` and the `webworker` lib. Workers' types alone fail on shared code that is right at run time
(dashboard's `TextEncoder().encode` as `Uint8Array<ArrayBuffer>`; mail's `globalThis.crypto`, which Workers' types
declare as a `const`), so Workers-only APIs (Durable Object state, storage, SQL, `ExportedHandler`) are checked against
Workers' types, but not that every web API the shared code uses exists in workerd: the workerd tests cover that.
`test/cloudflare/tsconfig.json` checks the Node-side tests with Node's types.

**The workerd tests** (`npm run check:cloudflare` at the root: the generator, both type checks, then `node --test`
over `server/test/cloudflare/*.test.ts`; about 10 s). The harness builds the test entry with `wrangler deploy
<entry> --dry-run --outdir <temp>` (so wrangler's bundling and build step are the deploy's) and runs it in Miniflare;
Google's two hosts go through Miniflare's outbound service to mail's `FakeGmail` in the test process, anything else is
refused and noted. The test entry adds `POST /__test/sql` (Data Studio's reads), `POST /__test/evict` (`ctx.abort`),
`GET /__test/alarm`, a 1.5 s backstop and an unlimited Gmail quota. All passed on 2026-11-21 (11 tests):
- `server.test.ts`: start and all 19 migrations (`__drizzle_migrations`, the tables, `PRAGMA foreign_keys` 1), the
  code in the table and in no log line; pairing with the table's code, the row gone, the code refused again; `/v1/me`,
  `/v1/home`, `/v1/counts`, `/v1/search`, `/v1/ai/status`, `/v1/search/ask`, the dashboard's `/sign-in`, REST without
  a token 401, `/mcp` without a token 401; plain http 403 with and without a token (pairing too), and a form from
  another site with `X-Forwarded-Host` refused by the dashboard; `/v1/events` delivering `inbox.changed` and
  `thread.changed` while three Gmail messages sync.
- `restart.test.ts`: no alarm before pairing; a reset before pairing keeps the same code and expiry (no new code, the
  log says it waits) and the first code pairs; with an inbox the alarm is armed within the backstop, and after a reset
  the alarm alone (no request) starts the object again, which reaches Gmail and syncs mail delivered meanwhile.
- `gmail.test.ts`: three small messages, then one of 30.0 MB (a 22 MB attachment) through the minimal and full forms
  only, no attachment downloaded, stored with its attachment's size; **workerd's resident memory grew 4 MB** (158 to
  162 MB) while syncing it, against 101 to 350 MB in the spike's raw form. 150 threads: `GET /v1/search?q=…&limit=150`
  (a page of 150 ids, each with its excerpt) and `POST /v1/actions` marking 150 read, its write-back reaching the fake;
  the control: this workerd refuses a statement with 101 parameters. Two inboxes (a second fake account) syncing at
  once: the second listed its mail while the first's 20 messages were still being fetched, its messages waited for the
  shared gate, and no more than two message requests were in flight across both (with a gate per provider the test
  fails).
- `bundle.test.ts`: the deployable bundle (wrangler.jsonc's `main`) has none of the test entry's hooks, no ImapFlow,
  SMTP client, hoodiecrow or `FakeGmail`, imports only workerd's modules and exports `UsualMailServer`; the test
  entry's bundle does carry its hooks.

**Not verified:** anything on Cloudflare itself (the Deploy button and Workers Builds, the 128 MB isolate, CPU and
subrequest accounting for background work, that a real eviction or deploy is followed by the alarm as in Miniflare,
Data Studio's view of the table, a Free account); memory is measured as workerd's whole process, not the isolate; an
attachment opened through the server (`fetchAttachment` holds it whole) wasn't tried in workerd.

## What the spike showed

All **local** (wrangler 4.152.0, workerd 1.20261019.1, compatibility date 2026-10-20, `nodejs_compat`):

- `wrangler deploy --dry-run`: **5,343.59 KiB, 1,198.76 KiB gzipped**, no ImapFlow; `wrangler check startup`: 75 ms of
  CPU (limit 1 s). The object booted the server in 23 ms on an empty store; all 19 migrations applied through the
  durable-sqlite migrator, FTS5 with 0018's tokenizer, prefixes, `bm25` and `snippet` worked; `PRAGMA foreign_keys`
  is 1. Pairing, info, Home, counts, search, AI status, the dashboard's `/sign-in`, `/mcp` (401) and `/v1/events`
  answered.
- **Transactions:** a throw inside `transactionSync`, and a foreign-key failure inside it, both undid a row written
  before them. (The first draft's rollback check couldn't fail: it updated a row that didn't exist.)
- **Foreign keys can't be turned off:** `PRAGMA foreign_keys = OFF` left it at 1, outside and inside a transaction. A
  drizzle-kit table rebuild run as the durable migrator runs it deleted both child rows of the rebuilt parent, also
  with `PRAGMA defer_foreign_keys = ON` (below, Migrations).
- **A fake Gmail sync of 300 HTML messages** (mail's `FakeGmail`): stored, threaded, indexed, pictures rewritten to
  the picture route, a tracker removed; a draft went out through Nodemailer's `MailComposer`. Broke: `inArray` over
  more than 100 values ("too many SQL variables"; 100 passes, 101 fails) in the write-back, and `SearchIndex`, whose
  `db.run(sql)` ran at once outside its batch and left orphan FTS rows; a lazy adapter fixed the second. "Sender
  pictures: the backfill stopped" in the log fits backfill's 500-id `inArray`.
- **One message of 30 MB** (`FakeGmail` served from a separate Node process on 127.0.0.1, so its own memory stayed
  outside workerd; five small messages and one raw message of 30.1 MB with a 22 MB attachment; Gmail's answer was
  40.14 MB of JSON): the workerd process grew from 101 MB to a peak of **350 MB** while syncing it. Local workerd
  didn't stop it; on Cloudflare an isolate gets 128 MB (docs), so this one message would reset the object, and the
  sync, which keeps its cursor only after a batch, would fetch it again at the next start, forever.

## Storage

- **Durable Object SQLite** (docs): 10 GB per object on Paid, 1 GB on Free; rows (all columns together) up to 8 MB;
  statements up to 100 KB; **at most 100 bound parameters**; FTS5 and JSON; `sql.exec` refuses `BEGIN`/`SAVEPOINT`,
  transactions go through `transactionSync`; output gates hold a response until its writes are durable; Data Studio
  reads and writes every table (Editor access to the Worker); point-in-time recovery to any moment of the last 30
  days, through code.
- **Not D1:** the server would still need the object for timers, memory and the event stream, and each of the
  service's many small awaited queries would cross the network. **Not one object per inbox:** it would mean splitting
  `MailService`. Neither gains anything for one person.
- **The driver:** awaiting a query builder works on the synchronous driver (`execute` is async). The host's adapter
  emulates `batch` with `transactionSync` and wraps `db.run/all/get/values(sql…)`, which execute at once in sync mode
  (Drizzle's `sqlite-core/db.js`), so they run when batched or awaited as on libSQL (built, `src/cloudflare/database.ts`).
  `src/db/index.ts`'s `Database` type, which names libSQL's `batch`, is unchanged: the adapter is cast to it.
- **The 100-parameter limit is a shared-code fix (built in step 1; [decisions.md](decisions.md)).** The audit for step 1: 49 `inArray` and 1 `notInArray`
  outside `src/node/`; raw `IN (${sql.join(…)})` lists in `search/excerpt.ts` (lines 33, 93, 105; the first up to a
  page of thread ids); multi-row `values` in `search/indexer.ts` (`search_people`, 7 columns) and `service/store.ts`
  (`senders`); 500-sized chunks in `ai/ask-again.ts`, `service/inboxes.ts` and `avatars/backfill.ts`. Unbounded lists
  become one `IN (SELECT value FROM json_each(?))` parameter (local: 5,000 ids fine; works on libSQL), multi-row
  inserts chunk to `floor(100 / columns)` rows, chunks stay inside one `runBatch` so they still land together, and a
  test-only wrapper of libSQL's client (not a Drizzle logger: `batch` never calls it) fails any statement over 100
  parameters across the Node suite. Step 2's workerd test binds 150 thread ids in a search page and an action.
- **Migrations (built):** the same frozen files, as a generated module for the durable-sqlite migrator
  (`migrations.generated.ts`, written by `scripts/cloudflare-prepare.mjs`), run first in the object's start (since
  step 4 not inside `blockConcurrencyWhile`). **Gotcha** (local, above; also in [known-issues.md](known-issues.md)): libSQL's
  `migrate` turns foreign keys off around its transaction, the durable migrator can't, so a future table rebuild would
  cascade-delete rows on Cloudflare only. None of 0000 to 0018 rebuilds a table. **Proposal:** a migration never
  rebuilds a table that others reference with `ON DELETE CASCADE` (it adds columns, or copies the children aside and
  back in the same file); built: `server/test/migration-replay.test.ts` replays every migration on a filled store
  inside one transaction with foreign keys on, as the durable migrator does.
- **Bodies** stay in `messages.text` and `.html`, their text once more in FTS; attachments are never stored. Text and
  HTML share the 8 MB row: **built (step 4)**, a stored message is kept within 1,900,000 bytes, its HTML left out or its
  text cut over that ([server-cloudflare-limits.md](server-cloudflare-limits.md)).
- **Pictures from the web:** R2 needs its own subscription checkout (docs), which the Deploy button can't do. The
  cache lives in two tables the Cloudflare host owns (parts of at most 1 MB, Node's 256 MB cap, its records and
  retries; built in step 5).
- **The ceiling (Settled):** 10 GB, accepted; the status's warning from 8 GB is **not built** (the guide says nothing
  warns yet); real-sized mail is measured later. At 150 messages a day, years; at 1,000 a day, about one. Writes then fail with `SQLITE_FULL` (docs).
- **Memory (the caps live on `Host` in `host.ts`; built in step 4):** an isolate gets 128 MB (docs). Node's caps were
  sized for a Mac: served picture plans up to 24,000,000 characters (`MAX_KEPT_CHARS`), sync batches of 200 whole
  messages, a picture up to 10 MB, the stored body. `HostLimits` is optional, Node's values by default; the Cloudflare
  host passes 4,000,000 characters, batches of 25 and messages of 1,900,000 bytes (the plan said 50 and 4 MB:
  [decisions-cloudflare.md](decisions-cloudflare.md)), search bodies read 1,000,000 characters a round, and two pictures
  fetched at once. Oversized messages are a `mail/` fix (Libraries).

## The host seams on Workers

- **Clock and Random:** `systemClock` (Workers' clock moves only between I/O; the code copes with a stopped clock) and
  `webRandom`. Neither in global scope: workerd refuses random values and timers there (local).
- **Scheduler (built in step 2):** timers stay `setTimeout`, clamped to 2^31−1 ms as `src/node/host.ts` does. Facts (docs): a
  pending `setTimeout` keeps an object in memory (for up to 15 minutes each, from compatibility date 2026-10-01); an
  idle object is evicted after 70 to 140 s; each request or alarm gives it 30 s of CPU; one alarm per object, each
  `setAlarm` a written row. While the server has an inbox, the host keeps the alarm at most 60 s ahead (read before
  any timer is set, and never overwritten while set, since that cancels a handler being delivered): each alarm tops up CPU and, after an eviction or a deploy, recreates the object, whose `start()` re-arms
  everything durable. Lost then, as on a Node restart: waiting Google sign-ins, pairing failures, write-backs held while
  paused. The REST event stream's keep-alive uses a plain `setTimeout` scheduler.
- **Start-up (built in steps 2 and 4):** `blockConcurrencyWhile` resets the object on a throw and after 30 s (docs),
  so nothing runs inside it: requests and alarms wait on the start's promise, which runs the migrations first; a failed
  start resets the object and repeated ones back off, a reset during search's first catch-up counting as one. On Node `start()` brings the search index up to date before
  returning; on Cloudflare the catch-up runs after it, in chunks of 20 threads with a turn between them, and a search
  waits for it ([server-cloudflare-limits.md](server-cloudflare-limits.md)).
- **CPU limit (Settled): left at the default 30 s.** The alarm tops it up at least every minute and the work is mostly
  waiting on Gmail and models; `limits.cpu_ms` applies to the whole script, front Worker included, so raising it only
  raises what a stray request can burn. `limits.subrequests` is raised (10,000 per invocation by default; docs), since
  how a long-lived object's background fetches are counted is **unverified**.
- **EventBus:** `MemoryEventBus` in the object. The apps use server-sent events (`UsualMailKit`'s `EventStream`), and
  the object streams them through the Worker (local). Hibernatable WebSockets would save duration only for an object
  that can hibernate, and this one can't.
- **Secrets (built):** `aesGcmSecrets` unchanged. The key is the Worker secret `USUAL_MAIL_SECRET_KEY` when set (it
  wins, as on Node), else made at the first start and kept in the object's KV storage (`usual-mail-secret-key`), as
  Node keeps `secret.key` beside its database.
- **PictureSource and SiteIconSource (Decided: both on, as on Node; built in step 5,
  [server-cloudflare-limits.md](server-cloudflare-limits.md)):** a fetcher under Node's rules where Workers allow (IP
  addresses refused, as Workers can't fetch them; names checked over DNS-over-HTTPS; every redirect checked). It can't
  pin the connection to the checked address, and Workers add a `CF-Worker` header naming the Worker's zone to every
  subrequest (docs); for workers.dev it may name the account's subdomain (**unverified** until a real deploy), so the
  guide advises an account subdomain that isn't the person's name. There is no home network to protect, and sites
  learn a Cloudflare address, not a home one. `global_fetch_strictly_public` (Settled) routes the Worker's own fetches
  as from the internet (docs).
- **Log:** `consoleLog` into Workers Logs (3 days on Free, 7 on Paid; their pricing becomes Observability pricing on
  2026-12-01; docs). **Invocation logs off (Settled):** they record each request's URL and headers (docs), which would
  keep Google's callback code and `state` and `?q=` search words; `observability.logs.invocation_logs: false`.
- **Time zone (Settled; built in step 6):** a Worker's own zone is UTC. The host takes the zone of the request that
  pairs the first person's device (`request.cf.timezone`, which the Worker copies into a header of its own, replacing
  any the client sent), keeps it in the object's storage and logs it; `USUAL_MAIL_TIME_ZONE` overrides it. Right for
  most people with nothing to fill in; behind a VPN it takes the VPN's zone, which the variable fixes. UTC only until
  that pairing.
- **First-sync window (built in step 6):** kept in the object's storage instead of `settings.json`;
  `USUAL_MAIL_SYNC_DAYS` wins.
- **Google client (built in step 6):** a person's paired device sets it through `PUT /v1/google/client`; the host
  implements all of `GoogleOptions`, sealing the client file's text with the server's key in the object's storage;
  the Worker secrets `USUAL_MAIL_GOOGLE_CLIENT_ID` and `_SECRET` are an optional fallback with Node's precedence. Order
  for a person: deploy, pair, set the client, sign in. Details: [server-cloudflare-access.md](server-cloudflare-access.md).

## The owner's code and pairing

- **Kept across evictions (Settled; built in step 2).** `start()` doesn't keep the code; only `keepOwnerCode(listener, { kept })`
  does (`service/devices.ts`; `src/node/main.ts` passes the file's code). Before pairing there is no inbox, so no
  alarm, and the object is evicted after a minute or two idle; without a kept code its next start would make a new one
  and expire the one shown.
- **Read in Data Studio (Decided; the table and the log lines built in step 2, the dashboard's hint and the expired
  code's handling in step 6).** The Cloudflare host writes the code and its expiry, in plain text, to a one-row
  table it owns, `owner_pairing_code`, as Node writes `<data-dir>/owner-pairing-code`; it reads the row back at every
  start and passes it as `kept`, and deletes it when a person pairs or the code expires (a new code replaces it). Not
  sealed: Data Studio needs Editor access to the Worker and shows every table (docs), the secret key in the same storage
  included, so sealing would hide nothing from anyone who can read the row. **Not in the logs:** the log line and the
  start page (a host-given hint on the dashboard's sign-in page, an option of the dashboard's own, not a core change)
  say only that a code waits, until when, and where: the Cloudflare dashboard's Durable Objects page, this Worker's
  namespace for the class `UsualMailServer`, Data Studio, the object named `server`, the table `owner_pairing_code`.
  Data Studio's queries are billed as requests and audit-logged (docs). A workerd test evicts the object before
  pairing, pairs with the first code, and finds the code in no log line.
- **Pairing failures per address (Settled; built in step 6).** The service locks pairing for everyone after ten wrong codes in ten
  minutes (`devices.ts`, `PAIRING_LIMIT`), and the rate-limiting binding can't help: 10 or 60 s periods, counted per
  Cloudflare location, approximate (docs). **Built:** the Cloudflare host counts failed `POST /v1/pair` and dashboard
  `POST /sign-in` answers (401) per `CF-Connecting-IP` (an IPv6 address by its /64), in the object, and answers 429
  after five in ten minutes without passing the request on, so one address never reaches the global ten. The service is
  unchanged on both hosts. **What remains:** a few addresses together can still lock pairing for a while (existing
  devices keep working); a code of 40 bits can't be guessed through the lock either way.

## The server's public address

Google's redirect address is `<public address>/v1/google/callback`. A workers.dev address is known only after the
deploy, and the Deploy form lets the person rename the Worker. Facts (docs): a Worker is reached only through
hostnames routed to it (that a mismatched `Host` never reaches it is **unverified**); `preview_urls: false` turns off
version addresses; branch Previews made by Workers Builds get their own Durable Object namespace and storage, so they
are separate, empty servers. (`.dev` is on browsers' HSTS preload list, so browsers reach workers.dev over HTTPS only;
apps and scripts still need the Worker's refusal of `http:`.)

**Decided: from each request's own host, never stored.** The object's request wrapper keeps the request's host for
the length of that request (`AsyncLocalStorage`, which `nodejs_compat` provides), and the host's redirect address is
`https://<that host>/v1/google/callback` only when the host is the Worker's own workers.dev address (with version
addresses off, the only workers.dev host Cloudflare routes to it) or the host of `USUAL_MAIL_PUBLIC_URL` (a custom
domain); any other host, and any moment outside a request, gives none, which `ServerInfo` reports as the missing
`address`. Nothing is written down, so a renamed Worker or a new custom domain needs no step. The unverified fact
above is checked on the first real deploy before this is relied on; should it fail, the variable alone applies.
**Built in step 6** (`src/cloudflare/address.ts`; the Worker doesn't learn its workers.dev name, it accepts any host
of the one shape routed to it, `<worker>.<subdomain>.workers.dev`). **The contract amendment is made:**
`docs/contract-sync.md`, "Connecting Gmail by signing in with Google", its address bullet and its "Safety" bullet now
name the exception for hostnames Cloudflare routes to the Worker.

## Libraries and parts

- **Gmail only (Settled).** The apps still offering IMAP and failing with the server's words is accepted; telling them
  which providers exist is in [improvement-ideas.md](improvement-ideas.md). IMAP would need ImapFlow on Workers' TCP
  sockets (port 25 refused; docs) and a spike of its own.
- **`mail/` changes in scope (Settled), each tested on Node:** a `./gmail` export (the provider and
  `GoogleTokenError`), so `src/cloudflare/parts.ts` never imports `src/index.ts` and ImapFlow; and **oversized
  messages:** `fetchMessages` asks for a whole batch with `format=raw` under one `Promise.all`
  (`gmail/messages.ts:71`), and an attachment fetches the whole raw message again (`:101-103`). **Proposal:** convert
  each message as it arrives; take each message's `sizeEstimate` first (a `format=minimal` or `metadata` request,
  20 units in the provider's cost table against 60 for raw; which form carries it is to confirm); fetch one over the
  host's cap without its attachments' bytes (Gmail's `format=full`); serve attachments through
  `users.messages.attachments.get`. `FakeGmail` learns both.
- **`nodejs_compat` covers the rest** (local: bundled and ran): postal-mime, htmlparser2, sanitize-html with postcss
  (the shared `src/pictures/present.ts` already pulls them in), `MailComposer`, `node:crypto`'s `createHash`.

## Repository layout and tooling

The Deploy button (docs): Workers only; a public GitHub or GitLab repository; it **copies** the repository (or a
self-contained subdirectory) into the person's account as a new repository, **not a fork**, connects Workers Builds,
which **deploys every push** to it, and runs `package.json`'s `build` and `deploy` (default `npx wrangler deploy`); it
provisions Durable Objects from the Wrangler file and shows `vars` and the secrets of `.dev.vars.example` in its form.
**Built:** no `.dev.vars.example` at all, so the form asks for no secret (check (c) below).

**Decided: the repository's root.** The owner accepted a root manifest beside the one-package-per-folder rule:

```
wrangler.jsonc        the Worker: main server/src/cloudflare/worker.ts; nodejs_compat and global_fetch_strictly_public;
                      workers.dev on, preview_urls false; invocation logs off; limits.subrequests; the object's SQLite
                      class (UsualMailServer); build.command runs cloudflare-prepare.mjs; keep_vars true, so the
                      variables set in the Worker's settings (public address, time zone, first-sync days) survive
                      each deploy; none in the file
package.json          a deploy and tooling manifest, no workspaces: wrangler, miniflare and the type packages as exact
                      dev dependencies; postinstall and build (server/scripts/cloudflare-prepare.mjs: installs the
                      missing part folders as the Dockerfile does, writes the migrations module), deploy (wrangler
                      deploy), check:cloudflare (both type checks and the workerd tests). Not yet: descriptions of the
                      variables for the Deploy form (cloudflare.bindings)
package-lock.json     its lockfile
server/src/cloudflare/            Worker, object, adapter, start, timers, limits, owner's code, secret key, parts,
                                  address, Google client, pairing, settings; web/ (pictures, site icons)
server/tsconfig.cloudflare.json   src/cloudflare and the test entry with Workers' and Node's types; src/cloudflare left
                                  out of tsconfig.json and tsconfig.node.json
server/test/cloudflare/           node:test with Miniflare (harness.ts, *.test.ts, worker/entry.ts the test entry,
                                  tsconfig.json), run from the root's check:cloudflare
```

`server/package.json` gains nothing, so the Docker build is untouched: `.dockerignore` lets in only the part folders,
the build stage installs no wrangler, and `scripts/build.mjs` keeps bundling `src/node/main.ts`. Updates: the person's
copy is not a fork, so an update is a manual merge of this repository's changes into it, and each push deploys; later
the Mac app could deploy new versions through Cloudflare's API.

## Plan, cost and limits

**Workers Paid is required.** Free (docs): 10 ms of CPU and 50 subrequests per invocation, 1 GB per object. Paid
(docs): $5 a month minimum; Workers 10 million requests and 30 million CPU ms included; Durable Objects 1 million
requests and **400,000 GB-s per account** (billed at 128 MB while the object is in memory), then $12.50 per million
GB-s, **with billable usage rounded up to the next million**; SQLite 25 billion rows read, 50 million written and 5
GB-month included, then $0.001 and $1.00 per million rows and $0.20 per GB-month.

For three Gmail inboxes, 150 messages a day, polls each minute, the app open ten hours a day, AI calls billed by the
person's own provider: the object in memory all month takes about 330,000 GB-s, about 120,000 object requests, 70,000
Worker requests, a million rows written, 0.3 GB more storage a month (to measure). So **$5 a month** until 5 GB stored,
then $0.20 a GB-month. Any other Durable Object use in the account shares the 400,000 GB-s; going over at all adds at
least $12.50. A Durable Objects spending limit **pauses the objects** when reached (docs), which stops the mail server;
the guide suggests an alert instead.

## Hardening and the security boundary

- **The Worker in front (built in steps 2 and 6, grown after their review):** refuses plain `http:` before reading
  `Authorization` (Settled); then, before waking the object, a body without Content-Length on `/v1/*` or in a dashboard
  POST (411) and `/v1/*` without a `Bearer umt_` token but for `GET /v1/info`, `POST /v1/pair` and the Google callback;
  copies `CF-Connecting-IP` and the time zone into headers of its own, dropping any the client sent; drops
  `X-Forwarded-Host` (the dashboard's own-site check accepts it); answers a failing object in core's error shape; adds
  `Strict-Transport-Security`, `nosniff`, framing, referrer, CSP and `no-store` headers where the server set none.
  Not built: `/healthz` answered by the Worker ([server-cloudflare-access.md](server-cloudflare-access.md)).
- **Already in the code:** tokens and codes looked up by SHA-256, Google's `state` kept as its hash, the dashboard's
  form tokens compared in constant time, its cookies `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-`, its CSP; no
  CORS headers on REST; agents' tokens only at `/mcp`. The Cloudflare entry has no demo or development switches.
- **The dashboard stays on the public server (Settled):** it is how a person without the Mac app sets things up, it
  takes no credential beyond the pairing code and the device token, runs no script and checks every form; its sign-in
  shares the per-address count above.
- **What workers.dev lacks:** no WAF or rate-limiting rules (they need a zone of one's own). A workers.dev name is easy
  to guess and the `CF-Worker` header names the zone to every picture host; nothing relies on the name being secret.
- **The boundary moves:** on a Mac it is the machine; here it is **the Cloudflare account and the person's repository
  copy**. Anyone with Editor access to the Worker can read every table in Data Studio (the waiting owner's code, the
  stored key and the sealed credentials included, so they can open them) and insert a device row; anyone who can push
  to the copy deploys code.
  The guide says so, and recommends the secret-key Worker secret, two-factor sign-in on both accounts and keeping
  Workers Builds' preview builds off (each makes a separate, publicly reachable server).
- **Localhost assumptions found:** the loopback redirect default and the development switches' loopback check (Node
  only), Node's own-network picture rule, the dashboard's `X-Forwarded-Host` trust.

## Backup, moving and the Free plan

- **Backup:** point-in-time recovery covers 30 days but needs code to run (docs); no export is built. An owner-only
  export, and restore through the recovery API, are left for later.
- **Moving between Node and Cloudflare:** no tool. The mailbox keeps what was written to it (categories, Screening,
  stacks), so a new server reads those back; rules, blocked senders, trust levels, devices, summaries (asked again,
  at a cost), history, the AI key and the Google client are lost. The two stores share one schema, so an export and
  import could follow.
- **A Free account clicking Deploy:** **unverified** (e, below). The guide and the README say Workers Paid first;
  wording the known symptoms ("Too many subrequests" while syncing) as needing Workers Paid is **not built**.

## The contract, core and coordination

Words in the contract pages:

- `docs/contract-sync.md`'s address and Safety bullets: the address exception (made in step 6; above, "The server's
  public address").
- `docs/contract-pictures.md` ("What is fetched, and how" and "What it hides"), `docs/contract-avatars.md` (the fetch
  rules and what the domain's owner learns): no pinned connection, no IP address fetched, no own network, a Cloudflare
  address and the `CF-Worker` header (made in step 5).
- `docs/contract-sync.md`: a host may keep a message only up to a size (made in step 4).
**Core's set-up words (changed in step 6):** `googleSetup(googleSignIn, client, { addressFix })` puts a host's own
words after core's one-sentence `noAddress` (Node's words, naming `--public-url` and a restart, are the default; the
Cloudflare host gives its own), so the answer's shape is unchanged; the agent prompt's last line now names the app's
set-up first and `usual-mail google set --file` only "on the machine the server runs on" (with
`docs/google-setup-agent.md`'s block). Still Node's words on Cloudflare: the server's own `src/google/words.ts`
(`notAvailable`, `clientRefused` and the inbox attention words name `usual-mail google set`; improvement-ideas.md).

## Build plan

Each step ends with `npm run check` green in `server/` and in any part it touches, Node tests otherwise unchanged.

1. **SQL fixes on Node (built 2026-11-21).** Every site of the audit above converted or shown bounded to 100, with a test of more than
   100 items for each path; chunks inside one `runBatch`; the parameter-counting logger across the suite; the
   migration-replay test on a filled store. Done: no statement over 100 parameters anywhere in the suite.
2. **The workerd harness, early (built 2026-11-21; "Built: step 2"):** a minimal `src/cloudflare/` (adapter, migrations module, Worker, object, Gmail
   parts), the root `wrangler.jsonc`, `package.json` and lockfile, the tsconfigs, and tests with Node's test
   runner driving Miniflare against the built Worker (as `smoke-bundle.mjs` drives the Node bundle, so no Vitest
   exception): start and migrations, pairing, the smoke test's REST checks, SSE, the object torn down and restarted by its alarm, the
   owner's code read back from its table after an eviction before pairing. Done: those pass and
   `npx wrangler deploy --dry-run` succeeds from the root. Built with it, ahead of their steps: the scheduler's alarm
   and clamp (4), the owner's code table, the http refusal and the
   dropped `X-Forwarded-Host` (6), and the workerd tests of 30 MB, of more than 100 ids and of two inboxes sharing
   one gate. Every later step adds its tests here.
3. **`mail/` (landed in `mail/` 2026-11-21, [mail.md](mail.md); its workerd test is in step 2's harness):** the `./gmail` export, per-message conversion, the size check and `attachments.get`, `FakeGmail`
   extended. Done: Node tests, then a workerd test syncing a 30 MB message from a fake outside the isolate within the
   caps.
4. **Host limits and start-up (built 2026-11-21; [server-cloudflare-limits.md](server-cloudflare-limits.md)):** the
   limits on `Host`, a stored message made to fit, search catch-up in chunks in the background, a failed start that
   recovers and backs off (the migrations moved out of `blockConcurrencyWhile` into the start).
5. **Pictures and site icons on Cloudflare (built 2026-11-21, the same note),** with fake hosts and a fake
   DNS-over-HTTPS resolver behind Miniflare's outbound handler and the dangers suite's cases that still apply.
6. **The dashboard's hint, address, Google client seam, settings, time zone, the per-address pairing count, the rest
   of the front Worker (built 2026-11-21; [server-cloudflare-access.md](server-cloudflare-access.md)).** Done: tests for
   each in workerd; the code in no log line; the client secret in no response, log or unsealed row.
7. **Docs (written 2026-11-21):** the README's Deploy button (`deploy.workers.cloudflare.com/?url=` the planned
   `github.com/usual-labs/usual-mail`; public since 2026-11-24, the button itself not tried yet);
   `docs/self-hosting.md`'s "On Cloudflare" (deploy, the variables, the secret key set before the first request, the
   address, the owner's code in Data Studio, more devices, the Google client from the app, the differences, the
   boundary, backup and moving, what is unverified) and two lines in `docs/google-setup.md`; `server.md`'s layout.

## Decided by the owner (2026-11-21)

1. **The first pairing code is read in Data Studio:** a plain copy in a one-row table the Cloudflare host owns,
   `owner_pairing_code`, deleted on pairing or expiry and read back at start as `kept`, like Node's owner-only file.
   Not sealed, since Data Studio readers see the secret key too; never in the logs, which (with the sign-in page) only
   say where it is ("The owner's code and pairing").
2. **The public address comes from each request's own host,** only the Worker's workers.dev address or the host in
   `USUAL_MAIL_PUBLIC_URL`, never stored; `docs/contract-sync.md` lines 266 and 321 to 322 gain the exception for
   hostnames Cloudflare routes to the Worker ("The server's public address").
3. **Pictures from the web and sender pictures are both on,** as on Node, with the differences documented: no pinned
   connection, and a `CF-Worker` header that may name the account's subdomain (unverified until a real deploy). The
   guide advises an account subdomain that isn't the person's name.
4. **The repository's root holds `package.json` and `wrangler.jsonc`,** with `wrangler` and `miniflare`; the owner
   accepted a root manifest beside the one-package-per-folder rule ("Repository layout and tooling").

## Checks still open

- **(a) The `CF-Worker` value: unverified.** Docs: "the name of the zone which owns the Worker"; their example, a
  route on `foo.example.com`, gives `example.com`, so a custom domain sends its zone. For workers.dev no page says,
  nothing local adds the header, and settling it needs a deployed Worker fetching a host that logs headers.
- **(b) Google and a workers.dev redirect address: partly resolved from docs.** Google's validation rules (OAuth for
  web server apps): HTTPS, no IP host, a TLD on the Public Suffix List, no wildcard, no fragment. `workers.dev` is
  itself a private suffix in that list (the server's shipped copy, `src/avatars/suffixes.json`), so
  `<subdomain>.workers.dev` is the top private domain. Whether the console requires it under Authorized domains for a
  client in Testing isn't on the pages read (a forum answer says authorized domains must cover redirect addresses); it
  can be added, and publishing would need it verified. **Unverified in the console**; nothing found makes a custom
  domain required for Testing.
- **(c) An empty or default secret in the Deploy form: unresolved by docs.** They don't say; a community post says
  every `.dev.vars.example` entry becomes a required prompt pre-filled with its example value, with no way to mark one
  optional. **Settled by design:** the deploy needs no secret, so the file isn't shipped.
- **(d) A 30 MB message through today's Gmail path: local**, above: 350 MB peak against a 128 MB isolate.
- **(e) The Free plan: unverified.** Docs: `limits` are supported only on the Standard usage model, and raising CPU is
  a Paid feature; Free allows at most 50 subrequests. Whether a deploy with `limits.subrequests` fails, or deploys and
  then breaks on the first sync, needs a Free account. Not setting `cpu_ms` removes one cause.

**Seen on the first deploy (2026-11-23;** Workers Paid, wrangler 4.158.0, a clean export of the committed tree, a custom
domain on a zone in the same account): `npm ci`, `npm run check:cloudflare` (80 tests) and `--dry-run` passed; the
upload was 5,452.74 KiB (1,241.21 gzipped), start-up 118 ms, and Paid took `limits.subrequests` ((e) stays open).
- **Secrets first:** `npx wrangler secret put` before the first deploy makes an empty draft Worker (without a terminal
  wrangler answers its question yes), so the key and the Google secrets exist before a request can start the object.
- **The domain:** `deploy --domain <name>` adds it; a deploy without the flag leaves it. Without a terminal wrangler
  overrides a conflicting DNS record or another Worker's domain unasked (its source), so check first:
  `POST …/workers/scripts/<name>/domains/changeset` lists `conflicting` and changes nothing. A wildcard record over
  the name isn't a conflict, but caches (the Mac's own too) keep its answer for its TTL. The zone's edge certificate
  is served. `--var NAME:VALUE` sets a variable (split at the first colon, so URLs work); `keep_vars` over a later
  deploy isn't seen yet.
- **Answered over HTTPS** at the custom domain and at workers.dev: `/v1/info` 200 with Google sign-in available and
  each host's own redirect address; `/healthz` 200; `/v1/*` with no, a malformed or a wrong `umt_` token, or at no
  route, 401; `http://` 403 from the Worker; the headers of "What runs"; `/` to `/sign-in` with the Data Studio words.
- **Not seen:** the owner's code (no documented API reads an object's SQL; the objects listing showed none minutes
  after the start) and the start's log lines (the Workers Logs query API refused wrangler's login; `wrangler tail`
  showed only the front Worker while the object stayed warm). Google, a sync, memory, the alarm, `CF-Worker`: open.

Also still to verify on a deployed Worker: a mismatched `Host`; how background work is counted for CPU and
subrequests; memory and storage with real-sized mail; Workers Builds' Node version; that the alarm restarts an evicted
object as Miniflare shows; step 6's own list (`request.cf.timezone`, `CF-Connecting-IP`, the error marks, `keep_vars`;
[server-cloudflare-access.md](server-cloudflare-access.md), "Not verified").
