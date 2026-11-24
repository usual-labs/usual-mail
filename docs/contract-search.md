# The contract: search

Part of [the contract](contract.md). Added on 2026-11-20 at the owner's request ("How can we make the search working?
let's think of the best approach and ux"; then "do step 1 and 2 first and then step 3"): **step 1**, real search over
what the server holds, and **step 2**, reaching back into the mailbox for older mail the server doesn't hold. **Step 3**
(the same day): [asking in a sentence](#asking-in-a-sentence), which the server's AI turns into the same filters.
Shapes are in `core/src/search.ts` (`SearchQuery`, `SearchResult`, `RemoteSearchResult`, `SearchAskInput`,
`SearchAskResult`) and `core/src/provider.ts` (`ProviderSearchQuery`, `MailProvider.search`, `fetchThread`). The
server's code is `server/src/search/`.

## What a search takes

`GET /v1/search` (`search`, a person or an agent) and `GET /v1/search/remote` (`searchRemote`, a person only) take the
same query, as query parameters: `q` (at most 200 characters), `inboxIds` and `kinds` comma-separated (`inboxId`, which
earlier clients send, counts as one of `inboxIds`), `from`, `to`, `subject`, `hasAttachment` and `unread` (`true` or
`false`), `after` and `before` (times), `tz`, `cursor`, `limit`. Every filter is optional and they combine (all must
hold). A search with filters and no text is allowed (every receipt from one sender); one with neither is `invalid`, and
so is an unknown kind, time zone or cursor; an inbox the caller can't see is `not_found`.

| Filter | Holds a thread when |
|---|---|
| `inboxIds` | It is in one of them. Default: every inbox the caller may see |
| `kinds` | It is in any of the categories named; `screened` narrows to screened threads, `done` to done (archived) ones: `receipt,invoice,done` is archived receipts and invoices |
| `from` | A message a person sees of it was written by: an address (exact), a domain (`studio.example`, or `@studio.example`, with its subdomains), or otherwise a word's start of the writer's name or address, folded (case, accents, ß as ss) |
| `to` | The same for who a message was sent to (To and Cc) |
| `subject` | Its subject holds the words, as word starts |
| `hasAttachment` | It has (true) or hasn't (false) an attachment; inline pictures don't count |
| `after`, `before` | Its newest mail a person sees is at or after, or before, the time |
| `unread` | It is unread (true) or read (false) |

**Operators typed in `q`** become the same filters, Gmail's common ones: `from:`, `to:`, `subject:` (a word, or
`subject:"several words"`), `has:attachment` (and `-has:attachment`), `is:unread`, `is:read`, `before:` and `after:`
(and Gmail's `older:` and `newer:`) with a day as `YYYY/MM/DD` or `YYYY-MM-DD`, the start of that day in `tz` (default
the server's own time zone). A `"quoted phrase"` matches word for word; a leading minus leaves a word or phrase out.
Operator names are read in any case. **Anything else is plain text, never an error**: an unknown operator
(`label:x`), a date that can't be read (`before:soon`), a minus before another operator. A typed operator wins over the
same filter given as a parameter. At most 16 words, phrases and excluded words count.

**What the server understood** comes back with every answer (`understood`: the filters applied, given or typed, the
free text left as `text`, phrases in quotes, and `exclude`), so a client can show the filters as chips. The filters are
plain values (closed lists, ISO times), so a later step can fill them from a model's structured answer.

## What is searched

One index entry per thread, built by the server from what it stores, by rule (no provider read, no AI request), in an
SQLite FTS5 table (`search_index`, migration 0018):

| Field | What it holds |
|---|---|
| `subject` | The thread's subject |
| `sender` | The names and addresses of who wrote its incoming messages |
| `people` | Who else is in it: the To and Cc of its messages |
| `summary` | The AI's summary |
| `facts` | The AI's checked facts: a payment's `party`, `what`, the amount as written digits ("49.99", and grouped from a thousand, "1,234.56") with its currency code; an event's `status` and `about` |
| `attachments` | Attachment file names (not inline pictures) |
| `body` | Every message's reading text, newest first: the text part, or the text made from the stored sanitized HTML, read exactly as a snippet reads it (`readingText` in `server/src/ai/text.ts`, one implementation), links taken out; at most 20,000 characters a message and 100,000 a thread |

The inbox's own address is left out of `sender` and `people`, so a person's own name doesn't match every thread.
**Only messages a person sees count:** what a blocked sender wrote into someone else's thread is never indexed, so it
never finds that thread and never shows in an excerpt; a sender's standing is read when the thread is indexed, as a
thread's row reads it when it is refreshed. A thread a blocked sender started is found (it is done).

**Which threads are found:** done (archived), screened and blocked senders' threads, and waiting ones, as the Search
row of [Lists](contract.md#lists) says; trashed threads and threads gone from the mailbox are not.

**How text matches:** words are cut as the index's tokenizer cuts them (unicode61 with `remove_diacritics 2`: case and
accents folded, so "muller" finds "Müller" and "CAFE" finds "café"); ß and ss are read as each other ("strasse" finds
"Straße"). Every word of two characters or more matches as a word's start, so results follow typing ("rech" finds
"Rechnung"); a one-character word matches whole. A word that cuts into several (an address, "e-mail", "49,99") matches
as a phrase. A quoted phrase matches word for word. Not built: matching inside a word ("loop" in "Paperloop"),
spelling mistakes, "ue" for "ü".

## How results rank

With text, **relevance first, recency a strong tie-break**:

1. **Threads the whole text matches within the subject and who wrote** come before every other (a match in the subject
   or the sender's name outranks one deep in a body, however old).
2. Within each of the two, by **score = bm25 ÷ √(1 + age / 14 days)**: bm25 is FTS5's relevance over the fields
   weighted subject 10, sender 10, summary 4, facts 4, people 3, attachments 3, body 1 (FTS5 weighs a field's term
   count before bm25 saturates it, which is why the tier above does the ordering of fields); age is how old the thread's
   newest mail is, in whole seconds. A match of the same strength two weeks old ranks about 0.7 as high as today's,
   three months old 0.37, a year old about 0.2.
3. Then by id, descending.

Filters with no text list **newest first**, as every list does (`lastMessageAt` in whole seconds, then id). A page's
`nextCursor` continues the same query exactly (it holds the moment the first page ranked against); a cursor from
another query is `invalid`. `limit` defaults to 50, at most 200.

## What a result carries

`SearchResult`: `items`, `nextCursor`, `understood`, and on the first page of a search with text, `people`. It reads as
a `Page<Thread>` too.

- **Each item is the thread exactly as lists give it** (`Thread`: its avatar, payment, event, `done`, `screened`,
  version and the rest; `done` is true for archived mail, so a client can offer "Move to Inbox"), **plus `match`**
  (absent for filters alone): `fields`, every field the text matched, most telling first (subject, sender, people,
  summary, facts, attachments, body); `subject`, the subject in runs when it matched; and `excerpt`, `{ field, runs }`,
  a short excerpt (at most about 200 characters) around the best match outside the subject, from the first of body,
  summary, facts, attachments, people and sender that matched.
- **Runs** (`SearchRun`): `[{ text, match }]`, plain text pre-split, matched words marked `match: true`. A client draws
  them in order and marks the matched ones. The text passes a snippet's checks (no markup, control characters or line
  breaks; it is cut from text the server cleaned as it cleans a snippet), so it is drawn as text, never trusted as
  markup. An excerpt cut short ends with "…".
- **People** (`SearchPerson`): up to five senders whose name or address has each of the text's words as a word start
  (folded), in the inboxes searched, most threads first, then newest: `email`, `name` (the one they last wrote under),
  `threads` (how many threads not trashed or gone hold mail from them) and `lastMessageAt`. The inboxes' own addresses
  are never among them. "Everything from them" is the `from` filter with `email`. Other filters don't narrow them.

## Keeping the index right

- A thread is indexed again whenever its version moved since it was indexed: new mail joining, a summary, payment
  details or an event landing, a snippet remade, removal and every other change a person sees raise it. When what the
  index reads of the thread's own columns is the same (subject, snippet, people, newest time, count, attachments,
  summary, facts), only the version is noted and its messages aren't read again.
- **A search first indexes whatever is stale**, so it always reflects every change made before it (the look costs
  under a millisecond for thousands of threads); events also keep the index current in the background.
- A thread gone from the mailbox leaves the index. Deleting a thread or an inbox (removing an inbox) deletes its entries
  by cascade, and a trigger deletes the FTS5 row with its entry.
- **The first start of a build with search** (migration 0018 adds empty tables) builds the index from what is stored,
  before syncing starts, by rule: no provider read, no AI request; the log says counts only ("Search index: N threads
  (M messages) indexed in S s").
- Measured on made-up mail (2026-11-20, this Mac, Node 22, the project's libSQL): building the index for 10,000 messages
  in 3,334 threads (bodies averaging 3,100 characters, half of them HTML) took 1.9 s, and the search tables took about
  50 MB; 900 messages took 0.2 s and 4.6 MB. A query as a person types took 2 to 16 ms ("re" the slowest, a two-letter
  prefix; full words 9 to 12 ms; filters alone 2 to 3 ms), the look for stale threads 0.6 ms.

## Who may search

- **Local search (`search`):** a person, and an agent in the inboxes it may see (its token's inboxes with
  `agentAccess`), as every list. The connector's `search_threads` tool takes the text and the filters.
- **Remote search and opening (`searchRemote`, `openRemote`):** a person only. An agent's token gets `needs_person`:
  an agent never makes the server query a mailbox on its own.

## Older mail in the mailbox

The server holds what the first sync's window took and everything since; older mail exists only in the mailbox. A
person may ask for it explicitly ("Search older mail in Gmail"); a client shows it as its own section after the local
results and never searches it as a person types.

- **`GET /v1/search/remote`** (person only) sends the same query to each inbox's mailbox (one or several with
  `inboxIds`, else every inbox), translated into the provider's own query language, and answers `RemoteSearchResult`:
  `items` (`RemoteHit`: `id`, `inboxId`, `subject`, `from` (the newest message's sender), `lastMessageAt`, `snippet`
  (the provider's own preview, as plain text), `hasAttachments`, `messageCount`, `archived`), `nextCursor`, `understood`,
  and `inboxes`: how each inbox answered (`ok`; `unsupported`: its provider can't search the mailbox, IMAP for now;
  `paused`; `needs_sign_in`: the mailbox refused the sign-in, with the words to sign in again; `provider_error`: the
  provider's words). One inbox failing doesn't fail the others.
- **It leaves out what the server holds** (a conversation it holds, by its provider key) and spam and trash, newest
  first. A page holds up to `limit` (default 10, at most `REMOTE_SEARCH_MAX`, 20) from each inbox searched, merged
  newest first; the server reads up to three provider pages per inbox to fill it, so a page may hold fewer, and
  `nextCursor` continues each inbox that had more. **Nothing found is stored.**
- **A result's `id`** is the same for the same mailbox conversation across pages and searches. It is opaque.
- **Gmail's translation:** words, `"phrases"` and `-words` as given; `from:`, `to:`, `subject:(…)`, `has:attachment` or
  `-has:attachment`, `after:` and `before:` as Unix seconds, `is:unread` or `is:read`; the filed categories as their
  labels (`label:usual-mail-receipts`, several as `{…}`), `screened` as the Screening label, `done` as `-in:inbox`; a
  kind filter naming `conversation` or `unknown` sends no category (they have no label); never drafts or chats. Gmail
  matches whole words, so a word's start typed locally ("rech") finds less there.

**Opening one:** `POST /v1/search/remote/:id/open` (person only) brings that conversation into the store from the
mailbox, every message of it, and answers its `ThreadDetail`, so the normal mail page shows it. **It is idempotent:**
a conversation already held is answered as it is, a second call answers the same thread. An unknown id, or one the
mailbox no longer has, is `not_found`; a paused inbox `conflict`; a mailbox that refuses `provider_error` with its
words (Sign in with Google again, for a refused sign-in).

- **Placed as the mailbox has it**, as the first sync places mail: archived there (under no filed label, no stack, not
  Screening) is **done** here, so by the existing rule the AI doesn't process it and it shows only in search; under a
  filed category's label, that category; under Screening, screened; on a stack's label, that stack; **still in the
  mailbox's inbox, not done**, so it shows in Home and the AI sorts and summarizes it like any other thread (about two
  requests to the person's AI account, and its label written back if the AI files it elsewhere).
- **No rule runs, and an old thread is never pushed into Screening as new mail:** a stranger's archived conversation is
  done, not screened; one still in the inbox is not screened either. **Opening it doesn't let its sender in** (reading
  isn't trusting): their next new thread is screened as any stranger's; a reply of theirs in the opened conversation
  lets them in, as anyone writing into a thread that isn't screened. The mailbox's own messages in it still let their
  recipients in (the inbox sent them mail), without lifting anyone's screening, as the first sync does. A blocked
  sender's conversation arrives done.
- **It writes nothing to the mailbox and doesn't touch the sync:** read-only provider calls, the sync's cursor and the
  first-sync window unchanged. What the server works out later is written back as for any thread (the AI's category; a
  blocked sender's conversation still in the inbox is archived by the next repair).
- **It stays when the provider lists its window again** (`reset`, [sync](contract-sync.md#providers)): such a listing
  covers the first sync's window, which never held the opened conversation, so its messages are no part of any listing
  and none drops them; opening one while a listing runs ends no listing. A message of it the provider reports removed
  goes as any other. What isn't seen: a change made to it at the provider in the gap a listing covers (deleted or
  filed elsewhere while the provider had lost its place) reaches the server only when the provider next reports that
  message.

**Limits:** at most 10 remote searches and openings together per device a minute (in memory; `rate_limited` with
`Retry-After` beyond). Gmail's quota units (the server spends at most 80 a second, Gmail allows 6,000 a minute):
a remote search page is one `threads.list` (10 units) and one `threads.get` in the metadata form per conversation
(counted as 20, like `messages.get`'s metadata form; Google's own figure for `threads.get` wasn't read again), so 210
units for 10, at most 630 when three provider pages are read; opening is one `threads.get` in the minimal form (20) and
each message whole (60), 140 units for a conversation of two.

**Privacy:** the search text and filters are sent to the person's own mailbox provider (their Google account), only
when the person asks for older mail; never to the AI service, and nothing of a local search leaves the server.

**Not built:** IMAP's search (an IMAP inbox answers `unsupported`); searching inside attachments; searching by meaning.

## Asking in a sentence

Step 3 (2026-11-20, the owner's "do step 1 and 2 first and then step 3"). A person may ask in a sentence, "invoices
from Cloudbase last month" or "the mail where Anna sent the contract pdf", and the server's AI turns it into the filters
and text a search takes. **`POST /v1/search/ask`** (`askSearch`, **person only**: an agent's token gets `needs_person`;
an agent builds filters itself) takes `{ question, inboxIds?, tz? }` and answers `SearchAskResult`:

| Field | Holds |
|---|---|
| `understood` | The filters and free text to search with, in exactly the shape a search echoes (`SearchUnderstood`); `inboxIds` as given |
| `text` | What stands in the search field: `understood.text`, then each excluded word as `-word`. Sent as `q` with `understood`'s filters as parameters, a search answers the same `understood` |
| `found` | True when the AI turned something into a filter or an excluded word |
| `ai` | `working` when the AI answered this sentence; otherwise the AI's own state (`not_set_up`, `paused`, `key_refused`, `model_not_found`, `out_of_credit`, `unavailable`) |
| `detail` | Why `ai` isn't `working`, in words a person can act on |

- **It searches nothing and returns no mail.** One job, one answer: a client shows `understood` as chips with `text`
  in the field, the person corrects what was misread, and the client calls `GET /v1/search` as for any search. (Why
  two calls: the person sees and can fix what was understood before it decides what they are shown.)
- **Only when a person asks this way.** An explicit action in the search field, never as a person types: what is
  typed into the search field otherwise never goes to the AI.
- **What goes to the AI service:** the sentence as written (spaces and line breaks one space, at most 200 characters,
  `SEARCH_ASK_MAX`: the same as `q`), today's date and weekday in `tz` (default the server's time zone), and the
  server's own words naming the fields and the kinds a search takes. **Nothing from the mailbox:** no message, no
  sender's name or address, no inbox's name, address or id (`inboxIds` are checked and echoed, never sent). An address
  the person writes in the sentence goes as part of it. See [what leaves the server](contract-ai.md#what-leaves-the-server).
- **Which model:** the summarize job's, through the structured answer payment details and events use: ten fields,
  each present, null when the sentence doesn't say it (`kinds`, `from`, `to`, `subject`, `hasAttachment`, `unread`,
  `after`, `before` as YYYY-MM-DD, `exclude`, `text`). The sentence is passed as data inside the marked block, as mail
  is ([mail is untrusted input](contract-ai.md#mail-is-untrusted-input-to-a-model)): a sentence that says "ignore the
  rules" changes none of the server's words. The wording is `askInstructions` in `server/src/search/ask-words.ts`.
- **Nothing the model says is kept unchecked** (`checkAsk`); what fails is dropped and logged by field and reason
  (`AI search ask dropped from: not_in_question`), never with content:
  - `kinds`: only the values a search takes (`SEARCH_KINDS`), any case; others dropped (`unknown`).
  - `from`, `to`, `subject`, `text`, `exclude`: **only words the sentence itself holds** (compared without case or
    accents). A word whose every part the sentence holds is kept as written, so an address the person wrote stays an
    address; of any other word only the parts the sentence holds are kept (`cut`: "billing@cloudbase.example" for "from
    Cloudbase" becomes "cloudbase"); nothing left is dropped (`not_in_question`). So the model can't invent an address, a
    name or a word. They then match as a search matches them today (`from` a word of a sender's name or address).
  - `hasAttachment`, `unread`: true or false, else dropped (`not_boolean`).
  - `after`, `before`: a real calendar day (`not_a_day`), from 1990 to a year ahead (`out_of_range`), `after` not
    later than now (`ahead`), `before` later than `after` (`order`: both dropped). A day is its start in `tz`, as a
    typed `after:2026/10/01` is. The model works "last month", "this week" or "since March" out from the date it is
    given; the server checks that the days are possible, not that they are the ones the person meant.
  - An answer of another shape (not an object, a field the server didn't ask for) is not used at all.
  - What is left goes through the same parser and limits as a typed search (`parseSearch`, the search's schema), so
    an operator the sentence itself types (`from:anna`) is read as typing it would be.
- **An amount** ("over 100 euros") has no filter: its words stay in `text` as written, where the person sees them and
  can take them out (an amount filter is in [improvement ideas](agents/improvement-ideas.md)).
- **The worst case is an ordinary search of the sentence.** When the AI isn't set up, is paused or waits after a
  failure, nothing is sent; when the request fails now, takes too long, or the answer is unusable or holds nothing,
  `understood` and `text` are the sentence as if it had been typed (operators in it included), `found` is false, and
  `ai` and `detail` say why. A client runs the plain search and may say why the AI didn't help.
- **Limits:** a sentence of 1 to 200 characters (`invalid` otherwise; so is an unknown time zone, and an inbox the
  caller can't see is `not_found`); at most **10 sentences a minute per device** (`rate_limited` with `Retry-After`;
  counted only when a request is about to be sent; in memory); the server waits **15 seconds** for the model, then
  answers with the sentence as typed (`ai: "unavailable"`, the AI's status left as it was); the request is **never
  sent twice** (no retry by the server or the AI SDK). One request to the person's AI account each: roughly 600 to
  700 input tokens (2,400 characters of the server's words, the sentence and the schema) and under 100 output tokens
  (an estimate from the request's size; no real call was made).
- **The AI's status and usage:** a refusal (the key, the model, no credit, the service failing) is recorded as any
  request's is, so the status says it and mail processing waits as usual; an answer makes a failing AI `working`
  again. Each sentence is one request in the usage under its own job name, `ask`
  ([usage](contract-ai.md#usage)).
- **Demo mode** answers a few English turns of phrase by rule (`server/src/ai/fake-ask.ts`); the sample's
  `searchAsks` are five sentences with their answers.
- **Not measured:** how well a real model reads sentences. Every test, demo mode and the development switch use fake
  models; no real model has been asked.
