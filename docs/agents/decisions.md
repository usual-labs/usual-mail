# Decisions

Choices that shape the code. Each part records its own decisions in its own note; this page holds the ones
that cross parts.

## 2026-11-16

- **The server has no AI vendor inside it.** It holds mail, rules, the trust setting, the action history and
  undo. An agent the person already uses connects from outside and does the judging. Without an agent the
  server still works as a plain mail store with rules. **Reversed on 2026-11-17 by the owner** (the fifth
  revision, below): the server runs its own AI; outside agents stay an option.
- **Safety lives in the server.** Trust levels, the actions that always need a person, and undo are enforced by
  the service, so they hold for every interface and every agent.
- **One service, many interfaces.** REST, the dashboard and the chat connector all call `MailService`. No
  interface has behaviour of its own.
- **Providers are plain adapters.** A provider fetches and changes mail at the mailbox and holds no state. The
  server owns the store, the sync loop and every decision.
- **TypeScript for the server,** because it runs both as an ordinary process in Docker and as a Cloudflare
  Worker. Node with a SQLite file comes first; storage, timers, live updates and held-open connections sit
  behind interfaces so a Cloudflare side can follow.
- **SwiftUI for Mac and iPhone,** from one codebase, with the system's own controls.
- **The iPhone app is its own target with its own shell, on the same packages** (the owner's "Yes, start" of
  2026-11-20 to this recommendation, after asking whether it should be a separate app). The owner's concept changes
  where the navigation sits (a switcher menu for the rail, the tabs at the card's foot, a full-width card) but keeps
  the pages and the behaviour, and `UsualMailKit` and the design package already built for iOS. So `UsualMailUI` holds
  both shells, each fenced by file (`#if os(macOS)`, `#if os(iOS)`), and shares the navigation, the pages and the row
  of capsules; a fully separate app would have copied them, and one adaptive window would have put platform branches
  in every view ([apps-phone.md](apps-phone.md)).
- **Design is shared as values, not code.** One token file generates CSS and Swift. Geist Serif for headings
  and reading, Geist Sans for small text and controls, Prociono for the wordmark only, and Hugeicons' free
  icon set (MIT). Its paid set may not be redistributed, so it is never added here.
- **Each TypeScript folder is its own package** with exact dependency versions, so parts can be built and
  checked on their own.
- **Names in code:** piles `people`, `reads`, `receipts`, `screening`; stacks `reply_later`, `set_aside`;
  `come_back` for a thread that returns later. (Piles were replaced by categories in the fifth revision.)

## 2026-11-17

From the contract's third revision. The contract has the details.

- **The three trust levels behave differently.** In an `act_silently` inbox, what rules and agents apply is
  recorded as silent: it can be undone, but Handled leaves it out unless the person asks, and the brief's counts
  and "what needs you" leave it out. Before this, `act_with_undo` and `act_silently` looked the same everywhere.
  **Silence never hides trouble:** a record the provider refused, or that carries a note, stops being silent.
- **Handled keeps the records of trashed threads,** so a trash can be undone from the place that shows it.
  "Trashed threads are in no list" means lists of threads.
- **Undo never overwrites a later change.** Undoing `allow_sender` or `block_sender` restores the sender and only
  the threads nobody changed since. The sender's state is always restored, because it is what the action was
  about.
- **At the provider, a People thread is in the inbox exactly when it shows in Now** (since the fifth revision: a
  thread is in the inbox exactly when it shows in Home). The provider's own app then
  shows the same "what needs you" as Usual Mail; stacked and waiting threads are archived with their stack's
  label. Moving a thread back into the inbox there wins, as every change made at the provider does. The cost,
  more moves at the provider, is accepted; providers avoid fetching again what they moved themselves.
- **A sender is screened until let in,** and the ways of letting in are listed in one place, so the server,
  the apps and agents agree on what Screening holds. Sorting a thread out of Screening counts as letting its
  sender in for later mail, since the person or agent has answered for that sender. (Since the fifth revision
  screening is a gate, not a pile, and that way of letting in is gone: see below.)
- **Everything a client copies has a version:** inboxes, threads, records and drafts. Versions may rise by more
  than one, because several changes can share one event. A client keeps the higher copy and needs no other rule.
  A sync that only moves `lastSyncedAt` is not a change, so a polled inbox doesn't send an event every minute.
- **Provider notes reach people** on the record or the draft they concern, not in a separate log.
- **Credentials change in place,** verified with the provider first, so a new password keeps an inbox's rules and
  history. **Removing an inbox never touches the provider,** so no mail there is lost by removing it here.
- **The connector takes agents' tokens only.** An AI acting with a person's token would count as the person and
  skip every trust check. **An agent's token comes only from an agent pairing code,** so a person always chooses
  which inboxes it sees.
- **The owner is never locked out.** Whenever no person's device remains, the server makes a new owner code at
  once, prints it and writes it to a file the command can read.
- **The owner has a password; the first visitor claims an unclaimed server** (the owner's decisions of 2026-11-24,
  [server-owner.md](server-owner.md)): finding the owner's code in a file, a log or Data Studio was too hard. Signing
  in with the password pairs the device as a person's, so the paired devices stay the only sessions (no Better Auth).
  `USUAL_MAIL_OWNER_EMAIL`, proven by Google, closes the claim window; the deploy files ask for it ("first visitor +
  email prompt", chosen over requiring the owner's code for the first claim). Claimable only with no password and no
  person's device, so servers paired before can't be taken over after the upgrade. A forgotten password is replaced
  from any signed-in device, or through a recovery code put where the owner's code goes (one mechanism, instead of a
  reset command and a Cloudflare secret first proposed).
- **Mounted interfaces get the full URL,** so each sees the URL its client used, whatever the web framework.
  REST always keeps `/v1` and `/healthz`, so no interface can shadow the API.
- **Only built providers are named.** `ProviderKind` is `imap` or `gmail`; Outlook returns when it exists.

## 2026-11-17, the fourth revision

From the coordinator's decisions that close the first milestone's contract. The contract has the details.

- **Rules are copied like everything else:** a `version`, who made them (`createdBy`) and `rule.changed` /
  `rule.removed` events, so the apps and the dashboard needn't refresh to learn of a rule an agent suggested.
  **Hits send one event per rule per batch of new mail,** not one per thread: a large sync would otherwise double
  its events, while a person still sees the count move.
- **The service guards a person's drafts.** An agent may change or delete only a draft an agent wrote. The
  connector did this on its own before; safety lives in the server, so every interface gets it.
- **A provider's note on a send is kept for a day** on the sent draft in its thread, so a person can see that no
  copy was saved; a sent draft without a note isn't kept, so drafts don't pile up.
- **"What needs you" is a question the server answers** (`attentionOnly`), instead of each interface scanning a
  page of history and missing older notes.
- **Inboxes say how they are connected, without secrets,** so a form can ask only for the password. The provider
  describes its own credentials (`MailProvider.connection()`), since their shapes are the provider's; the server
  stays agnostic and never shows a secret. Credentials are still replaced whole: one shape in, nothing merged.
- **Paused means hands off the mailbox:** nothing read, nothing written, until resumed. Work done meanwhile is
  written back after the first good sync, where changes made at the provider still win.
- **One dashboard path is the contract's** (`/inboxes/<id>`), so the apps can send a person there for what only the
  dashboard does.
- **Mail a person's own filter filed keeps its filing.** The third round sorted all new mail wherever it arrived,
  which overrode a person's Gmail filters and server-side rules. Their filing is a person's decision, so it stands:
  no rules, screening or triage for it. Mail delivered to the inbox is sorted as before.
- **Spam is treated like trash,** and new mail to spam is ignored: nothing in spam should reach Now or an agent.
- **"Changed since" means moved,** for undoing an allow or a block: reading a thread or a come-back time passing
  doesn't stop the undo from putting it back.
- **A refused write-back never overwrites a later change.** It puts back only what is still as it left it, and a
  later action then remembers the part as it was before the failed one, so its undo lands where things really were.
- **The image carries only what runs:** the bundle's run-time dependency (libSQL) is installed on its own, since
  pruning left build tools behind.

## 2026-11-17, the final review of the first milestone

- **Every inbox is polled, watched or not.** A provider's `watch` only brings changes sooner: IMAP's watches INBOX
  alone, so mail a server-side rule files elsewhere, and changes made only there, must still arrive within the poll
  interval. Before the review a working watch stopped the poll.

## 2026-11-17, the coordinator's decisions after the final review

The contract has the details (an amendment to the fourth revision).

- **A message that leaves spam is sent whole,** never as a change. The server ignores mail delivered to spam, so it
  doesn't hold such a message and would drop a change for it; sending it whole lets it arrive as new mail where it
  now sits. The rule sits with the providers because only they know a message left spam. Trash is unchanged: the
  server holds trashed threads.
- **Lists order by what they publish:** the whole second, then id, descending (the triage queue, oldest first, the
  other way round), and cursors hold the same. Clients see whole seconds only, so ordering by milliseconds gave an
  order no client could reproduce. The server changed; the apps' order already followed the contract.
- **A send cut off by a stop fails at the next start and says it may have gone out.** Nobody knows whether the
  provider sent it, so the words send the person to the Sent folder before sending again, rather than retrying.
- **What needs a look is anyone's record,** the person's own refused change included, because otherwise it shows
  nowhere but an event. Handled's ordinary list stays what rules and agents did.
- **The IMAP server's reason for a refused move is not passed on:** ImapFlow returns `false` and gives the reason
  only to its logger, so reading it would rely on undocumented internals.

## 2026-11-17, the fifth revision: the owner's change of architecture

The owner decided the first five points; the coordinator turned them into decisions; the contract has the details.

- **The mailbox is the main database.** The provider's mailbox is the source of truth for mail; the server's store
  is a synced copy plus what the server works out. What should survive losing the server (category, stacks, the
  screening gate) is written back as labels or folders, so a new server on the same mailbox reads it back. Summaries
  can be made again, so they stay on the server. Why: the person owns their mail where it already lives, and the
  provider's own apps keep working.
- **Gmail first.** Gmail is the provider the product is built and proven for; IMAP stays as it is, Outlook later.
  New mail is noticed on a timer. **Gmail's push is a later step,** through a Pub/Sub pull subscription, so a home
  server needs no public address; Google may delay or drop notifications, so the timer stays anyway.
- **The server runs its own AI** (reversing the first decision of 2026-11-16), with the person's own AI account:
  a gateway key or a provider's key now, signing in with a provider later. Why: every device shows the same summaries
  and routing, and it works without any agent connected. The connector for outside agents stays as an option.
- **Categories replace piles,** and **screening becomes a gate:** a thread is screened while its sender isn't let in,
  whatever its category. A first mail can be a newsletter or an invoice, so the sender question and the kind of mail
  are separate. **`categorizedBy`** replaces the triage state: the AI, a rule, an outside agent, the person or the
  mailbox. `agent` is there because the connector stays.
- **Home is `conversation` and `unknown`,** not screened, done, stacked or waiting (notifications joined it on
  2026-11-18, below). Read from two decisions together:
  Home holds conversations, and what the AI couldn't decide shows in Home so nothing is hidden. **A thread is in the
  provider's inbox exactly when it shows in Home.**
- **`conversation` has no label,** as decided, so the mailbox can't tell a conversation from an undecided thread. A
  new server reads such a thread in the inbox as `unknown` and decides it again: a few requests, against a label on
  every conversation in the person's Gmail.
- **The AI processes only threads that aren't done,** screened ones included, and nothing from a blocked sender or
  spam. Why: done threads are in no list but search, so deciding them costs money for nothing seen; the screening
  list is easier to answer with summaries. A done thread is processed if new mail brings it back.
- **History:** threads that aren't done whose newest message is within `historyDays` (default 30 at first, 7 since
  the amendment below), newest first, in the background behind new mail, with a pause. Because archived history is
  done, the first sync costs about two requests per thread in the inbox or on a stack, not per message. **Changed on
  2026-11-18 by the owner:** history is all synced mail that isn't done (below).
- **Only categorizing is recorded,** by an `ai` actor naming the job and the model, always applied and always silent
  unless something went wrong: correctable and visible on asking, without flooding Handled. **A summary isn't
  recorded:** it decides nothing and nothing undoes it. The AI gives no `reason` (decision models can't); interfaces
  say who decided from `categorizedBy`.
- **`categorize` replaces `move`,** for people, agents, rules and the AI alike, so one action kind carries every
  category decision and its undo. Undoing one sets `categorizedBy` to whoever undid it, so the AI doesn't decide the
  same thread again and again.
- **Deciding a category lets no sender in.** Only `allow_sender`, the inbox writing to them, the first sync and
  writing in a thread that isn't screened let a sender in. The old "a move out of Screening lets the sender in" has
  no counterpart, because a category says what mail is, not who may write.
- **AI credentials are stored, then tested,** not verified first as mailbox credentials are: a key can be right while
  a job's model is missing, and a person should be able to fix the account and test again. The status says which.
  The status has two states beyond the five decided: `paused` and `unavailable` (the service failing for a while).
- **Gateway and providers named:** Vercel's AI Gateway (the owner's earlier Gmail sorter uses it, and it carries
  decision models), and OpenAI's and Anthropic's own keys. Signing in comes later as a third kind of connection.
- **What the AI may set is only a category or a summary,** with mail inside marked boundaries, answers checked
  against the categories or a length limit, no tools, and nothing shown as HTML: mail is untrusted input to a model
  as to an outside agent.
- **Counts are one call and one event,** at most once a second, so the apps needn't fetch every thread for badges.
  `unread` counts Home's unread threads, "New" for now. **A waiting list** (come-back time ahead) was added for the
  Snoozed page, soonest first.
- **The triage queue** now holds `unknown` threads the AI won't process: inboxes with AI processing off (gone since
  the owner removed the switch, below), the AI not
  working, or history beyond the window.
- **Every list but search and screening leaves out screened threads,** so the gate holds everywhere.
- **Inboxes have an `icon`** (person, building, briefcase, house, shop, globe: the design's three and three spares)
  **and a `position`,** the same on every device. Colour stays. Grouping inboxes into a profile isn't built.

## 2026-11-17, the fifth revision amended after its risks were reviewed

The coordinator's follow-up decisions, the same day, before any part adopted the revision.

- **Sending an inbox's mail to the AI is an explicit choice per inbox.** **Reversed by the owner later on 2026-11-17**
  (below): there is no per-inbox switch, and saving the key is the consent. Setting a key turned nothing on: every inbox's
  `aiProcessing` is off when credentials are first set, and a new inbox's is off unless the person turns it on while
  connecting it. Turning it on needs credentials, and an interface must show at that moment what is sent and to whom.
  Why: on by default would send every inbox's mail, strangers' included, to a third party without asking. **Our
  reading:** removing the credentials or moving to another gateway or provider turns it off for every inbox, since
  the mail would go somewhere the person didn't choose; a new key for the same one keeps it.
- **One-time codes are never summarized,** and a thread that becomes `otp` loses its summary: a code shouldn't be
  copied to every device and to a second model for nothing.
- **History defaults to 7 days,** and the status counts what raising it would add (`beyondHistory`, up to
  `maxHistoryDays`, the first sync's reach), so the person sees the cost first.
- **The AI never takes a conversation out of Home by itself.** On mail joining a thread it may decide an `unknown`
  thread or move one it filed elsewhere to `conversation`, never the other way. Why: an automatic reply must not pull
  a real conversation away, and it saves a request per reply.
- **A one-time code is never held back by screening.** For a sender who isn't let in, the AI categorizes first; an
  `otp` isn't screened and doesn't let its sender in. Everything else from that sender is screened, and so is the
  code when the AI is off or failing. **Our reading:** while the answer is awaited the thread counts as screened but
  isn't written back, so the provider never sees it moved to Screening and out; and any categorize to `otp`, by
  anyone, lifts the gate for that thread, except a filing under Screening made at the provider. (Since the review's
  decisions, the server's AI's `otp` lifts it only when the server's own check holds: below.)
- **A person's correction to `conversation` is the one decision not written back,** because `conversation` has no
  label; accepted as the cost of keeping labels off every conversation.
- **The contract is split by subject:** `docs/contract.md` is the entry point and holds the service's behaviour;
  `docs/contract-ai.md` the server's AI; `docs/contract-sync.md` sync and providers. Each stays under the 500-line
  guide.

## 2026-11-17, the fifth revision built

The builders' choices that cross parts, with the coordinator's two requirements. Details in [server.md](server.md),
[cli.md](cli.md), [dashboard.md](dashboard.md) and [mcp.md](mcp.md).

- **The AI SDK reaches every service.** `ai` 7.0.173 with `@ai-sdk/gateway`, `@ai-sdk/openai` and `@ai-sdk/anthropic`,
  exact versions, bundled into the server (only libSQL stays outside the bundle, so the Dockerfile didn't change).
  Behind the server's own seam (`AiModels`: `choose` and `write`), so the pipeline builds every request and checks
  every answer and a provider only carries them. Why: one library for the gateway and both providers' own keys, on web
  APIs only, so the Cloudflare side can use it too.
- **On Vercel's AI Gateway, categorizing uses a decision model** through the gateway's Decisions API, and summarizing a
  language model; with OpenAI's or Anthropic's own key, both jobs use a language model, categorizing through
  structured output limited to the six categories (OpenAI's strict schema with `store: false`, Anthropic's native
  output format, never a forced tool). No request carries tools. Why: a decision model answers only from the given
  choices and costs little; the owner's earlier Gmail sorter uses one.
- **Default models:** on the gateway `liquid/d1.2` to categorize and `anthropic/claude-haiku-5.5` to summarize;
  with OpenAI's key `gpt-6-luna` for both; with Anthropic's `claude-haiku-5-5` for both. Chosen from the services'
  model lists on 2026-11-17 for price; the gateway's categorize default became `liquid/d1.2` (it was `typesafe-ai/jev`)
  by the owner's decision of 2026-11-18, after the owner's server had been set to it and the server's own test of it
  had passed against the real gateway. The OpenAI and Anthropic defaults were **never tried against a service.** The
  server may change them; the settings show them.
- **A development-only switch for fake models** (`--dev-fake-ai`): the server's AI answers from fake models and
  nothing reaches a service, so the command, the dashboard, the connector and the apps can be tried with a made-up
  key. The server refuses it unless it listens on 127.0.0.1, ::1 or localhost and `NODE_ENV` isn't `production`, and
  its start line says "DEVELOPMENT ONLY". Demo mode uses fake models too. The switch can't make the fake fail.
- **Saving AI settings answers after their test** (the coordinator's requirement). `PATCH /v1/ai` stores new
  credentials or a model, tests them at once, and only then answers with the settings, so a status read straight
  after says how the test went. The contract says so since the review's decisions.
- **The key is scrubbed from anything a service said** (the coordinator's requirement). The server's `scrubKey`
  replaces the key, its prefixes and suffixes of four characters or more, any eight characters of it in a row and
  key-shaped words, and cuts to 300 characters, both where the service's words are read and before the status is
  stored; a refused key is always the server's own sentence. The connector shows no `detail` at all. The command and
  the dashboard also replace the key a person typed in anything they print about that request. Why: anyone may read
  the status, agents included. Since the review's decisions the key written another way (base64, hexadecimal, spaced
  out) is caught too (below).
- **Consent is to a service.** Turning an inbox's AI on in the dashboard carries the service the page showed, and is
  refused if the settings moved meanwhile; the command asks after printing the words, and needs `--yes` without a
  terminal. Why: the contract's "what leaves the server and to whom" must be what the person saw.

## 2026-11-17, the coordinator's decisions after the review of the fifth revision

The coordinator decided the review's findings; one engineer carried them through `core/`, the contract, the server,
the command, the connector and the dashboard (not the Mac app). The contract has the details.

- **Nothing more may leave than the person was told.** A summary request carries no address: a nameless sender is
  "someone", a name holding an address counts as none, and addresses in the subject and text become `[address]`.
  Categorizing still sends the newest incoming message's sender name and address, as people are told. A blocked
  sender's mail never goes to a model, in either job. Why: the words shown before AI is turned on are the person's
  consent, so the requests must match them exactly. **Our reading:** "never carries an address" covers the text too,
  not only the sender's label; the blocked sender's subject is left out with their message (the oldest other
  message's subject is sent).
- **The words are written once,** in `core/src/ai-words.ts`, from the same limits and field names the server builds
  its requests with; the command and the dashboard show them, and a server test fails if a request carries a field
  they don't name. Why: three copies had already drifted from the code.
- **The key never shows, in any form:** written out, base64, hexadecimal, spaced out or broken up. The server works on
  letters and digits only, so base64's two alphabets, its padding and separators between characters all match the
  same forms. Why: anyone may read the AI's status, agents included.
- **A model's `otp` alone never lifts the screening gate.** For a sender who isn't let in, the server also checks that
  the mail is machine-sent and holds a code (six to eight digits, or two groups of three or four, within 80
  characters of "code", "passcode", "one-time", "otp", "verification" or "verify"); otherwise the thread stays
  screened in `otp`. Conservative on purpose: a missed code waits in Screening, where the person sees it. A person's
  `otp` lifts it as before. **Our reading:** only the server's AI is checked; agents' `otp` is a new question (63).
- **A rule the person taught always applies,** whatever the trust: it is the person's own instruction. Trust governs
  outside agents and agents' rules. **Our reading:** "always applies" includes `trash` and `block_sender` in such a
  rule; its records stay silent in an `act_silently` inbox, as rules' records were, and are otherwise shown with undo.
- **Recent filed history isn't done on a new server:** within the history days, a filed thread is in its category's
  list. Why: losing the server shouldn't empty every category list.
- **A blocked sender writing into a thread changes nothing a person sees:** not its place, snippet, unread state,
  participants, count or messages, and no wait ends. **Our reading:** worked out from the sender's standing when the
  thread is refreshed, without a column; the message stays in the store and at the provider.
- **What lives only on the server** now names senders' standing. **Our reading:** the decision's "whether a non-filed
  thread is done" was read as "whether a thread in a filed category is done": a non-filed thread's done is its archive
  state at the provider, while a filed thread's isn't kept there (a new server guesses it from the history days).
- **The interfaces' additions:** `Thread.sender` (the oldest incoming message's sender, lower case; none for a thread of
  the mailbox's own mail only), `Thread.categorizedByActor` (the AI with its model, the rule, the agent with its name,
  the person's device; none for the mailbox), and the category list for several categories at once (REST joins them
  with commas; cursors run across them). `categorizedByActor` needed a column (migration `0005`); older decisions have
  none.
- **Removing the AI key is `credentials: null`** and stops all processing (it "turned AI off for every inbox" until the
  switch was removed); the server remembers the service
  and the chosen models. `usual-mail ai remove` and the dashboard's AI page offer it and ask first.
- **On the gateway, categorizing needs a decision model.** The server tells a model's kind from the gateway's own
  model list (`getAvailableModels`) when it tests, and fails the test with `model_not_found` and words that say why,
  before sending anything to that model. No new status state, so clients need no change for it.
- **A command whose reader has gone exits quietly,** with 0, at the first failed write.

## 2026-11-17, Sign in with Google for Gmail

The owner asked for Gmail to be connected by signing in with Google, with one Google client they own, the server on
their Mac first. The coordinator decided the shape (the client is the host's; a person-only start; a callback without
a token checked against the `state`; an outcome route; reconnecting in place; tokens sealed and revoked on removal;
AI off, overtaken the same day by the removal of the per-inbox switch; the safety list; the command and the dashboard). One engineer built it in `core/`, the contract, the server,
mail's fake, the command and the dashboard, against a fake of Google's endpoints only. The contract has the details
([sync and providers](../contract-sync.md#connecting-gmail-by-signing-in-with-google)); Google's documentation was
read on 2026-11-17 ([the host's guide](../google-setup.md) lists it).

- **A Web application client, with an exact redirect address.** Google's web-server documentation lets a web client
  register `http://127.0.0.1:<port>/…` ("localhost IP addresses" are exempt from the HTTPS and raw-IP rules), the
  redirect must match exactly, and the same kind of client takes an HTTPS address when the server is hosted later.
  A Desktop app client's loopback flow takes any port and its documentation doesn't say whether a path may follow, so
  it is refused (the file and the command say to create a web client). The client used on the
  maintainer's own server (web, a loopback redirect, the one scope, External in Testing) fits this exactly.
- **One scope, `gmail.modify`.** The server reads, labels, moves and sends mail; it never deletes for good, so not
  `https://mail.google.com/`. The address comes from `users.getProfile`, which `gmail.modify` allows (Google's
  reference), so no `email` or `openid` scope and no second consent item.
- **`access_type=offline` and `prompt=consent`,** because Google gives a refresh token only on the first authorization
  otherwise, and a reconnect needs a new one. A new inbox also asks for `select_account` (people with many inboxes have
  several Google accounts signed in); a reconnect sends `login_hint` with the inbox's address. No
  `include_granted_scopes`.
- **PKCE (S256) with the web client's secret.** Google documents PKCE for installed apps and lists `S256` in its
  discovery document; its web-server page doesn't mention PKCE. Sending both is what widely used libraries do with web
  clients. **Unverified against Google.**
- **The server's own address comes from its settings, never a request:** `--public-url` / `USUAL_MAIL_PUBLIC_URL` (an
  origin, HTTPS unless loopback), else the loopback address and port it listens on; a server on every address without
  it has none, and sign-in is off. `usual-mail init --mode docker` passes `http://127.0.0.1:<port>` to the container,
  whose port it publishes there.
- **The host's client from the environment or `<data-dir>/google-client.json`,** the JSON Google's console downloads
  for a web client, as it is. Read when needed (no restart); refused when other users can read it; its contents and
  the secret never printed or logged. Environment first, like every other setting. The file was first written only by
  the host (the command, or by hand); since 2026-11-21 a person's own paired device may write it through a route
  (below).
- **The inbox keeps only the client's id and the refresh token,** sealed; the host's secret is added when the mailbox
  is opened. So the host can change the secret, the secret isn't copied into every inbox, and an inbox whose client
  the host replaced says so instead of failing obscurely.
- **Sign-ins live in memory,** state kept as its SHA-256, the verifier dropped once it ends; a restart ends those
  waiting. Ten minutes to come back; the outcome readable for an hour, only by the device that started it.
- **The page Google returns to is the server's, under `/v1`** (`GET /v1/google/callback`, the one route that answers
  with HTML), so it works without the dashboard and no interface can shadow it. It shows only the server's words.
- **Revoke on removal, only what the server obtained.** Google's documentation says revoking ends the account's whole
  grant to the client's project; so a token given by hand isn't revoked (it may be used elsewhere), reconnecting
  doesn't revoke the old token (it would end the new one), and a failed sign-in drops its tokens unrevoked (it could
  end a working inbox of that account).
- **The dashboard links to Google instead of redirecting a form there,** because its strict `form-action 'self'` would
  block a form whose answer redirects off-site; the link opens in a new tab.
- **A development-only switch, `--dev-fake-google <url>`,** refused off loopback and in production like
  `--dev-fake-ai`, sends Google's sign-in, token, revocation and Gmail addresses to a fake; only those Google origins
  are rewritten, anything else is refused.

## 2026-11-17, the owner removes the per-inbox AI switch

The owner's words: "we dont have any feature to turn off ai, everything is heavily integrated with AI so remove
this". It reverses the decision of the same morning's amendment ("sending an inbox's mail to the AI is an explicit
choice per inbox", from the fifth revision's risk review, 2026-11-17). The coordinator decided how; one engineer
carried it through `core/`, the contract, the sample, the server, the command, the dashboard and the connector (not
the Mac app), test-first.

- **No `aiProcessing`.** Once AI credentials are set, every inbox's mail is processed, those connected later too;
  without credentials, none. Connecting or changing an inbox with the field is `invalid`.
- **Consent moves to the key.** Saving a key, or one for another service, is the person's yes to every inbox's mail,
  now and later, going to that service. The words of what is sent and to whom (`aiDisclosure`, reworked to need no
  inbox name and to say "every inbox connected to this server, now and later") are shown before the key is saved:
  `usual-mail ai set` shows them and asks (`--yes` without a terminal), the dashboard shows them above the key field,
  for the service its page shows. Another service no longer turns anything off; it shows its words again.
- **What the switch brought is gone:** `usual-mail inbox ai on|off`, `inbox add --ai/--no-ai` and its question, the
  AI column of `inbox list`, the dashboard's per-inbox switch and its consent check, the `conflict` for turning AI on
  without credentials, `doctor`'s "AI off for every inbox", the triage queue's "inbox with AI off", the rule that
  changing or removing credentials turns inboxes off, and `aiProcessing` in the connector's `list_inboxes`.
- **What protects the person stays:** the key never leaves the server in any form; a blocked sender's mail, spam,
  done and trashed threads are never sent; a one-time code is never summarized; no address in a summary request; mail
  is data to the model; pause stops all processing; history days limit what old mail costs; removing the key stops it.
- **The words are served** (the coordinator's addition, for the Mac app, which can't import core's TypeScript):
  `GET /v1/ai/disclosure?gateway=vercel|provider=openai|provider=anthropic`, person only, no key needed, answers
  `AiDisclosure` built by core's `aiDisclosure` with the models that would do each job there and the history days.
  The command and the dashboard show what it answers, so the three can't differ. **Our reading:** "the models that
  would do each job" are the person's chosen models only for the service already set (a chosen model belongs to its
  service); another service's are its defaults. The type keeps its name, `AiDisclosure`.
- **Our reading:** the database column stays, unused (dropping it needs a migration for nothing); an inbox that had AI
  off is processed from then on like the others, its waiting threads as history within the history days. `pending`
  is 0 without credentials. The sample's personal inbox had AI off, so its three waiting threads now count:
  `aiStatus.pending` went from 1 to 4.

## 2026-11-17, after the owner's first run against Gmail

The owner signed in with Google on their own server; it worked, and four things about the server and the command were
wrong or awkward. The coordinator decided them; one engineer carried them through `core/`, the contract, the server,
mail, the command, the guides and the Docker files (not the Mac app), test-first. The contract has the details.

- **A client file that doesn't list the server's redirect address is a hint, not a prediction.** The file is the
  client as it was when it was downloaded; Google's own list is what counts. The server's log, `usual-mail google`,
  `google set` and `doctor` say the same words: the file doesn't list it, it may be older than a change made at
  Google, check the address there if Google refuses a sign-in. **Our reading:** in `doctor` it is a note on the `ok`
  check, not a `warn`, since nothing is wrong while sign-ins work and the note would otherwise stay forever.
- **The first sync's days are a setting of the server that persists.** **Our reading:** kept in the data directory,
  `<data-dir>/settings.json` (`syncDays`), because the data directory is what Node mode's folder and Docker's volume
  both are, so every start finds it whatever runs the server; not in the command's own settings, which a server run
  with Compose or by hand never sees. `USUAL_MAIL_SYNC_DAYS` still wins (with Compose, it is the way to set it). The
  server reads it at its start, like its other settings, and `usual-mail sync-days` restarts a server `init` set up so a
  change applies at once; reading it while running would need the AI's `maxHistoryDays` and every open provider to
  change under the server. `init` asks for it the first time (its default is the variable's value when set, so a
  number given that way is saved, not lost at the next start). `status` and `doctor` show the server's own number
  (`AiSettings.maxHistoryDays`, the same reach), and `doctor` warns when it differs from the saved one. No new route
  or field: the shapes didn't change.
- **A smaller window takes effect for a first sync in progress; a larger one only for inboxes connected afterwards.**
  Mail older than the new window is no longer fetched; nothing fetched is deleted. **Our reading:** a provider's rule
  (it owns the cursor): opened with a later `since`, a first sync still being sent narrows to it; an earlier `since`
  never widens it; the window the first sync began with stays in the cursor for a listing after the provider loses its
  place, so a later reset can't drop what was fetched beyond the new window. Gmail marks its first sync's listing in the
  cursor (`f`); cursors from before the mark can't be told from a carried history batch, so they aren't narrowed (a
  known issue). Fetching more for an existing inbox would be a new first sync: the command says so where the number is
  changed, and that only removing and connecting the inbox again starts one.
- **The owner's code is printed once, when it is made.** A later start while it is still valid keeps it (the Node host
  hands the service the code from its file; the service checks it is a valid, unused owner's code) and says one
  waits, until when and where the file is. **Our reading:** without the file the server can't tell the code (it keeps
  only a hash), so it makes a new one and prints that, as before; a code is never printed twice. The guide, the
  command's words and `compose.yaml` point to the file, never to the log.

## 2026-11-18, the owner's decisions after the first days of real mail

Found on the owner's server: most recent threads the AI had processed had no summary; hundreds of older threads in
Home were never processed, and the status said nothing waited (see [known-issues.md](known-issues.md)).

- **History is all synced mail** (the owner: "Yes, all synced mail"). The AI works through every synced thread that
  needs work and isn't done, newest first, new mail still ahead of history, whatever `historyDays` said. The first
  sync's threads filed under a category are not done in the whole synced window. Why: the person sees all of it in
  Home and the lists, and an unsummarized `unknown` row tells them nothing. `historyDays`, `maxHistoryDays` and
  `beyondHistory` stayed in the JSON for a day, reading the truth, with any other `historyDays` refused; then they
  left the contract (below).
- **Archived mail stays unprocessed** (the owner: "No, skip archived"). Done threads aren't sorted or summarized
  unless new mail brings them back. Why: categorizing them would write labels to archived threads at the provider.
- **A summary aims for one short line; the apps show at most two and cut there** (the owner: "the ellipsis should be 2
  lines but ai should aim for 1 line summery"). The request asks for one plain sentence under about 100 characters; a
  target, not a check.
- **An over-long summary is shortened, never dropped** (the coordinator, from the owner's "rather a shortened summary
  than none"): the safety checks run on the whole answer first and still drop it; then it is cut to its first
  sentence or the last whole word under 200 characters, with "…", and checked again. **Naming the sender no longer
  drops a summary**: a repeated name costs a few characters, a dropped summary costs the row. Nothing about what is
  sent to a model changed.
- **A dropped summary is logged** with the thread's id and a reason code only, so the next "why no summary?" has an
  answer without reading mail. **Summaries earlier builds dropped are asked for again** once, by migration 0006.

## 2026-11-18, the history setting removed, the first sync's window a person's, and the AI's usage kept

The coordinator's decisions (parts B and C of the day's work), the second from the owner's request "add an AI usage
section in settings":

- **No history setting anywhere.** `historyDays`, `maxHistoryDays` and `beyondHistory` left core, the server, the
  command, the dashboard and the connector; the status keeps `pending`. A patch naming `historyDays` is `invalid` like
  any unknown field. Why: nothing may say or offer something untrue about what the AI works through, and the first
  sync's window already decides how much old mail there is.
- **`usual-mail ai history` is retired, not just removed:** it prints one line pointing to `usual-mail sync-days` and
  exits 2, so a person or a script that used it learns what replaced it instead of reading "Unknown command".
- **A person reads and sets the first sync's window** (`GET`/`PATCH /v1/first-sync`), kept in settings.json where the
  command keeps it, and applied at once: a smaller window narrows a first sync still running from its next sync (the
  engine opens the provider again); a larger one changes only inboxes connected afterwards. **Not built:** widening an
  inbox already connected (it would be a new first sync), and 0 days; both are for the owner (contract question 71).
  Refused (`conflict`) while `USUAL_MAIL_SYNC_DAYS` sets it, since the variable would win at the next start anyway.
- **Usage is kept by the UTC hour, job and model,** not per request: requests, failures, tokens and cost as the
  service reported them, with how many requests reported each, so a client can tell "not reported" (null) and "at
  least" (partial) from a number. Periods are cut at the person's midnight (`?tz=`), within the hour. 90 days kept.
  No backfill: the records can't give it. Every request counts, the key's tests too, not marked apart (simplest; they
  are requests to the person's account). A cost is null today, since no service puts one in its answer (contract
  question 72). No event, no command, no dashboard page (ideas).

## 2026-11-18, the gateway's cost in the AI's usage

The coordinator's answers (contract questions 71 to 73) and decisions for the cost:

- **An agent's token on the person-only routes gets `needs_person`** (403), as on the other person-only AI routes.
- **The onboarding window step moves before connecting Gmail,** with 7 and 30 days; 0 ("only new mail") is with the
  owner and not built.
- **The cost is looked up at Vercel's AI Gateway** by the generation id its answer carries, apart from the mail work:
  the amount is the gateway's own `totalCost` in US dollars, never an estimate. First 10 seconds after the request,
  then after 1, 5, 30 and 120 minutes, then given up (the documentation says nothing of when a lookup can answer, so
  the pauses grow). **The ids waiting are kept in the store**, since a restart would otherwise lose those costs for
  good and the owner restarts often; they hold the id, hour, job and model only. Lookups aren't requests in the usage,
  wait while the AI may not send, and are dropped without a key or with a service that has none. Only the documented
  place for the id is read, so a categorize (the Decisions API) likely stays "not reported" until the real gateway
  shows otherwise.

## 2026-11-18, pictures from the web and the reviews that followed

In [decisions-pictures.md](decisions-pictures.md): pictures through the server, the three security reviews, "outgoing"
from evidence only, and which stored message new mail is.

## 2026-11-18, notifications in Home

**Replaced on 2026-11-19** (notifications out of Home again, below); kept for the record. The owner's decision:
"notifications should go to Home not in receipts". The coordinator's decisions with it, as built (test-first):

- **Home is `conversation`, `notification` and `unknown`** (core's `HOME_CATEGORIES`), not screened, done, stacked or
  waiting, as before otherwise. Nothing else about notifications changes: their category, their category list, the
  AI's rules.
- **At the provider they stay as they were,** out of the inbox under `Usual Mail/Notifications`: no write-back
  changes and no moves in anyone's mailbox. So the rule of 2026-11-17 above narrows to "a conversation or undecided
  thread is in the provider's inbox exactly when it shows in Home". Done on a notification changes nothing there, as
  for any filed category (contract-sync.md's table already says so: "A filed category, whatever its state").

## 2026-11-20, more inbox icons

The owner's request: "in the settings user should be able to change the icon for the inboxes" (the Mac app builds the
picker). The coordinator's decision: eight more names after the six, in this order: `plane`, `wallet`, `family`,
`rocket`, `school`, `heart`, `star`, `leaf` (core's `INBOX_ICONS`, fourteen in all). Everything that validates or lists
them follows from core (the server's `PATCH /v1/inboxes/:id` and Google sign-in, the command's help and check, the
dashboard's picker); the design system gained the eight Hugeicons free icons (Airplane01, Wallet01, UserGroup, Rocket01,
School01, Favourite, Star, Leaf01) for the web sprite and the Swift catalog. A new inbox's default stays person,
building and briefcase in turn. Existing sample inboxes are unchanged.

## 2026-11-19, notifications out of Home again

The owner's decision, typed in the Mac app session: "since we have a notification tab now, the Home should [not] show
notifications anymore". It replaces the decision of 2026-11-18 above. As built (test-first):

- **Home is `conversation` and `unknown` again** (core's `HOME_CATEGORIES`), not screened, done, stacked or waiting.
  Notifications live only in their tab and category list; done works from there as before.
- **Nothing moves at the provider:** the write-back and placement rule (`inInboxCategory`) never changed with either
  decision; notifications stay out of the inbox under `Usual Mail/Notifications`.
- On a real store the first start of this build drops Home's count by the notifications that aren't done; nothing
  changes in Gmail. The sample's Home is 5; the connector says so in its words.

## 2026-11-19, the sorting words, what a model reads, and asking the AI again

In [decisions-ai.md](decisions-ai.md): the owner's request and the audit's numbers, the new words and tie-break, the
text a model reads, the AI's own filings asked again, and payment details for receipts and invoices.

## 2026-11-19, sender pictures

The owner's request: "also now we should also render the sender avatars properly for the emails everywhere". A design
was researched first (sources and the reasoning in [server-avatars.md](server-avatars.md) and the contract's
[page](../contract-avatars.md)); the coordinator's seven decisions the same day, as built:

1. **A logo needs the mailbox provider's own proof and a let-in sender:** Gmail's own checker proved the From domain
   (an aligned DMARC pass, or an aligned DKIM pass when the domain has no DMARC result), the sender is let in and not
   blocked, the thread isn't screened, and the domain is never a mailbox provider's anyone can sign up to. A real logo
   beside a forged sender would lend trust; this is what keeps a forged From from borrowing one.
2. **Fetched when the first qualifying mail from a domain arrives, after a random delay of up to six hours, one domain
   at a time; no timed refresh**: a site is looked at again only when new mail comes and the last look is more than 30
   days old. What this tells the domain's owner is written in the contract.
3. **ICO is accepted and turned into PNG on the sender-picture path only**, by the server's own writer.
4. **No BIMI** (adoption is small, and it needs SVG, which the server never shows, and certificate checks).
5. **People get initials in the first build.** Google contacts' photos may come later as an opt-in (a second Google
   permission); Gravatar is never on by default ([improvement-ideas.md](improvement-ideas.md)).
6. **No logo or favicon service**: each would learn the person's senders.
7. **The authentication result is backfilled** at each start for threads that aren't done from the last 90 days (their
   sender's oldest and newest message), with its outcome logged as counts only.

Also decided: the server serves the original bytes with `size` and `fit` and never re-encodes (no image decoder in the
server); mail that reached Gmail by its POP import or an IMAP upload may carry a sender's `mx.google.com` result on top,
and is not guarded (a `Received`-line guard would be brittle; the forged address must already be let in), only counted
by the backfill; without the Public Suffix List the server shows no picture and fetches nothing, with one log line,
rather than guessing registrable domains.

After the independent security review the same day (the coordinator's word): Gmail's header is read strictly (a quote
inside a comment, a quoted value with `;`, `(` or `)`, or an envelope property on a DKIM or DMARC result makes it
unreadable), since Gmail writes the envelope sender into it; two or more results from Gmail's own checker prove nothing
(forwarded mail loses its picture, accepted); `live.*`, Zoho, mail.com's whole published list and platforms whose
customers share the platform's domain are no brand; a caller limited to some inboxes gets a picture only when proved
mail from its domain is in one of them.

Later the same day the owner approved downloading the Public Suffix List ("Yes, download it", to the coordinator's
question naming the file, its source and size): it ships at a pinned commit, so sender pictures are on from that build.


## 2026-11-20, blocked senders in Settings

The owner's request: "showing the blocked senders in a separate tab and unblock them or see how many emials they've
sent so far which has been blocked". The Mac app couldn't build it: blocking and allowing were only thread actions,
with no list of senders, no unblock by sender and no count. The coordinator's decisions, as built (test-first):

- **A person-only list** (`GET /v1/senders?state=blocked`) with who blocked each sender, since when, the count of
  their messages since and their newest mail; **a person-only unblock by address** (`POST /v1/senders/allow`) that is
  exactly `allow_sender` on one of their threads; **`sender.changed`** so the tab follows changes made elsewhere.
- **The count is a query over stored messages, not a counter:** blocked mail is stored like any other, so it can be
  counted honestly; spam and trash at the provider are never taken in and aren't counted. No migration.
- **Unblocking brings nothing back** (it is what `allow_sender` always did); the behaviour is described to the app in
  words, not changed. Proposed, not built: an option on the unblock to also bring back what the block made done.
- **Not built:** a `usual-mail senders blocked` command; any agent access; listing let-in senders.

Choices made in building it: `blockedAt` is when the block in force now was applied (after an undone unblock, the
undo's time, so mail let in meanwhile isn't counted as blocked), `blockedBy` the newest applied block record's actor;
a message counts when its date is after the block; the unblock is recorded on the sender's newest thread that isn't
trashed or gone, and a sender with none left is let in without a record rather than staying blocked for good; the
event also goes out when blocked mail arrives, so the count on screen moves; the sample gained three blocked senders
(three done threads, seven messages, three block records, one an agent's approved proposal).

## 2026-11-20: search

- **Search is SQLite FTS5 in the store**, one row per thread, unicode61 with diacritics removed and prefix indexes, kept
  right by thread versions and checked before every search; ranked by a subject-and-sender tier, then bm25 over the
  square root of age in 14-day units; excerpts as runs of plain text, never markup. Why each: [server-search.md](server-search.md).
- **Older mail stays in the mailbox until a person opens it:** remote results aren't stored; opening one conversation
  places it as the mailbox has it (archived is done, so the AI leaves it), writes nothing back and doesn't let its
  sender in. Person only, so an agent never makes the server query a mailbox.
- **A waiting thread is out of sight until it comes back** (the owner's decision): only the waiting list and search hold
  it; category lists and their counts leave it out, as Home did.

## 2026-11-20: a search asked in a sentence (step 3)

The owner's "do step 1 and 2 first and then step 3"; the coordinator's brief. The contract's
[section](../contract-search.md#asking-in-a-sentence).

- **One job, one answer: the route doesn't search.** `POST /v1/search/ask` answers what was understood and the client
  then calls the normal search. Running the search in the same call would save a round trip (a few milliseconds beside
  a model's second or two), but the person would be shown mail picked by a reading they hadn't seen; with two calls
  the chips come first and every correction is an ordinary search, and the search route stays the one place mail is
  found.
- **Always an answer that can be searched.** The AI not set up, paused, waiting after a failure, failing now, too
  slow, or answering nothing usable is a `200` with the sentence as typed and the AI's state in `ai`, not an error: a
  client has one path (run the search with what came back), and says why the AI didn't help only if it wants to.
  Errors are for the caller's own mistakes (`invalid`, `not_found`, `needs_person`) and `rate_limited`.
- **Counted as its own job in the usage, `ask`, not under `summarize`.** It uses the summarize job's model, but a
  person who looks at what the AI cost should see what asking cost apart from what mail cost. The name exists in the
  usage only (`AiUsageJob`); `AiJob` stays the two jobs with a model setting, so no client gains a third model picker
  and a refused request still names `summarize` as the job whose model failed. Read in the Mac app's source before
  choosing (read-only): `AiJob` is an open enum with `unknown(String)`, and its usage table lists the jobs it knows
  first, then any other, capitalized, so "Ask" shows without a change; the dashboard and the command show no usage.
- **Words, not meanings: everything textual must be in the sentence.** `from`, `to`, `subject`, the text and the
  excluded words keep only words the sentence itself holds (case and accents aside), so a model can't turn "from
  Cloudbase" into an address or a domain it guessed, nor add a word that narrows the search unseen. The cost: a model
  that helpfully writes a domain gets it cut back to the name. `from` then matches as a search matches a name today.
- **Dates are the model's, checked for possibility.** It is given today's date and weekday in the person's time zone
  and asked for YYYY-MM-DD; the server keeps a real day, in order, not ahead of today, between 1990 and a year on. It
  doesn't recompute "last month" itself (seven languages of phrases would be a second parser; improvement-ideas.md).
- **The sentence may be 200 characters, the same as `q`,** so the fallback is exactly the sentence typed, and a client
  can put it in the same field.
- **Never sent twice, 15 seconds, 10 a minute per device.** A person is waiting, so no retry (`ObjectRequest.retries:
  0`, which the SDK access passes as `maxRetries`); the server's own wait is shorter than a mail request's 60 seconds
  and a wait that runs out doesn't touch the AI's status (the service may be fine, only slow), though it counts as a
  failed request in the usage. A refusal does change the status, as any request's does, and an answer clears a
  failure, as any answer does. The rate limit counts only sentences about to be sent.
- **An amount stays in the text** (the coordinator's decision): there is no amount filter, and its words usually find
  nothing, which the chips show.
- **The disclosure gained a fourth item, "To search by a sentence",** before "Never": it is a new thing sent, though
  only when asked for and never mail. The lead ("For each thread the AI processes, the server sends:") was left as it
  is; the item's own words say when.
- **The fake models answer by rule** (`ai/fake-ask.ts`): a few English turns of phrase, so demo mode and the
  development switch show the feature and tests can be exact. It reads only what a real model is sent.

## 2026-11-21: the host's Google client from a person's device, and the set-up served

**The owner's decision:** a person's own paired device may give the server its Google client through a route
(`PUT /v1/google/client`), reversing "never through a route" of 2026-11-17. Why: the Mac app is sandboxed and can't
write into the server's data folder, and a server on Cloudflare (being designed) has no data folder at all. What stays:
no route, event or log returns or prints the secret. The coordinator asked for the route, a set-up route serving the
browser agent's prompt and the manual steps from core, and `usual-mail google prompt`. The contract's
[section](../contract-sync.md#connecting-gmail-by-signing-in-with-google).

- **Who:** a person's device only, by the same rule as starting a sign-in (`auth: "person"` in core's route table,
  `needs_person` for an agent, and `requirePerson` in the service). No new mechanism.
- **The body is Google's file as it is,** read as text and kept byte for byte, as `google set --file` copies it; so
  `replace` is a query flag (`?replace=true`), not a field that would change the file. One reading of the file for the
  server's data directory, the route and the command: core's `readGoogleClientFile` (problems as codes, each surface
  its own words). **Our reading:** the command now also refuses a client id or secret of spaces, which the server
  already refused.
- **Replacing needs `replace=true`,** because another client stops every inbox connected by signing in with Google
  until each signs in again. **What counts** (corrected after the independent review the same day, which found that
  counting only what `client()` gives let a refused file and its inboxes be overwritten unasked): a client file saved,
  whether the server uses it or refuses it (others can read it, a Desktop client's, not JSON: it may still hold the
  client inboxes were connected with), read through the seam's `savedClient()`; and, with no file, inboxes connected by
  signing in with Google under another client id than the one given (their `connection.clientId`; for example
  connected while the environment gave the client, which the host then removed). `replaced` is true whenever either
  was there. The same client id gets its own words (re-downloaded, or a new secret: inboxes keep working) but still
  needs the flag; giving the very client stranded inboxes were connected with needs no flag, since it strands nobody.
  So an app that sees `missing: ["client"]` may still be asked to confirm; `GoogleClientState.note` (optional, added
  the same day) says why beforehand. **Differs from the command:** `usual-mail google set` replaces a file already
  there without asking; left as it is (improvement-ideas.md).
- **The client id is returned** (in the answer and in `GET /v1/google/setup`'s `client`), never the secret: an inbox's
  `connection` already shows it to anyone who may see the inbox, and the command prints it. It isn't added to
  `GET /v1/info`, which needs no token.
- **The order of refusals:** on this route the token is checked before any of the body is read (`unauthorized`, also
  for a body too large; `needs_person`), then the body is read up to 16,384 bytes only: refused at once when
  Content-Length says more, otherwise as soon as more has arrived (since 2026-11-21 every route checks its token before
  its own limit: known-issues.md, Fixed). Then the environment (it
  wins, so a saved file would do nothing) and a host with no place to keep it (demo mode) answer `conflict` before the
  file is looked at; then the size again, the flag and the file (`invalid`); the replace check last, so an app asks to
  replace only for a file the server would take. The log gets one line, without the id.
- **Through the host's seam:** `GoogleOptions.saveClient`, `savedClient` and `clientFromEnvironment`; Node writes the
  file owner-only through a temporary file beside it, created exclusively (`wx`) under a random name with mode 0600 from
  creation, so a file or link planted at that name is never written through, and removed if the write or the rename
  fails (`saveGoogleClientFile`; the command's `writeOwnerOnly` does the same). A Cloudflare host would implement the
  same three. Nothing outside `server/src/node/` imports `node:`.
- **Not `MailService` methods** (`calls: "-"`, like the attachment, picture and callback routes): adding them to the
  interface would break the dashboard's and the connector's test doubles, which this change didn't touch, and neither
  mounted interface offers them. When the dashboard offers the upload, move them onto `MailService`.
- **The prompt lives in core as words** (`googleSetupPrompt(redirect)`), and `docs/google-setup-agent.md` keeps its
  `[FILL IN: …]` redirect blank; core's `npm run check` compares the guide's code block with the prompt given that
  blank, so the two can't drift. The steps follow `docs/google-setup.md` section 1 (seven steps, the console pages the
  prompt names); the client's suggested name, "Usual Mail server", comes from the prompt, as section 1 names none.
- **Words for a person, not a caller** (the coordinator, after the apps were built on the routes): the replace cases'
  `conflict` words end "Confirm to replace it." (or "Confirm to save it anyway." for inboxes under another client),
  naming no flag, because the apps show them above their own "Replace it" button; the contract documents
  `?replace=true` for callers. The prompt's report ends with "my next step: give that file to my Usual Mail server, in
  the Usual Mail app's Google set-up or with usual-mail google set --file …", right for the app and the command.
- **Words that fit the address:** the served client step keeps section 1's "http, not https" for an http (loopback)
  address and names the host as written, since 127.0.0.1 and localhost differ to Google; an https address is told
  only to copy it as it is. The prompt's redirect line (core and the guide together) says the same without naming one
  host as the right one.
- **No address, no prompt:** a server listening on every address without `--public-url` answers `noAddress` (what the
  host sets) instead of a prompt or steps with a hole in them; the client can still be given.

## 2026-11-21: no statement over 100 bound parameters, no LIKE pattern from input (the Cloudflare host's first step)

Step 1 of [server-cloudflare.md](server-cloudflare.md)'s build plan, on Node, in the shared code; the LIKE part followed
the same day's review.

- **No statement binds more than 100 parameters,** the most a Durable Object's SQLite (and D1) takes, on both hosts,
  so the shared code runs unchanged on Cloudflare.
- **A list that comes from stored data or a caller is one JSON parameter:** `inList` (`server/src/db/params.ts`) writes
  `IN (SELECT value FROM json_each(?))`. Text only: `json_each` gives a JSON number back as a number, which no TEXT
  column's value equals. `inArray` stays only for lists of the code's own (an enum, deduplicated when a caller gives
  it) or capped well below the limit (a brief's 50 highlights, a write-back's one record). A remote search's hits use
  `inList` too, whatever page size a provider answers with. Removing an inbox picks its attachments by a subquery.
- **A multi-row insert goes in chunks inside one batch:** `insertChunks` keeps rows × the table's columns, plus what
  the statement binds besides, within 100 (`search_people`: 14 rows; senders let in: 19, the upsert binds 2); every
  chunk's statement goes in the same `runBatch`, so the rows still land together.
- **No LIKE or GLOB with a pattern from input or stored data:** a Durable Object refuses a pattern over 50 bytes (one
  around a word of 16 CJK characters already is), and only when a row is compared. `contains` and `endsWith` (`server/src/db/match.ts`)
  write `instr(lower(x), lower(?)) > 0` and `substr(lower(x), -length(?)) = lower(?)`, which match as the escaped
  LIKE did: literally (`%` and `_` are characters), ASCII letters in either case and no others (SQLite's `lower`, like
  its LIKE, folds ASCII only). Used by search's `from:`/`to:` and the people it finds, and sender pictures' domain
  suffixes. LIKE stays for constant patterns of the code's own (`src/db/upgrade.ts`). A leading wildcard never used an
  index, and the plans are unchanged.
- **Plans kept on Node:** every list statement the suite sends was compared with `EXPLAIN QUERY PLAN` before and
  after: the same index lookups, a few with a sort the literal list avoided. One would have changed: a search page's
  excerpts, where SQLite ran the MATCH over the whole index; the page's JSON list now drives a `CROSS JOIN`, so each
  thread's index row is read by rowid as before. `server/test/list-plans.ts` fails a list statement whose plan scans
  any table but the JSON list itself, the full-text index (`search_index`, which a MATCH reads) and `inboxes` (a
  handful of rows).
- **Every test enforces both limits:** `npm test` and `npm run check` load `server/test/parameters.ts` (`--import`),
  which wraps libSQL's local client and fails any statement over 100 parameters or with a LIKE or GLOB pattern over 50
  bytes (bound or written; one joined in SQL counts as too long), also one whose error a background job caught. Not a
  Drizzle logger: Drizzle's `batch` never calls it.
- **Migrations are replayed as Cloudflare runs them:** `server/test/migration-replay.test.ts`, with foreign keys on,
  over rows in every table: each file committed on its own (every file meets rows), and a store's pending files in one
  transaction as the durable-sqlite migrator runs them, a later file's failure undoing the earlier ones
  (known-issues.md).

## 2026-11-21: Gmail's large messages (the Cloudflare host's mail step)

Built in `mail/`, revised after an independent review the same day; details in [mail-gmail-large.md](mail-gmail-large.md).

- **The size check is a host's choice, off on Node.** `largeMessageBytes` defaults to `Infinity`: every message raw,
  no minimal-form request, exactly as before, since the check adds 20 quota units to every message's 60 (a third
  longer first sync) for memory Node has. The Cloudflare host passes `GMAIL_SMALL_MEMORY`'s 2 MiB.
- **A large message is rebuilt as MIME and read by the raw form's parser,** not converted from Gmail's parts by hand,
  so it matches what the raw form gives by construction; a marker with a random nonce in a left-out part's body names
  Gmail's part, and every multipart gets a boundary of ours.
- **One download budget per message:** `largeMessageBytes` in all, across the text bodies, forwarded messages and
  calendar invites Gmail left out, in the order they come.
- **An attachment is served the way its message was stored:** raw on Node's default; with a limit, the minimal form
  decides raw or the full form, so a position is always read by the same form, and the same decisions, that numbered
  it. A part written empty is never served. Over the limit an attachment costs 100 units (minimal, full,
  `attachments.get`); under it 80 (minimal, raw).
- **Only a failure that may pass fails a sync batch** (`failsTheBatch`: no connection, a broken-off answer, a timeout,
  Gmail's 401, 403, 408, 429, 5xx, a refused token): the server retries the same cursor forever, so anything
  deterministic leaves the part out or makes the message the usual note instead.
- **One gate for all inboxes where memory is shared:** a host passes the same `createGate(slots)` gate to every Gmail
  provider (the Cloudflare host's one Durable Object syncs every inbox at once); Node keeps a gate of 4 per provider.

## 2026-11-22: no U+0000 in stored text

- **U+0000 is taken out where text comes in:** mail's parser removes it from a message's text, HTML and subject, the
  server from a draft's subject and body. It means nothing in mail, SQLite's `length()` stops at it, and libSQL reads a
  stored text back only up to it, so on Node whatever followed was lost. Taken out rather than refused: one stray
  character shouldn't cost a message. Mail stored before keeps its own (known-issues.md).

## 2026-11-23: how far a first sync has got

**The owner decided it on 2026-11-23:** while an inbox's first sync runs, the apps show how far it has got ("Fetching
your mail · 120 of 340") instead of only "connecting" (on a first real run an inbox said only "connecting" for
minutes). The proposal of 2026-11-17 was the starting design; the code changed it where it said
otherwise ([contract-sync.md](../contract-sync.md#sync), "How far a first sync has got"):

- **The provider counts, from its cursor** (`SyncBatch.progress`, as proposed). Gmail keeps how much of its listing it
  sent (`n`), IMAP how much of its "first" backlogs (`fs`), so the count carries on across sync rounds, a restart and an
  evicted Durable Object without the server adding anything up in memory. `total` is sent plus still to send: a smaller
  window or a removed message lowers it, as proposed.
- **Also while a batch runs** (`SyncOptions.onProgress`, not in the proposal). Gmail's quota fetches about one message
  a second, and Node's batch is 200, so batch-end counts alone would have said nothing for the first two and a half
  minutes, much the owner's complaint. Gmail says the total once the window is listed, then after each message. IMAP
  doesn't: its batches are quick.
- **Kept on the inbox's row** (migration 0019), written only when shown, so every shown count raises the version as
  every other change does and the list has it after a restart. Not in memory only: an evicted object would list none
  until its next count.
- **Shown after two seconds, then at most every two** (`FIRST_SYNC_PROGRESS_EVERY_MS`), "at most every few seconds" as
  proposed, and not at all for a first sync quicker than that: a small mailbox goes from `connecting` to `ok` with no
  count and no extra version. No trailing timer: during a first sync the next count is never far off.
- **Gone when the first sync is done, not when the inbox turns `ok`** (the proposal said `ok`). The two come together
  (one version, one event) except when a first sync outlasts one sync's 10,000 rounds, where the status says `ok`
  while it still runs; and it stays while the inbox is paused or needs attention, since the first sync goes on from
  there. Interfaces show it only while the inbox is `connecting` or `ok`.
- **Core owns the words** (`firstSyncWords`, `firstSyncCount`, `FIRST_SYNC_FETCHING`); the command lower-cases them
  in its status column, the Mac app mirrors them (`FirstSyncProgress.words`) and keeps its own "Fetching mail from Ana ·
  120 of 340" in the corner note. The connector gives agents the numbers (`firstSync`) and says so in `list_inboxes`.

The Cloudflare host's own decisions (its address, pairing count and time zone; its limits, start-up and pictures) are
in [decisions-cloudflare.md](decisions-cloudflare.md).

The licence (AGPL-3.0-only, the owner's decision of 2026-11-23), the contributor agreement, the third-party notices and
the checks before the repository goes public are in [decisions-licence.md](decisions-licence.md).

Deploying beyond Cloudflare (the owner's decision of 2026-11-23: Docker with a guide for any VPS, Coolify, then Render
and Railway buttons; home servers later), the image's entry point and the publishing workflow are in
[decisions-deploy.md](decisions-deploy.md).
