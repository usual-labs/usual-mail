# Server: search

The server's side of search (2026-11-20, the owner's request; the contract's [page](../contract-search.md)), in
`server/src/search/`. Built and tested with made-up mail only; never run against the owner's mailbox.

## How it works

An FTS5
  index in the store (migration 0018: `search_index` with unicode61 `remove_diacritics 2` and prefix indexes of 2 and 3;
  `search_docs` maps a thread to its integer row and keeps the version and source hash it was read at; `search_people`
  holds who wrote and was written to per thread, folded, for `from`, `to` and the people a search finds; a trigger
  deletes the FTS5 row with its `search_docs` row, so cascades clean up). `SearchIndex` (`indexer.ts`): a thread whose
  version differs from its entry's is read again (outside the lock; written under it only if its version didn't move);
  the same source (the thread's own columns) only notes the version; a removed thread's entry is deleted. `start()`
  catches up before the engine starts (a first start builds it and logs "Search index: N threads (M messages) indexed in
  S s"), then follows `thread.changed`, `thread.removed` and `inbox.removed` in the background; `fresh()`, before every
  search, looks for anything stale (0.6 ms at 3,300 threads), so search never lags a change. Messages are read with
  `readingText` (`ai/text.ts`, which `snippetText` now shares), shown ones only (`shownIn`). `local.ts`: `prepare`
  (valibot `SearchQuerySchema`, the scope from `listScope` per inbox, `parseSearch` in `terms.ts`, `invalid` with neither
  text nor a filter); the ranked query (the subject-and-sender tier by a `{subject sender}` column filter, then
  `bm25 squared / (1 + age / 14 days)` on whole seconds, then id; a cursor of the tier, score, id and the moment ranked
  against) or, for filters alone, newest first; exclusions as `NOT IN` a second FTS5 match. `excerpt.ts`: `highlight`
  of the subject and `snippet` of each other field with control-character marks, cut into runs. `remote.ts`: person
  only, a per-device limit of 10 a minute (in memory), each inbox's provider asked in turn (paused, `unsupported`,
  `needs_sign_in` for a `GoogleTokenError`, `provider_error`), held threads (by `threadKey`, not removed) left out, up
  to three provider pages per inbox; ids `rem_` + base64url of `[inboxId, threadKey]`; `openRemote` fetches outside the
  lock and ingests under it with `ingest(..., history, { imported: true })`: placed as the first sync places mail
  (`classify`'s history branch), incoming senders not let in, a blocked sender's done, no rule, no gate, the cursor
  untouched, no write-back; already held answers the held thread. Its messages take the mark `IMPORTED`
  (`messages.listed = -1`, `sync/ingest.ts`): no reset listing drops them, and an opening neither joins nor ends a
  listing that is running (known-issues.md, "Fixed", 2026-11-20). Demo mode searches the sample (its `olderMail` sits in
  the Northwind memory mailbox, before the cursor, so only the mailbox's search finds it). Tests: `search-local` (11),
  `search-index` (9), `search-remote` (5: the real Gmail provider and `FakeGmail` through REST), `migration-0018` (1),
  `demo` (one more), and mail's contract suite's search part on `MemoryMailbox` (`testing/memory-search.ts`).

## Asking in a sentence (step 3, 2026-11-20)

`ask.ts` (the service) and `ask-words.ts` (pure: the words sent, the schema, the checks); the contract's
[section](../contract-search.md#asking-in-a-sentence), the decisions in decisions.md. `askSearch`: person only, the
input checked (`SearchAskSchema`: 1 to 200 characters, inboxes, zone), the sentence made one line, then `prepare` on
the sentence as typed (what every failure falls back to; it also refuses an unknown inbox or zone). `mayRun` decides
whether anything is sent (not set up, paused or in a failure's wait: the status's state and words come back, no
request). Then the per-device limit (10 a minute, in memory, like the remote search's), one `extract` on the summarize
model with `retries: 0` and the server's own 15-second wait on the host's scheduler (the request is aborted and
tracked so a stop waits for it), `recordUsage(ctx, "ask", …)` either way, `recordFailure(…, "summarize")` for a
refusal or `recordAnswer(ctx, false)` for an answer. `checkAsk` keeps what passes; what is left is given to `prepare`
again as `q` and filters, so `understood` is the search parser's own. `text` is `understood.text` and each excluded
word with its minus. Dropped fields are logged as `AI search ask dropped <field>: <reason>, …`.

- **The request:** `askInstructions(id, today)` (today as `sentDay` gives it, in the zone asked for) names the ten
  fields, the eight kinds with a few words each (`unknown` isn't offered), how `after` and `before` bound a period,
  that an amount stays in `text`, and the data notice for a question; the data block holds one item, `{ "question" }`
  (`AI_ASK_FIELD_WORDS`). `ASK_SCHEMA` is zod, every field nullable, name `search`.
- **`ObjectRequest.retries`** (new, `ai/models.ts`): how often the access may send a request again by itself; the SDK
  access passes it as `maxRetries` (`ai/sdk.ts`), the fake records it. Only the ask sets it.
- **Fake models:** `FakeModels.extract` answers name `search` with `guessFilters` (`ai/fake-ask.ts`).
- **Tests:** `search-ask` (21: what is sent, the sentence as data, the shape that comes back and that a search with it
  understands the same, each field's checks, the log line, every AI state, the wait, the limits, person only through
  REST, the rate limit, the usage row), two in `ai-sdk` (the schema on the gateway; never sent twice), one in `demo`
  (the sample's five sentences).

## Choices

- **SQLite FTS5**, checked first with a scratch test against this project's libSQL (`@libsql/client` 0.18.0, SQLite
  3.45.1, `ENABLE_FTS5` among its compile options): MATCH, bm25 with column weights, `highlight`, `snippet`, column
  filters (nested too), prefix indexes and the trigram tokenizer all work, in memory and in a WAL file. Cloudflare's D1
  and Durable Object SQLite both document FTS5 as supported (from Cloudflare's documentation as last known; not read
  again for this change, no Cloudflare side is built); D1's export doesn't carry virtual tables.
- **Tokenizer: unicode61 with `remove_diacritics 2`** (case and accents folded, German and other accented text), prefix
  indexes of 2 and 3 characters for typing; ß and ss are ORed at query time (unicode61 doesn't fold them). Not trigram:
  it would find inside words but makes a short word match everything and the index three times as big.
- **One index row per thread**, the content kept in FTS5 (so `snippet` works); the bodies are read with `readingText`,
  the same reading a snippet has. Thread-level matching means operators that combine several messages (from one sender
  and a word another wrote) match the thread, as Gmail's do.
- **Field priority by a tier, not weights alone:** FTS5 weighs a field's term count before bm25 saturates it, so a
  weight of 10 lifts a subject match only about twice; the brief's "a match in the subject or the sender's name outranks
  one deep in a body" is a tier (`{subject sender}` match first).
- **Recency in whole seconds**, as lists publish times, so equal times rank by id like every list.
- **The index follows versions, not hooks at every write:** any change a person sees raises a thread's version, so a
  look for stale versions before each search (well under a millisecond) is all a search needs; events only keep it warm.
- **People are a table** (`search_people`), not FTS: exact address and domain filters, folded word starts for names.
- **Remote results aren't stored; ids carry the inbox and the provider's key**, so they are stable and need no table.
- **An opened old conversation doesn't let its sender in** (the brief asked to decide): the first sync lets its history's
  senders in because recent mail tells who the person deals with; one old conversation opened to read doesn't.

## Measured (2026-11-20, this Mac, made-up mail)

A scratch script (`perf/search-perf.ts` in the session's scratch folder, not kept): 10,000 messages in 3,334 threads,
bodies averaging 3,100 characters, half HTML, in a WAL file: built in 1.9 s; search tables 50 MB. 900 messages: 0.2 s,
4.6 MB. Queries while typing "r", "re", "rec", "rech", "rechn", "rechnung", "rechnung mü", "rechnung müller": 2.4, 15.5,
10.3, 8.8, 8.9, 8.8, 11.1, 11.7 ms (page of 50 with excerpts); a phrase 8.6 ms; filters alone 2 to 3 ms; the stale look
0.6 ms.
