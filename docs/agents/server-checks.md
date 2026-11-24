# Server: check runs

What each pass ran and saw on this Mac (Node 22.23.2), newest first, split out of [server.md](server.md). Commands are
in server.md, "Run and check".

- **The owner password's re-review follow-ups (2026-11-24, `owner-claim-fix`):** `npm run check` in `server/` (both
  type checks, 1,063 tests: 1,057 pass, 6 skipped, 0 fail; the build and the smoke test). `npm run check:cloudflare`:
  both type checks clean, 91 tests pass. Each new test seen failing on a mutation that undoes its fix (the ceiling back
  to a hundred, no /48 count, each prose field back to `line()`, an inbox's name made prose, the /0 refusal off, the
  `cloudflare` word gone). `node scripts/build.mjs <scratch folder>` twice: `server.mjs` (7,984,584 bytes)
  byte-identical; the smoke test passed on it (with `migrations` beside the folder and `node_modules` linked in, as the
  image has them). Probed with that build on scratch ports and temp data folders: `USUAL_MAIL_TRUSTED_PROXIES` of
  `0.0.0.0/0`, `::/0` and `private, ::/0` each exit 2 with the /0 sentence, `private,cloudflare` starts; behind
  `private` (the probe connecting from 127.0.0.1 and naming clients in `X-Forwarded-For`), ten /64s of one /48 with
  three wrong codes each then the right password from an eleventh /64 answered 429 "from your network" with
  `Retry-After: 600`, another /48 and an IPv4 address 200; the reviewer's ten IPv4 addresses of ten then the owner 200;
  at a thousand failures the owner 429 "from everyone together". In demo mode a decision batch of three with a line
  break in one reason 200 with it made one line, a rule's text likewise, and a rule's `listId` with a tab, an inbox's
  name and a device's name with a line break 400 `invalid`. Every server and folder removed afterwards.
- **0.1.1 merged onto the owner's password (2026-11-24):** the stop fixes rebased by hand onto `main` after the
  owner's password (`09675db`) and the guides' claiming (`3fcda2e`); `main.ts` keeps both the owner email's wiring and
  the stop during start-up. Both type checks clean; `npm test` 1,035 tests (1,029 pass, 6 skipped, 0 fail).
  `npm run check:cloudflare`: 84 tests pass. `node scripts/build.mjs <scratch folder>` twice (in `server/`):
  `server.mjs` (7,973,470 bytes), `runtime.package.json` (`libsql` 0.5.29 alone) and `THIRD_PARTY_LICENSES.txt`
  byte-identical; `USUAL_MAIL_BUNDLE=… node scripts/smoke-bundle.mjs` passed on one. In Docker (29.9.3), the image
  built from the merged tree on a scratch volume and port: `/v1/info` said 0.1.1 and claimable by password; a claim
  with a password answered 200 and removed the owner's code file, a second claim 409, a sign-in with the password 200
  (also after a restart) and with a wrong one 401; the server ran as uid 1000; `docker stop` 0.13 s, exit 0,
  `StopTimeout` 180. With `USUAL_MAIL_OWNER_EMAIL` set: claimable by Google, a password claim 403, the owner's code
  file written. Containers, volumes and the image removed afterwards. `dist/` untouched (its hash checked).
- **SIGTERM during start-up, and 0.1.1 (2026-11-24, the final review's last findings):** both type checks clean;
  `npm test` 1,022 tests (1,016 pass, 6 skipped, 0 fail). New, `stop-at-start.test.ts` (2), both seen failing on the
  code before the fix: `main.ts` run from source with a preload that sends the process SIGTERM as soon as anything
  listens for it exits 0 without listening (before: it listened, printing the owner's code, then stopped); a
  `MailServer.start({ signal })` aborted during the start starts no sync and a start without one syncs (before: 2
  syncs). `npm run check:cloudflare`: both type checks clean, 82 tests pass. `node scripts/build.mjs <scratch folder>`
  twice (in `server/`): `server.mjs` (7,939,909 bytes), `runtime.package.json` and `THIRD_PARTY_LICENSES.txt`
  byte-identical; `USUAL_MAIL_BUNDLE=… node scripts/smoke-bundle.mjs` passed on one. The scratch bundle with the
  same preload: its handler in place 103 ms after the process began, exit 0, never listened. In Docker (29.9.3), the
  image built from the working tree, `--cpus 0.1` (start-up 8 s instead of 0.27 s), `--stop-timeout 10`, a fresh
  volume, `docker stop` 4 or 6 s after `docker run`: with a bundle built from the code before the fix mounted over
  `dist/server.mjs`, 10.1 s each time, exit 137, after listening; with the fix, 4.4 and 2.4 s (the start-up step in
  hand finishing at a tenth of a CPU), exit 0, never listened. Sent 2 s after `docker run`, before Node had parsed the
  bundle, the fixed image too ignored it (10.2 s, 137): the gap left open (known-issues.md). Every test container,
  volume and the image were removed afterwards. `dist/` untouched (its hash checked).

- **The re-review's engine guard (2026-11-24, for 0.1.1):** both type checks clean; `npm test` 1,020 tests (1,014
  pass, 6 skipped, 0 fail). New: `first-sync-stop.test.ts`'s second test (as the first, then "sync now" for the fast
  inbox once its close is done, while the stop waits for the slow one's batch): on the engine before the guard the
  fast inbox started 17 batches during the stop, which took 3.5 s. With the guard, `provider-inbox.test.ts` (a
  come-back after a stop) and `sync-provider.test.ts` (repair after a restart) failed until their "first process"
  was started, as a process is. `npm run check:cloudflare`: both type checks clean, 82 tests pass (they sync: first
  syncs, two inboxes at once, the alarm's restart, Gmail). `node scripts/build.mjs <scratch folder>` twice: the three
  files byte-identical, `server.mjs` 7,938,533 bytes. The smoke test wasn't run on it. `dist/` not rebuilt (its hash
  checked unchanged).

- **The stop closes every inbox together; the stop in the image (2026-11-24, after 0.1.0):** type checks clean;
  `npm test` 1,019 tests (1,013 pass, 6 skipped, 0 fail). New: `first-sync-stop.test.ts` (two inboxes whose batches
  take 400 and 150 ms of real time, the stop beginning as the slow one's second batch starts): no batch starts once
  the stop begins, the stop takes about the slow batch in hand, and every batch that started is stored; on the old
  `stop()` the fast inbox started three more batches. `npm run check:cloudflare`: both type checks clean, 82 tests
  pass. `node scripts/build.mjs <scratch folder>` twice: the three files byte-identical; `server.mjs` 7,938,483 bytes
  (esbuild: 7.6 MB). The image built from the working tree (arm64, 387 MB) holds that same `server.mjs` (sha256
  equal). In it, two IMAP inboxes (test IMAP servers on the host behind bandwidth-limited proxies, 1,000 and 2,000
  messages, batches of 200 taking about 7.5 and 4 s, reached through a relay in the container's network: see
  known-issues.md, "Hosting platforms") were stopped with `docker stop` (`StopTimeout` 180) during their first syncs:
  6.6 s, each inbox stored its batch in hand (+200), and nothing more was fetched. An image with only the old
  `stop()` took 7.7 s, and the second inbox fetched a whole extra batch four seconds into the stop. The bundle run by
  Node on this machine gave the same (SIGTERM: 5.7 s, +200 each), and pausing both through the API stored each batch
  in hand within 6 s. `dist/` untouched (its hash checked).

- **The final review's fixes and libSQL's local client (2026-11-24):** type checks clean; `npm test` 1,018 tests
  (1,012 pass, 6 skipped, 0 fail), before and after the libSQL change. New: `first-sync-reconnect`'s third test
  (`needs_attention` after new credentials), `first-sync-pause`'s fifth (a pause while the provider opens fetched a
  batch) and `sync.test.ts`'s second "inbox lifecycle" test (a removed inbox's refused write-back logged an error),
  each seen failing on the code before. `npm run check:cloudflare` (after the root's `npm ci`, which this checkout
  lacked): both type checks clean, 82 tests pass. `node scripts/build.mjs <scratch folder>` twice, before and after
  each change: `THIRD_PARTY_LICENSES.txt`, `server.mjs` and `runtime.package.json` byte-identical between the two
  builds; the own-code fix changed only the two "(in this repository)" headings; with libSQL's local client the
  bundle takes in 58 packages (`@libsql/client`, `@libsql/core`, `js-base64` added; esbuild's metafile shows no
  `promise-limit`, `ws` or hrana client) and leaves only `libsql` outside, which `runtime.package.json` names at
  0.5.29. A scratch bundle built inside `server/` passed `USUAL_MAIL_BUNDLE=… node scripts/smoke-bundle.mjs` and went
  to the Trash. `dist/` not rebuilt (the owner's running server uses it; its hash checked unchanged).

- **The re-review's fixes: closing in the background (2026-11-23, evening):** type checks clean; `npm test` 1,015 tests
  (1,009 pass, 6 skipped, 0 fail). New or rewritten: `first-sync-pause` 4 and `first-sync-reconnect` 2 (the pause,
  removal and credentials tests failed first: each answered only after the batch in hand; then, in scratch copies of
  the engine, each of `#sync`'s closing check, `#close`'s `forget`, `#sync`'s gone check and `#closes`' order fails
  exactly its test when removed). `npm run check:cloudflare` 82 pass (the pause test, Gmail slowed meanwhile, failed
  on the code before: the PATCH took 9,198 ms). Command 169 pass. `wrangler deploy --dry-run` 5,461.83 KiB
  (1,243.98 KiB gzipped). `dist/` not rebuilt: a scratch bundle built inside `server/`
  passed `smoke-bundle.mjs` and went to the Trash, but `scripts/build.mjs` itself exited 1 after writing it: its new
  licence step (`scripts/licenses.mjs`, another session's work in progress) found no licence file for
  `@ai-sdk/provider-utils@5.0.81` and `drizzle-orm@0.45.4` in `node_modules`.
- **First-sync progress (2026-11-23):** type checks clean (`tsconfig.json`, `tsconfig.node.json`); `npm test` 1,004
  tests (998 pass, 6 skipped, 0 fail), the 5 new ones (`first-sync-progress` 4, `migration-0019` 1) seen failing
  first; `npm run check:cloudflare` at the root 81 pass (the new `first-sync.test.ts` seen failing with the count
  written to the event only, not the row: the list never showed it); `wrangler deploy --dry-run` 5,459.23 KiB
  (1,243.16 KiB gzipped). **`dist/` not rebuilt** (a running server used `dist/server.mjs`;
  known-issues.md), so the bundle was built with `scripts/build.mjs`' options into a scratch folder in `server/`,
  passed `smoke-bundle.mjs` (`USUAL_MAIL_BUNDLE`), and was moved to the Trash (known-issues.md).
- **The review's fixes (2026-11-23):** type checks clean; `npm test` 1,011 tests (1,005 pass, 6 skipped, 0 fail). New:
  `first-sync-pause` 2 (both failed before the engine fix: all ten calls ran), `first-sync-progress` 2 more (the
  rounds test fails with `|| counted` removed; several inboxes), `first-sync-counts` 3 (each fails with its guarded
  line removed: `countsUnchanged`, the paused and done guards, `toInbox`'s). `npm run check:cloudflare` 82 pass (the
  pause test failed before the fix: the PATCH answered with the first sync already done); `wrangler deploy --dry-run`
  5,460.25 KiB (1,243.46 KiB gzipped). `dist/` again not rebuilt: a scratch bundle
  built with `scripts/build.mjs`' options inside `server/` passed `smoke-bundle.mjs` and was moved to the Trash.
- **A real server rebuilt (2026-11-22):** the reviewed tree, unchanged: `npm run build` (7.5 MB) and `npm run smoke`
  passed in place. The server restarted on it with no migration to apply ([apps-runs.md](apps-runs.md)).
- **The final review before a real server is rebuilt (2026-11-22):** the same tree re-run by an independent
  reviewer. Type checks clean, 999 tests (993 pass, 6 skipped, 0 fail); `npm install && npm run check:cloudflare` 80
  pass; mail 541 (526 pass, 15 skipped); core's check; dashboard 160, connector 133, command 169; `apps/scripts/check.sh`
  exit 0 (`UsualMailKit` 497, `UsualMailUI` 382, both builds). `wrangler deploy --dry-run` 5,452.74 KiB (1,241.21 KiB
  gzipped). A bundle built outside the repository (its own `dist/`, a copy of `migrations/`, `node_modules` linked)
  passed `smoke-bundle.mjs`; `dist/server.mjs` unchanged. Mutations in scratch copies: the
  next sync queued before the held write-backs fails `sync-rounds`' order test; forgetting a sender picture's load in
  flight at the start of `load`, or just before its request, fails `aLoadStartedWhileTheRequestIsOutJoinsIt` only (5
  runs of 5). libSQL 0.18 (SQLite 3.45.1), probed: a text with U+0000 is stored whole, read back cut, `length()` stops
  at it, `length(CAST(… AS BLOB))` and `octet_length()` count every byte, and JSON columns escape it.
- **After the re-check of those fixes (2026-11-22):** search's round counted in bytes (a leading U+0000 counted 0),
  U+0000 out of parsed mail and of drafts, the next sync queued after the held and repair write-backs
  ([server-cloudflare-limits.md](server-cloudflare-limits.md), "After the re-check"). Each new test seen failing on the
  code before. Type checks clean, 999 tests (993 pass, 6 skipped, 0 fail; new: `nul` 1, one in `sync-rounds`);
  `npm run check:cloudflare` 80 pass (one in `limits`); mail 541 (526 pass, 15 skipped; one in `parse`); core's check;
  dashboard 160, connector 133, command 169. `wrangler deploy --dry-run` 5,452.74 KiB (1,241.21 KiB gzipped). Scratch
  bundle smoke-tested; `dist/server.mjs` unchanged.
- **The fixes from the review of the Cloudflare host's steps 4 to 6 (2026-11-21, late evening):** search's index reads
  bodies in bounded rounds (identical entries), a first sync done only when all of it is in, the start's record kept
  until search's first catch-up, the token before the body on every REST route and 16 KiB for pairing, the front
  Worker's 411 and 401, the pairing count by the routed path, the fetcher refusing the server's own hosts and taking
  gzip and br, kept pictures streamed, the fit's first reference and order ([server-cloudflare-limits.md](server-cloudflare-limits.md),
  "After the review"). Each new test was seen failing against the code before it, then passing. No migration. Type
  checks clean, 997 tests (991 pass, 6 skipped, 0 fail; new: `search-bodies` 2, `sync-rounds` 2, `rest-bodies` 5, one
  in `message-identity`); `npm run check:cloudflare` 79 pass (new: `front` 2, `pairing` 1, `limits` 1, `web-fetch` 3);
  core's check; dashboard 160, connector 133, command 169 with their type checks; mail not touched. `wrangler deploy
  --dry-run` 5,452.25 KiB (1,240.96 KiB gzipped). Scratch bundle (not `dist/`) smoke-tested; `dist/server.mjs`
  unchanged.
- **The Cloudflare host's steps 4 and 5 finished (2026-11-21, evening):** the tree a usage limit left at 15:29
  (the first local commit) was checked first: server type checks clean, 987 tests (981 pass, 6 skipped); workerd 28 of 32
  (the gate timing test and three limits tests failing, all test faults: [server-cloudflare-limits.md](server-cloudflare-limits.md)).
  Then the tests fixed, `host-limits`' background test replaced by one that tells the two modes apart, and new workerd
  tests (`web-fetch` 16, `web-pictures` 11, `web-icons` 11, `addresses` 2, one more in `limits`, `bundle` grown); each
  new or fixed test seen failing against deliberately broken code (the note lists them). End: type checks clean, 987
  tests (981 pass, 6 skipped, 0 fail); `npm run check:cloudflare` 73 pass; core's check; dashboard 160, connector 133,
  command 169, each with its type checks; mail type-checks, 540 tests (525 pass, 15 skipped); `wrangler deploy
  --dry-run` 5,444.10 KiB (1,237.81 KiB gzipped). `npm run build` not run (a running server used `dist/`): bundled
  to a scratch folder, `smoke-bundle.mjs` passed against it; `dist/server.mjs` unchanged.
- **The review's follow-ups to step 1 (2026-11-21, later):** `inList` takes text only; the remote search's hits use
  it; every LIKE whose pattern came from input or stored data replaced by `contains`/`endsWith`, and the tests fail a
  LIKE or GLOB pattern over 50 bytes; the migration replay also runs a store's pending files in one transaction.
  Type checks clean, 979 tests (973 pass, 6 skipped as before; new: `statement-patterns` 4, one each in
  `statement-limits`, `statement-limits-mail` and `migration-replay`). The new search, picture and remote tests failed
  on a copy of the old code (patterns of 59 and 66 bytes; 157 parameters). The plans of every statement that used
  LIKE are the same before and after (`EXPLAIN QUERY PLAN`, scratch copy). Scratch bundle smoke-tested again; `dist/` untouched.
- **No statement over 100 parameters (2026-11-21, the Cloudflare host's step 1):** lists as one JSON parameter,
  chunked inserts, the check in every test (decisions.md). Type checks clean, 972 tests (966 pass, 6 skipped as before;
  new: `statement-limits` 6, `statement-limits-mail` 10, `statement-limits-avatars` 4, `migration-replay` 2). The
  over-100 tests, run on a copy of the code from before the change, all failed (13 of 13; statements of 118 to 287
  parameters). Plans: the suite's 91 list statements compared before and after with `EXPLAIN QUERY PLAN` in a scratch
  copy: 81 the same, 9 adding only a sort of rows already found; the excerpts' query, whose `IN (SELECT … json_each)`
  ran its MATCH over the whole index, now has its old plan (a `CROSS JOIN` from the page). `npm run build` not run
  (a running server used `dist/`): bundled to a scratch folder, `smoke-bundle.mjs` passed against it.
- **Words for a person in the Google client's set-up (2026-11-21, later):** the replace cases' `conflict` words end
  "Confirm to replace it." or "Confirm to save it anyway." without the flag; one refused-file reason no longer repeats
  "doesn't use"; the prompt's report ends with the next step for the app or the command (core and the guide together).
  No shape change. Type checks clean, 950 tests (944 pass, 6 skipped as before; the route's tests now check the ends
  and that no flag is named); core's check; command 169. `npm run build && npm run smoke` passed.
- **The review's fixes to the Google client route (2026-11-21, afternoon):** what counts as a client to replace, the
  token before the body and a 16 KiB read, the exclusive temporary file (server and command), the served words. No
  migration; shapes changed only by the optional `GoogleClientState.note`. Type checks clean, 950 tests (944 pass, 6
  skipped as before; new: `google-client-guards` 9). Each new test was seen failing with the old behaviour put back,
  one at a time in place and restored (no token check first, the general limit first, "existing" from `client()`
  only, a non-exclusive temporary file, no clean-up): 2, 1, 3, 1 and 1 failures. Core's check (the prompt's redirect
  line changed in core and the guide together); command 169 (a new test, also seen failing with `w` for `wx` and
  without the clean-up); connector 133; dashboard and mail type-check. `npm run build && npm run smoke` passed. Live again on a scratch directory and port 0: the earlier run's steps, plus a chunked upload
  over real HTTP without Content-Length (401 without a token; 400 for a person offering 1 MiB). Stopped and removed.
- **The host's Google client from a person's device, and the guided set-up (2026-11-21, 12:45 CET):** no migration; the full check run twice, the second after the refusal words were split from `reason`.
  Type checks clean, 941 tests (935 pass, 6 skipped as before; new: `google-client` 11); core's check (the sample, and
  the new prompt check against docs/google-setup-agent.md, which was also seen failing on a changed line and passing
  again); command 168 (3 new); connector 133 and dashboard 159 with their type checks, unchanged; mail type-checks
  (its tests not run: mail didn't change). `npm run build && npm run smoke` passed.
  Live, the built bundle on a scratch data directory, port 0 and `--dev-fake-google http://127.0.0.1:9` (nothing
  called): paired from the owner's code file; `GET /v1/google/setup` had the redirect address in the prompt and seven
  steps; `PUT /v1/google/client` saved the file as sent with mode 0600 and no temporary file, refused a second client
  (409), a Desktop client and 20,000 bytes (400), replaced with `?replace=true`; `/v1/info` said available without a
  restart; `node cli/src/cli.ts google prompt` printed the prompt with the address and two blanks; the secret in no log
  line or answer. Stopped and removed. `cli/dist` not rebuilt.
- **Blocked senders for Settings (2026-11-20, 01:40 CET):** the tree was read and found green first (892 pass, 6
  skipped), and compared with a copy before the build: no edits but this work's. Test-first (`senders` 6, a REST case,
  the demo's list and Handled pin). No migration. Type checks clean, 900 tests pass and 6 skipped. Core's check (28
  threads, 3 blocked senders), connector 133, dashboard 159, command 165, design 38. Built once at the end:
  `npm run build && npm run smoke` passed; a start on a scratch store was clean.
- **A search asked in a sentence, step 3 (2026-11-20, 09:30 CET):** test-first (`search-ask` 21, two in `ai-sdk`, one
  in `demo`; a scratch run weakened eight guarantees one at a time, each failed a test: words not checked against the
  sentence, a retry allowed, an agent let in, a date ahead kept, sent while paused, no rate limit, counted under
  summarize, another field in the data block). No migration (the usage's job columns are text). Type checks clean,
  930 tests (924 pass, 6 skipped as before); core's check (5 sample sentences); mail 501 (486 pass, 15 skipped as
  before); connector 133, dashboard 159 and command 165, each with its type checks (their test doubles gained
  `askSearch`). `npm run build && npm run smoke` passed once, the smoke now asking a
  sentence without a key. `cli/dist` not rebuilt: the command's source didn't change, and it shows the disclosure the
  server answers. No real model was asked.
- **Search's first real bundle, after a state check (2026-11-20, 01:28 CET):** the session that finished this was
  resumed without the memory of the one that built search, so it read the tree first. Found and repaired: the
  connector's and the dashboard's test doubles didn't type-check against the new service (`ThreadDetail` not imported;
  `searchRemote` and `openRemote` missing), so `npm run check` failed in `mcp/` and `dashboard/` though their tests
  ran; and an opened old conversation met a reset listing wrongly in two ways (known-issues.md, "Fixed"), fixed
  test-first (`sync-provider` 15 to 17). Old bundle beside migration 0018, tried in a scratch copy (the bundle of
  00:33, in demo mode): it started, applied 0018, acted on threads, synced, searched the old
  way and removed an inbox (3 ms) without an error. Then: type checks clean, 898 tests (892 pass, 6 skipped: the
  contract suite's search tests on the IMAP-shaped memory mailboxes); core's check; mail 501 (486 pass, 15 skipped:
  nine of the same on the three IMAP servers, three "never loses its place", two spam, the Docker suite); connector 133,
  dashboard 159, command 165. `npm run build && npm run smoke` passed. `cli/dist` not
  rebuilt: the command's source didn't change and it uses nothing of core that did.
- **Search, steps 1 and 2, and waiting threads out of the category lists (2026-11-20, 01:25 CET):** test-first in a
  scratch copy of `server/` with its own `migrations/` (0018 moved in last). Type checks clean, 890 tests pass (6
  skipped; new: `search-local` 11, `search-index` 9, `search-remote` 5, `migration-0018` 1, one more in `demo`; the
  waiting lists in `sync`, `service-trust`, `demo`). A scratch bundle built in the copy (not `dist/`) passed
  `npm run smoke`, with search's new check. Core's check, mail 486 (15 skipped; the search part of the contract suite on
  Gmail's fake, skipped on IMAP), connector 133, dashboard 159, command 165. `dist/` and `cli/dist` not rebuilt.
- **More inbox icons, and untimed moment groups (2026-11-20, 00:33 CET):** test-first (the eight icons through the
  service, REST and Google sign-in; untimed moments in `ai-event-moments` and `ai-event-groups-pipeline`, with the
  pass again under its new id). Type checks clean, 857 tests pass; `npm run build && npm run smoke` passed. Core's check, command 165 (`cli/dist` rebuilt), dashboard 159 (sprite re-embedded),
  connector 132, design 38 and its Swift package (19 tests).
- **Groups by moment, and a limit's reset time (2026-11-19, 19:45 CET):** test-first (`ai-event-moments` 5 new, three
  moment and pass cases in `ai-event-groups-pipeline`; group-free facts in `ai-event-pipeline`, the last pass's id in
  `ai-payment-store` and `snippets`). No migration. Type checks clean, 853 tests pass. `npm run build && npm run smoke`
  passed; a start on a scratch store was clean.
- **Plain snippets (2026-11-19, 19:15 CET):** test-first (`snippets` 15, new: twelve readings, the cut and the summary's
  checks, at ingest, the start's pass once with silent done threads; `ai-payment-store`'s marker now the last pass).
  No migration. Type checks clean, 845 tests pass. `npm run build && npm run smoke` passed (the bundle
  holding the groups round too); a start on a scratch store was clean.
- **Notification groups, and notifications out of Home (2026-11-19, 18:55 CET):** test-first (`ai-event-groups` 7,
  `ai-event-groups-pipeline` 6, `migration-0017` 1, new; the Home tests in `lists-counts` and `demo`, the demo's
  groups, the event wording pin, `ai-sdk`'s seven fields, mail joining's pair in `ai-event-pipeline`). Built in a
  scratch copy with migration 0017 and moved in last; `drizzle-kit check` clean. Type checks clean, 830 tests pass.
  Core's check (25 threads, Home 5), connector 132, command 165, dashboard 159. `npm run build && npm run smoke`
  passed; a start on a scratch store was clean.
- **Notification events after their audit (2026-11-19, 18:19 CET):** test-first (`ai-event-rules` 9 new; the event
  wording pin, `changes` in place of `dated`, the event pipeline's asking-again test replaced, the payment test's
  notification now asked by it). `event.ts` split into `event-dates.ts`, `event-times.ts`, `event-lines.ts`. No
  migration. Type checks clean, 818 tests pass. `npm run build && npm run smoke` passed; a start on a scratch store was clean.
- **The day each message was sent, and the server's date for a time (2026-11-19, 18:00 CET):** test-first
  (`ai-sent-dates` 3 new; `ai-event` 13, three new; `ai-event-pipeline` 8, two new; the event and details wording
  pins, the items' keys and the details marker's last id updated). No migration. Type checks clean, 809 tests pass.
  Core's check (22 threads, Home 10), connector 131, command 165, dashboard 159. `npm run build && npm run smoke`
  passed; a start on a scratch store was clean.
- **Notification events (2026-11-19, 17:25 CET):** test-first (`ai-event` 10, `ai-event-pipeline` 6, event cases in
  `ai-sent` and `ai-sdk`, `migration-0016` 1; four earlier tests now expect a notification's event request or the
  sample's new Home). Built in a scratch copy with migration 0016 and moved in last. Type checks clean, 801 tests pass
  (the suffix list now ships, so none skip). Core's check (22 threads, Home 10), connector 131, command 165, dashboard
  159. `npm run build && npm run smoke` passed; a start on a scratch store logged sender pictures on.
- **Sender pictures on: the Public Suffix List shipped, and one-word payment parties (2026-11-19, 14:12 CET):** the
  list downloaded at commit `09c1b150f33c6145a73afcf7db0fb872fc54b4d1` (the owner's approval; checks in
  [server-avatars.md](server-avatars.md)); test-first for the one-word party rule (`ai-payment-rules` +4,
  `ai-payment-store` +2, one of them the real list's grouping). No migration. Type checks clean, 782 tests pass, none
  skipped (both shipped-list tests run). Mail 482 (476 pass, 6 skip), core's check, connector, command and dashboard
  type checks. `npm run build && npm run smoke` passed: `dist/server.mjs` 7.3 MB. A start on a scratch store logged "Sender pictures
  are on: the Public Suffix List at commit 09c1b150f33c; …" in place of the "off" line.
- **The payment state and one name per domain (2026-11-19, 13:41 CET):** test-first (`ai-payment-state` 12,
  `ai-payment-store` 5, the asking-again for the state and the pinned words in `ai-payment-pipeline`; older tests now
  expect `state`). No migration. Type checks clean, 774 tests pass and 2 skip. Core's check (18 threads, a state of
  each kind), connector 131, command 165, dashboard 159. `npm run build && npm run smoke` passed.
- **The payment details' last round (2026-11-19, 10:12 CET):** test-first (`ai-payment-rules` 12, `ai-payment-store` 3,
  `migration-0015` 1, the pinned words). Built in a scratch copy with migration 0015 and moved in last. Type checks
  clean, 760 tests pass and 2 skip. `npm run build && npm run smoke` passed; a start on a scratch store logged the
  usual lines, sender pictures off.
- **Payment details revised after their audit (2026-11-19, 09:58 CET):** test-first (`ai-payment` 19, `ai-payment-pipeline`
  11, `migration-0014` 1; `migration-0013` now compares only the columns a store had). Built in a scratch copy with
  migration 0014 and moved in last. Type checks clean, 744 tests pass and 2 skip (the sender pictures' suffix list
  isn't shipped). `npm run build && npm run smoke`: the bundle (7.1 MB, with the sender-picture code, off) passed; a
  start on a scratch store said "Sender pictures are off: this server carries no Public Suffix List …".
- **Payment details for receipts and invoices (2026-11-19, 08:42 CET):** test-first (`ai-payment` 11,
  `ai-payment-pipeline` 8, three in `ai-sdk`, one in `ai-sent`, `migration-0012` 1; six earlier tests now expect a
  receipt's details in place of its summary). Built in a scratch copy with migration 0012 and moved in last. Type
  checks clean, 652 tests in 175 suites pass (32 of them another session's avatar tests, new in the folder meanwhile).
  `npm run build && npm run smoke`: the bundle (7.1 MB) passed. Core's check, command 165, connector 131, dashboard 159.
- **The second round of the sorting words and asking again (2026-11-19, 08:15 CET):** test-first (`ai-categories`
  7, `ai-ask-again` 7, `migration-0011` reshaped: this build marks 212 on a store with the first round done). No
  schema change, so no migration; 0011 untouched. Type checks clean, 597 tests in 160 suites pass. `npm run build &&
  npm run smoke`: the real bundle (7.0 MB) passed. Core's check, command 165, connector 130, dashboard 159.
- **The sorting words, what a model reads, and asking the AI again (2026-11-19):** test-first (`ai-categories` 7,
  `ai-text` 8, `ai-ask-again` 6, `migration-0011` 1). Part C and migration 0011 were built and checked in a scratch
  copy of the package (its own migrations folder) and moved in as the last step. Type checks clean, 596 tests in 160
  suites pass. `npm run build && npm run smoke` at 00:32 CET: the real bundle (7.0 MB) passed. Core's check (sample
  consistent), command 165, connector 130, dashboard 159. No real model, key or mailbox: nothing measures accuracy.
- **The fourth review's fix and notifications in Home (2026-11-18):** test-first (`message-identity` 29, a Home test
  in `lists-counts`, the demo's Home now with the sample's notification). Type checks clean, 574 tests in 151 suites
  pass. `npm run build && npm run smoke` at 23:30 CET: the real bundle (7.0 MB) passed; the command's bundle was
  rebuilt at the same time (its copy of core's routes lacked the picture route). Core's sample check (Home 6), mail
  440 (6 Docker skipped), command 165, connector 130, dashboard 159, design. A mutation run of the six new
  defences (the sent key without text, HTML or attachments; `becameOwn` with a blocked sender, a filed note to self,
  a filed thread): all noticed.
- **Which stored message new mail is, after the pictures' third security review (2026-11-18):** step 1 first: the
  real bundle built from the round-2 tree at 22:24 CET (`npm run check`: 540 tests, smoke passed); `dist/` not touched
  since. Then each fix began with a failing test (`message-identity` 22, new cases in `pictures-present`,
  `pictures-source` and `pictures-dangers`, and mail's own-move removal). Type checks clean, 566 tests in 149 suites
  pass (with migration 0010 in place); a scratch bundle passed the smoke test. The reviewer's round-3 probes, run as
  copies: no rewrite by a known Message-ID, no trashed thread, the spammer stays screened; a note to self and a Cc to
  self become "You"; the kept-HTML thrash probe's second round takes 7 ms. A probe of my own found an exact copy
  filed as spam still trashing the thread, which held copies fixed. Mutation runs: 58 weakened defences (55 noticed
  once two tests were added; three second layers from round 2), then 27 for held copies and the provider's removals
  (25 noticed; equivalent: a removed inbox's held copies, which the foreign key removes anyway, and forgetting an own
  move once reported, since the cursor never reports that UID again). Mail 440 (6 Docker skipped), command 165,
  connector 129, dashboard 159, core's sample check.
- **Pictures after the second security review, and "outgoing" from evidence (2026-11-18):** each fix began with a
  failing test (`forged-own` 7, `migration-0009` 1, and new cases in the picture suites). Without `npm run check`
  (`dist/` untouched): type checks clean, 540 tests in 144 suites pass; a scratch bundle passed the smoke test
  (migration 0009 included). The reviewer's round-2 probes, run as copies: no CSS hole, no fuzz hit in 4 × 20,000,
  a 0.86M-character message served in about 0 ms after the first time, the forged-From thread screened with its
  picture refused, the interface cases as decided. A scratch mutation run weakened 40 defences: 37 failed a test;
  three are second layers no input separates from the first (records' share of the cap's count, and the stored
  sanitizer's whole re-read and whole-text script check). Mail 439 (6 Docker skipped), command 165, connector 129,
  dashboard 159.

- **Pictures after the security review (2026-11-18):** each fix began with a failing test. Without `npm run check`
  (`dist/server.mjs` untouched): both type checks clean, `node --test test/*.test.ts` 514 tests in 142 suites pass; a
  scratch bundle passed `scripts/smoke-bundle.mjs` (its private-address picture now served blank). The reviewer's
  probes: no served variant loads from another host; the failing tracker asked twice in their four openings; the
  forget race leaves nothing. Mail 396 (390 pass, 6 Docker skipped), the command 165, the connector 129, the dashboard
  159.

- **Pictures from the web (2026-11-18):** written test first by part (mail's pass, then the plan, the route, the
  address rule, the fetcher, the source). Run without `npm run check`, so `dist/server.mjs` (the build a running
  server used) wasn't overwritten: both type checks (`tsc -p tsconfig.json`, `tsc -p tsconfig.node.json`) clean and
  `node --test test/*.test.ts`: 490 tests in 139 suites pass. A bundle built with the same esbuild options into a
  scratch folder passed `scripts/smoke-bundle.mjs` (`USUAL_MAIL_BUNDLE` pointing at it), its new picture checks
  included. Mail (342: 336 pass, 6 Docker suites skipped), the command (165), the connector (129) and the dashboard
  (159) pass against the changed core. The running servers weren't touched.

- **The gateway's cost in the usage (2026-11-18):** `test/ai-usage-costs.test.ts` (5) failed first, then passed,
  with an SDK test of the id and the lookup's request (`GET /v1/generation?id=…`, no body). `npm run check`: type
  checks clean, 439 tests in 128 suites pass, the bundle rebuilt and its smoke test passed. Never run against the real
  gateway.

- **No history setting, the first sync's window a person's, and the AI's usage (2026-11-18):** the changed tests
  failed first for the window and the history (the usage tests were written beside `usage.ts`); the runtime narrowing
  test was checked to fail with the engine's reopening switched off. `npm run check`: type checks clean, 433 tests in
  126 suites pass, the bundle rebuilt and its smoke test passed (it now also reads `GET /v1/first-sync` after a
  restart and sets it with `PATCH`, checking settings.json and its mode). Core's, the command's (165), the
  connector's (129), the dashboard's (159) and design's (38) checks pass; the command's bundle rebuilt. The running
  real server wasn't touched; the rebuilt command read its status (no "Works on" line: that server has no window
  route yet).

- **Summaries kept and history over all synced mail (2026-11-18):** the new `test/ai-summaries.test.ts` and the
  changed history, settings, first-sync and triage tests failed first, then passed; `npm run check`: type checks
  clean, 418 tests pass, the bundle rebuilt (`dist/server.mjs` holds the new prompt and the refusal's words) and its
  smoke test passed. Migration 0006 was also run by `openDatabase` on a scratch store at migration level 0005, filled
  with several hundred made-up threads: the threads missing a summary set due, `pending` up by that many, and a second
  start didn't run it again. Core's, the command's (167), the connector's (129), the dashboard's
  (159) and design's (38) checks pass with the changed sample. The running real server wasn't touched.

- **The gateway's categorize default changed to `liquid/d1.2` (2026-11-18):** the `defaults` test in `ai-sdk` failed
  first, then passed; `npm run check`: type checks clean, 409 tests in 118 suites pass, the bundle rebuilt
  (`dist/server.mjs` now names `liquid/d1.2`) and its smoke test passed. The running real server wasn't restarted; it
  sets `liquid/d1.2` explicitly, so the new default changes nothing there.

- **After the owner's first run against Gmail (2026-11-17):** `npm run check`: type checks clean; 409 tests in 118
  suites pass; the smoke test now starts the bundle twice on one data directory (the second start, with
  `settings.json` saying 7, doesn't print the code, still pairs with it, answers `maxHistoryDays` 7). **Joined** with
  the built command (scratch home, port 8836, Node mode): `init --sync-days 7`, then `stop` and a plain `start`, kept
  7; `sync-days 3` and `20` restarted it; a client file without the address gave the hint in the log, `google` and
  `doctor` (exit 0). The bundle twice on port 8837: no code in the second log. All stopped; the other servers untouched.

- **Earlier on 2026-11-17** (each `npm run check` passed, the bundle's smoke test included): Sign in with Google, the
  switch's removal and the disclosure route (404 tests; the live run is in the [overview](01-overview.md)); the
  review's decisions (382, with 29 joined checks beside hoodiecrow); the fifth revision's first build and its review
  (338 to 341, the joined run in the overview).
