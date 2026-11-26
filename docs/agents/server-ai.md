# Server: the AI

The server's own AI (`server/src/ai/`), split from [server.md](server.md) on 2026-11-18 to keep each note under
about 500 lines. The contract is [contract-ai.md](../contract-ai.md); what runs where, the flags and the rest of the
server are in server.md.

## How it reaches models

`AiModels` is the server's own seam: `choose` (one value among labelled options) and `write` (plain text), each given
a model id, the server's instructions and the data block, and nothing else. The pipeline builds every request and
checks every answer; an implementation only carries them.

`src/ai/sdk.ts` implements it with the **AI SDK 7** (`ai` 7.0.173, `@ai-sdk/gateway` 4.0.146, `@ai-sdk/openai`
4.0.118, `@ai-sdk/anthropic` 4.0.105, `zod` 4.6.7; exact versions; documentation and type definitions read
2026-11-17):

- **Vercel AI Gateway** (`gateway: "vercel"`): `createGateway({ apiKey })`. Categorizing goes through the gateway's
  Decisions API (`experimental_decide` with `gateway.decisionModel(id)`, one `choice` question whose criteria are the
  six categories and their descriptions); summarizing through a language model (`generateText`). The gateway's
  categorize model must be a decision model and its summarize model a language model: `fitFor` asks the gateway's
  own model list (`getAvailableModels`, its `/config`, once per opening, never with mail) for the model's kind, and the
  test fails with `model_not_found` and `unfitWords` ("On Vercel's AI Gateway, categorizing needs a decision model;
  anthropic/claude-haiku-5.5 is a language model. …") before anything is sent to it. A model the list doesn't name,
  or a list that can't be read, is left to the request.
- **OpenAI** (`provider: "openai"`): `createOpenAI({ apiKey })`, the Responses API. Both jobs through `generateText`,
  categorizing with `Output.choice` limited to the six values (OpenAI's strict JSON schema), `store: false`.
- **Anthropic** (`provider: "anthropic"`): `createAnthropic({ apiKey })`, the Messages API. Categorizing with
  `Output.choice` and `structuredOutputMode: "outputFormat"`, so Anthropic's native `output_config.format` is used,
  never the forced "json" tool older models needed. No sampling settings are sent (current models refuse them).
- No request carries tools. Each request has a 60-second timeout and the SDK's two retries on 429, 5xx and network
  errors; at most 4,000 output tokens. `globalThis.AI_SDK_LOG_WARNINGS = false`, so the SDK logs nothing.
- Failures become `AiServiceError` with the status's word: 401 and the gateway's authentication error are
  `key_refused`; 402 and anything saying credit, quota, billing or balance are `out_of_credit`; 404 and "model …
  not found / does not exist" are `model_not_found`; a 403 otherwise `key_refused`; everything else (429, 5xx, 529,
  timeouts, network) `unavailable`. A service that answered with nothing usable (no output, an answer outside the
  options, a refusal, malformed or incomplete data) gives `null`, which the pipeline drops.

**Default models** (`DEFAULT_MODELS`; chosen 2026-11-17 from Vercel's gateway model list, the AI SDK's provider
pages and Anthropic's model list; the gateway's categorize default changed on 2026-11-18, the owner's decision):

| Connection | `categorize` | `summarize` |
|---|---|---|
| Vercel AI Gateway | `liquid/d1.2` (the owner's choice of 2026-11-18, replacing `typesafe-ai/jev`; set first on the owner's server, where the server's own test of it passed against the real gateway: the test sends the categorize question through the Decisions API, so the gateway took the model there, though an unusable answer would also pass and the test says nothing about accuracy; its price isn't recorded here) | `anthropic/claude-haiku-5.5` ($0.10 / $0.50 per million tokens) |
| OpenAI's own key | `gpt-6-luna` (OpenAI's smallest current model; $0.10 / $0.50 on the gateway's list) | `gpt-6-luna` |
| Anthropic's own key | `claude-haiku-5-5` ($0.10 / $0.50) | `claude-haiku-5-5` |

## Settings (`src/ai/settings.ts`)

- Person only (`needs_person` otherwise); anyone reads the status. Validation messages are the server's own words and
  never repeat a value that was sent, so a key typed into the wrong field is never echoed.
- The key is sealed with the same AES-GCM key as mailbox credentials (bound to the context `ai-settings`) in the
  `server_state` row. No route returns it, no event carries it, nothing logs it; the settings say `credentialsSet`.
- **Saving credentials or a model stores them, then tests at once, and the route answers only after the test**, so
  a status read straight after reflects it (the coordinator's requirement). Pausing doesn't test.
- **No per-inbox switch** (the owner's decision of 2026-11-17): once credentials are set, every inbox's mail is
  processed, those connected later too (`mayProcess` in `state.ts`, `work()` in `work.ts` without an inbox filter;
  `pending` is 0 without credentials). Moving to another gateway or provider changes no inbox and puts every job back
  on the default unless the same change names models; a new key for the same service keeps them. Removing the
  credentials stops all processing; the service is remembered, so a new key for it keeps the chosen models. Each
  change raises `version` and sends `ai.settings.changed` to people's devices only. `aiProcessing` in a connect or a
  patch is `invalid` (valibot's strict objects); the `ai_processing` column stays in the store, unused.
- **The words before a key is saved** (`aiDisclosureFor`, `GET /v1/ai/disclosure?gateway=…|provider=…`, person only,
  no credentials needed): core's `aiDisclosure` for that service, with the person's chosen models for the service
  already set or that service's defaults (`models.defaults`); its `history` says new mail as it arrives, then all the
  synced mail that isn't done. The command and the dashboard show what it answers.
- **No history setting** (removed from the contract on 2026-11-18, after a day in which `historyDays` read as the
  first sync's days and other numbers were refused): the settings carry no `historyDays` or `maxHistoryDays`, a patch
  naming `historyDays` is `invalid` (valibot's strict object: "The AI settings' fields are credentials, models and
  paused"), and the status no `beyondHistory`. The AI works through all synced mail that isn't done; how far back that
  goes is the first sync's window (`service/first-sync.ts`, in [server.md](server.md)). The `history_days` column
  stays, unread. `testAi` sends one small request per job's model with a fixed sentence and no mail, and answers with
  the status; first it asks `fitFor` whether each job's model can do that job (only the gateway can say).

## What it processes, and when (`work.ts`, `runner.ts`, `process.ts`)

- Each thread has `category_due` and `summary_due`. A new thread delivered to the inbox, a new filed thread and the
  first sync's threads get them as the contract says; incoming mail that joins a thread (not the mailbox's own, not a
  blocked sender's) sets the summary due (unless `otp`) and the category due when nobody decided it or the AI filed it
  elsewhere than `conversation`. Nothing else sets them. A thread **needs categorizing** when `category_due` and it is
  undecided (`unknown`, nobody) or the AI filed it in a category other than `conversation`; it **needs a summary** when
  `summary_due` and it isn't `otp`.
- **May process**: credentials set, not paused, not in a failure wait, in any inbox, the thread not
  done, trashed or gone, with mail someone sent the inbox who isn't blocked now (`hasIncoming` in `work.ts`).
- **Nothing a blocked sender wrote is sent**, in either job (`sendableMessages` in `process.ts`, from the senders'
  standing when the request is built): not their messages in someone else's thread, not one when it is the newest
  incoming message (the newest other one is categorized, and its id is what clears the due flag), not the subject
  they gave a thread (`subjectToSend`: the oldest other message's).
- **Order**: the queue (`AiRunner`) takes new mail first, as it arrives (ingest hands it the threads when the AI may
  process that inbox now), then history: every synced thread with work that isn't done, however old, newest first by
  each thread's newest message, a few at a time from the store (`historyBatch`, 20 per read); new mail that arrives
  meanwhile is taken before the next history thread. One thread at a time; each thread at most once per round. Demo mode turns history
  off (`aiHistory: false`) so the sample stays as it is.
- Per thread: categorize (if needed), then summarize (if needed and not `otp`). Each request is built under the lock,
  sent outside it, and applied under the lock against the thread as it is then; a thread someone decided meanwhile
  keeps their decision. A due flag is cleared only if no incoming mail joined since the request was built.
- **Categorizing** goes through the action engine as a `categorize` by `{ kind: "ai", job: "categorize", model }`:
  always applied, always silent unless the write-back is refused or carries a note, `categorizedBy: "ai"` and
  `categorizedByActor` the AI with its model, reason cleared, written back. **At the screening gate** (the thread
  screened by the sender gate, not by the mailbox) the AI's categorize always carries `gate` to `perform`: a kind
  lifts the gate and sets `skipped_screening`; none keeps the thread screened whatever the category
  ([server-screening.md](server-screening.md)). A thread the AI filed elsewhere is only ever moved to `conversation`;
  any other answer leaves it, unless it is asked again (below). **A summary** sets `summary` with a version and
  `thread.changed`; it isn't recorded.
- **Accepted answers** (`prompt.ts`): one of the six decided categories (only `conversation` where the AI may only
  move a thread there). A summary (`acceptSummary`, since 2026-11-18): line breaks become spaces; then the safety
  checks on the **whole** answer (control, zero-width or direction characters; markup or an HTML entity; the data
  block's marker) drop it; then, over 200 characters, `shortenSummary` keeps the first sentence when it fits (a
  sentence ends at `.`, `!` or `?` before a space and a capital, digit or quote, and is at least 30 characters, so
  "U.S. Bank…" or "e.g. the…" don't end it), else cuts where the last word that fits ends and adds "…" (one long word
  is cut at 199); the checks run again on what is kept. Naming the sender no longer drops it. A drop (`no_answer`:
  the service gave nothing usable; `empty`; `control`; `markup`; `marker`) leaves the thread as it was, clears its due
  flag (not asked again until mail joins it), and logs `AI summary for <thread id> dropped: <reason>`: no content,
  name or address.
- **The summarize prompt aims for one short line** (the owner's decision of 2026-11-18; apps show at most two lines):
  one plain sentence "under about 100 characters" (`SUMMARY_AIM`), not repeating the sender's name; a target, no
  token cap. `TextRequest.maxCharacters` (200) is still carried and still not sent to the service.
- **Summaries asked for again** (migration `0006_summaries_again`, once per store, at the first start of a build
  with it): every thread with no summary that isn't `otp`, done, trashed or removed gets `summary_due = 1`, so what
  earlier builds dropped (over 200 characters, or naming the sender) is asked again as history. Checked by a test and
  on a scratch store of several hundred made-up threads.
- **Categories asked for again** (`ask-again.ts`, 2026-11-19; migration `0011_ask_again` adds only the columns
  `threads.category_ask_again` and `server_state.categories_asked_again`, so a build without the code that applies it
  changes nothing; 0011 is frozen, applied on real stores). In `MailServer.create`, under the lock, before demo
  mode seeds and before the queue starts: unless `server_state.categories_asked_again` already holds the plan's id,
  `askAgainOnce` marks (`category_due = 1`, `category_ask_again = 1`) every thread with `categorized_by = 'ai'`, not
  done, trashed or removed and with incoming mail (`hasIncoming`), that is in one of the plan's `categories`; or in
  one of its `ifStubText` categories when the newest incoming message a model may read (`incoming` in `process.ts`)
  has a stub text part (`isStubText`); or in one of its `ifNeverWrittenIn` categories when no message in the thread is
  `outgoing` (`neverWrittenIn`: evidence only, so a forged "From: me" doesn't count). Then it stores the id (the
  column holds the last one done) and logs only the count. `ASK_AGAIN` is the one place the scope is set. The first
  build of 2026-11-19 had id `2026-11-19 sorting words` (receipt, invoice, notification; newsletter if a stub). **This build's:** id `2026-11-19 second round`, categories `receipt` and
  `notification`, `ifNeverWrittenIn` `conversation` (the owner's dated exception, contract-ai.md). `wantsCategory` and
  `wantsCategoryNow` take a conversation only while it is marked. A marked thread is categorized as history with
  `onlyConversation` false, so any of the six answers goes through `perform` like any AI categorize (silent record,
  write-back, undo; the gate's check for `otp`; the same answer is a no-op with no record); `applyCategory` then
  clears the mark whatever came back, so afterwards only mail joining asks, towards `conversation` only, and never
  about a conversation. A failed request leaves it marked. `MailServerOptions.askAgain` lets tests name other plans
  (the first round's runs there as a made-up plan). Tests: `ai-ask-again` (7) and `migration-0011`, the latter on a
  made-up store at migration 0010 (32 receipts, 5 invoices, 169 notifications, 16
  conversations, 5 of them with mail the mailbox sent and 1 with only a forged "From: me", and 125 newsletters the AI
  filed, plus done, trashed, removed, person's, rule's, agent's and mailbox's ones), with the first id recorded: the
  migration changes no row, this build's first start marks exactly 212, a second marks none.

## The screening gate

The server's own check, the gate's one question and the kind a thread skipped Screening with are in
[server-screening.md](server-screening.md) (2026-11-25), with the sender rules that let a person's own addresses in.

## The sorting words (`prompt.ts`)

`CATEGORY_OPTIONS` (each kind's line) and `categorizeInstructions` (the question, the data block's notice, and the
tie-break) are the one place the server says what the kinds mean; every categorize request carries them, the
settings' test too (`ai-categories.test.ts` pins them and where they travel). On the gateway's Decisions API each line
is that option's criterion and the instructions are the question's `instructions`; a language model gets both in its
system prompt. The wording of 2026-11-19 is the coordinator's, from two audits of the AI's labels on real mail
(decisions-ai.md): a conversation is written personally to the reader, never mail sent to many people; a newsletter is
reading or marketing sent to many, nudges included; an invoice is money still owed (an upcoming charge with its amount
too); a receipt is proof the reader paid or bought (not a shipping update, nor a booking with no payment); a
notification is an automatic notice about the reader's own account, order or plans, never marketing; `otp` is
unchanged. The second round of that day added to the receipt "An order confirmation with a price is a receipt even
when it shows delivery progress." The tie-break, in the instructions: when more than one fits, the first of
`TIE_BREAK_ORDER` (otp, invoice, receipt, conversation, notification, newsletter); mail sent to many people is never a
conversation, and mail with no payment made or owed is never an invoice or receipt; and (second round) a nudge to buy
or finish signing up, or a group's new event, is a newsletter even when it names the reader. The order stays: a
deadline hidden in Feed is worse than a nudge on Home. Nothing can say how well a model sorts with them: tests use the
fake models, and no real model is called.

## Payment details (`payment.ts`, `currencies.ts`, `process.ts`; 2026-11-19)

The owner's request for the Receipts tab; the rules are the contract's ("Payment details" in contract-ai.md). Built:

- **The request** (`detailsRequest` in `prompt.ts`): the same items as a summary (`summarizeItems`), with
  `detailsInstructions(id, category)` (it names the kind the thread is filed as; `PAYMENT_SERVICES` names the payment
  services `party` is not; revised 2026-11-19 after the first audit) and `DETAILS_SCHEMA` (zod: six fields, all
  required, nullable but `refund`). The seam's
  `extract` (`models.ts`) answers an object: `sdk.ts` asks `generateText` with `Output.object` on the summarize
  job's model: on the gateway its language model with a JSON response format (the gateway passes it to the model's
  provider; run through the real gateway from 2026-11-19, [decisions-ai.md](decisions-ai.md)), OpenAI's strict `json_schema` with `store: false`, Anthropic's
  native `output_config.format`. A malformed object is no answer. Counted as `summarize` in the usage, its failures
  are the summarize job's in the status. The fake's `extract` guesses from the newest message that names an amount.
- **When** (`wantsSummary` in `work.ts`, `wantsSummaryNow` in `process.ts`): a receipt or invoice with
  `payment IS NULL`, or one with `summary_due` (mail joined). No one-off flag: the rule asks for the ones a store had
  at its first start. `saveThreadState` (`store.ts`, every decider's path) clears `payment` when a thread leaves
  those categories (and sets `summary_due`) or turns from one into the other, and wakes the queue either way.
  `planSummarize` plans details for those categories; `applyDetails` checks (`checkDetails`, with the thread's
  category for the refund rule), logs drops by field and reason, combines with what the thread had
  (`combineDetails`), and writes `payment` and `summary` (= `what`) with one version and a `thread.changed`; if the
  thread left those categories meanwhile its summary stays due.
- **Checks** (`payment.ts`): `resolveCurrency` (ISO code with minor units from `currencies.ts`, or `SIGNS`),
  `parseAmount`, `writtenIn` (forms built from the value, its minor digits with trailing zeros optionally left out,
  matched standing alone; a whole amount needs its currency's marker within six characters), `currencyIn`,
  `dateWrittenIn` (month names from `Intl` in seven locales plus "sept"; dropped as `on_receipt` on a receipt),
  `acceptLine` (the summary's checks, shared) for `party` and `what`; `partyName` (`LEGAL_SUFFIXES`, longest first,
  two-capital ones matched as written, repeated until none is left; a trailing "Team", then a leading "The"), also for
  the sender's name (`senderParty`); `withoutParty` (the party's name, as the model wrote it or cleaned, at the start
  of `what` before a separator; `only_party`, `only_payment` by `ONLY_PAYMENT`, which leaves "Payment for …" alone). `currencies.ts` is ISO 4217's active
  codes with their minor units as the standard lists them: the runtime's `Intl` follows CLDR and says 0 for LAK, MGA
  and HUF, 0 for IQD, 2 for gold, so it is not used for minor units (only for the signs to match).
- **Store:** `threads.payment` (JSON, migration `0012_payment`, the column only). `toThread` shows it only on a
  receipt or invoice. Demo mode seeds the sample's. **Zero** (2026-11-19): `checkAmount` drops an amount of 0
  (`zero`); `combineDetails` never carries a stored 0 forward; `toThread` serves `servedPayment(row.payment)`, which hides a stored
  one (wired 2026-11-19 with the sender pictures; `test/thread-rows.test.ts`).
- **Asked again under the revised words** (`askDetailsAgainOnce` and `PAYMENT_AGAIN`, id `2026-11-19 payment
  wording`, in `ask-again.ts`; migration `0014_payment_again`: `threads.payment_again` and
  `server_state.details_asked_again`, columns only). In `MailServer.create`, after the categories' asking-again: once
  per store, every receipt and invoice not done, trashed or removed with incoming mail gets `summary_due` and
  `payment_again`. `applyDetails` then replaces the details whole (no earlier facts) unless the answer was unusable,
  and clears the flag whatever came back; a receipt never keeps an earlier due date.
- **The last round's rules** (2026-11-19, after the re-audit; `payment.ts` was split by responsibility):
  `payment-dates.ts` (`dateWrittenIn`; `checkDueDate` with each message's text and date, `DatedText`, which
  `detailsRequest` now returns as `sources`, the subject carrying the thread's first date: not before its message,
  `DUE_TOLERANCE_DAYS` 2, `swappedDate`, `dateOrder` from unambiguous dates; `swapped` is logged as "read the due
  date's day and month the other way round"), `payment-party.ts` (`partyName`, `cutDisplayText` at " — ", " – ",
  " | ", " · " with two letters left, else `display_text` and the sender's name; `samePartyForm`, `canonicalParty`),
  `payment-services.ts` (`PAYMENT_SERVICE_LIST`: the request's words and `isPaymentService`, by a label of the
  sender's domain), `payment-store.ts` (`oneNamePerSender`, called by `applyDetails`; `applyPaymentRulesOnce`, id
  `2026-11-19 payment rules`, marker `server_state.payment_rules_applied`, migration `0015_payment_rules`, the column
  only; run in `MailServer.create` after the two asking-agains, re-exported from `ask-again.ts`). The pass re-reads a
  stored due date only for `before_message` or a swap (a date no longer found in the mail is left alone), drops one on
  a receipt, cleans every party, unifies per inbox and sender, writes the details alone (the summary stays) with a
  version and a `thread.changed`, and logs counts only.
- **The payment state** (the owner's decision of 2026-11-19): `PaymentDetails.state` (`paid`, `scheduled`, `due`,
  null; core's `PAYMENT_STATES`), asked as a nullable string in `DETAILS_SCHEMA` (like the other fields, rather than
  an enum some providers' structured output handles differently) and checked by `checkDetails` (`unknown_state`).
  `settleDetails` after every combine: a refund is `paid`; `stateOf` (the state, else the category's: invoice `due`,
  receipt `paid`) of `paid` takes the date away (`paid`, replacing `on_receipt`). `servedPayment` gives a row from
  before the state `state: null`. The asking-again for it reuses `PAYMENT_AGAIN` (new id `2026-11-19 payment state`)
  and `threads.payment_again`, so no migration: `applyDetails` then `fillDetails` (the answer's state, only facts the
  thread has none of; an unusable answer keeps all), then settles.
- **One name per domain, and a district** (the same build): `senderKey` (`payment-store.ts`) is the domain after the
  @, the registrable domain with the Public Suffix List (`ctx.avatars.suffixes` live; the start-up pass gets the same
  list from `suffixListOf` in `avatars/service.ts`, since it runs before the sender pictures' service exists), the
  whole address at a free mailbox or a shared platform (core's `isPublicMailDomain`, `isSharedPlatform`, once the sender pictures' `isFreemail`), null
  for a payment service. `cutDisplayText` gives null for a single lowercase word before the separator.
  `PAYMENT_RULES` was `2026-11-19 payment rules, by domain`: the pass runs once more with both.
- **A party that is one lowercase word** (2026-11-19, a real store kept one from an earlier cut): `isOneLowercaseWord`
  and `orSenderName` (`payment-party.ts`) give it the sender's display name, cleaned by `senderParty`, in
  `combineDetails` and in the start-up pass; it stays when the sender has no usable name, and a brand written in lower
  case whose sender's name is the same word stays. `PAYMENT_RULES` is now `2026-11-19 payment rules, one-word
  parties`, so the pass runs once more (by rule, no model, counts only: "N one-word parties named"). With the shipped
  Public Suffix List (2026-11-19) `senderKey` groups by registrable domain; `ai-payment-store` keeps one case without
  the list on purpose and one with it.
- **Tests:** `ai-payment` (19), `ai-payment-rules` (12: each due-date branch, display text, one name, the services'
  list), `ai-payment-state` (12: the state, refund, dates by state, settle, fill, the district, sender keys),
  `ai-payment-pipeline` (11, the words and the asking-again for the state included), `ai-payment-store` (5: the swap,
  one name per sender and per domain, both passes), a details case in `ai-sent`, three in `ai-sdk`, `migration-0012`,
  `-0014` and `-0015`. `migration-0013` (the avatars') compares only the columns a store had.

## Notification events (`event.ts`, `event-dates.ts`, `event-times.ts`, `event-lines.ts`, `event-reference.ts`, `event-group.ts`, `process.ts`; 2026-11-19)

The owner's request for the Notifications tab; the rules are the contract's ("Notification events" in
contract-ai.md). Built:

- **The request** (`eventRequest`, `eventInstructions`, `EVENT_SCHEMA` in `prompt.ts`: six nullable strings, the
  summary among them; `STATUS_AIM` 30, `ABOUT_AIM` 60): the same items as a summary, `name: "event"`, through the
  seam's `extract`, counted as `summarize`. One request for the summary and the event.
- **When:** `wantsSummary`/`wantsSummaryNow` take a `notification` with `event IS NULL`, or with `summary_due`.
  `saveThreadState` clears `event` when a thread enters or leaves `notification` (leaving sets `summary_due`) and
  wakes the queue. `planSummarize` plans `kind: "event"`; `applyEvent` checks (`checkEvent`), logs drops, combines
  (`combineEvent`: since the groups build, a given status brings its `when`, else the pair stays; `about` when given),
  replaces the summary only when the answer gives one, and saves through `saveEvent` (event-group.ts: key, group, one
  version and a `thread.changed` when what is served changed); an unusable answer leaves what was there, or an
  all-null event. The first build
  needed no one-off flag: the rule asks for every notification without an event.
  Migration `0016_events`, the column only.
- **The day each message was sent, and the server's date for a time** (2026-11-19, after real notifications
  lost a time to `no_date`: the request gave no message dates). `Host.timeZone` (`host.ts`; Node's
  `main.ts` gives `Intl.DateTimeFormat().resolvedOptions().timeZone`, so `TZ` or the machine's zone);
  `serverTimeZone` and `zonedDate` (`payment-dates.ts`) make an absent or unknown zone UTC. `summarizeItems` puts
  `sent: sentDay(at, zone)` ("Thursday 2026-11-19") between `from` and `text` for every summarize, details and event
  request; `planSummarize` resolves the zone once and keeps it on the plan (`PlannedDetails.timeZone`) for the check.
  `eventInstructions` and `detailsInstructions` say "each with the day it was sent"; the event's `date` may be "said
  relative to the day its message was sent". `checkEvent(..., timeZone)` checks times without the date first, then,
  with no date left, `dateOfTime`: the sources that write the time and have a `RELATIVE` word (not a weekday name),
  each word moving that source's `zonedDate`; exactly one date or `no_date`. `checkDate` still accepts either
  `localDates` day; due dates unchanged. Run on a real server, it more than doubled the notifications with a `when`.
- **Checks**, split by responsibility in the audit round: `event.ts` (`checkEvent`, `checkMoment`, `combineEvent`,
  `reviseEvent`; re-exports the helpers tests use), `event-lines.ts` (`withoutRelativeWords`: `RELATIVE_IN_STATUS`,
  English words, "in/within N units", weekday names, with "on/at/for/from/in" before them, "by" kept, `relative_only`
  when no word of two letters but connectors is left; `arrivingWhenLater`: `DISPATCH` and a date after the newest
  source's `zonedDate`; `withoutSender` with `wordOrPlace`: one word, or up to three capitalised words with
  `PLACE_JOINERS` between, keep the line whole), `event-dates.ts` (`checkDate`: written via `dateWrittenIn` and
  `readingThatFits` with `nearItsMessage`, `EVENT_RANGE_DAYS` 365; `writtenWithoutYear`, "dd.mm." or "dd/mm" day
  first, `yearlessYear` with `YEARLESS_PAST_DAYS` 92 per `localDates` day; `relativeDates`: `RELATIVE`, `IN_DAYS` per
  language in digits, weekday names; `dateOfTime`), `event-times.ts` (`readTimes`: each time with its marks, `local`,
  `utc` from `UTC_MARK`/`ZULU_MARK`, `offset` from `OFFSET_MARK`, a window's start taking its end's mark like am/pm;
  `markOf`, UTC first; `fromUtc` via `Intl` with `hourCycle: "h23"`; `timesIn`). `checkMoment` order: times written,
  the date or `dateOfTime`, `no_date`, `utc_offset` drops, UTC conversion of the start (may move the date) and the end
  (`two_days` when its date differs), `time_order`. `CheckedEvent.changes` (`dated`, `relative_word`, `arriving`,
  `from_utc`) replaced `dated`; `applyEvent` logs each by `CHANGED`.
- **Groups** (the owner's "Yes, build it", 2026-11-19; the contract's "Notification groups"). `EVENT_SCHEMA` asks
  `reference`; `checkReference` (`event-reference.ts`: `plainLine`, then `URL`, a leading "+", `AMOUNT`, `DATE`,
  `LABEL` taken off in seven languages with a separator after it, `SEPARATOR` out, `[\p{L}\p{N}]` only, 5 to 40,
  a digit, then a regex of its characters with optional separators between and no letter or digit either side,
  case-insensitive) gives `CheckedEvent.reference` in capitals or a `reference` drop. `event-group.ts`: `eventKey`
  (the answer's reference → `groupKey("r", inbox, sender, [reference])`; else a stored "r" key; else, when
  `appointmentLike(status)` (appointment, reservation, booking as a word) with `about` and `when`, `groupKey("a",
  …, [about without case or punctuation, date])`; sender = `senderKey` with `ctx.avatars?.suffixes`, else the domain);
  `groupKey` is "r" or "a" and 24 hex of SHA-256 (`crypto.subtle`) over the joined inputs; `settleGroup(inbox, key,
  joining?)` counts the notification threads with that key (not removed), with the joining one, and gives null when
  more than `GROUP_MAX_THREADS` 8, or for an "r" key newest mails more than `GROUP_SPAN_DAYS` 60 apart, updating the
  others' `event.group` (version, `thread.changed`) and logging a count; `saveEvent` computes the key, settles it,
  writes `event` (with `withGroup`) and `event_key` (key alone without a version when nothing served changed), and
  settles the key the thread left. Migration `0017_event_groups`: `threads.event_key` and index `threads_event_key`
  (inbox, key); `saveThreadState` clears it with the event; new rows `eventKey: null`. The reference is never stored.
- **Moments** (2026-11-19, after the audit of the groups): `momentOf(event, sentAt, zone)` (date, the time when
  `"date time" > zonedMinute(sentAt)` in the server's zone, the appointment's `sameAbout`, and since 2026-11-20
  `untimed`: the `sameAbout` of an event with no time), `sameMoment` (same date, and the same upcoming time, the same
  appointment subject, or the same untimed subject; the untimed key reuses "a" with subject and date; the pass id
  became "2026-11-20 moment groups, untimed" after "2026-11-19 moment groups" in `passes.ts`), `momentKeyAmong` (the most common non-reference key
  among the same inbox's and sender's notifications at the same moment, earliest on a tie, else `groupKey("m", …,
  [date, time])` or `groupKey("a", …, [about, date])`); `eventKey` queries the inbox's keyed notifications for it.
  `groupFor(key, dates)` is the guard, shared by `settleGroup` and the pass; the log says "a reference" or "a moment".
  `event-times.ts`: `tokensOf` (one token list for `readTimes` and `resetTimes`), `SECONDS` with a fraction,
  `ZULU_MARK` with a numeric zero offset after seconds, `OFFSET_MARK` with other numeric offsets after seconds,
  `UTC_BEFORE`, window marks both ways; `TOKEN` no longer reads an offset's digits and reads "14:00-15:00" as two
  times (`(?<!(?<![:.]\d{2})-)` and `(?!-\d(?!\d?[:.]\d{2}))`). `checkMoment` drops a `resetTimes` time for a
  `limitLike` status, and the date unless it is the newest mail's day (`reset_time`). `regroupEventsOnce`
  (`event-regroup.ts`, `MOMENT_PASS` in `passes.ts`, after `SNIPPET_PASS`; re-exported from `ask-again.ts`, run in
  `MailServer.create`): the same rules over every stored notification, oldest first, in memory, then writes.
- **Asked once more for references** (`askEventsAgainOnce`, `EVENT_AGAIN` `2026-11-19 event groups`, in
  `ask-again.ts`; run in `MailServer.create` right after `askDetailsAgainOnce`): every notification not done, trashed
  or removed with incoming mail gets `summary_due` and `payment_again`. `applyEvent`
  with the flag and a stored event keeps the event and summary and takes only the reference (an unusable answer: a
  key from what is stored, so appointments still join); with no stored event it applies the answer as any.
  `askedAgain` clears the flag in all three apply paths. `DETAILS_AGAIN_ORDER` is `[PAYMENT_AGAIN, "2026-11-19 event
  dates", "2026-11-19 event audit", EVENT_AGAIN]` on the shared `server_state.details_asked_again` (`hadAskingAgain`:
  a later marker has had the earlier ones). `reviseEvent` and `fillEvent` are gone (their rules: `combineEvent`, or
  only the reference).
- **Served** by `toThread` only on a `notification`. Demo mode seeds the sample's, its dates moved by the demo's
  whole-day shift so "today" stays today. The fake's `extract` guesses an event for requests named "event".
- **Tests:** `ai-event` (13: status and about, the summary, written and relative dates, times, the words with the
  reference, a time with no date in two zones), `ai-event-rules` (7: dispatch to Arriving, relative words in a status,
  "within N days" in seven languages, year-less dates and their bound, UTC and offsets, about's place),
  `ai-event-groups` (7: references kept and dropped by reason, labels, appointments, the key, `combineEvent`'s pair),
  `ai-event-groups-pipeline` (9: one sender's reference joins, another number or domain doesn't, the key kept on mail
  joining, appointments the same day, a reminder with its confirmation and move, a meetup's three mails, two builds
  at one past minute apart, more than 8 and 60 days apart, the pass by rule, the reference-only one-off),
  `ai-event-moments` (5: the new UTC forms, the reset rule, `momentOf` and `sameMoment`), `ai-event-pipeline`
  (7: the server's date in Europe/Berlin, mail joining's pair), `ai-sent-dates` (3), an event case in `ai-sent` and
  `ai-sdk` (seven fields), `demo` (the sample's two groups), `migration-0016`, `migration-0017` (no row changed, 165
  marked once). Earlier tests that summarized a notification now expect its event request.

## What leaves the server (`prompt.ts`)

Exactly core's words (`AI_SENT_WORDS` in `core/src/ai-words.ts`), built from the same limits; the items carry only
the fields `AI_SENT_FIELD_WORDS` names (typed so in `prompt.ts`), and `test/ai-sent.test.ts` fails on any other.

**In linear time** (0.1.3; [known-issues.md](known-issues.md), "Reading a message could take minutes"): requests are
built under `ctx.lock`, so no pattern reading mail may scan back and forth. Addresses are taken out by
`ai/addresses.ts` (re-exported by `prompt.ts`): each at sign, "@" or "＠", read once; its domain, any number of
labels of any length dotted by ".", "。", "．" or "｡", letters, digits and marks; its local part back from it, the whole
run when at most 256 long, else its last 64. `cutWithoutAddresses` cuts the text to its budget first, with room for
one address, back to where none is split. A subject goes to every job cut to `SUBJECT_LIMIT` (1,000). Tags in what
a model reads (`readableHtml`) start where HTML starts one ("<" or "</", then a letter, "!" or "?") and run to their
nearest ">", and comments end where htmlparser2 ends them ("<!-->" and "<!--->" are whole, any other runs to its
nearest "-->" or "--!>"; one never closed stays), each found by a forward scan: a lone "<" in text stays, and a "<"
inside an attribute leaves no piece of the tag. The screening gate reads the same text the model read (0.1.4;
`plainText`, which 0.1.3's gate read with tags from any "<" to the nearest ">", is gone). On stored HTML, sanitized so that a "<" in text or an attribute is written `&lt;` and comments are
gone, snippets and model text read as 0.1.2's (38,794 comparisons), so `SNIPPET_PASS` isn't run again: only a message
with no HTML part whose text part is HTML source keeps a snippet 0.1.2 made, until its thread changes. A model's
amount answer loses its leading and trailing separators by a scan from each end (`parseAmount`). Tests: `ai-linear`
(27 bodies of 1 MB, each in a worker stopped at 10 s, `test/linear.ts`),
`ai-addresses` and `ai-text`.

- **A search asked in a sentence** (2026-11-20, `search/ask-words.ts`, server-search.md): the sentence alone, as
  `{ "question" }` in the data block (`AI_ASK_FIELD_WORDS`, `AI_SENT_WORDS.ask`), with today's date and weekday in
  the instructions. Nothing from the mailbox; `test/search-ask.test.ts` fails if a sender's name, an inbox's name,
  address or id, or the key is in the request. On the summarize job's model, counted in the usage as `ask`.
- **Categorize:** the subject, cut to `SUBJECT_LIMIT` (1,000 characters); the newest incoming message's sender name
  and address, its List-Id and whether it looks machine-sent; that message's text as a model reads it (`modelText`,
  below), at most 4,000 characters. The screening gate's question carries the same item (`categorizeItem`;
  [server-screening.md](server-screening.md)).
- **Summarize:** the subject, cut to `SUBJECT_LIMIT` (1,000 characters), and the thread's messages newest first, each
  with its sender's name ("someone" when
  they gave none or their name holds an address, `summarizeSender`; "you" for the mailbox's own), the day it was sent
  (`sent`, `sentDay`: weekday and date in the server's zone), each text as a model reads it (`modelText`), at most
  8,000 characters of text in all, with every address in the subject and the text replaced with `[address]`
  (`withoutAddresses`). No address at all. Details and event requests carry the same items; categorize no date.
- **Never:** HTML, attachments or their names, remote pictures, the recipients' fields, credentials, the guide,
  rules, anything a blocked sender wrote, spam, or done or trashed threads. The test sends a fixed
  sentence and no mail.
- **What a model reads of a message** (`modelText` in `text.ts`, 2026-11-19; the audit found over a third of the
  messages cut at 4,000 characters, most of those under 40% readable text, an order's total past the cut, and text
  parts that were stubs of their HTML). The text part, cleaned (`cleanText`), or the HTML's text (`readableHtml`: tags stripped,
  entities read once, numeric and the common named ones, then cleaned) when there is no text part or it is a stub
  (`isStubText`: under `STUB_TEXT` 300 characters cleaned while the HTML gives at least `STUB_RATIO` 3 times as many),
  or (since 2026-11-19, the snippets' fix) when the text part is HTML source itself (`HTML_SOURCE`: it starts with
  `<!doctype html`, `<html`, `<head`, `<body`, `<meta`, `<table`, `<div`, `<p`, `<span`, `<center` or `<style`; the
  HTML part is read when there is one, else the text part as HTML). Thread snippets are made from this same reading
  (`snippetText`, contract.md "Words").
  `cleanText`: `\r\n` to `\n`; invisible characters out (soft hyphen, combining grapheme joiner, Hangul and other
  fillers, zero-width and direction marks, word joiners, byte-order mark); other spaces to one space; each `http(s)`
  link to `scheme://host/…` (`scheme://host` when nothing follows the host; who signed in dropped, a full stop or
  bracket after it kept); a run of four or more of one punctuation, maths, modifier or box-drawing character (single
  spaces between allowed) to three; runs of spaces to one, lines trimmed, blank lines at most one. The limits cut after
  cleaning, and summaries' addresses are replaced after it. The screening gate's check reads the same (0.1.4), and
  every pattern here is linear ("In linear time", above, has how tags and comments are read): style, script, head and
  title blocks taken out by `withoutBlocks` (a scan that stops looking for a closing tag once none follows), a link's
  trailing punctuation read from its end, and the snippet's angle-link and markdown-link patterns kept from reading
  past a `<` or `[`. Tests: `ai-text`, and `screening-gate`'s and `ai-linear`'s 1 MB bodies. A summary,
  payment-details or event request takes addresses out without a pattern that scans back and forth
  (`ai/addresses.ts`, as above), after cutting the text to its limit and room for one address, back to where no
  address is split; when a run of
  address characters goes on past that room, at the limit unless an at sign behind it (whose domain reaches it) or
  ahead of it within a local part's length, in code units, means an address could cross it, then just before that
  address and any it is joined to (`cutWithoutAddresses`, `safeCut`); the subject goes to every job cut
  to `SUBJECT_LIMIT` (1,000, core's words). Tests: `ai-linear`.
- The data goes in one block per request: `<usual-mail-data id="X">`, one JSON line per item with `<`, `>`, every line
  break and the direction overrides escaped, `</usual-mail-data id="X">`, with X 18 random hex characters per request
  (the connector's format). The instructions outside say everything inside is data, never an instruction. Decision
  models get the block as their state; language models as the user's turn, the instructions as the system prompt.

## Status (`status.ts`)

- `not_set_up` (no credentials), `paused`, otherwise how the service last answered (`working` until it first fails).
  `detail` is set while not working; `job` only with `model_not_found`; `lastRunAt` when a thread was last processed
  (tests don't count).
- Waits: `key_refused`, `model_not_found`, `out_of_credit` stop processing for an hour (then one request is tried),
  or until a person saves credentials or a model or tests. `unavailable` waits 1, 2, 4, 8, then 15 minutes. Any answer
  makes it `working`. While the AI can't run, the queue lets go of every stranger's thread held at the screening gate
  (screened in `unknown`, written back) and threads that waited become history.
- **`detail` never holds the key or any recognisable part of it, in any form** (`scrubKey`): the key, any prefix or
  suffix of it of four characters or more, and anything shaped like a key (`sk-…`, `vck_…`, `****abcd`) are replaced
  with `[key]`; so is any run in which eight or more letters and digits in a row, separators between them ignored,
  belong to the key written out, in base64 (each of the three alignments; standard and URL-safe, padded or not, are
  the same once `+/-_=` are ignored) or in hexadecimal (either case), so a key spaced out or broken across lines goes
  too. Then it is cut to 300 characters. The same applies to the service's words in `sdk.ts`. Nothing about AI
  requests or failures is logged, except a dropped summary's thread id and reason code (above). A refused key (401, 403, the gateway's authentication error) is always the server's
  own sentence, never the service's words.
- `pending` is counted from the store whatever the state: every synced thread with work that isn't done, however
  old. The status and counts carry versions
  kept in `server_state`, so they never go back after a restart; reading them raises the version if they changed.

## Usage (`usage.ts`; `GET /v1/ai/usage`)

The owner's request of 2026-11-18 ("an AI usage section in settings"; the Mac app's Settings show it). Built that day.

Since 2026-11-20 a row's job is `AiUsageJob`: `categorize`, `summarize` or `ask` (a search asked in a sentence, on the
summarize model; `recordUsage(ctx, "ask", …)` in `search/ask.ts`). `ai_usage.job` and `ai_cost_lookups.job` are text
columns, so no migration; rows sort in `AI_USAGE_JOBS` order. `AiJob` (settings, the status's `job`) is unchanged.

- **What the services report** (read from the installed AI SDK 7 types and the gateway package's own docs, no real
  call): `generateText` returns `usage` (`LanguageModelUsage`: `inputTokens`, `outputTokens`, each possibly
  undefined); `experimental_decide` returns `usage` with `inputTokens`, `outputTokens`, `totalTokens`, each possibly
  undefined (the gateway's decision response has `usage` as optional). **No cost in any answer:** the gateway's docs
  give a cost only through `gateway.getGenerationInfo({ id })`, a separate lookup with the generation id from
  `providerMetadata.gateway.generationId` (`totalCost` in USD and its breakdown); OpenAI's and Anthropic's answers carry
  tokens only. So `AiAnswer.usage` (`models.ts`) carries tokens as reported (whole numbers or null) and `costUsd` null
  from `sdk.ts`; the fake can report any of them, or nothing (its default), with `models.usage`. The cost comes from
  the lookup (below).
- **The seam:** `AiModels.choose` and `write` answer `{ value, usage }` (`AiAnswer`); an unusable answer is
  `{ value: null, usage: nothing reported }`; a failure still throws `AiServiceError`. The SDK's own retries (two, on
  429, 5xx and network errors) stay inside one call: the server sees one request.
- **Written** by `recordUsage` (takes the lock; called outside one) where the outcome is known: in `process.ts` after
  each `choose` and `write` (answered: with its usage, whatever the checks then make of the answer; thrown: failed),
  and in `settings.ts`'s test for each job (counted like the rest, not marked apart). A model `fitFor` refuses is never
  sent anything (`AiServiceError.unfit`) and isn't counted.
- **Store:** `ai_usage` (migration `0007_ai_usage`): one row per UTC hour, job and model, with `requests`, `failed`,
  token sums and how many requests reported each (`input_reported`, `output_reported`), the cost in USD and how many
  reported one; an upsert adds to the hour's row. `server_state.ai_usage_since` is set at the first start with it
  (`startUsage` in `MailServer.start`), which also drops hours older than 90 days; `recordUsage` drops them again at
  most once an hour. No thread id, no content.
- **Read** (`readUsage`, person only, `needs_person` otherwise): `tz` validated with `Intl.DateTimeFormat` (its
  resolved name is answered; anything it doesn't know, or longer than 64 characters, is `invalid`); each period's start
  is midnight 0, 6 or 29 days back in that zone (`localMidnight`, offsets from `Intl` twice so a summer-time change that
  day holds), floored to the whole UTC hour; one grouped sum per period. A row's tokens are null when no request
  reported them and partial when some did and some didn't (failed requests report nothing); cost the same; rows in
  `AI_JOBS` order then by model, rows with no requests left out. No backfill: summaries weren't recorded, dropped and
  failed requests weren't either, so the records can't give it.
- **Demo mode** keeps its own usage from its start (the sample's `aiUsage` isn't seeded): only the clients' previews
  read the sample's example.

## The cost, looked up at the gateway (`costs.ts`; 2026-11-18, contract question 72)

**What the documentation says** (the gateway package's own page, "AI Gateway" in `@ai-sdk/gateway/docs/00-ai-gateway.mdx`,
sections "Generation Lookup", "Credit Usage" and "Conditional Decision Fallbacks Example"; and its types and source,
`src/gateway-generation-info.ts`, 4.0.146; no real call was made):

- "Generation IDs are available in `providerMetadata.gateway.generationId` on both `generateText` and `streamText`
  responses" (format `gen_<ulid>`). For the Decisions API the page names a `generationId` only inside
  `providerMetadata.gateway.routing.modelAttempts`, whose attempts "carry their own `generationId`, `usage`, and cost
  fields" when a conditional fallback ran; it says nothing of a top-level id for a plain decision. So only the
  documented place is read (`generationOf` in `sdk.ts`): a summary should get a cost; a categorize gets one only if
  the gateway also puts the id there, unverified.
- `getGenerationInfo({ id })` is `GET <gateway origin>/v1/generation?id=<id>` with the key's headers and no body; it
  answers `totalCost` (USD, "Total cost"; `usage` is the same), optional `marketCost`, `surchargeCost` and
  `gatewayCost` ("Total amount debited"), `upstreamInferenceCost` (BYOK), the model, tokens and timings. The server
  takes `totalCost`.
- **Not documented:** how soon after a request the lookup can answer (its examples call it straight after
  `generateText`), its rate limits, and whether a lookup is billed or counted anywhere. Hence the retries below.

**Built:** `AiAnswer.generation` carries the id from the gateway's answers (`gen_` and up to 60 letters and digits,
else null); `AiModels.lookupCost(id)` exists only for the gateway (`sdk.ts`) and rejects when no cost comes back.
`recordUsage` stores an answered request's id in `ai_cost_lookups` (migration `0008_ai_cost_lookups`: the id, the
hour, job and model, tries, next try; no thread, no content), due 10 seconds later. `CostLookups` (started and stopped
with the server, beside the AI's queue, on its own timers, never holding the lock across a lookup) takes up to 20 due
ids a round: a cost found is added to that hour's row (`cost_usd`, `cost_reported`) and the id dropped; a failure,
of any kind, is tried again after 1, 5, 30 and 120 minutes, then given up (5 tries), logging only `AI cost lookup
given up after 5 tries: no cost for N requests`. It waits while the AI may not send (paused, a failure's wait),
drops every id without a key or with a service that has no lookup, and is woken by a new id and by every settings
change. Pending ids survive a restart (the table): a server may restart often, and a lost id is a cost lost for good.
Lookups aren't requests in the usage and never touch the AI's status. Ids older than 90 days go with the usage.
The fake plays each case: `generation` (ids per request, gateway only), `costOf` (a cost, an error, or one after
some tries) and `lookups` (what was looked up).
