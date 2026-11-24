# Server on Cloudflare: limits, start-up, pictures and site icons (build steps 4 and 5)

**Built 2026-11-21 and tested in local workerd; deployed once to a real account on 2026-11-23** (its first deploy,
[server-cloudflare.md](server-cloudflare.md), "Seen on the first deploy"), **with no sync run there yet**, so "Not
verified" below still stands. Steps 4 and 5 of
[server-cloudflare.md](server-cloudflare.md)'s build plan. A session started them and was stopped by a usage limit at
15:29 that day, mid-change and without a report; the tree it left became the first local commit. A later session the same day
checked that tree, fixed its four failing workerd tests (all four were test faults, below), added the picture,
site-icon, address and bundle tests, and wrote this note; that evening it fixed what two independent reviews of steps 4
to 6 found ("After the review", below). The decisions are in [decisions-cloudflare.md](decisions-cloudflare.md)
("limits, start-up and pictures" and "after the review of steps 4 to 6"); the contract changes are
`docs/contract-sync.md` (a host may keep a message only up to a size), `docs/contract-pictures.md` ("What is fetched,
and how" and "What it hides") and `docs/contract-avatars.md` (the fetch rules and what the domain's owner learns).

## Files

`server/src/cloudflare/`: `limits.ts` (`CLOUDFLARE_LIMITS`), `start.ts` (the start and what a failed one does),
`web/` (`addresses.ts` the address rule in plain JavaScript, `dns.ts` DNS-over-HTTPS, `fetch.ts` the fetcher,
`pictures.ts` the picture source over the object's SQLite, `sources.ts` both sources), `object.ts` (wiring). Shared
code: `src/host.ts` (`HostLimits`, `NODE_LIMITS`), `src/service/context.ts` (`ctx.limits`, `ctx.picturePlans`),
`src/sync/fit.ts` (new) and `ingest.ts`, `src/sync/engine.ts` (the batch; a first sync done only when all of it is
in), `src/search/indexer.ts` and `doc.ts` (chunks, bodies read in rounds, the background), `src/rest/app.ts` and
`files.ts` (the token before the body; a streamed picture), and three files moved out of `src/node/` so both hosts
share them: `src/pictures/rules.ts` (ranges,
limits, headers, ports), `src/pictures/kept.ts` (the cache's caps and retries, the blank picture, `checkedPicture`),
`src/avatars/site-icons.ts` (`SiteIcons`, the discovery over a host's fetcher; `src/node/avatars/site.ts` is now
`NodeSiteIcons` over Node's fetcher). Tests: workerd `limits.test.ts`, `start.test.ts`, `web-fetch.test.ts`,
`web-pictures.test.ts`, `web-icons.test.ts`, `bundle.test.ts` (grown); `addresses.test.ts` (plain Node, both hosts'
address rules compared); the test entry's hooks in `worker/hooks.ts` (start faults, limits, `POST /__test/web`); fake
hosts and resolver in `web-hosts.ts`; Node `test/host-limits.test.ts`, `search-bodies.test.ts` (with
`search-memory.child.ts`, run under a 128 MB heap), `sync-rounds.test.ts`, `rest-bodies.test.ts`, one more in
`message-identity.test.ts`.

## What runs

- **The limits** (`HostLimits`; a host that sets none gets Node's, `NODE_LIMITS`, so Node is unchanged):

  | Limit | Node | Cloudflare | What it bounds |
  |---|---|---|---|
  | `syncBatch` | 200 | 25 | messages (and label changes) asked of a provider in one batch, held converted until stored |
  | `storedMessageBytes` | none | 1,900,000 | a stored message's text, HTML and headers, in UTF-8 bytes |
  | `keptPictureChars` | the shared 24,000,000 | 4,000,000, its own plans | served HTML and picture plans kept |
  | `searchChunk` | 100 | 20 | threads the index reads (their messages' heads, attachment names) and writes together; a chunk also ends before 2,000 messages |
  | `searchReadChars` | 4,000,000 | 1,000,000 | characters of text and HTML the index reads in one round (at least one message) |
  | `searchInBackground` | false | true | the catch-up at start inside `start()`, or after it |

- **A message made to fit** (`fitMessage`, at ingest): over `storedMessageBytes` (as `storedBytes` counts the row),
  headers no message needs that long are cut first, only when they alone take more than a quarter (subject 2,000
  characters, ids and address parts 1,000, the first and the last 49 references, address lists while they fit); then the HTML is left
  out and the text kept, made from the HTML when there is none or only a stub, ending "[This message is too large to
  keep here in full, so its formatted version was left out. …]"; then the text is cut on a character and ends with the
  cut note. The same message always fits the same way, so the next sync doesn't rewrite it; whether a copy is exactly
  what the server itself sent is decided before, on the message as it came. A message over Gmail's 2 MiB arrives
  without its attachments' bytes already (mail's large-message path); this bounds what is stored, not what is held
  while converting.
- **What the index reads** (both hosts): a chunk's messages without their text and HTML (who, when, to whom, and how
  many bytes their bodies hold: `BODY_SIZE_SQL`, never fewer than their characters, since SQLite's `length()` stops at
  a U+0000) and its attachment names; then the text and HTML of each thread's shown messages,
  newest first, in rounds of at most `searchReadChars` (one message more when a single one is larger), each thread
  only as far as its body can still grow (each message adds at most 20,003 characters, and no more than a few times
  its own length), so a long thread of large mail reads its first few messages and stops. Bodies are read whole, never
  cut: the entries are exactly what reading every message whole made.
- **Search's catch-up in the background:** `SearchIndex.start()` subscribes and starts the catch-up without awaiting it;
  each chunk of 20 threads is read, then written under the lock in one batch, with a `setTimeout(0)` turn before the
  next, so the object answers requests between chunks (Durable Object SQLite answers at once, so its awaits alone never
  give requests a turn). A search awaits `fresh()`, so it waits for what is stale. The "Search index: N threads …" line
  follows the start line.
- **Start-up** (`start.ts`, `Starts`): every request and alarm awaits the start; the start runs the migrations first
  (not inside `blockConcurrencyWhile`), creates the host's tables (`owner_pairing_code`, `host_pictures`,
  `host_picture_parts`), reads the alarm, then builds the server. Before it runs it writes itself down as a failure
  (`usual-mail-start` in the object's KV: failures in a row, when, why) and syncs that to disk; it is deleted once the
  server answers and search's first catch-up has finished (`Started.settled`), so a reset during that catch-up counts
  as a failed start. A
  start that fails answers every waiting request 503 (`internal`, "The server couldn't start; its log says why."),
  logs why, records the reason and resets the object after 1 s. After one failure the next start runs at once; after
  two or more it waits the backstop doubling (1 min, 2, 4 … up to an hour), answering 503 "… It tries again after …"
  without trying. A start the runtime cuts off can't answer, but its record counts it. With an inbox the alarm is set
  for the next try (inside the alarm's own handler after its delivery, never overwriting it), so the server comes back
  alone; an alarm handler that throws would be retried only six times, so it doesn't throw.
- **Pictures from the web** (`SqlPictureSource`): `host_pictures` (inbox and address as SHA-256, kind `picture`,
  `refused` or `failed`, type, size, the failure's words, tries, retry time, last served) and `host_picture_parts`
  (bytes in parts of at most 1 MiB, written with the row in one transaction). Node's rules: fetched when first asked,
  then served from the store; refused ones kept and served blank; a failing site tried at once, after ten minutes and
  after a day, then kept failed; 256 MB for pictures (least recently served first, down to 90%, and 30 days unserved),
  50,000 records for a year, both across the whole server; several asks share one fetch; removing an inbox deletes its
  rows, and a fetch still running for it writes nothing. Two fetches at once (Node six). Each new source sweeps at its
  first write, so once per object instance. A kept picture is served as a stream, one stored part per pull (whole when
  its parts' total, counted in SQL, is its size), never assembled; a picture fetched now is served from the bytes in
  hand.
- **The fetcher** (`fetchWebBytes` in `web/fetch.ts`): http on 80 and https on 443 only; no user name; any IP address in
  the address refused (a special-range one as "a private one", a public one as "a bare IP address, which this server
  can't fetch from", both for good); each name asked for A and AAAA at `https://cloudflare-dns.com/dns-query` (JSON,
  2 s and two tries each, within the whole fetch's 15 s); one address outside the public ranges among them refuses it
  as a failure that may pass; the server's own host names (`OwnHosts`: `USUAL_MAIL_PUBLIC_URL`'s, each host whose
  address a request was taken at, the host of the request being answered) refused before any lookup, as a failure
  that may pass; `redirect: "manual"` and each hop checked again, at most three; Apple Mail's user agent, the picture
  types (or what a page or manifest asks), `accept-encoding: gzip, br` (decoded by the Worker's fetch; any other
  encoding refused); 10 MB declared (encoded) or read (decoded), 5 s to an answer. Not kept on a Worker: the pinned
  connection and the server's own networks.
- **Site icons:** the shared `SiteIcons` over this fetcher (`webSources`), so the page (its first 512 KB), manifest,
  icons, the 6-request and 45-second caps and every address rule are Node's.

## Checked locally (2026-11-21)

- **The tree as left (the first local commit), before any change:** server both type checks clean, `npm test` 987 tests (981 pass,
  6 skipped, 0 fail); `npm run check:cloudflare` 32 tests, 28 passing; core, dashboard (160), connector (133), command
  (169) checks green; mail type-checks and 540 tests (525 pass, 15 skipped).
- **The four failures, each a test fault, the code right:** (1) "workerd refuses a row over 8 MB" inserted 8 MiB + 1
  byte, which local workerd takes: its limit is 8,388,636 bytes for a lone value and applies to the row, all columns
  together (two 4.5 MB values are refused); the test now inserts 8 MiB + 64 KiB, and two 4.5 MB values, and a row of
  the host's own limit beside 1 MB that passes. (2) "a message whose row would pass 8 MB" asserted its 8.8 MiB HTML was
  over 9 MiB; now over 8 MiB, and the rest passed unchanged. (3) The search catch-up test failed only because (2) had
  stopped before delivering its mail. (4) "two inboxes … share one gate": the earlier test's action left 150 label
  changes in the first inbox's history, which batches of 25 (step 4's `syncBatch`) read in 6 rounds, so the
  second inbox synced alone and the premise never held; the test now catches the first inbox up first (a history
  request starting at the mailbox's latest id), and compares by turn instead of by clock: each of the first inbox's 20
  messages began before the second's first. It fails with a gate per provider.
- **Seen failing on purpose, then restored:** every address public (3 fetch tests fail), each redirect hop unchecked (1),
  more than three redirects (1), compression accepted (1), refusals not remembered (3 picture tests), one part per
  picture (1), the icon source ignoring the request's limits (1), an off-by-one in either address range check (the
  comparison fails), no reset after a failed start (all 3 start tests), the catch-up inside `start()` (Node's test),
  no turn between chunks (the new workerd test: 33 of 33 indexed before the next request was answered, against 4 of 33),
  demo code imported by the Worker (the bundle test).
- **A failed start recovers:** `start.test.ts` (3 tests): one failure answers 503, resets, and the next request starts;
  starts cut off three times wait longer each time and never loop; with an inbox, two failed starts in alarms, then the
  alarm alone brings the server back and it syncs the mail that came meanwhile.
- **No demo or development code in the deployable bundle:** its source map names 229 of the repository's files and
  none under `server/src/demo`, `server/src/testing`, `server/src/node`, `server/src/ai/fake*`, `server/test`,
  `mail/src/testing`, IMAP or SMTP, nor `core/fixtures`; `bundle.test.ts` now checks that and the names `seedSample`,
  `demoProviders`, `FakeModels`, `dev-fake`, "DEVELOPMENT ONLY", `MemoryMailbox`. What the step-2 review saw bundled
  can't be told from that commit; it isn't there now.
- **The end of that pass:** `npm run check:cloudflare` 73 tests passing; `npx wrangler deploy --dry-run` 5,444.10 KiB.

## After the review (2026-11-21, evening)

Two reviewers checked steps 4 to 6; each fix below has a test that fails on the code before it (shown by putting the
old code, or its old line, back and restoring it):

1. **Search's catch-up memory:** bodies read in rounds (above). `search-bodies.test.ts`: every entry of nine threads
   (long ones, HTML stubs, HTML only, astral characters, HTML as text, an unclosed style block, many small, empty, links)
   equals the old algorithm's under four sets of limits (also seen failing when HTML is read cut at 20,000); a child
   process with a 128 MB heap catches up over 20 threads of 70 messages of 81 KB (113 MB of HTML): the old indexer
   aborts out of memory.
2. **A first sync marked done early:** `sync-rounds.test.ts` (3 rounds of 2 messages, 15 in history): all 15 stored as
   history, none screened; the old logic stored 6. Reviewer B's probe (batches of 1, 10,005 messages) now stores all
   10,005 with none screened (67 s).
3. **The start's record cleared early:** `limits.test.ts`: the record stays while the catch-up runs and goes after it;
   a reset during the catch-up makes the next start's record count 2.
4. **Bodies before the token:** `rest-bodies.test.ts` (Node: 401 or 404 with at most two 16 KiB chunks read, pairing
   cut at 16 KiB, a tokened chunked body still read); `front.test.ts` (the Worker's 411 and 401,
   server-cloudflare-access.md). Reviewer A's probe of forty 2 MB tokenless bodies now gets each connection closed by
   the Worker's 411 mid-body (EPIPE) instead of 182 MB held.
5. **`/v1/%70air` uncounted:** `pairing.test.ts`.
6. **The server's own hosts fetched:** `web-fetch.test.ts` (through `OwnHosts`, however written) and the end-to-end
   picture test (a picture at the request's own host: 502, never asked).
7. **Compression refused:** `web-fetch.test.ts` (gzip and br decoded; deflate and zstd refused; a 50 MB gzip or br
   bomb stops at 10 MB).
8. **Kept pictures assembled:** `web-pictures.test.ts` (a 2.5 MB kept picture read as chunks of 1 MiB, 1 MiB and the
   rest). Reviewer A's probe of 12 kept 9.5 MB pictures read at once: workerd grew 21 MB, 41 MB with the old source.
9. **The fit:** the first reference kept (`host-limits.test.ts`), a large sent message's copy still the inbox's own
   (`message-identity.test.ts`).

End: the server's Node suite 997 tests (991 pass, 6 skipped); `npm run check:cloudflare` 79 tests; `npx wrangler deploy
--dry-run` 5,452.25 KiB (1,240.96 KiB gzipped); the rest in [server-checks.md](server-checks.md).

## After the re-check (2026-11-22)

A fresh reviewer judged every fix above right and found no Node regression; one more small round followed, each with a
test that fails on the code before it:

1. **A U+0000 slipped past the round's cap (Cloudflare):** a round was sized by SQLite's `length()`, which counts
   characters only up to the first U+0000 (0 for a 1,201-character text starting with one, in a Durable Object's
   SQLite, which reads the text back whole), so such messages added nothing and a round could take any number of
   them. Now it counts bytes (`CAST(… AS BLOB)`). `limits.test.ts`: the count is at least 1,201 (0 with the old
   expression) and the words after the U+0000 are found.
2. **Text after a U+0000 lost on Node:** libSQL reads a stored text back only up to its first U+0000. Mail's parser now
   takes U+0000 out of a message's text, HTML and subject (`mail/test/unit/parse.test.ts`), and the server out of a
   draft's subject and body (`server/test/nul.test.ts`: "Before the NUL." was all a draft kept). Mail stored before
   keeps its own (known-issues.md).
3. **Held write-backs behind an extra sync:** when a sync's rounds run out, the next sync is now queued after the
   write-backs held while paused and the repair (`sync-rounds.test.ts`: the held "read" went out after the second sync
   before; now between the first and the second).

End: the server's Node suite 999 tests (993 pass, 6 skipped); `npm run check:cloudflare` 80 tests; mail 541 (526 pass,
15 skipped); `npx wrangler deploy --dry-run` 5,452.74 KiB (1,241.21 KiB gzipped).

## A first sync's count across rounds and resets (2026-11-23)

How far a first sync has got ([sync](../contract-sync.md#sync); [server.md](server.md)) runs the same shared code here.
A Gmail first sync goes in batches of 25 (`syncBatch`) with the object liable to be reset between any two, so nothing
about the count lives only in memory: the provider counts from its cursor (`n`, stored in `inboxes.sync_cursor` with
every batch) and the server writes each count it shows to the inbox's row (migration 0019). After a reset, the list
shows the row's count at once and the restarted first sync counts on from the cursor's, never from 0; only the
two-second marks are in memory, so the first count after a restart comes two seconds into it.
`server/test/cloudflare/first-sync.test.ts`: 100 messages behind 100 ms of fake latency, the object reset once the
count passed the first batch; the count listed after the reset, every count after it at or above the stored cursor's,
total 100 throughout, and at the end all 100 stored as history and the count gone (seen failing with the count in the
event only).

**What a count costs** (the review of 2026-11-23). Any `inbox.changed` used to go through `Ctx.emit`, which tells the
change notifier, whose flush (at most once a second) works out every inbox's counts (`computeCounts`, a scan of all
`threads`), the AI's status and the triage queues under the global lock. A count alone changes none of them, yet it
came every two seconds per syncing inbox, mostly while a batch was still being fetched: on Cloudflare about ten per
batch of 25 (Gmail about 1.3 messages a second), against the one flush the batch's own stored mail needs; on Node about
75 per batch of 200. Each flush reads every thread stored so far, so over a first sync of M messages that grows to T
threads the counts alone read about 0.4·M·T/2 rows: some 10⁹ for 100,000 messages in 50,000 threads, and a Durable
Object's SQLite counts every row read toward the plan. So the count's event goes out with `countsUnchanged`
(`src/sync/progress.ts`): published to the same event bus, so every receiver that may see the inbox hears it as before,
without touching the notifier. `server/test/first-sync-counts.test.ts` checks both (seen failing without it).

**Pausing.** The round loop and the close (`src/sync/engine.ts`) are the shared ones, so a pause stops a first sync
here as on Node: the PATCH answers at once, and the batch being fetched (25 messages, about 20 seconds of Gmail) is
stored with its cursor in the background; nothing more is fetched, and resuming goes on from the cursor. The close
needs nothing to keep the object up (Cloudflare's docs, read 2026-11-23): it waits on the batch's own fetches, and
pending outbound fetches and timers each keep a Durable Object from eviction for up to 15 minutes, as for every sync
here; `ctx.waitUntil` in an object only does the same, so it isn't used. Were the object evicted mid-close anyway,
nothing is lost: the pause, new credentials or a removal's deletion are stored before the answer, and a restarted
object opens only inboxes that aren't paused, with their stored credentials. Nothing of the host's own drives a sync:
the alarm only restarts the object and tops up its CPU. `server/test/cloudflare/first-sync.test.ts` pauses a second
inbox's first sync of 100 messages once its count shows, Gmail slowed to a second an answer meanwhile: the PATCH
answers within a second (9.2 s before the background close; before the round loop's check it answered only once the
whole first sync was done), and the batch in hand is then stored.

## Not verified

On Cloudflare itself: the isolate's memory under real mail with these limits (workerd's process memory is all that was
measured, and only for the 30 MB message); that 8 MB is the platform's row limit as the page says (local workerd's is
8 MiB and a little); DNS-over-HTTPS from a deployed Worker (`global_fetch_strictly_public`), and whether Cloudflare's
network then resolves the name as the resolver answered (the rebinding gap is by design); the `CF-Worker` header's
value; that `redirect: "manual"` holds on the platform: locally a fetch with `redirect: "follow"` through Miniflare's
outbound service wasn't followed either, so only the per-hop check is shown by the tests (known-issues.md); real
sites' answers through Cloudflare's network; that Cloudflare's fetch decodes gzip and br as local workerd does; that
a client on HTTP/2 or HTTP/3 always sends Content-Length with a body (the Worker answers 411 otherwise). Open (known-issues.md): a
backlog of label changes is read 25 at a time; the Gmail cursor's ids in the inbox's row; an old conversation or
`refreshThread` reads one whole thread; every request wakes the object.
