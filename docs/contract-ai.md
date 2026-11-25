# The contract: the server's AI

Part of [the contract](contract.md) (fifth revision, 2026-11-17, as amended the same day, after its review, and when
the owner removed the per-inbox AI switch; amended 2026-11-18 by the owner's decisions that the AI works through all
synced mail, that a summary aims for one line, and that a person's Settings show the AI's usage; amended 2026-11-19
after an audit of the AI's labels: the kinds' words, what a model reads of a message, and asking the AI again once;
and the same day by the owner's request for payment details on receipts and invoices; amended 2026-11-25 by the
owner's decision that more kinds of mail than one-time codes skip Screening, through one more question at the gate).
Shapes are in
`core/src/ai.ts` and `core/src/ai-usage.ts`, and what leaves the server, in numbers and in the words a person is shown,
in `core/src/ai-words.ts`; the words, lists, actions and the sorting of new mail are on the contract's main page.


## Jobs and settings

- **The server runs AI jobs on mail itself,** with the AI account the person set up, and the clients only show the
  results, so every device shows the same. Two jobs are built: `categorize` sets a thread's category and
  `summarize` writes its summary, or for a `receipt` or an `invoice` asks for its payment details instead, and for a
  `notification` for its summary and its event together (below; the same job for its model, settings, status,
  pausing and usage). **Planned, not built:** a one-time code and when it
  expires, and drafting replies. Each job has its own model.
- **Settings are for a person only** (`aiSettings`, `updateAiSettings`): how models are reached, the key, which model
  each job uses, and whether the AI is `paused`. **There is no history setting** (removed 2026-11-18): the AI works
  through all the mail the server has synced that isn't done, newest first, and how much older mail that is is
  decided only by the first sync's window ([the first sync](contract-sync.md#sync), `GET`/`PATCH /v1/first-sync`). A
  patch naming `historyDays` is `invalid`, like any unknown field.
- **How models are reached.** Either a gateway's key, which reaches several providers' models (`gateway`: Vercel's AI
  Gateway, `vercel`; model ids are `provider/model`), or a provider's own key (`direct`: `openai` or `anthropic`;
  model ids are the provider's own). A later revision adds signing in with a provider instead of a key as a third
  kind of `AiConnection`; the two kinds and the rest of the settings stay as they are.
- **The key** is stored encrypted, as mailbox credentials are. No route returns it, no agent sees it, no log holds
  it: the settings say only whether credentials are set (`credentialsSet`). New credentials replace the stored ones
  whole, and `null` removes them. **Setting credentials is the person's consent** to the mail of every inbox, those
  connected now and later, going to that gateway or provider: from then on every inbox's mail is processed. So an
  interface shows what is sent and to whom (below) before it saves a key, and again before a key for another gateway
  or provider. Moving to another one keeps processing, with that one, and puts every job back on the server's default
  model unless the same change names models; a new key for the same one keeps the models. **There is no per-inbox
  switch** (the owner's decision of 2026-11-17, which reversed the same day's earlier "an explicit choice per inbox").
- **Removing the AI key** is setting the credentials to nothing (`PATCH /v1/ai` with `credentials: null`). It stops
  all processing: nothing more of any inbox's mail is sent, threads keep the categories and summaries they have, and new mail stays
  `unknown` in Home. The service is remembered, so a new key for it keeps the chosen models. Interfaces offer it
  (`usual-mail ai remove`, the dashboard's AI page) and ask the person first.
- **Models.** Each job uses the model the person chose (`model`) or, when that is null, the server's default for the
  current connection (`defaultModel`). The server chooses the defaults and may change them in a later version; the
  settings show them to the person. Model ids are as the service names them.
- **The kinds of model each job needs.** On a gateway, `categorize` needs a decision model (it goes through the
  gateway's decision API) and `summarize` a language model. With a provider's own key both jobs use language models,
  categorizing through structured output. When a person sets a model the server can't use for its job, the test
  fails with `model_not_found`, that job, and words that say why ("On Vercel's AI Gateway, categorizing needs a
  decision model; anthropic/claude-haiku-5.5 is a language model. …"), before any request is sent to it. The server
  tells from the gateway's own list of models; a model the list doesn't name is left to the request.
- **Saving credentials or a model tests them at once,** as `testAi` does, and **the call answers only after that test
  has run**, so a status read straight after says how it went. They are stored even when the service refuses them,
  so the person can fix the account and test again.
- **Testing** (`testAi`, person only) sends one small request per job's model, with no mail in it, and answers with
  the status that follows.
- **Pausing** (`paused: true`) stops all processing, for every inbox: nothing is sent. Resuming carries on.
- **A store from before the switch was removed** keeps its column, which nothing reads: an inbox that had AI off is
  processed from then on like every inbox, its waiting threads as history (newest first).

## Status

- `aiStatus` (anyone may read it) and the event `ai.status.changed` (at most once a second, carrying the latest) say
  whether the AI works, why not in `detail`, which job's model is missing (`job`, with `model_not_found`), when it
  last processed a thread (`lastRunAt`) and how many threads it still has to process (`pending`), so an interface can
  say why there are no summaries yet. Clients fetch the usage (below) again on this event too.
- **States:** `not_set_up` (no credentials), `paused` (the person paused it), `working` (its last request was
  answered), `key_refused` (the service refused the key), `model_not_found` (the service doesn't know a job's model,
  or the model can't do that job), `out_of_credit` (the account has no credit or reached its limit), `unavailable`
  (the service couldn't be reached or kept failing, which usually passes by itself).
- **The key never shows, in any form.** The status's `detail`, events, logs and errors never carry the key or a
  recognisable part of it: not written out, not in base64 (standard or URL-safe, with or without padding, at any
  alignment), not in hexadecimal, not spaced out or broken across separators; any eight of its letters and digits in
  a row, in any of those forms, and a prefix or suffix of four characters or more, count as recognisable. A refused key
  is always the server's own sentence.
- **After a failure,** `key_refused`, `model_not_found` and `out_of_credit` stop processing until a person changes the
  settings or tests, or an hour has passed, when the server tries one request again. `unavailable` is tried again
  with growing pauses, from a minute up to 15 minutes. Any answer makes the AI `working` again and processing carries
  on.
- `pending` counts the threads that need a category or a summary and that the AI would process if it worked now:
  while credentials are set, every synced thread that isn't done or trashed, however old (0 without credentials). It
  is counted whatever the state, so an interface can say how much is held up.

## What the AI processes, and when

- **A thread needs categorizing** when its category is `unknown` and nobody has decided it, or when the AI filed it
  in a category other than `conversation` and incoming mail has joined it since, or when it is asked again (below).
- **The AI never takes a conversation out of Home by itself.** On a new thread it may choose any category. When
  incoming mail joins a thread, it may decide a category for an `unknown` one, and it may move a thread it had filed
  elsewhere to `conversation` (a person answered a newsletter, say); any other answer leaves that thread where it is.
  It never moves a thread out of `conversation`: a thread in `conversation` is never categorized again by the AI. The
  one exception is the dated one-off of 2026-11-19 below; it is not a standing behaviour. **A thread that skipped
  Screening while its sender isn't let in** (`skippedScreening`) keeps to its kind's categories whoever asks again
  (core's `SCREENING_PASS_CATEGORIES`): never a `conversation`, which would put a stranger's mail in Home, never an
  `invoice`. Mail from someone let in joining it asks nothing; mail from anyone not let in
  screens it again and the gate judges the newest message, with any category allowed
  ([rules and learning](contract.md#rules-and-learning), step 3).
- **A thread needs a summary** when it has none, or when incoming mail has joined it since the summary was written,
  unless it is `otp`. **One-time codes are never summarized:** an `otp` thread is not sent to the summarize job, and a
  thread that becomes `otp`, whoever decides it, loses any summary it had. **A `receipt` or an `invoice` needs its
  payment details** (in place of a summary) while it has none, whoever filed it, and again when incoming mail joins it.
  **A `notification` needs its event** (with its summary) while it has none, likewise.
- **The AI may process a thread** when credentials are set, the AI isn't paused or in a failure's wait, and the
  thread isn't done or trashed, in any inbox. Screened threads are processed too, so the screening list
  can say what they are about and they land where they belong once their sender is let in. **Nothing a blocked sender
  wrote is ever sent to a model,** in either job: not their own threads (they are done), not their messages inside
  someone else's thread, not when one of them is the newest incoming message (the newest one that isn't theirs is
  categorized), and not the subject they gave a thread (the oldest other message's is sent). Mail a blocked sender
  writes into a thread makes no work for the AI.
- **What starts it:** a new thread (the steps in [Rules and learning](contract.md#rules-and-learning)), incoming mail
  joining a thread, and history. Mail joining a thread is summarized again (unless it is `otp`), and categorized again
  only as the rule above allows. A thread becoming a `receipt` or an `invoice` (or one turning into the other),
  whoever decides it, the mailbox included, is asked for its payment details; one leaving them is summarized again.
  A thread becoming a `notification` is asked for its summary and event; one leaving it is summarized again.
  Nothing else starts it: not the mailbox's own sent mail, reading, stacking, a come-back time passing, any other
  category decided by anyone else, or another change made at the provider. A done thread that new mail brings back
  is processed then.
- **Asked again, once** (2026-11-19, after two audits of the AI's labels on real mail; built in
  `server/src/ai/ask-again.ts`): at the first start of a build that changes the words a model is given, the server
  marks the threads that build names, once per store, and the AI categorizes each of them again as history. Such a
  thread's answer may be any of the six categories, once; it is applied like any categorize by the AI (recorded
  silently, written back as its label, undoable), a model's `otp` still lifts the screening gate only as below, and an
  answer that is the same leaves it as it is, with no record. Nothing a person, a rule, an outside agent or the mailbox
  decided is asked about, and only threads that aren't done, trashed or gone from the mailbox and hold incoming mail
  a model may read. Afterwards the threads are processed as before: only mail joining asks again, only towards
  `conversation`, and never about a `conversation`. Summaries aren't redone. The first build of 2026-11-19 asked about
  the AI's `receipt`, `invoice` and `notification` threads and its `newsletter` threads whose newest incoming message
  has a stub text part (below). **This build's, the second of that day:** the AI's `receipt` and `notification`
  threads, and its `conversation` threads in which the mailbox has never written.
- **The owner's exception for conversations (2026-11-19, this one-off only).** A thread the server's AI filed as
  `conversation` in which no message is the mailbox's own (`outgoing`: the provider's evidence or a copy of what the
  server itself sent, never a From that names the inbox, so a forged "From: me" doesn't count) is asked once, and the
  answer may take it out of `conversation` to any category, through the same path: a silent record the person can
  undo, written back (it leaves the provider's inbox for its category's label). A conversation the mailbox has
  written in is never asked. This is a dated one-off of the build that carries it, not a standing behaviour: in normal
  processing the AI still never takes a thread out of `conversation`, and no later build asks again unless its own
  decision says so.
- **Mail that arrives while the AI may process it** is processed at once, as it arrives. **Everything else that needs
  work is history:** mail from before the inbox was connected, and mail that arrived while the AI was paused, not
  set up, failing or off for its inbox. The server processes history in the background, newest first by each
  thread's newest message, as far back as the synced mail goes. New mail goes ahead of history.
- **When the AI can't or may not process a thread,** it stays as it is: a new one is `unknown`, without a summary,
  and shows in Home unless it is screened, done or stacked. Interfaces show the snippet in place of a summary.
- **What a categorize does:** it sets the category and `categorizedBy: "ai"`, clears `reason`, raises the version,
  sends `thread.changed` and writes the thread back to where it now belongs (its label). Putting a thread in `otp`
  also removes its summary. For a thread screened by the sender gate, it stops screening it only when the server's own
  check confirms a kind of mail that may skip Screening (below), and then sets `skippedScreening` to that kind. **What a summary does:** it sets `summary`, raises the version and sends `thread.changed`;
  payment details set `payment` and `summary` (their `what`) the same way.
  Nothing else: the AI never marks done, stacks, screens or lets in, sets `need`, trashes, sends, drafts or changes a
  rule.
- **Cost:** at most one categorize request and one summarize request per thread for each incoming message, and for a
  thread at the screening gate at most one more on the categorize job's model: the gate's question, asked only when
  the server's own check could let the mail through (below); no summarize request for a one-time code, no categorize request for a thread in `conversation` once decided, and none
  at all for a done thread, a blocked sender or spam. Asking again costs one categorize request per thread it marks,
  once.

## First sync and history

- **How much:** every synced thread that isn't done, however old (the owner's decision of 2026-11-18, "all synced
  mail"). How far back the synced mail goes is the first sync's window (`FirstSyncWindow.days`: 30 unless the host or a
  person set otherwise, see [the first sync](contract-sync.md#sync)); mail an earlier, longer first sync kept is
  history too.
  **Archived history is done, so it isn't processed** unless new mail brings it back (the owner's decision of
  2026-11-18, "skip archived": categorizing it would write labels to archived threads at the provider); history filed
  under a category's label isn't done (see [the first sync](contract-sync.md#sync)), so it is summarized. So the first
  sync costs about two requests for each thread in the provider's inbox or on a stack, and one (a summary) for each
  thread filed under a category.
- **In what order:** newest first, in the background, behind new mail: new mail that arrives is taken before the next
  history thread.
- **How the person limits it:** the first sync's window, before an inbox is connected (a smaller one also narrows a
  first sync still running), `paused`, and removing the key. `aiStatus.pending` says how much is left. Setting a key or
  connecting an inbox adds to history.

## What leaves the server

For each thread the AI processes, the server sends to the service the person chose (a gateway, which passes it on
to the company that runs the model, or that provider itself). These words are `AI_SENT_WORDS` in
`core/src/ai-words.ts`, built from the same numbers and field names the server builds its requests with
(`AI_SENT_FIELD_WORDS`); the server's tests fail if a request carries a field they don't name.

- **To categorize it:** the subject (at most 1,000 characters); the newest incoming message's sender name and
  address, its List-Id and whether it looks machine-sent; and that message's text (made from its HTML when it has no
  text part or only a short stub of one), with each link cut to its site and invisible characters, padding and long
  divider lines taken out, at most 4,000 characters. For machine-sent mail from a sender you haven't let in, the same
  may be sent once more, to ask whether it is a sign-in link, a security alert, an order update or another notice that
  may skip Screening (below).
- **To summarize it:** the subject (at most 1,000 characters), and the text of the thread's messages from the newest
  back, with links cut to their site and invisible characters taken out, at most 8,000 characters in all, each with
  its sender's name ("someone" when the sender gave none, "you" for your own) and the day it was sent (its weekday and
  date where the server runs). Any email address in the subject or the text is replaced with [address], so no
  address is sent.
  Never for a one-time code. For a receipt or an invoice the same is sent, and in place of a summary the AI is asked
  who the money goes to or came from, how much, whether it is paid, will be charged or is to be paid, whether it is a
  refund, when it is due or charged and what it was for. For a notification the same is sent, and with the summary
  the AI is asked what happened, about what, and when.

**The day a message was sent** (2026-11-19; `sentDay` in `server/src/ai/prompt.ts`): each message's item carries
`sent`, its weekday in English and its date as YYYY-MM-DD, `"sent": "Thursday 2026-11-19"`, between `from` and
`text`, so a model can read "today" or "tomorrow". The date is the one in the **server's own time zone**, the host's
`timeZone` (`server/src/host.ts`): the Node server gives the machine's zone, or the one `TZ` names (a container that
sets none is UTC); a host that gives none, or not a zone, is UTC. The server keeps a message's time in UTC, so the day
is where the server runs, not where the sender was; the date checks below still accept either of the sender's two
possible days. Summarize, payment details and event requests carry it (they share one data block); **a categorize
request carries no date**.

**A message's text, as a model reads it** (2026-11-19; `server/src/ai/text.ts`): the same field as before, with less
noise. The text part is read, or the text made from the HTML when there is no text part or the text part is a stub:
shorter than 300 characters once cleaned while the HTML's text is at least three times as long. Then each link keeps
its scheme and site and loses the rest ("https://site/…"; a link that is only a site stays whole), invisible and
zero-width characters go, other spaces count as one, a run of four or more of one divider character becomes three,
and blank lines and spaces at the ends of lines collapse; the limits cut what is left. Since 2026-11-25 the screening
gate's own check (below) reads the same, as far as the model read it; and every pattern that reads a message runs in
time linear in its length, since a message is read under the server's lock (the gate's security reviews: a link
followed by many ")" or a run of "<" took seconds for 40,000 characters; taking addresses out of a summary request took
55 seconds for 128 KB without an "@"). Since then a request's text and subject are cut to their limits, with room for
one address, before addresses are taken out, and no part of an address cut there can come within the limit. A
subject sent to any job is at most 1,000 characters (`SUBJECT_LIMIT`).
- **To search by a sentence** (2026-11-20, [asking in a sentence](contract-search.md#asking-in-a-sentence)): only
  when a person asks search in a sentence, and only then: the sentence as they wrote it, with today's date and weekday
  (in the time zone the app gives), to be turned into search filters. Nothing from the mail goes with it: no message,
  no sender's name or address, no inbox's name or address. What is typed into the search field otherwise is never
  sent. These are `AI_SENT_WORDS.ask` and `AI_ASK_FIELD_WORDS` (the one field, `question`); the disclosure shows them
  as a fourth item, "To search by a sentence", before "Never". Unlike a summary request, an address the person writes
  in the sentence is sent as written: it is their own sentence, not mail.
- **Never:** attachments or their names, HTML, remote pictures, who else a message was sent or copied to, any
  credentials, an inbox's guide, rules, anything from a sender you blocked, spam, or threads that are done or in the
  trash. Testing the AI sends no mail.

A sender's name counts as none when it holds an address. The categorize job sends the newest incoming message's
sender name and address as they are; the summarize job never sends an address.

**An interface must show this before it saves a key** (and before a key for another gateway or provider): that saving
it sends the mail of every inbox connected to the server, now and later, what is sent, the service it goes to, and
that the service's own terms then apply, in core's words (`aiDisclosure` in `core/src/ai-words.ts`), not a copy. The
command shows them and asks (`--yes` without a terminal); the dashboard shows them above the key field and its
button. Saving the key is the yes.

**The server builds the words** and serves them: `GET /v1/ai/disclosure?gateway=vercel` (or `provider=openai`,
`provider=anthropic`), person only, no credentials needed, answers `AiDisclosure` (`service`, `destination`, `terms`,
`lead`, `sent` as labelled items, `history`) from `aiDisclosure` in `core/src/ai-words.ts`, with the models that would
do each job for that service (the person's chosen ones for the service already set, otherwise its defaults); `history`
says it processes new mail as it arrives, then all the synced mail that isn't done, newest first. A missing, doubled
or unknown service is `invalid`. The command, the dashboard and the apps all
show what it answers, so their words can't differ.

## Payment details

The owner's request of 2026-11-19, for the Receipts tab; its words revised the same day after an audit of the first
details. For a `receipt` or `invoice` thread the summarize job tells its model which of the two the thread is filed as
and asks it (structured output: one object, every field present, null when the mail doesn't say) for `party` (the shop
or service bought from or owed, without a legal suffix, never the payment service, reseller or wallet that only
handled the payment: PayPal, Stripe, Klarna, Adyen, Paddle, FastSpring, Apple Pay or Google Pay, the server's one list),
the `state` (since the owner's decision of 2026-11-19, "Yes, add it", to a third title: `paid` when the mail says paid,
charged or received or shows a payment confirmation; `scheduled` only when it says the amount will be collected,
debited or charged automatically or on a date; `due` when it asks the reader to pay or gives payment instructions;
else null), the `amount` this message says was paid, will be charged or is owed now, from the newest message that
states one, exactly as written (not an order's or a plan's total or a remaining balance when a smaller amount is the
one paid or due; for an order bought on invoice, the amount owed), its `currency`, `refund`, `dueDate` (YYYY-MM-DD:
the charge date when scheduled, the due date when due, never when paid) and `what` (one line under about 60 characters, a product's or plan's name alone being enough, without the
party's name, the amount or a date; null when it would only say a payment was made), from exactly what a summary
request carries. One request per thread
for each incoming message; there is no separate summary. **Nothing the model says is kept unchecked**; a fact that
fails is dropped and logged as `AI details for <thread id> dropped <field>: <reason>`, never with content:

- **`amount`** is kept only when its currency resolves to an ISO 4217 code with minor units (the model's code, or an
  unambiguous sign such as € or £; "$", "¥" and "kr" name several currencies and resolve to nothing; reason
  `currency`); when the amount as written can be read for sure (the last `.` or `,` is the decimal point when one or
  two digits follow it, or three for a currency with three; otherwise separators group thousands, each group after the
  first three digits; `unparsable`, or `precision` for more decimals than the currency has); when the same number is
  written in the text the model was given (`not_in_text`: with its minor digits after `.` or `,`, trailing zeros may be
  left out ("18.6" for 18.60) but never more digits than the currency has, its whole part plain or grouped by `,` `.`
  space `'` or `’`, or a dash for none, "49,-"; a whole amount without decimals only right next to its currency's code,
  sign or name; never as part of a bigger number, so "0.8399999999999999" is no amount); and when the currency's code, sign or name
  appears in that text (`currency_not_in_text`). It is stored as `minor`, an integer in the currency's **ISO 4217 minor
  units** (EUR 2, JPY 0, KWD 3; the server's own table of ISO 4217's active codes, not the runtime's), never negative.
  The amount the model chose must still be written there. **An amount of
  zero is dropped** whatever the text says (`zero`): a shop's "Total 0" line is not what was paid; one an earlier
  build stored is not kept when the thread is processed again.
- **`refund`** is true only on a `receipt` (money came back to the reader). On an `invoice` it is always false, and an
  amount the model read as a refund there is dropped (`refund_on_invoice`), since it would read as money to be paid.
- **`state`** is kept only as `paid`, `scheduled` or `due` (any case), else null (`unknown_state`). A refund is
  `paid`, whatever the model said. A `paid` state on an `invoice` (one already charged) and a `due` or `scheduled`
  state on a `receipt` (an order bought on invoice) are kept: the category stays what sorting decided. While the state
  is null, a title reads the category (an invoice to be paid, a receipt paid).
- **`dueDate`** is never kept while the money is paid: a `paid` state, or a null state on a `receipt` (`paid`;
  this replaced 2026-11-19's earlier "never on a receipt"). Otherwise it is kept only when it is a real calendar date (`invalid_date`) written in the text (`not_in_text`), and **not before the
  message it was read from** (the earliest message that writes it; the subject counts as the thread's first), give or
  take two days: a message's date is kept in UTC, which can be a day earlier than the sender's "due today", and a
  reminder may say "due yesterday". A date before its message whose day and month read the other way round make
  another date that is written there and isn't before it is kept that way (07/11/2026 read as 11 July becomes 7
  November); else it is dropped (`before_message`). When both readings fit, the one that follows the way the mail
  writes its unambiguous dates (a day over 12 in digits, or a day before or after a month's name) is kept, else the
  model's. The forms it may be written in:
  2026-11-30; in digits joined by `.`, `/` or `-`, day or month first, with a four- or two-digit year; or as a day and
  a month's name in English, German, French, Spanish, Italian, Dutch or Portuguese, either way round, with an optional
  year that must then be the same.
- **`party` and `what`** pass a summary's checks (control, zero-width and direction characters, markup or an HTML
  entity, the data block's marker; reasons as for a summary) and hold no address (`address`); a long one is shortened
  to 60 and 100 characters, never dropped for its length. **`party`** loses a trailing legal suffix (GmbH, AG, KG,
  Inc., Ltd., LLC, Corp., plc, S.A., SAS, S.r.l., B.V., N.V., SE, AB, AS, Pty Ltd and the like: the server's list) and
  a trailing "Team" (then a leading "The"); nothing left is `empty`. A missing or dropped `party` falls back to the
  newest incoming message's sender name, cleaned the same way, never an address. A `party` of display text is cut at
  the first " — ", " – ", " | " or " · " when two letters are left before it (`display_text` when not, and then the
  sender's name, cut the same way); so is one that leaves a single lowercase word before it (a district, not a
  name). A `party` that is one lowercase word on its own takes the sender's name, cleaned the same way, when there is
  one, and otherwise stays as it is (2026-11-19); a brand that writes itself so usually has the same word as its name. **One name per sender:** a sender's receipts and invoices in the same inbox share one form of its name,
  without a model, a sender being the domain after the @ (its registrable domain when the server carries the Public
  Suffix List, the sender pictures' list; the whole address at a free mailbox or a shared platform, whose senders are
  different people): names that differ only by a domain ending take the form without it ("Amazon"
  for "Amazon.de"), and of two where one is the other's start at a word boundary the shorter wins ("Fernsafe" over
  "Fernsafe Digital"); the other threads change with a `thread.changed`. Never across domains, and never for mail from
  a payment service on the list (known by its address's domain), whose party is a different shop each time. **`what`** loses the party's name at
  its start when a separator (`:` `-` `–` `—` `|` `·` `,`) follows it; nothing meaningful left is `only_party`, and a
  line that only says a payment was made (to someone, through a processor) is `only_payment`.
- **The answer as a whole:** none or one of another shape is `no_answer` or `shape`; the thread still gets details (the
  sender's name, if any), so it isn't asked again until mail joins it.

**Combined with what the thread had:** a fact the new answer gives wins; one it doesn't is kept from before, so a
shipping notice joining an order's thread keeps the order's amount, and an invoice joining it replaces it (the model is
asked for the amount of the newest message that states one); `refund` goes with the amount it was read with; the
newest `state` given wins, and a date goes when the state is paid. `party`
and `what` may each be null on their own. **`summary` is `what`** when there is one, and absent when not (interfaces
show the snippet), so a client never shows the same line twice.

**When:** a thread becoming a `receipt` or an `invoice` has none and needs them, whoever filed it; mail joining asks
again. **Leaving** those categories removes them, and a summary is due again; **turning from one into the other**
removes them and asks again, since a refund means something only on a receipt. A `receipt` or `invoice` without
details at a server's first start with this rule (2026-11-19) needs them like any other: one request each, as history.
Screened threads get theirs (the screening list shows `what` as the summary); a blocked sender's mail is never sent;
an `otp` thread never has details. **Asked again once** (2026-11-19, with the revised words): at the first start of
that build, every `receipt` and `invoice` that isn't done, trashed or gone and holds incoming mail is asked once more,
whoever filed it, and the answer **replaced** its details whole. **Asked again for the state** (the next build of
2026-11-19, a new one-off id): the same threads once more, but the answer applies conservatively, since each full
re-read also breaks a few right facts: its `state` is taken, a fact the thread has none of is filled when the answer
gives one that passes its checks (so an order bought on invoice gets its amount owed), a fact already there is never
overwritten, and `dueDate` follows the new state (gone when paid). An unusable answer keeps everything. One request
each; nothing changes at the provider. **A pass by rule only** (2026-11-19, after the re-audit; once per store, at the first start of that build, no
model asked): every stored receipt's and invoice's due date is checked against its message as above (read the other
way round, or dropped), every party is cut and cleaned as above, then one name per sender; each thread that changes
gets a new version and a `thread.changed`, and only counts are logged. The next build's pass (a new id) cut a district
from a party and unified names by domain; the one after (`2026-11-19 payment rules, one-word parties`) also gives a
party that is one lowercase word the sender's name. **Not built:** amounts from attachments (a PDF invoice), marking an
invoice paid, totals, "due soon" in Home.

## Notification events

The owner's request of 2026-11-19, for the Notifications tab ("focusing on simplicity, and low noise and only give
the important info first"; "Yes, build both": rows that lead with the event and when it matters, and the tab in Today,
Coming up and Earlier). For a `notification` thread the summarize job asks its model (structured output: one object,
every field present, null when the mail doesn't say) for the `summary` as for any thread, and the event: `status`
(what happens or happened **at the date it gives**, a short phrase in English whatever the mail's language, under
about 30 characters, never with a relative word; a preferred list as examples, not a closed one: deliveries
Dispatched, Arriving, Out for delivery, Delivered, Ready for pickup; appointments and bookings Appointment confirmed,
Appointment moved, Appointment cancelled, Reservation confirmed, Reminder; accounts Password changed, Payment failed,
Trial ended, Limit reached; a dispatch notice that gives an arrival day is Arriving with that day; a mail that asks
the reader to act by a date is an event whose status names what is needed, "Consent needed", "Action required",
"Pick up by", and whose date is the deadline), `about` (what or who it concerns, as the mail names it, without the
sender's name or a date, under about 60), `date` (YYYY-MM-DD, the event's own moment, not a neighbouring one such as
when a limit resets), `time` and `endTime` (HH:MM, a delivery window when the mail gives one, as written, without
converting time zones), and `reference` (exactly as the mail writes it, the number or code that identifies this
order, parcel, booking or case; never an amount, a date, a phone number or a customer or account number; used only to
join notifications about the same thing, [below](#notification-groups), never served or stored); all of the event
null for a notification that tells of none. From exactly what a summary request carries (what leaves the server is
unchanged); one request per thread for each incoming message. The wording is `eventInstructions` in
`server/src/ai/prompt.ts` (revised 2026-11-19 after the audit of 119 rows). **Nothing the model says is kept unchecked**; a dropped fact is logged as `AI
event for <thread id> dropped <field>: <reason>`, never with content:

- **`summary`** passes a summary's checks; a dropped one leaves the thread's summary as it was.
- **`status` and `about`** pass the same checks and hold no address (`address`), shortened to 40 and 80 characters,
  never dropped for length. `about` that is only the sender's name (as a party: "Parcelway GmbH" is "Parcelway") is
  dropped (`only_sender`); one that starts with it before a separator loses it, unless only a single word or a place
  would be left (up to three capitalised words, with joiners such as "am" or "de": "Parcelway: Berlin" stays whole).
- **A status holds no relative word** (`server/src/ai/event-lines.ts`): "today", "tonight", "tomorrow", "yesterday",
  "the day after tomorrow", "this morning" (afternoon, evening, week), "next week", "in" or "within" a number of
  minutes, hours, days or weeks, and weekday names, each with an "on", "at", "for", "from" or "in" before it, are taken
  out when a phrase is left ("Arriving tomorrow" is "Arriving"; "by" stays: "Pick up by"); a status that was nothing
  else is dropped (`relative_only`).
- **A dispatch with a later date is Arriving:** a status that is only a dispatch word ("Dispatched", "Shipped", "On its
  way", "In transit", with "Order", "Parcel", "Package" or "Shipment" before it) whose `when.date` is after the day the
  thread's newest message was sent (in the server's time zone, as its `sent` states) becomes "Arriving".
- **`date`** must be a real calendar date (`invalid_date`) that the mail supports, one of two ways. **Written** in the
  text (the payment details' forms: ISO, digits day or month first, a month's name in seven languages), within **365
  days either side** of a message that writes it (`out_of_range`): a notification may tell of the past ("delivered on
  2 November") or plan ahead, but not by years; read day or month first as the mail writes its unambiguous dates, as
  for due dates. Or **said relative to a message's own date**: today, tonight, tomorrow, yesterday, the day after
  tomorrow, the day before yesterday in English, German, French, Spanish, Italian, Dutch and Portuguese ("morgen" only
  in lower case, since "Morgen" is the morning; "mañana" not after "la" or "esta"; French "hier" left out, since it is
  "here" in German and Dutch), or a weekday's name, which is that day of the week from the message's date to a week
  after it, that date included, or **"in" or "within" N days** in digits, each language with its own words ("within 14
  days", "in 3 Tagen", "innerhalb von 14 Tagen", "binnen 7 Tagen", "dans" or "sous 10 jours", "en" or "dentro de 4
  días", "tra", "fra" or "entro 5 giorni", "in", "binnen" or "over 7 dagen", "em" or "dentro de 2 dias"), which moves
  it by N. The server keeps a message's time in UTC, not the sender's offset, and offsets run from UTC−12 to UTC+14, so
  a message's own local date is one of two days: the dates of its time 12 hours earlier and 14 hours later. The word
  moves both; the model's date is kept only when it is one of them. Or **written without a year**, day first, as
  "05.12." (the dot after the month needed, no digit after it) or "05/12" (no third part; never month first): in the
  message's year, or the next one when that day lies more than **92 days** before one of its local days
  (`YEARLESS_PAST_DAYS`): a notification tells of the recent past far more than of anything months ago, and a deadline
  or appointment rarely lies more than nine months ahead, so a year-less date is read in the year from about three
  months before its message ("15.01." in November is next January, "20.09." this September). Otherwise `not_in_text`.
- **`time` and `endTime`** must be HH:MM (`invalid_time`), written in the text (`not_in_text`: "15:15", "14.30 Uhr",
  "15 Uhr", "9h30", "18h", "9:40 am", "12 pm"; a time with no am or pm before another with one in a window takes its
  "3:15–6:15 pm"), and come with a date (`no_date`); an end not after its start, or without one, is dropped
  (`time_order`). **A time marked UTC is converted** (`server/src/ai/event-times.ts`): written with "UTC" or "GMT"
  right after it (an offset of zero allowed, "(UTC)", seconds before it) or a "Z" against it ("14:30Z",
  "2026-11-19T14:30:00Z"), the time is in UTC on the event's date and becomes the date and time it is in the server's
  time zone, which may move the date; a window's start takes its end's mark ("14:00–16:00 UTC"), and an end that lands
  on another day than its start is dropped (`two_days`). A time written both marked and plain counts as UTC when any
  writing of it is so marked. One marked with another offset ("UTC+1", "GMT-05:00": the sign is written both ways) is
  dropped and the date kept (`utc_offset`). Times in other zones are kept as written. Since the audit of the groups
  (2026-11-19) the marks also read: seconds with a fraction ("00:00:00.000 UTC", "T00:00:00.000Z"), a numeric zero
  offset after seconds ("T00:00:00+00:00"; another numeric offset after seconds is `utc_offset`), and "UTC" or "GMT"
  right before the time ("at UTC 00:00"); a window's mark goes either way between its two times; a plain hyphen
  between two times is a window ("14:00-15:00", which before read as no time at all), while the digits of an offset
  ("+00:00") and of a date are never a time. **A limit's reset time is not its moment:** for a status about a limit
  ("limit", "quota", "usage", "credits" or "allowance" as a word), a time the mail writes shortly after a word for
  resetting ("resets", "reset", "renews", "renewal", "refreshes", and German and French ones, in the same sentence, at
  most 30 characters before it) is dropped (`reset_time`), with its end, and so is the date (`reset_time`) unless it
  is the day the thread's newest mail was sent. **A time with no date takes the
  server's** (2026-11-19, `dateOfTime` in `server/src/ai/event.ts`):
  when the answer gives a time but no date, or a date that fails, and the message (or subject) that writes that time
  also has one of the relative words above, the date is that message's day sent in the server's time zone (the day
  its `sent` states), moved by the word. Weekday names don't count here ("on Monday" may lie before its message or
  after it); words that disagree ("not today: tomorrow") or none leave `no_date`.
- **What the server changed** is logged by code, never content: `AI event for <thread id> took its date from the day
  its message was sent`, `... took a relative word out of the status`, `... named a dispatch with a later date
  Arriving`, `... converted a time marked UTC to the server's time zone`.
- **The answer as a whole:** none or one of another shape is `no_answer` or `shape`; the thread still gets an event (all
  of it null, or what it had), so it isn't asked again until mail joins it.

**Combined with what the thread had** (since 2026-11-19, notification groups): when the new answer gives a status, its
`status` and `when` are taken **together**, since a status names what happens at its date: "Delivered" with no date
after "Out for delivery today, 3:15–6:15 pm" leaves no `when`, and a client shows the mail's own day. An answer with no
status keeps the status and `when` the thread had. `about` and the thread's reference are kept when the answer has
none. The summary is replaced only when the answer gives one. (Before, the three were combined field by field, which
kept an old window under a later "Delivered".)

**When:** a thread becoming a `notification` has none and needs it, whoever filed it; mail joining asks again; leaving
`notification` removes it and a summary is due. A notification without an event at a server's first start with this
rule needs one like any other: one request each, as history; nothing changes at the provider. Screened threads get
theirs; a blocked sender's mail is never sent.

**Asked once more for references** (2026-11-19, `EVENT_AGAIN` "2026-11-19 event groups" in
`server/src/ai/ask-again.ts`): at the first start of a build with groups, once per store, every notification that
isn't done, trashed or gone and holds incoming mail is asked again (one summarize-model request each, as history),
whoever filed it. **Only the reference is taken** from the answer, and the thread's group
worked out from it as below (or, for an appointment, from what is stored, also when the answer is unusable); its
`status`, `when`, `about` and summary stay exactly as stored. A thread with no event yet takes its answer as any.
Logged as a count only. The same day's two before it on this marker ("2026-11-19 event dates": a status and no `when`,
only filling; "2026-11-19 event audit": status and `when` together) ran on real stores; the marker
(`server_state.details_asked_again`) keeps build order, so a store that had a later one has had the earlier ones, and
the per-thread flag (`threads.payment_again`) is the payment details'.

**Sections, computed by each client** (the server sends none): from `when.date` and the person's own clock and date.
**Today**: `when.date` is the person's current date. **Coming up**: a later date, soonest first (then by time, a
missing time last). **Earlier**: no `when`, or a past date, newest mail first. The date is the mail's local reading:
a client compares it with the person's local date as it is, without converting it. A group's section is its shown
thread's ([Words](contract.md#words)). **Not built:** joining a shop's and a carrier's mails about one parcel, an
appointment moved to another day, grouping receipts or newsletters, a window that spans two days (the field has one
date), a "needs you" mark for alerts and deadlines, adding to a calendar.

### Notification groups

The owner's "Yes, build it" of 2026-11-19 (one row per parcel or appointment). The server says which `notification`
threads of an inbox tell of the same thing: `event.group`, an opaque string ([Words](contract.md#words); clients only
compare it, and show one row per group). Built in `server/src/ai/event-group.ts` and `event-reference.ts`:

- **A reference the mail prints** (an order, tracking or shipment number, a booking or reservation code, a ticket or
  case number), asked as `reference`. Kept only when it passes a safe line's checks (`markup`, `address`) and is not
  a link (`url`), a phone number (a leading "+", `phone`), an amount (a currency sign or code, or digits with two
  decimals, `amount`) or a date (ISO or day, month and year in digits, `date`); a label before it ("Order", "Tracking
  number:", "Sendungsnummer", in the matcher's seven languages) is taken off; what is left must be letters, digits and
  separators (space, "-", "_", ".", "/", "#", ":"; else `shape`), **5 to 40 characters** without separators
  (`length`), with a digit (`no_digit`), and **written in the text the model was given** with the same letters and
  digits in order, separators and case aside, not inside a longer run of letters and digits (`not_in_text`). Kept as
  its letters and digits in capitals. The group is then a hash of the inbox, the sender's domain (the thread's first
  incoming sender, registrable domain with the Public Suffix List as the payment details count senders; a whole
  address at a free mailbox) and the reference. **The reference itself is neither served nor stored**: only the
  hash, in `threads.event_key` (migration 0017, with an index), which is enough to compute and re-check a group;
  debugging is by the logged codes.
- **Without a reference, the moment** (since the audit of the groups, 2026-11-19, `momentOf`, `sameMoment`): an event
  can join the same sender's other notifications (same inbox, same domain, none of them on a reference) about the
  same moment, whatever its status or `about` say. Its moment is its `when.date` with its **time, when that time is
  still ahead of the mail** (the thread's newest mail, both read in the server's time zone: an upcoming moment, not a
  report of something that already happened at that minute, so two builds that finished at one minute stay apart),
  and, for an **appointment** (a status with "appointment", "reservation" or "booking" in it, with an `about`), what
  it is about, compared without case, punctuation or spacing. Two moments are the same on one date **at the same
  upcoming time** (a reminder and its confirmation, a meetup's "Approval pending", "Reservation confirmed" and
  "Reminder"), **or as two appointments about the same thing** (a confirmation and its move to another time that
  day), **or with no time on either and the same `about`** (since 2026-11-20, whatever their statuses: a "Reminder"
  and an "Approval pending" for one meetup, both dated without a time; never a timed event with an untimed one unless
  both are appointments, and never two different things the sender names for one day). An event takes the key that
  most of the sender's notifications at the same moment already have (the earliest one's on a tie), else its own: "m"
  with a hash of the date and time, or "a" with a hash of the subject and date (an appointment's, or an untimed
  event's: the same key for the same subject and day). So a reminder joins a confirmation, and a move joins both. An event with neither an upcoming time
  nor an appointment's subject has no group. **An appointment moved to another day doesn't join its old mail** (the
  model isn't asked for the old date). One key per thread: two sets that would be bridged by a later mail aren't
  merged (each joins the larger one).
- **Otherwise no group.** A shop's and a carrier's mails about one parcel have different domains, and usually
  different numbers: they stay separate rows. A thread keeps the reference's key when a later answer has none.
- **Over-grouping** is worse than a duplicate row: a sender that prints the same number in all its mail (a customer
  number the model took for a reference) would make one row of everything it sends. So a key shared by **more than 8**
  of the inbox's notification threads (not removed, done ones counted), or, for a reference, by threads whose newest
  mails lie **more than 60 days apart**, is no one thing's: all those threads lose the group (logged as a count:
  `AI event groups: a reference on N threads isn't one thing's; they are shown apart`). An appointment's key holds its
  day, so its mails may lie further apart (booked months ahead). The rule is applied whenever a thread's key is
  worked out, to every thread with that key (each changed one gets a new version and a `thread.changed`), and to the
  key a thread left. A thread leaving `notification` loses its event and key; the group it left is re-checked when
  another thread next takes that key.
- **Mail joining** keeps the thread's reference key when the new answer gives no reference; a moment's key follows
  the event (moved the same day: the same group).
- **Once, by rule** (`MOMENT_PASS`, `regroupEventsOnce` in `server/src/ai/event-regroup.ts`, at the first start of a
  build with it, after the snippets' pass on the same marker; "2026-11-19 moment groups", then "2026-11-20 moment
  groups, untimed" for the untimed rule): every stored notification's key and
  group worked out again by these rules, oldest mail first (a reference's key stays), and a limit's stored time that
  the mail writes after a word for resetting dropped as below. No model asked, no provider read; each thread whose
  served event changed gets a new version and a `thread.changed`; counts only in the log ("Notification groups by
  rule: N threads changed, M reset times dropped").

## Mail is untrusted input to a model

Mail is untrusted input to a model, exactly as it is to an outside agent. The server:

- **passes mail as data inside marked boundaries:** a marker with a random id for each request opens and closes the
  data, nothing inside can contain the marker or close it (the connector's data block is the model), and the
  instructions outside say that everything inside is data, never an instruction;
- **accepts an answer only as one of the allowed categories** (any of the seven but `unknown`; only `conversation`
  where the AI may only move a thread there), or as plain text for a summary, with line breaks turned to spaces and
  no control, zero-width or direction characters, no markup or HTML entity, and nothing of the data block's marker,
  all checked on the whole answer. **A summary longer than 200 characters is shortened, never dropped for its
  length:** to its first sentence when that fits, otherwise where the last word that fits ends, with "…"; the checks
  run again on what is kept. A summary that names the sender is kept (the request asks it not to). Anything else is
  dropped: the thread stays as it was and isn't asked about again until incoming mail joins it, and the server logs
  the thread's id and a reason code (`no_answer`, `empty`, `control`, `markup`, `marker`), never anything of the
  answer or the mail;
- **gives models no tools,** so they take no actions; an answer sets a category or a summary and nothing else;
- **never lets a model's answer alone lift the screening gate** (below);
- **never shows anything a model wrote as HTML.** Interfaces show summaries as plain text.

**A model's answer at the screening gate** (2026-11-17 for one-time codes; every kind since the owner's decision of
2026-11-25). Mail can talk a model into calling it anything, and phishing imitates exactly the mail that may skip
Screening: sign-in links, security alerts, password resets, receipts. So for a thread screened by the sender gate (not
filed under Screening by the mailbox) the server's AI lifts the gate only when the server's own check also holds for the
message the model read, and only while the server holds the new thread for the AI's answers (`gatePending`) and that
message is still its newest incoming one; otherwise the thread stays screened, in the model's category. The check is
conservative on purpose, so what it misses waits in Screening rather than a stranger skipping it
(`server/src/ai/gate.ts`, `gate-shape.ts`, `gate-evidence.ts`):

- **the mailbox provider's checker proved the From domain,** and it is the address's own: `fromCheck` is `verified`
  for exactly that domain, by the rules sender pictures use ([sender pictures](contract-avatars.md), "When a picture
  is shown", 3), the provider is one whose checker the server trusts (Gmail), and the domain is no public mail domain
  or shared platform (core's `isPublicMailDomain`, `isSharedPlatform`). A server without the Public Suffix List
  proves nothing; **and**
- **the message looks machine-sent** by the provider's test (`ProviderMessage.automated`: bulk, auto-submitted, a list
  header or no-reply); **and**
- **it has the shape of mail sent to this person by that organisation alone** (the gate's security review of
  2026-11-25: the proof says which domain sent the mail, not who wrote it; a platform carries anyone's words under its
  own domain, a comment on a shared document, a mention, a money request, a help desk's free trial, and a brand's real
  alert can be sent on to others with its signature intact): (a) no List-Id; (b) every Reply-To at the From's
  registrable domain; (c) To or Cc names the inbox's own address, a `+tag` ignored and dots at gmail.com (and
  googlemail.com), and on Gmail only in a field the sender's own DKIM signature vouches for
  (`ProviderMessage.signedRecipients`: the field is given once, Gmail's checker passed a signature of the From
  address's organisation, and every DKIM signature in the message whose `d=` is in that organisation, matched to a
  result or not, names the field in its `h=`; one of them must match a passing result. A message giving To or Cc
  twice, with any signature that can't be read, lacks `d=`, `h=` or `b=`, has a `d=` with no organisation or matches
  a result that didn't pass, or with a header line that is neither a field nor a fold, has none. The check is
  monotone: anything added to the headers or altered in them only takes fields away). This stops a copy sent on by
  Bcc and a replay with a
  To or Cc added on top (the second security review: a real signed alert to the attacker, with `Cc: victim` added,
  passed before); it doesn't stop every replay: a sender who signs a field naming someone else is beyond it, and mail
  signed with no DKIM at all (DMARC by SPF alone) never passes; (d) not from a platform whose customers send from
  their own subdomain of it (`TENANT_PLATFORMS` in `gate-shape.ts`: zendesk.com, freshdesk.com, atlassian.net,
  helpscoutapp.com, service-now.com, intercom-mail.com, my.salesforce.com, gitbook.io, notion.site and the like);
  (e) not from a notifier whose mail carries its users' words: google.com and microsoft.com whole (each product
  there sends its own notices: a document's comments, a file shared, a calendar event, a form's answers, a team's
  chat; Google's own account alerts too, since a genuine one can carry an app name an attacker typed), but for
  Microsoft's account team (`account-security-noreply@accountprotection.microsoft.com`, as Microsoft names it), and
  payment services' requests and receipts
  (paypal.*, venmo.com, square.com, squareup.com, stripe.com; sharepointonline.com too); where a request can't be
  told from a security alert at the same address, the address is refused, and a real alert waits in Screening;
  **and**
- **it shows the kind's evidence**, read in its subject (at most 1,000 characters) and its text as the model read it
  (above: made from its HTML when needed, links cut to their site, at most 4,000 characters), words whole and in any
  case, a phrase's words joined by up to three spaces or hyphens or nothing ("sign in", "sign-in", "signin"); a link
  counts in the stored text or among the HTML's own links:
  - **a one-time code** (`code`, for the AI's `otp`): a code within 80 characters of one of the words `code`, `codes`,
    `passcode`, `one-time`, `otp`, `verification` or `verify`. A code is six to eight digits, or two groups of three or
    four digits joined by one space or hyphen (`482913`, `482 913`, `4829-1375`), standing alone: no letter, digit or
    one of `# + $ € £ . , / : _ -` right before it, and no letter or digit, nor one of `. , / : -` followed by a digit,
    right after it;
  - **a sign-in link** (`sign_in`): a web link (in the text, or one of the HTML's own links) and "sign in", "log in"
    or "magic link";
  - **an email confirmation** (`email_confirmation`): a link, a word for confirming ("confirm", "verify",
    "activate", "validate" and their nouns) and one for what ("email", "address", "account", "sign up",
    "registration", "subscription");
  - **a security alert** (`security`): a security phrase ("new sign-in", "new device", "was this you", "suspicious",
    "unusual activity", "password changed", "two-factor", "recovery codes", "passkey" and the like);
  - **a password reset or account change** (`account`): a link with a reset phrase ("reset your password", "password
    reset"), or an account change ("email address changed", "plan changed", "account deleted", "data export",
    "download your data" and the like);
  - **a receipt or order update** (`order`): an order or shipping word and either a reference (five to thirty capital
    letters, digits and hyphens with at least one digit, within 40 characters after "order", "booking",
    "confirmation", "tracking", "reference", "ticket" and the like) or an amount (a currency's symbol or ISO code next
    to a number);
  - **a booking** (`booking`): a booking word ("booking", "reservation", "flight", "hotel", "ticket",
    "appointment" and the like) and a reference, an amount, or a day or time;
  - **a payment alert** (`payment`): a payment word ("payment", "charged", "card", "renewal", "declined", "fraud"
    and the like) and an amount or a card's last four digits ("ending in 4242", "•••• 4242").

**A one-time code** needs less: the proof, machine-sent mail, (c) the inbox addressed, and the code; not the rest of
the shape (a code may come from a list's address or reply elsewhere). **An inbox whose provider has no checker at all**
(IMAP) can't give the proof, so there a code passes on the rest, as before 2026-11-25 (the coordinator's decision of
2026-11-25, so IMAP doesn't get worse); nothing else passes there. A Gmail inbox's missing or failed proof
(`unverified`, `other_checker`, `repeated`, `no_header`, or none read) never falls back.

**The gate's question.** For an answer of `otp` whose code the check accepts, nothing more is asked. Otherwise, when
the AI's category may be one of the kinds and the proof, machine-sent mail, the shape and one of those kinds' evidence
hold, the categorize job's model is asked once which kind it is (`server/src/ai/pass-prompt.ts`): the same item the
categorize request carried, inside its own marked data block, a choice among that category's kinds (core's
`SCREENING_PASS_CATEGORIES`) and `none`; a decision model answers it on the gateway, a language model through
structured output limited to the options. Only an answer among the options counts, and the kind it names must then
pass the check itself. It is counted in the usage as a categorize request. When the service fails it, the category
stands, screened, and the failure counts like any other. **An `invoice` is never asked about and never skips
Screening.**

A person's own `categorize` to `otp` lifts the gate as before; the check applies only to the server's AI.

Decision models answer a choice among the categories; language models answer through structured output limited to
them. Either way the server checks the answer itself.

## Records and correcting

- **What the AI decides is recorded like any other action:** a `categorize` record whose actor is
  `{ kind: "ai", job: "categorize", model }`, and the thread's `categorizedByActor` is that actor, so "why it's here"
  can name the model and be corrected. It always applies and is
  silent: Handled lists it only with `includeSilent`, a brief doesn't count it, and "what needs you" shows it only
  when its write-back failed or carries a note (silence never hides trouble).
- **A summary isn't recorded:** it decides nothing and nothing undoes it.
- **The AI's usage isn't a record either:** it is counted by the hour, with no thread (below).
- **Correcting a category** is a person's `categorize`: recorded, undoable, written back as the label, and it may
  return a teach prompt (see [Rules and learning](contract.md#rules-and-learning)). Undoing the AI's record also
  corrects it: the category goes back and the person has decided it. An agent may undo the AI's records where it could
  have applied the opposite itself.

## Usage

The owner's request of 2026-11-18: a person's Settings show what the AI used of their account. `GET /v1/ai/usage`
(`aiUsage`, person only: an agent's token gets `needs_person`, 403, like the other person-only AI routes) answers
`AiUsage` (`core/src/ai-usage.ts`). No event: clients fetch it when Settings opens and again on `ai.status.changed`.

- **Jobs in the usage** (`AiUsageJob`, `AI_USAGE_JOBS`): `categorize`, `summarize`, and since 2026-11-20 **`ask`**, a
  search asked in a sentence ([asking in a sentence](contract-search.md#asking-in-a-sentence)). `ask` runs on the
  summarize job's model but is counted apart, so a person sees what asking costs and the summarize row stays what mail
  cost. It is a name in the usage only: `AiJob` (the jobs a person chooses a model for, `AiSettings.jobs`, a failure's
  `AiStatus.job`) stays `categorize` and `summarize`, and a refused `ask` names `summarize` as the job whose model
  failed. A client that doesn't know a job name shows it as it is (the Mac app capitalizes it: "Ask").
- **What one request is:** one call the server makes to the service for one job: categorizing or summarizing a
  thread, turning one search sentence into filters, or one job's part of a test (`testAi`, and the test on saving a key or a model; these count like the rest,
  not marked apart). Whatever the server then makes of the answer, it counts: a summary dropped by the checks is a
  request. A model the gateway says can't do its job is never sent anything, so it isn't one. The AI SDK retries a
  call itself, at most twice, after a 429, a 5xx or a dropped connection; those retries are inside the one request,
  not seen by the server and not counted apart. A search sentence is the exception: it is never sent again. Looking up the gateway's model list isn't a request.
- **`failed`** is counted inside `requests`: a request the service refused or couldn't answer (after its retries).
- **Only what the service reported counts; nothing is estimated.** Tokens are what the AI SDK reports for the call:
  language models report input and output tokens; the gateway's Decisions API may report them or not. A failed
  request reports nothing.
- **The cost** comes only from Vercel's AI Gateway, and only for a request whose answer carried the gateway's
  generation id (`providerMetadata.gateway.generationId`; its documentation promises one for text calls, so for
  summaries; for its Decisions API it names one only inside fallback attempts, which the server doesn't ask for, so a
  categorize's cost is likely not reported). The amount is the gateway's own figure for that generation, the
  `totalCost` in US dollars its generation lookup answers (`GET /v1/generation?id=…`), not an estimate. The server
  looks it up apart from the mail work, about 10 seconds after the request, and if the gateway can't say yet (or the
  lookup fails) tries again after 1, 5, 30 and 120 minutes, then gives up and that request's cost stays unreported.
  So a cost can arrive some time after the request; until then its row's cost is null or partial. A lookup sends
  the generation id and the key's authorization, nothing of the mail; it isn't a request in the usage; it runs only
  while the AI may send anything (not while paused, without a key or in a failure's wait), and the ids waiting are
  kept across a restart and dropped when the key is removed or the service has no lookup. A provider's own key
  (OpenAI, Anthropic) puts no cost in its answers and has no lookup: its cost is not reported.
- **Null and partial.** `inputTokens`, `outputTokens` and `cost` are summed over the requests that reported them, and
  null when none in the row did (a client says "not reported", never 0). When some requests in a row reported them
  and others didn't (a failed request never does), `tokensPartial` or `costPartial` is true and the number is a floor
  (a client says "at least").
- **Rows and periods.** One row per job and model (a model changed in the period gives two rows; a client adds them
  up), in `AI_USAGE_JOBS` order then by model, only with requests. `periods.today` runs from the last midnight in the time
  zone asked for (`?tz=<IANA zone>`, default `UTC`; an unknown one is `invalid`), `last7Days` from midnight six days
  before, `last30Days` from midnight 29 days before. Usage is kept by the UTC hour, so a period starts at the whole
  hour that holds that midnight: exact for zones a whole number of hours from UTC, within half an hour for the rest.
- **Kept** for 90 days (`AI_USAGE_KEPT_DAYS`), by the hour; older hours are dropped at a start and once an hour.
  `since` says when the server began keeping usage (its first start with it, 2026-11-18 at the earliest): nothing
  before it is counted, and nothing was filled in from before (the records can't give it: summaries aren't recorded,
  and dropped or failed requests weren't).
- **Never in it:** a thread, a message, a subject, a name, an address or anything of the mail; only the job, the
  model id and the counts.
