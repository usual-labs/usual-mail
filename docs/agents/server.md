# Server

`server/` is the package `@usualmail/server`. It implements core's `MailService` over a SQLite store and serves
it as the REST routes in `core/src/api.ts`, beside the interfaces and with the mail providers listed in
`src/node/parts.ts`. It runs on Node 22 with a SQLite file. The code that differs on Cloudflare sits behind small
interfaces; the Cloudflare host is in `src/cloudflare/` (a Worker and one Durable Object, Gmail only; all seven build
steps built and tested in local workerd, deployed once to a real account on 2026-11-23 with `npx wrangler deploy`,
where no sign-in, sync or AI has run yet and the Deploy button is untried:
[server-cloudflare.md](server-cloudflare.md)). It follows the contract's fifth revision of 2026-11-17, as amended the
same day and again after its review (the coordinator's decisions: what leaves the server, the key in any form, the
screening gate and one-time codes, rules a person taught, recent filed history, blocked senders in a thread,
`Thread.sender`, `Thread.categorizedByActor`, several categories in one list, model kinds on the gateway).

**Sign in with Google for Gmail** (2026-11-17, below) **has run against Google once:** the owner's own sign-in on
their server worked (the coordinator's report). Every test and the live runs use mail's fake of Google's endpoints.

**Real AI models have run only on the owner's server:** since 2026-11-18 it has a Vercel AI Gateway key, categorizes
with `liquid/d1.2` (set explicitly; the server's test of it passed) and summarizes with the default, and its status
said working (the coordinator's report). No test calls a real model or uses a real key: every test, demo mode and the
development switch use fake models, and the real model access (`src/ai/sdk.ts`) is type-checked and unit-tested with
the network replaced. How well the AI categorizes and summarizes is unverified.

**Pictures from the web through the server** (2026-11-18, the owner's choice; the contract's
[page](../contract-pictures.md)) are built and tested with made-up mail and fake picture hosts on the loopback
addresses only. They have never fetched a real picture: no test reaches the real network, and the running servers
weren't touched. The Mac app shows the rewritten pictures only once its own update lands (the list for it is in the
coordinator's report of 2026-11-18).

**Sender pictures** (2026-11-19, the owner's request; the contract's [page](../contract-avatars.md), the code and its
choices in [server-avatars.md](server-avatars.md)) are built and tested the same way, with migration `0013_avatars`.
The Public Suffix List ships with them since 2026-11-19 (`scripts/update-suffixes.mjs`, the owner's approval), and an
independent security review's fixes are in.

## Run and check

All commands run in `server/` after `npm install`. `npm install` in `mail/` comes first: the server bundles mail
from its folder. The Cloudflare host's checks run at the repository's root instead: `npm install` there, then
`npm run check:cloudflare` (both Cloudflare type checks and the workerd tests; `npx wrangler deploy --dry-run` builds
the Worker without deploying; [server-cloudflare.md](server-cloudflare.md)).

| Command | What it does |
|---|---|
| `npm run check` | Type-checks twice (portable code without Node types, then everything with them), runs every test, builds the bundle and runs `npm run smoke` on it |
| `npm test` | The tests only (`node --test test/*.test.ts`) |
| `npm run dev` | Runs `src/node/main.ts` from source and restarts on changes. Data in `./data` |
| `npm run demo` | Runs from source in demo mode |
| `npm run build` | `scripts/build.mjs`: bundles `src/node/main.ts` with esbuild into `dist/server.mjs` (server, core, mail, dashboard, connector, the AI SDK and their dependencies; 7.6 MB, 7,973,470 bytes for 0.1.1 with the owner's password, 2026-11-24), with libSQL's local client (`src/node/db.ts` imports `@libsql/client/sqlite3` and `drizzle-orm/libsql/sqlite3`, never the main entries, which load the clients for remote databases). Only `libsql`, the native part, stays external. It also writes `dist/runtime.package.json`, naming only `libsql` at the version the server's lockfile holds, which the Docker image installs on its own (with `detect-libc`, `@neon-rs/load` and the platform's packages; since 2026-11-24 not `@libsql/client`, whose remote clients' packages, `promise-limit` among them, came with it), and `dist/THIRD_PARTY_LICENSES.txt`, the licence texts of every package and file the bundle holds (`scripts/licenses.mjs`; fails when a package has none; the repository's own code beside a `<name>.LICENSE` isn't listed, only its data files). `node scripts/build.mjs <folder>` builds into another folder, leaving `dist/` (which a running server may use) alone |
| `npm run smoke` | `scripts/smoke-bundle.mjs`: starts `dist/server.mjs` on a scratch data directory, waits for `/healthz`, pairs with the owner's code file, checks `GET /sign-in` (200), `POST /v1/search/ask` without an AI key (the sentence as typed, `not_set_up`, nothing sent), `POST /mcp` without a token (401), `GET /v1/ai/status` (`not_set_up`) and that the start line says the AI goes through the AI SDK, connects an IMAP inbox on an in-process test server, syncs (an HTML message whose picture must point at the picture route with its tracker taken out, and whose picture at a private address must be refused with 502 without any connection), sends a reply over SMTP, and stops it. Then it starts the bundle twice on another data directory (the second start keeps the owner's code without printing it and reads the first sync's days from `settings.json`), starts it with `--dev-fake-ai --host 0.0.0.0` and checks it refuses to start, and checks `dist/runtime.package.json`. `USUAL_MAIL_BUNDLE` names another bundle (the runtime file isn't checked then) |
| `npm start` | Runs `dist/server.mjs`. It needs `node_modules` (for libSQL) and `migrations/` next to `dist/` |
| `npm run db:generate` | Writes the next migration into `migrations/` after `src/db/schema.ts` changes. It asks questions when a column is both added and removed, so run it in a terminal. **A running server applies whatever `migrations/meta/_journal.json` lists at its next start, whatever bundle it runs**, so a file placed there is live: generate and test a new migration in a copy of `server/` (its own `migrations/`, `node_modules` linked), move it in as the last step, and treat it as frozen once there (a later change is a new migration) |
| `node scripts/update-suffixes.mjs <commit>` | Writes `src/avatars/suffixes.json` and `suffixes.LICENSE` from the Public Suffix List (`publicsuffix/list`, MPL-2.0) at that commit, in ASCII. Run by hand; review the difference. Shipped: commit `09c1b150f33c6145a73afcf7db0fb872fc54b4d1` (2026-11-19), 6,951 ICANN and 3,512 private rules; the file's size, lines and sha256 are in `suffixes.json`'s `source` |
| `node scripts/update-trackers.mjs <commit>` | Writes `src/pictures/trackers.json` and `trackers.LICENSE` from MailTrackerBlocker's list at that commit (downloaded from GitHub; the only thing that is). Run by hand when updating the list; review the difference. Shipped: commit `7463682a39af055a488539a3d0aa7898437b33f5` (2026-09-12), 320 trackers with 468 patterns |

The bundle starts with `const require = createRequire(import.meta.url)`, because ImapFlow, Nodemailer and
sanitize-html (through postcss) are CommonJS and require Node's own modules. Running from source never shows this,
which is why `npm run check` starts the bundle.

### Flags and environment variables

| Flag | Variable | Default | Meaning |
|---|---|---|---|
| `--data-dir <path>` | `USUAL_MAIL_DATA_DIR` | `./data` | Holds `usual-mail.db`, `secret.key` and, while no person's device is paired, `owner-pairing-code` |
| `--port <n>` | `USUAL_MAIL_PORT` | `8484` | Port. `0` picks a free one; the start line names it |
| `--host <addr>` | `USUAL_MAIL_HOST` | `127.0.0.1` | Bind address |
| `--demo` | | off | Fresh in-memory store filled from `core/fixtures/sample.json`, with the AI on fake models. Writes nothing to disk |
| `--dev-fake-ai` | | off | **Development only.** The AI answers from fake models (`dev-fake/categorize`, `dev-fake/summarize`) and nothing reaches any AI service; any made-up key works. Refused unless `--host` is `127.0.0.1`, `::1` or `localhost` and `NODE_ENV` isn't `production`, so a release (the Docker image binds 0.0.0.0) can't start with it by accident. The start line says "DEVELOPMENT ONLY" and names the fake models. On the gateway it knows `dev-fake/categorize` as a decision model and `dev-fake/summarize` as a language model, so choosing one for the other job fails the test in words |
| `--public-url <url>` | `USUAL_MAIL_PUBLIC_URL` | loopback | The address people reach the server at, an origin (HTTPS unless `127.0.0.1`, `localhost` or `[::1]`), for Google sign-in's redirect address `<url>/v1/google/callback`. Without it, a server on `127.0.0.1`, `localhost` or `::1` uses `http://<host>:<port>`; one on every address has none, and Google sign-in is off |
| `--dev-fake-google <url>` | | off | **Development only.** Google's authorization page (`<url>/o/oauth2/v2/auth`), token and revocation endpoints and Gmail's API go to a fake at `<url>` (a loopback origin) under the same paths; any other address is refused, nothing reaches Google. Refused like `--dev-fake-ai` (loopback host, not `NODE_ENV=production`); the start line says "DEVELOPMENT ONLY" |
| | `USUAL_MAIL_GOOGLE_CLIENT_ID`, `USUAL_MAIL_GOOGLE_CLIENT_SECRET` | the file | The host's Google client (a web application client), both or neither; they win over `<data-dir>/google-client.json` |
| | `USUAL_MAIL_SECRET_KEY` | key file | 32 bytes in base64 or base64url that seal mailbox and AI credentials |
| | `USUAL_MAIL_POLL_SECONDS` | `60` | Poll interval for every inbox. IMAP's IDLE watch brings INBOX changes sooner. Five of them, or 15 minutes when that is longer, without a finished sync make an inbox `not_syncing` |
| | `USUAL_MAIL_SYNC_DAYS` | `settings.json`, else `30` | How many days of mail a new inbox's first sync takes (`GET /v1/first-sync`, below). Wins over `<data-dir>/settings.json`, and a person can't change it while it is set; empty counts as unset |
| | `USUAL_MAIL_OWNER_EMAIL` | none | Only Google's proof of this address claims an unclaimed server ([server-owner.md](server-owner.md)); refused at start when it isn't an address |
| | `USUAL_MAIL_TRUSTED_PROXIES` | none | The reverse proxies in front of the server: addresses and CIDR ranges separated by commas, `private` (loopback, RFC 1918, 100.64.0.0/10, link-local, `fc00::/7`, `fe80::/10`) and `cloudflare` (Cloudflare's 22 published ranges, `CLOUDFLARE_RANGES`, copied 2026-11-24 from cloudflare.com/ips, never fetched). A connection from one of them is counted under the right-most `X-Forwarded-For` address that isn't one of them (`client-address.ts`, `node/client.ts`); from anyone else, and without the setting, the header is ignored. Refused at start when an entry isn't an address, range or word, and for any /0 range. The Caddy and Coolify files set `private`, Render's `private,cloudflare` |

`<data-dir>/google-client.json` is the host's Google client as Google's console downloads it for a web application
client (`{ "web": { "client_id", "client_secret", "redirect_uris", … } }`), renamed. `usual-mail google set` writes it,
or, since 2026-11-21, a person's own paired device through `PUT /v1/google/client` (`saveGoogleClientFile`: the text as
sent, through a temporary file beside it created exclusively under a random name with mode 0600, then renamed into
place, the temporary file removed on failure; refused while the environment gives the client). The
server reads it whenever it needs the client (no restart), refuses it while other users can read it, refuses a
Desktop app client's file (`installed`; core's `readGoogleClientFile`, the command's reading too), and never logs or
returns its contents. When the file's `redirect_uris` don't include its own redirect
address it says so once in its log, **as a hint** (core's `googleRedirectHint` since 2026-11-21; a hint since 2026-11-17's first real run): the file may be
older than a change made at Google, where the client's own list counts; check the address there if Google refuses a
sign-in. It still uses the client. The start line says whether Google sign-in is available and its redirect address.

`<data-dir>/settings.json` holds the server's own settings that persist (`src/node/settings.ts`, since 2026-11-17):
today `{ "syncDays": N }`, how many days of mail a new inbox's first sync takes, 1 to 36,500. `usual-mail init` writes
it and `usual-mail sync-days` changes it; the server reads it at every start, so Node mode and Docker (the data
directory is the volume) both honour it. `USUAL_MAIL_SYNC_DAYS` wins; without either it is 30. A file that isn't JSON
or a number out of range stops the start with words (exit 2). The start's second line says the number and where it
came from (`firstSyncWords`). Demo mode reads no file.

Flags win over variables. Without `USUAL_MAIL_SECRET_KEY` the key is `<data-dir>/secret.key`, created on first
start with mode 0600. The data directory is created with mode 0700 and the database file with 0600. Losing the
key means reconnecting every inbox and setting the AI key again. The start line ends with how the AI reaches models
(`AI through AI SDK`, `demo (fake models)` or `development fake models`).

### The owner's code

Since 2026-11-24 the owner has a password too, and the same place holds recovery codes:
[server-owner.md](server-owner.md).

`MailServer.keepOwnerCode(listener, { kept })` keeps a person pairing code waiting whenever no person's device is
paired: at start, when the waiting code expires unused (24 hours), and right after the last person's device is
revoked. The listener hears each code with `made` (true when made just now) and null once a person pairs. The Node
host writes `<data-dir>/owner-pairing-code` (mode 0600, written to a temporary file and renamed into place) and removes
it once a person pairs. **A code is printed once, when it is made** (since 2026-11-17): at a start the host passes the
file's code as `kept`; while it is a valid, unused person code the service keeps it (and its expiry timer) instead of
making a new one, and the host logs that an owner's code waits, until when and where the file is, without the code
(`ownerCodeLines` in `src/node/owner-code.ts`). Without the file, or with a code no longer valid, a new one is made and
printed. Demo mode prints every code (its store is new at each start) and writes nothing.

## Layout

```
src/host.ts          the seams: Clock, Scheduler, Random, EventBus, Secrets, Log, and Host that holds them with the Database
                     (and the optional pictures, site icons, time zone and HostLimits: batch, stored size, plans, search
                     chunks; NODE_LIMITS when a host gives none)
src/parts.ts         the shape of joined parts (providers by kind, mounted interfaces) and their checks
src/providers.ts     ProviderRegistry
src/db/              Drizzle schema, the Database type, upgrade.ts (fourth-revision shapes rewritten at start)
src/ai/              the server's AI
  models.ts          the seam: AiModels (choose, write, fitFor; answers carry the usage reported), AiModelAccess
                     (defaults, open), AiServiceError, scrubKey, unfitWords
  sdk.ts             the real access with the AI SDK; DEFAULT_MODELS
  fake.ts            FakeModels for tests, demo mode and --dev-fake-ai
  prompt.ts          what leaves the server for each job (core's limits and field names), the kinds' words and the
                     tie-break, the data block, which answers are accepted
  text.ts            what a model reads of a message (modelText: stub rule, links cut; linear patterns); plainText for
                     the gate
  addresses.ts       addresses taken out of a summary request, each at sign read once, and the cut that splits none
  event.ts           a notification's event checked (event-dates.ts, event-times.ts, event-lines.ts)
  ask-again.ts       ASK_AGAIN: the AI's own filings asked again once per store at a start; payment*.ts and
                     currencies.ts: a receipt's details checked, dates, party, services, store (server-ai.md)
  gate.ts            the server's own check before the AI's `otp` lifts the screening gate
  state.ts           the server's own row (settings, sealed key, status, counts version), may-run checks
  settings.ts        aiSettings, updateAiSettings, testAi
  status.ts          the status, recording answers and failures, the waits
  work.ts            which threads need work and may be processed, pending, history batches
  usage.ts           the AI's usage by the hour: recording, pruning, GET /v1/ai/usage
  costs.ts           looking the cost of gateway requests up by generation id, apart from the mail work
  process.ts         processing one thread: categorize, then summarize
  runner.ts          the queue: new mail first, then history; the screening gate let go when the AI can't answer
src/service/         MailServer and the service logic, one file per area
  act.ts             act, undo, approve, reject, decide: each answers with an ActResult
  actions.ts         the action engine: trust, silence, proposals, commit, undo, approve, refusals at the provider
  records.ts         adding and changing action records (versions, events, retiring undo, notes)
  first-sync.ts      the first sync's window: GET and PATCH /v1/first-sync
  state.ts           ThreadState, which parts each action touches, pure state changes
  store.ts           thread state with versions and revisions, senders, letting senders in
  senders.ts         the blocked senders' list (GET /v1/senders), their items, `sender.changed`
  lists.ts, views.ts what each list holds (shared with counts), the lists, the triage queue
  counts.ts          counts per inbox and for a caller
  changes.ts         ChangeNotifier: counts, status and triage numbers versioned, sent at most once a second
  inboxes.ts         connecting, changing (icon, position, credentials), removing (revoking a Google sign-in,
                     forgetting its pictures)
  pictures.ts        pictures from the web in the messages served (held back for screened and blocked senders),
                     the picture route (person only; only what the stored HTML shows), forgetting a removed inbox's
src/avatars/         sender pictures, host-neutral: the suffix list, freemail, discovery, ICO and PNG, what may be kept,
                     the sites table, settling threads' pictures, the fetch queue, the backfill, the service
                     (server-avatars.md)
src/pictures/        pictures from the web, host-neutral
  present.ts         one message's plan: trackers (the list, tiny or hidden) taken out, the rest pointed at the
                     route (at most 100) or held back; `Message.remotePictures`; a picture id (SHA-256 of the address,
                     22 base64url characters) answering only for a picture shown
  trackers.ts        the tracker list and matching (patterns over the address, ignoring case)
  trackers.json      generated by scripts/update-trackers.mjs: MailTrackerBlocker's list, with its BSD-3-Clause
  trackers.LICENSE   licence inside (so the bundle carries it) and beside it
  sniff.ts           the type and size read from a picture's bytes: PNG, JPEG, GIF, WebP, AVIF; size limits
  refused.ts         PictureRefused, the one error a picture source throws
  rules.ts, kept.ts  what both hosts' fetchers and caches share: special ranges, limits, headers, ports; the cache's
                     caps and retries, the blank picture, checkedPicture
src/sync/            the sync engine, batches (ingest, identity, rows, placement, sorting), write-back, come back; fit.ts:
                     a message made to fit a host's stored size (HostLimits.storedMessageBytes; Node: no limit);
                     progress.ts: how far a first sync has got (Inbox.firstSync); health.ts, watch.ts, status.ts:
                     when an inbox needs attention and why (Inbox.statusReason)
src/search/          search (docs/contract-search.md): terms.ts (the typed text and operators read into filters),
                     fts.ts (the FTS5 query, columns and weights), doc.ts (a thread's index entry), indexer.ts
                     (SearchIndex: kept right by version, built at a first start), local.ts (the query, ranking, cursors),
                     excerpt.ts (fields matched, runs, people), remote.ts (the mailbox searched, opening one, limits)
src/rest/            the Hono app, mounting interfaces, the event stream, attachment and picture responses
src/google/          Sign in with Google for Gmail
  config.ts          what the host gives (GoogleOptions: the client when needed, the redirect address), Google's URLs
  oauth.ts           the authorization address, PKCE, the code exchange, the granted scope, revocation
  sign-in.ts         info, start, the outcome, finishing at the callback (connect or reconnect in place)
  store.ts           the sign-ins in memory, by id and by the state's SHA-256
  credentials.ts     what a signed-in inbox keeps (client id and refresh token), the host's secret added when opened,
                     the words when Google refuses it
  setup.ts           GET /v1/google/setup (core's prompt and steps, the client's state and note) and
                     PUT /v1/google/client (checked by core; what counts as a client to replace; saved through
                     GoogleOptions.saveClient; person only; never on MailService)
  words.ts, page.ts  the person's words (the client route's refusals in clientWords); the callback's page and its headers
src/secrets.ts       AES-GCM sealing with Web Crypto
src/demo/seed.ts     demo mode: sample.json into the store, memory mailboxes, fake models with the sample's ids
src/testing/         MemoryMailbox and MemoryProvider, ManualClock (clock and scheduler)
src/client-address.ts  client addresses on both hosts: the keys a client counts under (IPv6 by /64 and /48), trusted
                     proxies' ranges (private, cloudflare, no /0) and the right-most-untrusted X-Forwarded-For rule
src/cloudflare/      Cloudflare only (server-cloudflare.md): worker.ts the front Worker, object.ts its Durable Object,
                     start.ts, database.ts (the durable-sqlite adapter and migrator), timers.ts, limits.ts, address.ts,
                     google.ts, owner-code.ts, pairing.ts, requests.ts, settings.ts, secret-key.ts, parts.ts (Gmail
                     only), env.ts; web/ (pictures and site icons); migrations.generated.ts (written, gitignored)
src/node/            Node only: entry point, config, libSQL and migrations, key file, timers, the owner's code file and its
                     log lines, client.ts (each request's client address, trusted proxies), parts.ts, google.ts (the client from the environment or the file, saving the file a
                     device gives, the redirect address, the redirect hint, the fake's rewriting), settings.ts (settings.json: the first sync's days),
                     pictures/ (address.ts: the public-address rule; fetch.ts: fetching one picture, pinned and
                     limited, also pages for sender pictures (`fetchWebBytes`, `cutAt`, `accept`); cache.ts:
                     DiskPictureSource, the pictures kept per inbox in <data-dir>/pictures), avatars/site.ts
                     (NodeSiteIcons: one domain's icon from its own site)
scripts/             build.mjs (the bundle), licenses.mjs and licences/ (its THIRD_PARTY_LICENSES.txt),
                     smoke-bundle.mjs (the bundle started and checked), cloudflare-prepare.mjs
                     (the part folders installed and the migrations module written for Cloudflare), update-trackers.mjs
                     (the tracker list from a pinned upstream commit), update-suffixes.mjs (the Public Suffix List
                     from a pinned commit)
migrations/          SQL generated by drizzle-kit: 0000_init to 0003_fourth_revision, 0004_fifth_revision,
                     0005_categorized_by_actor, 0006_summaries_again (custom: summaries asked for again, in
                     server-ai.md), 0007_ai_usage (the usage table and since when it is kept),
                     0008_ai_cost_lookups (generation ids whose cost is still to look up), 0009_sent_message_ids
                     (the server's sent keys; custom: the inbox's own address forgotten where let in),
                     0010_held_copies (copies held until a move's old ref goes), 0011_ask_again (columns only:
                     the AI asked again once, in server-ai.md), 0012_payment (a receipt's details, the column only),
                     0013_avatars (sender pictures: avatar_sites, messages' from_check and from_verified, threads'
                     avatar; adds only), 0014_payment_again, 0015_payment_rules, 0016_events (columns only, server-ai.md),
                     0017_event_groups, 0018_search (search_docs, search_people, the FTS5 table search_index and a
                     trigger; custom SQL appended to the generated file; fills nothing)
test/                node:test suites; test/e2e/ holds what the end-to-end suites share; test/cloudflare/ the workerd
                     suites (Miniflare), run from the root
```

Nothing outside `src/node/` imports `node:` modules but `src/cloudflare/address.ts` (`node:async_hooks`, which
`nodejs_compat` provides); the AI SDK runs on web APIs (`fetch`, `AbortSignal`). `tsconfig.json` checks `src/` without
Node types and excludes `src/node/` and `src/cloudflare/`. `tsconfig.node.json` checks everything else with Node types,
including the sources of the joined packages it imports; `tsconfig.cloudflare.json` checks `src/cloudflare/` with
Workers' and Node's types (from the root's `npm run check:cloudflare`).

## Joining parts: `src/node/parts.ts`

`src/node/parts.ts` registers mail's IMAP and Gmail providers (`@usualmail/mail`), mounts the connector
(`@usualmail/mcp`) at `/mcp` and the dashboard (`@usualmail/dashboard`) at the root. All three are `file:`
dependencies. `src/node/main.ts` picks the AI access: `sdkModelAccess()` normally, `demoModels(sample)` in demo mode,
`FakeModels` with `--dev-fake-ai`. Base paths are `""` or like `"/mcp"`, never `/v1` or `/healthz`; the server checks
this at start. REST routes come first; an interface at the root gets every other path.

## The server's AI

In [server-ai.md](server-ai.md): how it reaches models, its settings, what it processes and when (history is all
synced mail since 2026-11-18), which answers it keeps (summaries shortened, not dropped for length), what leaves the
server, and its status.

## What is implemented

- **Store.** Threads: `category`, `categorized_by`, `categorized_by_actor` (who decided, by name: JSON of the actor,
  null for the mailbox and for decisions from before migration `0005`), `screened`, `screened_by_mailbox` (the mailbox filed it under
  Screening: such a filing holds even a one-time code), `gate_pending` (a stranger's thread awaiting the AI's first
  answer; not written back meanwhile), `summary`, `category_due`, `summary_due`, plus `version` and `revision` (rises
  when category, screened, done, stack, come-back time or trash change; not on reading, summaries or a come-back time
  passing). Inboxes: `icon`, `position`, `ai_processing`. `server_state` (one row): sealed AI credentials, the service,
  chosen models, history days (unread since 2026-11-18), paused, settings version, the service's last state, detail,
  job, last run, retry time, failures, status version, counts version, since when the AI's usage is kept.
  `ai_usage`: the AI's usage by the UTC hour, job and model ([server-ai.md](server-ai.md)). Times are Unix
  milliseconds. Migrations run on open.
- **The first sync's window** (`service/first-sync.ts`, `GET`/`PATCH /v1/first-sync`, 2026-11-18): the host gives the
  days, where they came from (`--`/env, settings.json or the default) and, on Node, how to keep a new number
  (`saveFirstSyncDays` in `node/settings.ts`: settings.json read, `syncDays` set, the rest kept, written owner-only to
  a temporary file and renamed); demo mode gives none, so it can't be changed there. A person's patch (1 to 36,500
  whole days, strict object) is kept, then `ctx.firstSync` changes and every inbox whose first sync hasn't finished
  is asked to sync. The engine opens a provider again before a sync when its first sync is still running and the
  provider was opened with another window (`#checkWindow`), so a smaller window narrows it from that sync on (the
  providers never widen a first sync); a finished first sync never reads the window again. `conflict` while
  `USUAL_MAIL_SYNC_DAYS` set it, or with no way to keep it.
- **When an inbox needs attention** (0.1.2, the owner's decision of 2026-11-25, and the server review's fixes;
  [sync](../contract-sync.md#when-an-inbox-needs-attention)): `sync/health.ts` sorts a failed attempt
  (`classifyFailure`: `SignInRefused`, Google's refused token or another client, Gmail's 401 or `kind` "scope" are
  `needs_sign_in`; no Google client, a refused host client or the Gmail API off in its project are `host_setup` for a
  signed-in inbox, in words naming this host's way, `GoogleOptions.clientFix`: `usual-mail google set`, on Cloudflare
  the Worker's secrets, and for the Gmail API (Gmail's `accessNotConfigured`) the server's own words saying to turn it
  on in the client's project (`attention.gmailApiOff`, after the final review of 2026-11-25); `needs_sign_in` for one
  connected by hand, the Gmail API's words naming the person's own client; anything else may pass, Gmail's `daily_quota`
  included) and makes the row's next state (`afterFailure` over the attempt's start and end, the start its end less
  its length on `Clock.monotonic`, so a sleep mid-attempt joins the gap before it, a new run only past the stale
  time; `afterSuccess`): at once
  with a reason; a refused sign-in or the host's setup kept through failures that may pass; after `not_syncing`,
  `provider_error` at once; else `provider_error` once the run (from the first failed attempt's start) has gone ten
  minutes across two attempts, an attempt begun longer than the stale time after the last one ended starting it again.
  Migration 0021 keeps the reason, the last attempt's end and the run (`failing_since`, `failures`), so a Cloudflare
  restart doesn't reset it. `sync/watch.ts` (`SyncWatch`) keeps each open inbox's last sign of life (opened, an attempt
  finished, a batch stored, a first sync's word, a write-back done) in memory on `Clock.monotonic` (`performance.now()`,
  which a sleeping machine doesn't advance) and looks every third of `notSyncingAfterMs` (5 minutes by default); the
  first sign of life after it said `not_syncing` settles it (`onRevived`), mid-sync too. `sync/status.ts` stores what
  either makes (`storeHealth`, a version and `inbox.changed` only when status, words or reason changed) and marks silent
  inboxes `not_syncing` (`markNotSyncing`, which asks the watch again under the lock and leaves a paused inbox, a
  refused sign-in and the host's setup alone): "This inbox hasn't synced since 25 Nov, 14:02 UTC, and none of its syncs
  has finished for over 15 minutes, …", in `Host.timeZone` (Node: the process's, so `TZ` in Docker). `start` settles a
  `not_syncing` left by the last run first. A new password or a resume clears the run. Tested in
  `test/sync-health.test.ts` (the sorting, the grace, the attempt's start, slow attempts, a kept sign-in, the words, a
  sleeping machine, a held sync, a long first sync, a restart, a pause), `test/sync-health-stalls.test.ts` (a slow batch
  settled by the next, a hang ending in `provider_error`, the lock's second look, write-backs; each seen failing with its
  fix undone) and `test/migration-0021.test.ts`. The memory provider's adapter and factory moved to
  `src/testing/memory-adapter.ts` (the mailbox file was over 500 lines).
- **How far a first sync has got** (`src/sync/progress.ts`, `FirstSyncCounts`; 2026-11-23, the owner's decision;
  [sync](../contract-sync.md#sync)): during a sync of an inbox whose first sync runs (`!historyDone`), the engine
  passes `onProgress` to the provider and hears each batch's `progress` (not the batch that ends the first sync).
  `begin` marks when this process began the first sync; a word heard two seconds (`FIRST_SYNC_PROGRESS_EVERY_MS`) after
  the mark or the last shown count is queued on the lock and written with the latest word heard by then
  (`first_sync_fetched`, `first_sync_total`, migration 0019) with a new version and `inbox.changed`; words in between
  only update the latest. `toInbox` shows the count only while `historyDone` is false. When the first sync ends,
  `#setStatus` clears both columns with `historyDone`, which counts as a change of the inbox when a count was shown
  (so the status turning `ok` and the count going are one version and one event), and the engine forgets its marks;
  a write queued before that finds `historyDone` (or `paused`) and writes nothing. A count's `inbox.changed` goes out
  with `Ctx.emit`'s `countsUnchanged`, so it reaches the same receivers without the change notifier working out every
  count and the AI's status again (the review of 2026-11-23: [server-cloudflare-limits.md](server-cloudflare-limits.md),
  "What a count costs"). Nothing is kept in memory that must survive a
  restart: the count is in the provider's cursor and the shown one in the row. The memory provider counts a first
  sync's batches (its first-sync pages carry an "F" cursor, a reset listing's "L"); with the tests' manual clock no
  count is ever due unless a test moves the clock, so other tests' versions and events are as before.
- **A pause, a removal or new credentials answer at once and stop a running sync after its batch in hand**
  (`SyncEngine`, the review and re-review of 2026-11-23). `Hooks.inboxClosed(id, { reopen })` returns at once: the
  engine's `#closeInBackground` runs `#close` as tracked work (so `whenIdle` and `stop` wait for it), the closes of one
  inbox one after another (`#closes`), and with `reopen` opens the inbox again afterwards unless it is paused or gone by
  then. `changeInbox` asks for it after storing and announcing the change (`reopen` unless the inbox is now paused).
  `#close` marks the inbox closing (`#closing`, counted, so two closes at once don't clear it early) until its queue
  drains, then forgets the first sync's clock (`FirstSyncCounts.forget`: after resuming, the first count waits two
  seconds again) and drops the provider; the round loop reads `paused` on the row it ingests under the lock and stops
  after that batch is stored, without `historyDone`, the held write-backs, the repair or another sync, when the row is
  paused or the inbox is closing; a sync queued before the close doesn't start (which only new credentials or `stop`
  can show: a pause's row already refuses it), and no round starts while the inbox is closing, so a close that began
  while the sync was still opening its provider fetches nothing (final review, 2026-11-24). A sync that fails while its
  inbox is closing stores no status, only an info line: after new credentials the old provider's batch may fail, and
  the inbox stays `connecting` for the new one. `removeInbox` deletes the rows under the lock first, sends
  `inbox.removed`, then asks for the close and revokes a Google token at once (not after the close: a revoke minutes
  later could come after the same account was signed in again); the batch in hand then finds no inbox and stores
  nothing, and neither `#sync` nor a refused write-back logs a failure for an inbox that is gone. The batch being
  fetched isn't cut short (up to 200
  messages on Node: about two and a half minutes of Gmail; known-issues.md). Resuming reopens the inbox and the next
  sync goes on from the stored cursor, still history. **`stop` closes every inbox together** (2026-11-24): it maps
  `#close` over the open inboxes and waits for them all, and since `#close` marks its inbox closing before its first
  wait, all are marked before any batch could start, and the stop waits for the longest batch in hand. Closed one
  after another, as before, an inbox whose close hadn't begun went on starting batches while another's was stored
  (`first-sync-stop.test.ts`; seen in the image too, [decisions-deploy.md](decisions-deploy.md)). **A sync runs only
  while the engine is started** (2026-11-24, the re-review): `#sync` returns at once when `#started` is false, and no
  round starts once it turns false. Before, a sync asked for after an inbox's close was done ("sync now", its watch, a
  sent draft) while the stop still waited for another inbox's batch opened the provider again and ran its rounds,
  which the stop then waited for (a probe saw 176 batches; `first-sync-stop.test.ts` saw 17 and a 3.5 s stop, and
  fails without the guard). Both hosts start the server before serving requests; the Cloudflare host never calls
  `stop()`, so its engine stays started (`npm run check:cloudflare` passes). Two tests synced a "first process" that
  was never started (`provider-inbox.test.ts`'s come-back after a stop, `sync-provider.test.ts`'s repair after a
  restart); they now `start()` it, as a process does.
- **A stop asked for during start-up** (Node host, 2026-11-24, for 0.1.1). `src/node/stop-signal.ts` is
  `main.ts`'s first import, so SIGTERM and SIGINT have a handler from about 100 ms into the process (the built bundle,
  measured), before the rest of the code is evaluated. In the container Node is PID 1, which ignores a signal it has
  no handler for: with the handler installed only after start-up, a `docker stop` during start-up was ignored, the
  server went on to listen, and Docker killed it at the deadline. A signal during start-up is acted on between steps
  (`quitIfAsked` after the key file, after the store opens, after `MailServer.create`, after demo seeding), never in
  the middle of one, and the process exits 0: nothing is in hand before syncing starts. `MailServer.start({ signal
  })` skips the steps left once the signal is aborted (search's catch-up, the engine, the AI, costs and sender
  pictures; `SyncEngine.start(signal)` also checks after reading the inboxes), so a stop asked for during the start
  starts no sync and `stop()` straight after it has nothing in hand. After start-up, a signal stops the server as
  before; one that came during the last steps (listening, the owner's code) runs when they are done. Still open: a
  signal before Node has parsed the bundle, or during the entry point's shell, is lost
  ([known-issues.md](known-issues.md)). The Cloudflare host calls `start()` without a signal.
- **Upgrade from the fourth revision** (`0004_fifth_revision.sql` and `src/db/upgrade.ts`): piles become categories
  (`people` conversation, `reads` newsletter, `receipts` receipt, `screening` screened in `unknown`); triage becomes
  `categorizedBy` (`by_rule` rule, `by_agent` agent, `by_person` person, `pending` none); a thread nobody had decided
  (`pending`) is `unknown` whatever its pile; `move` records become `categorize`, moves into screening are deleted;
  inboxes get positions in connection order, icons person, building, briefcase in turn, AI processing off, version
  up; threads' versions rise; message placements get `category` and `screened` (IMAP's Screening folder keeps none);
  the records' kept thread states, rules' and teach prompts' actions are rewritten at start (a rule left with no
  action is switched off). Tested with a store migrated to `0003` and filled by hand (`test/upgrade.test.ts`).
- **Ids** are opaque but sort in the order they were made.
- **Threads as clients see them** carry `sender` (the `sender` column: the oldest incoming message's sender, lower
  case; absent for a thread of the mailbox's own mail only) and `categorizedByActor` (absent for the mailbox).
- **Lists** (`lists.ts`, `views.ts`): Home (core's `HOME_CATEGORIES`: conversation and unknown; notifications were in
  it from 2026-11-18 until the owner's decision of 2026-11-19 gave them their own list only), each category or several merged (`category(caller, ["invoice",
  "receipt"])`, REST `/v1/categories/invoice,receipt`: one `inArray` list in the normal order, so cursors run across
  them; an empty or unknown name is `invalid`, a repeated one counts once), each stack, waiting (soonest first, ties by id ascending),
  screening, search (below), Handled (rules', agents'
  and the AI's records; silent only with `includeSilent`; `attentionOnly` as before), the triage queue (undecided,
  nobody decided, not done or screened, with mail, and the AI won't process it: the AI not `working`, or the AI's
  answer for it dropped; age is no reason since 2026-11-18). Inboxes in `position` order. Every list
  orders by the whole second it publishes, then id.
- **Counts** (`counts.ts`, `changes.ts`): per inbox in list order and in all, from the same conditions as the lists.
  `counts.changed`, `ai.status.changed` and `triage.pending` go out at most once a second, carrying the latest; each
  receiver of `counts.changed` gets only the inboxes it may see and their sum. `ai.settings.changed` goes to people's
  devices only.
- **Actions** as the contract lists them, `categorize` in place of `move`: it sets the category, `categorizedBy` and
  `categorizedByActor` (`decidedBy`; also when only proposed; an undo sets them to whoever undid it; a refused
  write-back puts them back), lets nobody in, keeps a screened thread screened except a one-time code (unless the
  mailbox filed it under Screening), and a one-time code loses its summary. Undoing a `categorize` puts the category
  (and a summary `otp` took) back and sets `categorizedBy` to whoever undid it. Trust, silence, proposals, approve,
  reject, exact undo and refused write-backs work as in the fourth revision; the AI's actor is always applied and
  silent. `decide` takes a category, records nothing when it doesn't change, and sets `categorizedBy` agent or person
  and `categorizedByActor` the caller. **A rule the person taught** (source `person` or `correction`) applies whatever
  the trust, `trash` and `block_sender` included (`gate(actor, trust, kind, taught)`; `applyRule` passes `taught`);
  silent only in an `act_silently` inbox, as before. Agents and agents' rules stay under trust.
- **Blocked senders** (2026-11-20, the owner's Settings tab; contract.md, "Blocked senders"). `senders.ts`:
  `listSenders` (person only, `SendersQuerySchema`: the lists' query plus `state`, only `blocked`) pages the `senders`
  rows with status `blocked`, newest `updated_at` first (whole second, then `inbox_id || ' ' || email`, descending;
  the usual cursor). `blockedItems` builds a page's items with, per inbox on the page, one read of the stored messages
  from those addresses (`lower(json_extract(from_address, '$.email'))`, not outgoing; From and date only) and one of
  the inbox's applied `block_sender` records joined to their threads: `blockedAt` is the row's `updated_at`,
  `blockedBy` the newest such record's actor (matched by the record's `before.sender.email`, else its thread's
  `sender`, which is how demo mode's seeded records match), `messagesSinceBlocked` the messages dated after
  `updated_at`, `name` and `lastMessageAt` from the newest. No counter column and no migration: a query is enough at
  these sizes (a handful of blocked senders; a scan of one inbox's message heads per page). `allowSender` (`act.ts`,
  `AllowSenderSchema`, `senderAddress`): person only, under the lock, `perform` with `allow_sender` on the sender's
  newest thread not trashed or removed; none left: `setSender(…, "known")` and no record. `sender.changed`:
  `senderChanged` emits the sender as they are now; `commit` calls it after the record exists when a block began or
  ended, `setSender` (used by `restoreSender` and `failUndo`) when it changed that, and `ingest` once per batch for
  each blocked address new incoming mail came from (`blockedMailArrived`). `#mayHear`: people who can see the inbox.
  Demo mode seeds the sample's `blockedSenders` as blocked rows since their `blockedAt`. Tests: `senders` (6), a REST
  case, the demo's list.
- **Letting senders in.** `allow_sender`; the inbox sending them mail (synced Sent mail, a draft sent through the
  server); the first sync's history (not senders of threads filed under Screening there, and history never lifts a
  filing under Screening); writing into a thread that isn't screened. A sender let in for the first time stops being
  screened everywhere: each of their screened threads is unscreened, with an event, and written back. Deciding a
  category lets nobody in.
- **Which stored message new mail is** (`src/sync/identity.ts`, 2026-11-18, after the pictures' third review):
  `sameMessage` finds it by ref; on IMAP also by the same Message-ID and the same `contentFingerprint` (From, To,
  Cc, subject, date, text, HTML, attachments; worked out from the stored row, so no column); never by Message-ID
  alone, and on Gmail by ref only. By ref, its state and a newer reading are taken. By content, a copy of the same
  kind is a move only when the batch reports the stored copy's ref removed (it takes the new ref and placement);
  otherwise it is held in `held_copies` (migration 0010: inbox, ref, the stored message's id, seen, placement; its
  changes kept, dropped when its own ref goes or with its message or inbox, never by age), and a later
  removal of the stored ref takes the held copy's ref, seen flag and placement (`takeHeldCopy`). A Sent copy joining
  an inbox copy calls `becameOwn` (outgoing, then the thread's sender and screening worked out again) and the stored
  copy keeps its placement; an inbox copy of a sent message changes nothing. Both hold the other copy, so the message
  stays when the stored copy goes. Otherwise it is a new message from its own From. A batch takes copies with Sent evidence first among
  equal dates. **The server's own evidence** (`sentKey`): a sent draft stores its Message-ID with a hash of From,
  To, Cc, subject, text, HTML and attachments (none, for what the server sends) in `sent_message_ids.message_id`; a copy matching both is the inbox's own and lets nobody
  in. `pruneSentIds` forgets them after 90 days, at each start.
- **Sorting new mail** (`src/sync/sorting.ts`): first sync as history (labels and folders read as categories,
  Screening, stacks; archived and not under Screening, a stack or a filed category is done; a thread under a filed
  category isn't, however old inside the synced window (since 2026-11-18; before, only within the history days);
  senders let in; no rules; AI later as history, so filed threads are summarized). After that, mail delivered outside the inbox keeps its filing (a category label is that category, decided
  by the mailbox, not done; Screening screens it; a stack; otherwise done; a blocked sender's is done). Mail delivered
  to the inbox: a blocked sender (done, screened, the AI never sees it), the first matching rule (its `categorize`
  sets `categorizedBy` rule even when proposed; not screened; the AI categorizes only when the rule didn't), a sender
  not let in (screened, `gate_pending` while the AI may answer at once, so a one-time code is never placed under
  Screening), otherwise the AI. Then the AI summarizes unless `otp`.
- **The provider's inbox follows Home.** Write-back places each incoming message: in the inbox exactly when the thread
  is a conversation or undecided and in Home (`inInboxCategory` in `service/state.ts`; a notification stays under its
  label, so neither Home decision moved anything at any provider), under its filed category's label or folder, under Screening while screened, with its stack's label or
  keyword. A thread at the gate isn't written until the AI answers or can't. A placement's category is compared only
  where the provider reports one (IMAP's Screening folder keeps none).
- **Inbox icons** are core's `INBOX_ICONS` (fourteen since 2026-11-20): `PATCH /v1/inboxes/:id` (`schemas.ts`) and
  Google sign-in (`google/sign-in.ts`, which had its own list of six until then) check against it; a new inbox takes
  `INBOX_ICONS[count % 3]`.
- **Snippets made plain once** (`remakeSnippetsOnce` in `service/snippets.ts`, `SNIPPET_PASS` "2026-11-19 plain
  snippets"; run in `MailServer.create` after the payment rules' pass, re-exported from `ai/ask-again.ts`): every
  thread not removed gets its snippet made again from the stored bodies (`threadSnippet` in `sync/rows.ts`: the
  newest shown message's id from the light columns, then that one message's `text` and `html`), with a new version
  when it differs; a thread not done also gets a `thread.changed`, a done one changes silently; the log says counts
  only ("Snippets made plain: N threads (M done, changed silently)"). Messages keep their `text` and sanitized `html`,
  so every thread can be recomputed; one whose message has neither stays empty. No provider read, no AI request. It
  shares `server_state.payment_rules_applied` with the payment rules' pass (`ai/passes.ts`: `PAYMENT_RULES`, then
  `SNIPPET_PASS`; a store whose marker is a later pass has had the earlier ones, `hadRulePass`). No migration.
  Tests: `snippets` (15).
- **A blocked sender writing into someone else's thread** changes nothing a person sees (`shownIn` in
  `src/service/store.ts`): `refreshThread` works out the subject, snippet (`snippetText` in `ai/text.ts`, from the
  newest shown message; contract.md, "Words"), participants, `lastMessageAt`, count,
  unread and attachments from the messages a person sees; `messageFlags` (the state actions use, and so `read` and
  `unread`), `thread(id)` and the triage queue leave the message out; `newMailInThread` returns before ending a
  come-back-if-no-reply wait or bringing anything back. The message is stored and placed with its thread at the
  provider. The sender's standing is read at refresh, so letting them in again shows it at the thread's next change.
- **Changes at the provider** (`src/sync/placement.ts`): moved into the inbox, a conversation decided by the mailbox,
  not screened, not done, off its stack, not waiting (a stack added at the same moment wins); a filed category's label
  or folder, that category decided by the mailbox; a category's label taken away, a conversation; the Screening label
  or folder screens or unscreens (the mailbox's filing); archived, done for conversation and undecided threads; stacks,
  trash, spam and seen as before. None of these starts the AI.
- **Come back, sync, write-back, paused inboxes, notes, drafts, repair, inboxes' credentials, sign-in, briefs, REST and
  the event stream** work as in the fourth revision; briefs count by category, and new inboxes take an icon and the
  last position, positions renumber on a move or a removal (each moved inbox `inbox.changed`), and turning AI
  processing on needs credentials (`conflict`), also when connecting.
- **Sign in with Google for Gmail** (`src/google/`; the contract's
  [section](../contract-sync.md#connecting-gmail-by-signing-in-with-google), the decisions of 2026-11-17).
  `info().googleSignIn` from the host's client and the redirect address. `startGoogleSignIn` (person only; `conflict`
  while unavailable; valibot-checked input; a reconnect only for a Gmail inbox, without name, colour or icon) keeps a
  sign-in in memory (id, the state's SHA-256, the PKCE verifier, the caller, ten minutes) and answers with Google's
  address: `gmail.modify`, `access_type=offline`, `prompt=consent select_account` (new) or `consent` with
  `login_hint` (reconnect), `S256`. `finishGoogleSignIn` (the callback) takes the state before awaiting anything, so a
  second visit finds it used; checks expiry, Google's `error` (only known codes get their own words), that the device
  is still paired, the client and address; exchanges the code (`exchangeCode`, with the verifier, the secret and the
  same redirect address); needs `gmail.modify` among the granted scopes and a refresh token; verifies with the Gmail
  provider (refresh, then `users.getProfile`); then refuses another account on a reconnect, or reconnects in place
  through `replaceCredentials` (the same path as changing credentials), or connects through `insertInbox` (the same
  path as connecting). The outcome (`googleSignIn`) answers only the starting device; it turns `expired` when read
  late. Sealed per inbox: `{ signIn: "google", clientId, refreshToken }`; `providerCredentials` adds the host's secret
  when the engine or `fillConnections` opens it, and fails with the person's words when the host's client is gone or
  another one; the engine checks before each sync of a signed-in inbox and reopens the provider when the secret
  changed. A refused token (`GoogleTokenError` from mail) becomes "… Sign in with Google again …" in `statusDetail`
  with `needs_sign_in`, a refused or missing host client `host_setup` (`sync/health.ts`; `attentionWords` still words
  remote search's refusals). Removing such an inbox revokes its refresh token at Google in the background (`ctx.background`,
  which `whenIdle` waits for); a failure is logged as information, without the token. Credentials given by hand that
  carry `signIn` are `invalid`.
- **The host's Google client from a person's device** (2026-11-21, the owner's decision; `src/google/setup.ts`, the
  contract's [section](../contract-sync.md#connecting-gmail-by-signing-in-with-google)). `GoogleOptions` gained
  `clientFromEnvironment`, `saveClient(file)` and `savedClient()` (`none`, `usable` with its id, or `refused` with the
  host's words), the host's seam; Node passes `config.googleClient !== null`, `saveGoogleClientFile` and
  `savedGoogleClient` (one read of the file, `readClientFile`, serves the client, the log and this), demo mode no Google
  at all. `GET /v1/google/setup` answers core's `googleSetup(info, client)`, the client's `note` from a refused file
  and from signed-in inboxes whose `connection.clientId` isn't the current client's. `PUT /v1/google/client`: in REST,
  as every route, the caller is checked (`callerFor`) before the body is touched, then the route's `bodyLimit`, here
  `GOOGLE_CLIENT_FILE_MAX_BYTES` (Content-Length over it: refused unread; without one: read until it passes 16 KiB;
  `POST /v1/pair` the same 16 KiB, every other route 2 MB, a path that is no route nothing), then the body as text and
  `?replace=true|false`. In the service, in order: `needs_person`; `conflict`
  for the environment or no `saveClient`; `invalid` for size, the flag or `readGoogleClientFile`'s problem; under
  `ctx.lock`, unless `replace` is true, `conflict` for a usable saved client (another id, or the same id, each its own
  words), a refused saved file (its reason), or, with neither, signed-in inboxes under another client id (named),
  each ending "Confirm to replace it." or "Confirm to save it anyway.", without the flag (the apps show them above
  their own button);
  the save (a failure is logged by message only and answers `internal`); one info line ("a person's device
  gave/replaced …", no id). The answer names the id, `replaced` (a file was there or inboxes were stranded),
  `googleSignIn` and the redirect hint. Both are MailServer methods outside `MailService` (`calls: "-"`), so the
  dashboard's and the connector's fakes needed no change.
- **Pictures from the web** (2026-11-18, revised after its security review the same day; `src/pictures/`,
  `src/service/pictures.ts`, `src/node/pictures/`). `messagesOf` (so `thread(id)` and the triage queue) writes each
  message's stored HTML again through mail's picture pass (`@usualmail/mail/pictures`, which reads CSS as a browser
  does and drops any declaration still naming the web): trackers on the list and tiny or hidden `<img>`s are taken
  out and counted, the rest point at `/v1/messages/<id>/pictures/<picture id>` (at most 100; at most 300 different
  addresses looked at), fonts from the web go. Every message of a screened thread, or of a blocked sender (the
  message's From or the thread's), has its pictures held back, the inbox's own included. HTML over 1,000,000
  characters is left out (`htmlTooLarge`). A plan per message (id, held-back state, SHA-256 of the HTML; kept with
  its served HTML in `servedPlans`, at most 200 and 24,000,000 characters, the plans' addresses counted, with `work`
  counters) answers both the serving and the route, so a picture request costs a lookup.
  The route (`fetchPicture`, person only, `needs_person` for an agent, also when called directly) fetches only a
  shown picture's address; anything else is `not_found`. `Host.pictures` (`PictureSource`) fetches: on Node
  `DiskPictureSource` (`<data-dir>/pictures`, not in demo mode): the first ask fetches, then the disk serves (per
  inbox: `sha256(inbox id)` folder, `sha256(address)` file, the type in its first bytes, the file's time as last
  served by the source's clock); one fetch per address at a time, 6 at once; 256 MB, the least recently served going
  first, nothing unserved for 30 days, half-written files older than an hour swept; a removed inbox is marked and its
  folder deleted (a picture written meanwhile goes after). A refusal by the rules or the content (`PictureRefused`
  of kind `refused`) is kept as a record and served as a blank GIF; a failure (kind `failed`) is kept with its tries
  and retried after 10 minutes and then a day, then kept failed. Only PNG, JPEG, GIF, WebP and AVIF (by their bytes,
  read to the end: every GIF frame, every AVIF `ispe` in meta/iprp/ipco) of at most 20,000 pixels a side and 40
  million in all; at most 2×2 served blank. The fetcher (`fetch.ts`): http or https on 80 and 443; names asked of DNS
  servers (`dnsResolver`: `dns.Resolver`, 2 s and 2 tries a query, A and AAAA) within the 15 s deadline;
  `isPublicAddress` for every address (one private among public is enough to refuse) and for IP literals, refusing
  too any address in a network of the server's interfaces (`os.networkInterfaces()` at each fetch); the connection
  pinned to the checked addresses through `http.request`'s `lookup`, a new connection per hop (`agent: false`),
  redirects checked again, at most 3; Apple Mail's user agent, `accept-encoding: identity` (a compressed answer is
  refused), no other headers; 10 MB (declared, then counted), 5 seconds for an answer. A failure is sent as
  `provider_error` (502). Pictures are served typed by their bytes, `inline`, `nosniff`, `CSP: sandbox`,
  `Cache-Control: private, max-age=86400`.
- **Search** (2026-11-20): in [server-search.md](server-search.md) (the code, its choices, the measurements).
- **Waiting threads leave the category lists** (2026-11-20, the owner's decision): `categoryListed(now)` in `lists.ts`
  (not screened, not done, no come-back time ahead) is a category's list and its count; stacks are unchanged.
- **Demo mode.** `--demo` seeds the sample into an in-memory store: inboxes, threads with categories and summaries,
  records, rules, drafts, the brief, the AI's settings (a sealed stand-in key for the sample's connection, the
  sample's chosen models), its status (state, last run, version) and the counts' version; the fake models report the
  sample's default ids. Every list, the counts, the AI's settings and status equal the sample. History isn't processed,
  so the sample's waiting thread stays waiting; new mail is categorized and summarized by the fake models. An inbox the
  sample gives a `firstSync` (Personal, since 2026-11-23) is seeded with its first sync not done and that count; its
  mailbox refuses every sync (it needs attention), so it keeps both.

## Tests

`npm test` runs 950 tests in 260 suites (944 pass; 6 skipped: the provider contract's three search tests on the two IMAP-shaped memory mailboxes, which have no search, as IMAP has none) in about ten seconds (2026-11-21). All use `FakeModels`; none calls a real model, none
reaches Google, and none reaches the real network for a picture.

- "Outgoing" from evidence (2026-11-18): `forged-own` (7: a forged From: me starting a thread is screened with its
  pictures held, addressed to a spammer lets nobody in, a reply into it lets nobody in, in a let-in thread shows as
  written; the provider's own sent mail still lets recipients in; the own address is never let in by itself; a
  copy of mail the server sent is the inbox's own) and `migration-0009` (1: the own address forgotten where let in,
  a block kept).
- Which stored message new mail is (2026-11-18, the third review): `message-identity` (a known Message-ID with
  other content, other words or an exact copy filed as spam or delivered to the inbox changes nothing; a move by
  another app taken in the same batch, after a later removal, with the copy's latest state, across a restart; held
  copies forgotten with their ref or inbox, and no longer held once a move takes them; Gmail by ref only; a note to
  self and a Cc to self becoming the inbox's own when the Sent copy joins, in either order and in one sync, and
  staying while either copy is left; sent keys pruned, with a Bcc added, reused with other recipients or words, and
  with HTML or an attachment added, on IMAP and Gmail; the Sent copy joining a thread whose first incoming sender is
  blocked, or which the mailbox filed under Screening; 29 in all).
- Pictures from the web (75 then, more since the second review; fake picture hosts in
  `test/picture-hosts.ts` on 127.0.0.1 and ::1, fake resolvers, a silent DNS server on a local UDP port, made-up
  pictures, certificates made by the system's openssl in a temporary folder and removed at once): `pictures-dangers`
  (14: each danger against the production address rule, the host it would reach getting no request and no
  connection: loopback in every form, localhost, private, shared, link-local, metadata, IETF (Teredo, benchmarking),
  IPv4-mapped and NAT64 forms, a name with one private address among public ones, other ports and schemes, a user
  name; the server's own networks (made-up interfaces, and this machine's own addresses); a hung lookup within the
  deadline; names asked of a DNS server, never the hosts file; pinning against rebinding; every redirect checked
  again; at most three); `pictures-fetch` (12: headers, a new connection per request and hop, a redirect, statuses,
  compression, size caps, no answer and a trickle, https pinned with the certificate checked against the name);
  `pictures-source` (17: the five kinds typed by their bytes, refusals served blank and asked once, a failing site
  asked at most three times, a recovery, the size cap, tiny pictures blanked, kept per inbox and address, one fetch
  for many, forgetting during a fetch, half-written files swept, the cap); `pictures-sniff` (5: sizes as decoders
  use them, GIFs and AVIFs read to the end); `pictures-present` (11: the plan, ids, held back, the caps, the work per
  plan); `pictures-route` (16, through REST and the service: the HTML and `remotePictures`, headers, agents refused at
  the route and the service, a device limited to another inbox, only shown pictures, the work per request, HTML too
  long, a 502, no source, screened, blocked, forged "From: me" in a screened and a blocked thread, a blocked sender's
  message in another's thread, removal). A scratch mutation run weakened 32 defences one at a time; each failed a test.
- `e2e-first-sync-window` (2, since 2026-11-17): a first sync stopped after its first batch, started again with fewer
  days, against the fake Gmail and hoodiecrow with the real providers: nothing older fetched, nothing fetched lost, a
  larger window later fetching nothing more.
- `first-sync-progress` (4, 2026-11-23): a slow first sync's count shown after two seconds and then at most every two,
  gone with the status turning `ok` (versions and events counted), nothing on later syncs; kept on the row and listed
  while the inbox needs attention, then going on from it; a word heard while a batch runs shown, the batch's own when
  due; a quick first sync shows none and its versions are as before; (the review's, 2026-11-23) a first sync longer
  than `syncRounds` says `ok` with its count and dropping the count is still a version and an event (fails without
  `|| counted`); several inboxes' first syncs at once, each its own count and clock. `first-sync-pause` (4): a pause
  during the second of ten batches answers while that batch is still fetched, the batch stored and the provider closed
  in the background, nothing more fetched or shown while paused, resuming goes on from the cursor to the end, all
  history; after resuming the first count waits two seconds again (fails without `#close`'s `forget`); a pause and a
  resume at once, the pause's close slow to stop watching, open the inbox only after that close (fails without
  `#closes`' order: the provider in use was dropped and the first sync stalled); a removal answers at once, gone from
  the list and `inbox.removed` sent before the answer, the same address connected again meanwhile as a new inbox that
  syncs all of it, the old batch dropped and its failure not logged (fails without `#sync`'s gone check).
  `first-sync-reconnect` (3): new credentials during the second batch answer at once, the old provider asked nothing
  more and closed, the new one going on from cursor `F4`, the count never back to 0; a sync queued before new
  credentials never reaches the old provider (fails without `#sync`'s closing check); the old provider's batch failing
  after new credentials leaves the inbox `connecting`, not `needs_attention`, and logs no error (2026-11-24).
  `first-sync-pause`'s fifth test (2026-11-24): a pause while the sync opens its provider (its credentials opened
  slowly) fetches nothing. `sync.test.ts`, "inbox lifecycle": a come-back's write-back refused because the inbox was
  removed meanwhile logs no error. The pause and removal tests
  failed before the background close (each answered only after the batch, `settlesWithin`'s second ran out), and
  before the round loop's check all ten calls ran. `first-sync-counts` (3): a count alone reaches the person and an agent given the inbox, not one
  given another, and never touches the change notifier; no count shown once done or while paused; `toInbox`'s guard
  (each seen failing with its line removed). `migration-0019` (1): both columns added, empty, nothing else changed, no
  count listed. Shared helpers: `test/first-sync-helpers.ts`.

- `google-sign-in` (14, end to end through REST with the real Gmail provider against mail's `FakeGoogle`): info;
  starting and Google's address; a new inbox syncing and its mail processed with a key set; nothing secret in any
  response, event, log, page or unsealed row; reconnecting in place after a refused token; a new-inbox sign-in for a
  connected address; a pasted inbox signed in; another account refused; declined, scope left out, no refresh token;
  expiry, reuse, made-up states, another device, a removed device; the page's headers and a hostile query;
  revocation on removal (its failure, none for a pasted token); the host's client gone or replaced; a hand-made
  `signIn` refused. `google-client` (11, 2026-11-21, through REST with the real Node seam on a scratch directory): the
  file saved as sent, 0600, no temporary file left, used by the next sign-in without a restart; an agent and no token
  refused; a Desktop client, not JSON, empty, missing fields, an array, too large and a bad flag refused in words; replace
  needs `replace=true` (another client, the same client, `false`); the redirect hint; the environment's client and a
  server without a seam refused, with the set-up's `client` saying why; a failed save; the set-up's prompt (core's, the
  address filled in, two blanks left), seven steps and their copy values, the client's id never its secret, no address
  (no prompt, no steps, `noAddress`); no secret in any answer or log line. `google-client-guards` (9, after the
  review the same day; each failed with the old behaviour put back): a saved file others can read and a Desktop
  client's file replaced only with `replace=true` and `replaced: true`, with the set-up's `note`; an inbox signed in
  while the environment gave the client, the variables then gone (refused naming its client id, the same client saved
  unasked and the inbox syncing, another confirmed); Content-Length over the limit (401 without a token, 400 with);
  a 1 MiB stream without Content-Length (401 and 403 with at most 2 KiB pulled, 400 with at most 18 KiB); the save not
  writing through a link at its temporary name nor removing it, the old pid name not used, a failing rename cleaned up
  (directly and through REST); a spoofed Host and X-Forwarded-Host leaving the redirect address alone; the client
  step's words for 127.0.0.1, localhost and https. `google-config` (8): the redirect address, `--public-url`, the switch's limits and rewriting, the
  client file as downloaded, its permissions, a desktop client, the environment.
- The AI: `ai-sorting` (20: every sorting step and its order, a stranger's one-time code with the AI working, without
  a key and failing, the gate held across a restart, the server's own `otp` check); `ai-sent` (3: core's words, no
  address in a summary request, nothing of a blocked sender's); `key-scrub` (17: the key in any form); `ai-pipeline`
  (17: may-process, history over all synced mail and its order, history days refused, re-categorizing, what leaves
  for each job, hostile mail, dropped category answers); `ai-summaries` (17, 2026-11-18: which summaries are kept,
  shortened or dropped, the drop's log line, the one-line prompt, migration 0006); `ai-usage-costs` (5: a cost looked up later and not a request, retried then given up, no id or a provider's own key, paused and the key removed, a restart with lookups waiting); `ai-usage` (9: what counts, null
  and partial, failures, a model change, periods cut at the person's midnight, 90 days kept, summer time, who may
  read it); `first-sync-window` (5: reading, the environment and demo, validation and keeping, new inboxes take it,
  a larger one widens nothing); `e2e-first-sync-window` (4: narrowed by a restart or by a person while running,
  Gmail and IMAP);
  `ai-status` (11: every state and wait, the key nowhere); `ai-settings` (11: no per-inbox switch, a key processes
  every inbox, another service keeps processing and resets the models, removal stops it, the disclosure route with
  and without a key, for each service, refused for an agent and an unknown service, defaults, versions, bounds, tests
  on saving, the gateway's model kinds); `ai-sdk` (26: the real access with `fetch` replaced; two for a search asked in a sentence); `search-ask` (21, server-search.md).
- `thread-fields` (5), `sync-decisions` (4), `lists-counts` (6), `upgrade` (1), `demo` (12), `memory-contract` (60:
  mail's contract suite on `MemoryMailbox` shaped like IMAP twice and like Gmail), and the translated suites:
  `service-sorting` (22), `service-trust` (28), `silent-undo` (10), `unit` (16), `rest` (16), `parts` (6),
  `inboxes-pairing` (9), `sync` (12), `sync-provider` (17: two more for an opened old conversation and a reset listing), `fourth-revision` (16), `final-review-fixes` (7),
  `provider-inbox` (6).
- End to end with the real providers: `e2e-imap` (6), `e2e-imap-filing` (3) (hoodiecrow and an SMTP sink),
  `e2e-gmail` (6, `FakeGmail`), and `e2e-ai-imap`, `e2e-ai-gmail` (1 each) with fake models: history processed, new
  mail categorized and summarized and filed, a correction taught, a stranger's code never under Screening, the key
  nowhere, a second server reading the categories back. Not covered end to end: AI failures, re-categorizing,
  pausing, the counts event, Gmail push.

## Checks

What each pass ran and saw, newest first: [server-checks.md](server-checks.md).

## Decisions where the contract leaves room

- **Now in the contract** (the review's decisions, 2026-11-17), as the server already did them: a `pending` thread from
  the fourth revision becomes `unknown`; the triage queue includes undecided threads whose AI answer was dropped; a
  filing under Screening made by the mailbox holds a one-time code (`screened_by_mailbox`), and history and filed mail
  under Screening aren't done; the first sync's history lets senders in without lifting anyone's screening, later
  ways of letting in do, also for threads the mailbox filed under Screening; a filed category's label taken away at
  the provider makes the thread a conversation decided by the mailbox; the gateway's categorize model is a decision
  model.
- **The triage queue leaves screened threads out,** as every list but search and screening does.
- **The `otp` check reads the message the model read** (the newest incoming one a model may see), its subject and its
  text made from HTML when it has no text part.
- **What a person sees of a thread follows the blocked senders as they stand when it is refreshed,** with no column;
  so letting a sender in again shows their messages in others' threads at that thread's next change.
- **Summaries naming the thread's first sender** (three or more characters, any case, as whole words since the review
  of 2026-11-17) are dropped. Before, a substring was enough, so a sender called "Tom" lost every summary that said "tomorrow"; the new test in `test/ai-pipeline.test.ts`
  failed first. A company that names itself in its own mail ("The best of Newsite this week") still gets no summary.
- **`triage.pending` goes out with counts,** at most once a second.
- **Counts and status versions are raised when they are read changed,** not only when the event goes out.
- Earlier decisions that still hold: archiving and moving at the provider told apart by the label; a stack added at
  the provider wins; rule hits one event per batch; paused write-backs held in memory; new mail older than a thread's
  newest message brings nothing back; proposals deduplicated; `includeSilent` and `attentionOnly` take only true or
  false; pairing failures counted in memory, per client address (below).
- **Wrong codes and passwords are counted per client address** (the owner password's security review, 2026-11-24,
  and its re-review; `service/attempts.ts`): ten from one address in ten minutes (an IPv6 address by its /64, an
  IPv4-mapped address as IPv4; `client-address.ts`'s `clientKey`), thirty from one IPv6 /48 ("from your network"), a
  thousand from everyone: at most 144,000 tries a day, about one in 7.6 million against one 40-bit code waiting all
  day (the derivation is in `attempts.ts`). Each key keeps at most its limit's newest failures; at most 10,000
  addresses and 10,000 /48s are remembered. The host says who the client is through `Host.clientAddress`,
  read by `MailServer` before it waits for the lock: Node keeps it per request in an AsyncLocalStorage
  (`node/client.ts`, `withRequestClient` around the app's fetch, so the dashboard and MCP get it too); Cloudflare in
  its request place (`cloudflare/address.ts`, from the front Worker's copy of `CF-Connecting-IP`). The host-neutral
  service imports no Node API, so the storage lives in each host. Outside a request, and in tests that set none, every
  attempt shares the key `unknown`.

## Other decisions

- **One lock for read-modify-write work, no interactive transactions** (D1 has none). Provider and model calls happen
  outside the lock.
- **Write-back and AI processing run in the background,** so actions answer at once; `whenIdle` waits for both.
- **Validation in the service** with valibot 1.5.0; unknown fields are refused.
- **libSQL with one connection.**
- **Versions:** Hono 4.13.18, @hono/node-server 2.1.8, Drizzle 0.45.4 with drizzle-kit 0.31.11, @libsql/client
  0.18.0, esbuild 0.28.2, ai 7.0.173, @ai-sdk/gateway 4.0.146, @ai-sdk/openai 4.0.118, @ai-sdk/anthropic 4.0.105,
  zod 4.6.7. Dev only: hoodiecrow-imap 3.3.1, smtp-server 3.21.6, imapflow 2.12.1.
- **Attachments** are served with `Content-Security-Policy: sandbox` and `nosniff`; pictures from the web too.
- **Pictures from the web: the HTML is written again each time it is served,** not when it is stored, so the stored
  HTML stays as the provider gave it (sanitized), letting a sender in shows their pictures, and a newer tracker list
  reaches older mail. It costs one sanitizer pass per message served, plus one per plan, which is kept. **Picture ids are hashes of the address**,
  not positions, so an id stays the same whatever else changes in the HTML. **Fetching stays in `src/node/`** behind
  `Host.pictures`, as nothing else may import `node:`; the plan and the byte checks are host-neutral.
- **The tracker list matches each pattern against a picture's address, ignoring case** (MailTrackerBlocker matches
  the whole `<img>` tag). Its broad patterns can take out an ordinary picture (known-issues.md).

## For provider authors (`mail/`)

- `connection()` describes stored credentials without secrets or the network.
- `sync` reports a placement exactly as `place` or `untrash` wrote it: `category` (filed category or `null`),
  `screened`, `stack` or `null`; leave `category` out while screened where a message has one folder, and `stack` out
  where stacks can't be kept. Mail filed on arrival is reported where it landed.
- The server sends `place`, `untrash` and `seen` only for incoming messages, with `inInbox: true` only with
  `category: null` and `screened: false`, and stores each new ref before the next `sync`.
- A message that leaves spam must come whole in `upserted`.
- `MemoryMailbox` (`src/testing/`) shows each case, including `categoryWhileScreened` (default false for `imap`, true
  for `gmail`), and passes mail's contract suite in three shapes.

## Not done

- **Real models have run only on the owner's server** (the gateway, from 2026-11-18); accuracy, OpenAI's and
  Anthropic's structured output on real models, and the real error bodies of each service are unverified (the tests
  use shapes from the SDK's code and the services' documentation).
- Gmail push notifications (Pub/Sub) are not built; the poll stays.
- One thread at a time in the AI queue; no batching or concurrency.
- Run against one real mailbox once (the owner's Gmail on their server, 2026-11-17, with the build before these
  notes' last fixes); never in Docker (not tried).
- Mail on Cloudflare itself: the Cloudflare host was deployed once to a real account (2026-11-23) and answered over
  HTTPS, but no Google sign-in, sync or AI has run there, and its Deploy button hasn't been tried
  ([server-cloudflare.md](server-cloudflare.md)).
- A fourth-revision IMAP mailbox with pile folders (`Usual Mail/Reads`) or a Gmail mailbox with pile labels isn't
  moved to the new names; no real mailbox was ever connected to such a build. An IMAP cursor naming `reads` or
  `receipts` is read as the categories, so it isn't refused as damaged.
- Pictures from the web are fetched only when first opened, never ahead of time; there is no setting to ask first; the
  tracker list is updated only by hand (`scripts/update-trackers.mjs`). A picture kept for a message that is later
  deleted stays until 30 days unserved or the cap.
- No replay of missed events; no pruning of old codes, prompts or history.
- Search: no matching inside words, no spelling tolerance, IMAP can't be searched remotely, nothing inside attachments
  (improvement-ideas.md).
- A repair the provider refuses is only logged. Write-backs held while paused are lost on a restart (the repair sends
  the differences).
