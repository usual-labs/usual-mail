# The contract

Every part of Usual Mail fits together through `core/`: the types, the service and provider interfaces, the
REST routes, the events and the sample data. This page says how they behave. The code in `core/src/` is the
source of truth for shapes; this page is the source of truth for behaviour.

Revised on 2026-11-16 after the first four parts were built, on 2026-11-17 after the second round and a review
(the third revision), and again on 2026-11-17 after the third round (the fourth revision, amended after the first
milestone's final review). **The fifth revision (2026-11-17) follows the owner's change of architecture:** the
mailbox is the main database; the server runs its own AI on mail with the person's own AI account; categories
replace piles and screening becomes a gate; Home replaces Now; lists and counts follow; inboxes gain an icon, a
position (and a per-inbox AI switch, since removed). It reverses "the server has no AI inside it"; the connector for outside
agents stays as an option. It was amended the same day after its risks were reviewed: one-time codes are never summarized and never held back by screening, history
defaults to 7 days, and the AI never takes a conversation out of Home by itself. **It was amended again the same day
after its independent review** (the coordinator's decisions): a summary request carries no address and nothing of a
blocked sender's is ever sent to a model, the words a person is shown are core's one copy (`core/src/ai-words.ts`),
the key never shows in any form, a model's `otp` alone never lifts the screening gate, a rule the person taught always
applies, a new server reads recent filed mail as not done, a blocked sender writing into a thread changes nothing a
person sees, and threads gained `sender` and `categorizedByActor` and the category list several categories at once.
**Later the same day the owner removed the per-inbox AI switch:** once a key is set, every inbox's mail is processed,
and saving the key is the consent (`aiProcessing` is gone). **Connecting Gmail by signing in with Google** was added
too (one Google client the host owns; the server on the host's Mac first): `core/src/google.ts` and
[sync and providers](contract-sync.md#connecting-gmail-by-signing-in-with-google). After the owner's first Gmail run, the
first sync's days persist and a restart doesn't reprint a waiting owner's code. **On 2026-11-18 the owner decided**
that the AI's history is all synced mail (archived mail still skipped), that a summary aims for one short line (apps
show at most two and cut there), and that an over-long summary is shortened, never dropped
([the server's AI](contract-ai.md)). The same day the history setting left the contract (`historyDays`,
`maxHistoryDays`, `beyondHistory`): the first sync's window is the one setting for old mail, which a person now reads
and sets (`GET`/`PATCH /v1/first-sync`, [sync](contract-sync.md#sync)); and the AI's usage is kept for a person's
Settings (`GET /v1/ai/usage`, [the server's AI](contract-ai.md#usage)). **Also on 2026-11-18 the owner chose that
pictures from the web load through the server, with tracking pictures taken out first** (as HEY does):
`Message.remotePictures`, the picture route and [pictures from the web](contract-pictures.md). **On 2026-11-19 receipts
and invoices gained payment details** (`Thread.payment`: who, how much, what for, each checked by the server; the
summarize job asks for them in place of a summary, [the server's AI](contract-ai.md#payment-details)), and
notifications an event (`Thread.event`: what happened, about what, when; asked with the summary,
[the server's AI](contract-ai.md#notification-events)). **Also on 2026-11-19
sender pictures** (`Thread.avatar`, `Message.avatar`, `GET /v1/avatars/:id`): an organisation's own site icon, shown only
when the mailbox provider's checker proved the From domain and the sender is let in ([sender pictures](contract-avatars.md)).
**Later on 2026-11-19 notifications left Home** for their own list (the owner's decision, replacing that of 2026-11-18;
`HOME_CATEGORIES` is `conversation` and `unknown` again) **and gained groups** (`NotificationEvent.group`: the same
opaque string on one inbox's notifications about the same thing, shown as one row by clients;
[notification groups](#words), [the server's AI](contract-ai.md#notification-groups)). **On 2026-11-20 search became
real** (the owner's request): full text over everything the server holds with filters, Gmail's operators, ranking and
excerpts, and, when a person asks, older mail found in the mailbox itself and opened one conversation at a time
([search](contract-search.md)), then a search asked in a sentence, turned into the same filters by the server's AI
(`POST /v1/search/ask`; only the sentence leaves the server, [asking in a sentence](contract-search.md#asking-in-a-sentence));
**and a waiting thread left the category lists** (the owner's decision: snoozed is out of
sight until it comes back, in the waiting list and search only). **On 2026-11-21 the owner let a person's own paired
device give the server its Google client** (`PUT /v1/google/client`; before, only the environment or a file the host
wrote), and the server serves the guided set-up of that client, the browser agent's prompt and the manual steps, so
every app shows the same words (`GET /v1/google/setup`;
[sync and providers](contract-sync.md#connecting-gmail-by-signing-in-with-google)). **On 2026-11-23 the owner decided
that an inbox says how far its first sync has got** (`Inbox.firstSync`, "Fetching your mail · 120 of 340"; the
provider counts it on each batch, `SyncBatch.progress`; [sync](contract-sync.md#sync)). **On 2026-11-25 the owner let
some mail from senders who aren't let in skip Screening,** as one-time codes already did: sign-in links, email
confirmations, security alerts, password resets and account changes, receipts and order updates, bookings and payment
alerts. The server's AI names the kind, the server's own check must also hold, and `Thread.skippedScreening` says why
([rules and learning](#rules-and-learning)). **The same day two kinds of sender came to be let in without the AI:**
another inbox on this server and a colleague (a person) at the inbox's own domain, both only when the mailbox provider
proved the From domain ([letting a sender in](#rules-and-learning)). Which parts follow it is in
[agents/01-overview.md](agents/01-overview.md); open questions in [agents/contract-questions.md](agents/contract-questions.md).

## Pages

The contract is split by subject. This page is the entry point.

| Page | Holds |
|---|---|
| `docs/contract.md` (this page) | The mailbox as the main database, parts, words, who may do what, trust, lists and counts, actions and undo, rules and learning (how a new thread is sorted), triage by an outside agent, inboxes, drafts, briefs, REST, pairing and sign-in, changing the contract |
| [`docs/contract-ai.md`](contract-ai.md) | The server's AI: jobs and settings, status, what it processes and when, first sync and history, what leaves the server, mail as untrusted input, records and correcting |
| [`docs/contract-sync.md`](contract-sync.md) | Sync (noticing new mail, Gmail's push, the first sync, spam, changes made at the provider, paused inboxes), providers (what is written to the mailbox, labels, what a provider must do), and connecting Gmail by signing in with Google |
| [`docs/contract-pictures.md`](contract-pictures.md) | Pictures from the web: how a message's HTML shows them through the server, trackers taken out, pictures held back, the picture route, what is fetched and how, and what it hides and doesn't |
| [`docs/contract-avatars.md`](contract-avatars.md) | Sender pictures: when an organisation's own icon is shown instead of initials (the provider's checker proved the From domain, the sender is let in), where it comes from and when it is fetched, the route, what it reveals and what it doesn't protect |
| [`docs/contract-search.md`](contract-search.md) | Search: what a search takes (filters, Gmail's operators), what is searched, how text matches and results rank, what a result carries (excerpts as runs, people), keeping the index right, who may search, older mail in the mailbox (searching it, opening one, placement, limits, privacy), and asking in a sentence (what the AI is sent, what is kept of its answer, limits) |

## The mailbox is the main database

- **The provider's mailbox is the source of truth for mail.** The server's store is a synced copy of it, plus what
  the server works out.
- **What should survive losing the server is written back to the mailbox:** a thread's category, its stack and the
  screening gate, as labels (Gmail) or folders and keywords (IMAP). A new server connected to the same mailbox reads
  them back (see [sync and providers](contract-sync.md)).
- **The one decision a person makes that isn't written back is a correction to `conversation`.** `conversation` has
  no label, so that a conversation is simply in the provider's inbox, or archived, as in any mail app, and the
  person's mailbox doesn't carry a label on every conversation. So the mailbox can't tell a conversation from a
  thread nobody has decided yet: a new server reads both as `unknown`, its AI decides them again, and a person's
  correction to `conversation` is lost with the old server.
- **What lives only on the server:** summaries and other text the AI writes (a new server writes them again),
  come-back times, whether a thread in a filed category is done (a new server reads those its first sync takes as not
  done), whether a sender is let in or blocked (a new server lets in the senders of its
  first sync's history, except those filed under Screening, and knows no block), Handled's history, rules, drafts,
  briefs, guides, devices, and the AI's settings and key. Losing the server loses them.
- **Gmail is the provider the product is built and proven for first.** IMAP with SMTP stays in the code and in this
  contract as it is. Outlook comes later.
- The server takes in whatever arrives at the mailbox (see [Sync](contract-sync.md#sync)) and keeps the two in step:
  changes made at the provider win.

## Parts

| Folder | What it is | Depends on |
|---|---|---|
| `core/` | Types and interfaces only, plus `fixtures/sample.json` | nothing |
| `server/` | The store, the service, REST, sign-in, the sync loop, the AI's jobs, rules, triage, undo, events | `core`, and `mail` through the provider interface |
| `mail/` | Mail providers: Gmail, and IMAP with SMTP | `core` |
| `design/` | Design tokens, generated CSS and Swift, fonts, icons | nothing |
| `apps/` | The Swift packages and the Mac app (the iPhone app comes later) | the REST routes, `design` |
| `dashboard/` | The web dashboard, mounted by the server at its root (rebuilt later) | `core`, `design` |
| `mcp/` | The connector for outside agents and chat apps, mounted by the server at `/mcp` | `core`, `design` |
| `cli/` | The `usual-mail` command, with the Docker files | the REST routes |

- Each TypeScript folder is its own package with its own `package.json` and lockfile. It uses core as
  `"@usualmail/core": "file:../core"`. Core ships TypeScript source, so run with Node 22's type stripping or a
  bundler. Imports use the `.ts` extension. Versions in `package.json` are exact, without `^`.
- **An interface the server mounts** (`dashboard/`, `mcp/`) exports one function that takes `InterfaceDeps`
  (the service, a way to turn a token into a caller, and its base path) and returns a standard `FetchHandler`.
  It has no behaviour of its own: everything goes through `MailService`.
- **Mounting:** the server passes a mounted interface every request whose path is its base path or under it, with
  the full URL, unstripped. `/healthz`, `/v1` and everything under `/v1` always stay with REST, so no interface is
  mounted there. A longer base path wins over a shorter one, so an interface at the root gets every path that no
  other claims.

## Words

- **Inbox:** one connected mailbox. In the apps it is a profile with an `icon` and a `position` in the profile
  switch, and a company's colour. The colour is any `#RRGGBB`; interfaces show the nearest of the design system's
  twelve hat colours and offer only those. Its `connection` says how it is connected, without anything secret.
- **Paused:** an inbox the person paused. The server reads nothing from its provider and writes nothing to it
  until it is resumed (see [Inboxes](#inboxes)).
- **Category:** what kind of mail a thread is: `conversation` (mail between people that may need the person),
  `newsletter`, `invoice`, `receipt`, `notification`, `otp` (a one-time code), or `unknown` (nobody has decided yet,
  or the AI isn't working). Every thread has exactly one. `categorizedBy` says who decided it: the server's AI
  (`ai`), a rule, an outside agent, the person, or the mailbox (a label read back, or a change made at the provider).
  `categorizedByActor` names who, so "why it's here" can say it: the server's AI with its model, the rule, the agent
  with its name, the person's device. It is absent for the mailbox, while nobody has decided, and for a decision a
  server made before it kept the name. The five categories other than `conversation` and `unknown` are **filed**: each
  has its own label or folder.
- **Sender:** the address a thread's screening, letting in and blocking are about (`Thread.sender`): the sender of its
  oldest message someone else sent (not the mailbox's own), lower case. Every thread of that address is screened,
  unscreened, let in or blocked together. A thread that holds only the mailbox's own mail has none.
- **The mailbox's own mail** (`outgoing`): mail the provider says the mailbox sent (Gmail's SENT label, IMAP's Sent
  folder), or a copy of exactly what the server itself sent from that inbox (its Message-ID with the same From, To,
  Cc, subject and text, and no HTML or attachments, since the server sends text only; such a copy lets nobody in). **Never because its From names the inbox:** anyone can write
  that, so such mail is treated like anyone else's (screened, held back, summarized as the sender's words, shown with
  its From rather than "You"), and the inbox's own address is never let in by itself (decided 2026-11-18). A copy
  first stored without evidence becomes the inbox's own when its Sent copy arrives ([sync](contract-sync.md#sync),
  "Which stored message new mail is"). Migration 0009, run once, forgot the inbox's own address where it had been let
  in, an `allow_sender` a person gave it included.
- **Screened:** a thread whose sender hasn't been let in, whatever its category, or that the mailbox filed under
  Screening. It is in no list but the screening list and search until its sender is let in. The mailbox's own filing
  under Screening (a person's filter, the first sync's history, a change made at the provider) is not the sender gate:
  it holds even a one-time code, and only letting the sender in or taking the thread out of Screening at the provider
  lifts it.
- **Skipped Screening** (`Thread.skippedScreening`, `ScreeningPass` in `core/src/screening.ts`; the owner's decision of
  2026-11-25): a thread from a sender who isn't let in that isn't screened, because the server's AI named a kind of
  mail that may skip Screening and the server's own check confirmed it ([rules and learning](#rules-and-learning)):
  `code` (a one-time code), `sign_in`, `email_confirmation`, `security` (a security alert), `account` (a password
  reset or account change), `order` (a receipt or order update), `booking` or `payment` (a payment alert). It sits in
  its category's list; its sender still isn't let in, so their next mail is screened. Absent while the thread is
  screened (undoing the AI's decision screens it again and drops the kind), for every other way out of Screening (the
  sender let in, a rule, a person's `otp`, the mailbox's filing), and on a code that skipped Screening before
  2026-11-25. Mail from someone not let in joining the thread screens it again and drops the kind until the gate
  judges the newest message ([rules and learning](#rules-and-learning)). It stays when the sender is let in later: it
  says how the thread came out of Screening. **What an
  interface shows:** in the reading view's "why it's here", under the category's line, `skippedScreeningLine` in core's
  words ("Skipped Screening: a sign-in link"), with the actions a screened thread offers for its sender (let in,
  block), so the person can still decide about them; in lists, nothing beyond what any thread of its category shows.
  The dashboard shows the line as a badge on the thread in Handled; the connector gives it as `skippedScreening`.
- **Home:** the conversations that need the person and what nobody has categorized yet (see [Lists](#lists)). It
  replaces Now. Notifications live in their own list and tab, not Home: the owner's decision of 2026-11-19 ("since we
  have a notification tab now, the Home should [not] show notifications anymore"), replacing that of 2026-11-18 which
  had put them in Home. At the provider they stayed out of the inbox under their label or folder throughout.
- **Stack:** where a person puts a thread on purpose: `reply_later` or `set_aside`. At most one. A thread on a
  stack is never done.
- **Done:** finished with. A done thread is in no list but search. A done `conversation` or `unknown` thread is
  archived at the provider. A done thread of a filed category, a notification made done from its list included,
  changes nothing there: it already sits out of the inbox, under its label or folder.
- **Come back:** hidden from Home and from its category's list until a time (in the waiting list and search only: the
  owner's decision of 2026-11-20), then at the top of Home again. With `comeBackIfNoReply`, a reply from
  someone else before that time ends the wait and brings the thread back at once. Until then the thread is
  **waiting**.
- **Trashed:** in the provider's trash. A trashed thread is in no list of threads; Handled still shows its
  records.
- **Handled:** the history of what rules, agents and the server's AI did or propose, each with who did it.
- **Trust:** how much outside agents, and rules an agent made, may do alone in an inbox. It doesn't govern rules a
  person taught or the server's AI.
- **Silent:** a record of what a rule or an agent applied alone and cleanly in an `act_silently` inbox, or of what
  the server's AI applied cleanly. It can be undone, but Handled shows it only when asked.
- **Let in:** what a sender is once their mail is no longer screened (see [Rules and learning](#rules-and-learning)).
- **Guide:** an inbox's plain-language notes, which people and agents read and edit.
- **The server's AI:** the models the server calls itself, with the AI account the person set up, to categorize and
  summarize mail (see [the server's AI](contract-ai.md)). An **outside agent** is the person's own agent connected
  through the connector or REST with an agent's token.
- **Summary:** one short plain line on what a thread is about, written by the server's AI: the request aims for one
  sentence under about 100 characters and asks it not to repeat the sender's name; the server keeps at most 200
  characters (see [the server's AI](contract-ai.md#mail-is-untrusted-input-to-a-model)). Interfaces show "Sender -
  summary" on at most two lines, cut with an ellipsis, and the snippet while there is no summary. A one-time code
  (`otp`) never has one. A receipt's or an invoice's summary is its payment details' `what`, when there is one.
- **Snippet** (`Thread.snippet`): plain reading text from the thread's newest message a person sees, made by the server
  (since 2026-11-19, `snippetText` in `server/src/ai/text.ts`): the message's text part, or its HTML's text when the
  text part is missing, a stub or HTML source itself (the same reading the server's AI gets); entities read, tags
  gone; a markdown-style link "[text](https://…)" reduced to its text; a link in angle brackets or standing alone
  taken out (a message that is nothing but a link keeps that link's host); invisible characters, padding and divider
  runs collapsed, control characters gone, every run of spaces and line breaks one space; at most 200 characters, cut
  at a word boundary. Never markup or control characters; clients still draw it as text. Quoted replies and
  signatures stay in it as the mail writes them. Empty when the message has no text.
- **Payment details** (`Thread.payment`, `PaymentDetails` in `core/src/domain.ts`; 2026-11-19, the owner's request
  for the Receipts tab): what the server's AI read in a `receipt` or `invoice` thread, each fact checked by the server
  against the mail it was given: `party` (who the money goes to or came from), `amount` (`minor`, an integer in the
  currency's ISO 4217 minor units, and `currency`, its ISO 4217 code), `refund` (only ever true on a `receipt`, and
  then paid), `state` (`paid`, `scheduled`: it will be collected automatically, or `due`: the reader pays it; null when
  the mail doesn't say; the owner's decision of 2026-11-19), `dueDate` (a calendar date the mail states: when it will
  be charged or is due, never while paid) and `what` (what it was for, one short line). Any of them may be null on its
  own. Present only on those two categories once processed, removed when the thread leaves them. An interface's title
  follows `state` ("Paid", "Will be charged", "To be paid"), "Refunded" for a refund, and while `state` is null the
  category (an invoice is to be paid, a receipt paid); the category stays what sorting decided.
- **Notification event** (`Thread.event`, `NotificationEvent` in `core/src/domain.ts`; 2026-11-19, the owner's request
  for the Notifications tab): what the server's AI read in a `notification` thread, each fact checked by the server
  against the mail it was given: `status` (what happened or will happen, a short phrase in English: "Out for
  delivery"), `about` (what or who it concerns, never the sender's name alone) and `when` (`date`, a calendar date,
  with `time` and `endTime` as HH:MM when the mail gives them; no time zone: the mail's own local reading). Any may be
  null; all are null for a notification that tells of no event. Present only on `notification` threads once
  processed, removed when the thread leaves it; `summary` stays a normal summary. An interface composes "{status}
  {when}" over "{about}", and keeps today's row while `status` is null; a `when` of null shows the mail's own day.
  See [the server's AI](contract-ai.md#notification-events).
- **Notification groups** (`NotificationEvent.group`; 2026-11-19, the owner's "Yes, build it"): an opaque string, the
  same on notification threads of one inbox that tell of the same thing (one parcel, order, booking or
  appointment); absent or null when the server found nothing to join a thread by. A client only compares it (same
  string, same thing) and never reads anything into it; how the server finds it is in
  [the server's AI](contract-ai.md#notification-groups). **How a client shows a group** in the Notifications list:
  one row for the group, taken from its thread with the newest mail (`lastMessageAt`, equal times by id); the
  others reachable behind it (expanded in place or on the row's page), newest first; the row says how many threads
  it stands for. Its section (Today, Coming up, Earlier) is the shown thread's. The group counts as unread when any
  of its threads is. An action on the collapsed row (done, read, unread, a category, a stack, trash) applies to
  every thread in the group, each recorded and undoable as usual; on one thread opened behind it, to that thread
  alone. A thread without a group is its own row. Threads stay separate everywhere else (search, counts, the API).
- **Version:** a counter on every inbox, thread, action record, draft and rule, and on the counts and the AI's
  settings and status. It rises with every change and may rise by more than one. Of two copies of the same thing,
  keep the higher. An inbox's `lastSyncedAt` moving alone is not a change.

## Who may do what

A token belongs to a person's device or to an agent.

- **A person** may do everything.
- **An agent** sees an inbox only if the token lists it and the inbox's `agentAccess` is on. Everything else
  answers as if it didn't exist (`not_found`).
- **Person only:** connecting and removing inboxes (signing in with Google included), giving the server its Google
  client and reading its set-up, changing any inbox field except `guide` (credentials, `icon`,
  and `position` included), the AI's settings and testing it, approving and rejecting proposals,
  answering a teach prompt, sending a draft, turning a rule on, changing or deleting a rule a person made, making
  pairing codes, loading a picture from the web a message shows, searching the mailbox itself and opening what it finds
  ([search](contract-search.md#older-mail-in-the-mailbox)), asking search in a sentence
  ([search](contract-search.md#asking-in-a-sentence)), listing the blocked senders and letting one in by address
  ([blocked senders](#blocked-senders)), and everything about other devices. An agent that tries gets `needs_person`.
- **An agent may:** read what it can see (counts and the AI's status included), act and decide under the trust
  table, write drafts, change or delete drafts an agent wrote, write briefs, change an inbox's `guide`, create rules
  (they start disabled, with source `agent`), change or delete rules an agent made, ask which device it is (`me`),
  and revoke its own token. Changing or deleting a draft a person wrote answers `needs_person`.
- **Undo by an agent:** only where it could have applied the opposite itself, so not in a `suggest` inbox and
  never for `trash` or `block_sender`. Otherwise `needs_person`.
- **The chat connector (`mcp/`) accepts agents' tokens only.** It refuses a person's token with `403`, because an
  AI acting with it would count as the person: no trust check, and `trash` and `block_sender` applied at once.

## Trust

When an outside agent, or a rule an agent made, acts on a thread:

| Inbox trust | What happens | Shown in Handled |
|---|---|---|
| `suggest` | The action is recorded as `proposed` and the thread stays where it is | Yes, waiting for a yes or no |
| `act_with_undo` | It is applied and recorded | Yes, with undo |
| `act_silently` | It is applied and recorded with `silent: true` | Only when asked for (`includeSilent`), with undo, unless something went wrong |

- `trash` and `block_sender` are always `proposed` when an agent or a rule an agent made asks, whatever the trust.
- A person's own action is always applied, and never silent.
- **A rule a person taught always applies** (source `person` or `correction`): it is the person's own instruction,
  so every action in it, `trash` and `block_sender` included, is applied whatever the inbox's trust, recorded with the
  rule as the actor. Its records are silent in an `act_silently` inbox, as an agent's are, and otherwise shown with
  undo, so the person's own rules never fill Handled with proposals.
- **The server's AI isn't governed by trust.** Its categorizing applies at once in every inbox and is recorded
  silently (see [the server's AI](contract-ai.md)). Trust keeps governing outside agents and rules an agent made.
- **Silent records** can be undone like any other. Handled leaves them out unless `includeSilent` is set, and a
  brief's counts and an interface's "what needs you" leave them out. Proposals are never silent, so neither is a
  proposal a person approves. Changing an inbox's trust changes no earlier record. Events carry silent records
  like any other; a client that keeps its own Handled leaves them out the same way.
- **Silence never hides trouble.** `silent` applies only to a record that was applied cleanly. When the provider
  refuses the record or its undo, or adds a note, `silent` turns false for good. The record is then shown like
  any other: Handled includes it whatever `includeSilent` says, and it counts in "what needs you".
- A proposal still sets the thread's `reason` and `need` at once, and `categorizedBy` and `categorizedByActor` when it
  proposes a category, so the thread leaves the triage queue, the server's AI leaves its category alone, and its card
  can say why.
- **Approving** applies every named proposal or none. An approved record's `at` becomes the approval time.
  If a thread changed so that its proposal no longer makes sense, or two of the named proposals change the same
  part of one thread, the whole call fails with `conflict` and nothing is applied.
- **Rejecting** sets the records to `rejected`.
- A new inbox's trust is `suggest` unless the person chooses otherwise.

## Lists

Every list of threads leaves out trashed threads, and every list but search and the screening list leaves out
screened ones. Lists are ordered newest first by the time each item publishes, in whole seconds as every time is
published, with equal times ordered by id, descending, unless the table says otherwise. So a client can reproduce a
list's order from what it was given, and two records made in the same second come in id order on the server and in
every client. A page's `nextCursor` holds the same second and id, so the next page starts right after the last item
of the one before: a page boundary skips and repeats nothing. `limit` defaults to 50 and is at most 200.

| List | Holds | Ordered by |
|---|---|---|
| Home (`home`) | Threads in `conversation` or `unknown` (core's `HOME_CATEGORIES`) that aren't done, aren't on a stack and have no come-back time in the future | The later of `lastMessageAt` and a come-back time that has passed |
| A category (`category`, one for each of the seven, or several merged into one list) | Threads in that category, or in any of the categories named, that aren't done and have no come-back time in the future, stacked ones included (a waiting thread is out of sight until it comes back: the owner's decision of 2026-11-20) | `lastMessageAt` |
| A stack (`stack`) | Threads on that stack | `lastMessageAt` |
| Waiting (`waiting`) | Threads with a come-back time in the future that aren't done | The come-back time, soonest first, equal times by id, ascending |
| Screening (`screening`) | Screened threads that aren't done | `lastMessageAt` |
| Handled | Records made by rules, agents and the server's AI, in the states asked for (default `proposed` and `applied`), without silent ones unless `includeSilent` is set. A record that failed or carries a note is never silent, so it is always included. With `attentionOnly`, only records that failed or carry an `error` or a `note`, whoever made them (a person's own refused write-back too), from every state unless `states` is given. Each row carries its thread, trashed or not | The record's `at` |
| Triage queue | Threads in `unknown` that nobody has decided, that aren't done, and that the server's AI won't process: the AI's state isn't `working`, or the AI's answer for them was dropped (until incoming mail joins them). Age is no reason: the AI's history is all synced mail. Each with its newest message a person sees | `lastMessageAt`, oldest first: the default order reversed, so equal times by id, ascending |
| Search | Threads the text and filters find ([search](contract-search.md)): full text over the subject, who wrote and who else is in it, every message's text, the summary, the AI's facts and attachment names; done, screened, waiting and blocked senders' threads included | With text, relevance first with recency a strong tie-break ([how results rank](contract-search.md#how-results-rank)); filters alone, `lastMessageAt` |
| Drafts (`listDrafts`) | Drafts in state `draft` or `failed` | `updatedAt` |
| Inboxes | The inboxes the caller may see | `position` |
| Rules (`listRules`) | An inbox's rules | The order they were made |

- **Home's New and Seen.** Interfaces split Home into New (its unread threads) and Seen (the rest). Whether New
  should instead mean what arrived since the person's last visit, a time their devices would share, is open; a later
  revision may add that time without changing Home.
- **Several categories in one list.** The category list takes several categories (REST: joined by commas, as in
  `GET /v1/categories/invoice,receipt`) and answers one merged page in the normal order, whose `nextCursor` runs across
  all of them. A category named twice counts once. Its count is the sum of the categories' counts.
- **Counts.** `counts` answers, for every inbox the caller may see and for all of them together: Home, Home's unread
  threads, each category's list, each stack's list, the waiting list and the screening list. Each count is the length
  of that list. The counts carry a `version`. When any count changes, the server sends `counts.changed` with the
  latest counts, at most once a second, each receiver getting the inboxes it may see.
- **Handled keeps the records of trashed threads,** so a trash can be undone from there. A client that keeps its
  own copy keeps a trashed thread while it holds a record for it. Records of a thread that is removed
  (`thread.removed`) leave Handled.
- **"What needs you"** in an interface is Handled with `attentionOnly` (records that went wrong or carry a
  provider's note, whoever made them, so a person's own action the provider refused shows there too), the
  proposals waiting, inboxes that need attention, drafts that failed, and the server's AI when its state is
  `key_refused`, `model_not_found` or `out_of_credit`. Silent records are never part of it. Handled's ordinary list
  stays rules', agents' and the AI's records. An agent sees what needs a look only in the inboxes it may see. What
  needs a look doesn't shrink by itself yet: a failed record stays failed, and nothing lets a person mark one seen
  (an open question).

## Blocked senders

The owner's request of 2026-11-20, for a Settings tab ("showing the blocked senders in a separate tab and unblock them
or see how many emails they've sent so far which has been blocked"). Both calls are a person's: an agent's token is
answered `needs_person`, also for an inbox it may read.

- **The list** (`senders`, `GET /v1/senders?state=blocked`, with the lists' `inboxId`, `limit` and `cursor`; `blocked`
  is the only state and the default, any other is `invalid`): the senders blocked in the inboxes asked for, the newest
  block first (the whole second of `blockedAt`, then inbox and address, descending). Each is a `BlockedSender`:
  `inboxId`, `address` (lower case), `name` (the one their newest stored mail gives, when it gives one), `blockedAt`
  (when the block in force now was applied), `blockedBy` (the actor of the newest applied `block_sender` record for
  that address, as records show actors: a person's device, a rule, an agent with its name; absent when no such record
  is left), `messagesSinceBlocked` and `lastMessageAt` (the date of their newest stored mail, before or after the
  block; null when none is held).
- **`messagesSinceBlocked` is counted, never guessed:** the messages the server holds in that inbox whose From is that
  address and whose date is after `blockedAt`, counted from the stored messages each time. A blocked sender's mail is
  taken in and kept like any other (it arrives done, or hidden inside someone else's thread), so it is counted; what
  the mailbox itself put in its spam or trash is never taken in, and mail deleted at the provider since is no longer
  held, so neither is counted. Mail from before the block isn't counted, though the block made it done.
- **Letting one in** (`allowSender`, `POST /v1/senders/allow` with `{ inboxId, address }`; the address compared
  without case; `invalid` when it isn't an address, `not_found` for an inbox the caller can't see): exactly
  `allow_sender` applied to the sender's newest thread that isn't trashed or gone, through the same engine. So it is
  one applied record on that thread by the person (`action.recorded`; undoable like any `allow_sender` until a later
  allow or block of that sender; like every action of a person's it isn't in Handled's list, which holds what rules,
  agents and the AI did), and it answers an `ActResult` with that record and the threads it changed. A sender with no
  such thread left is let in without a record (nothing to record it on; `records` is empty). A sender who is already
  let in changes nothing and gets no record. It works for any sender, blocked or not.
- **What unblocking does** (as `allow_sender` always did): the sender is let in; their threads that were screened
  stop being screened; **nothing the block marked done comes back** (their threads stay done, archived at the
  provider when they were conversations), and neither does mail that arrived while they were blocked. Mail that
  arrives afterwards is sorted like any let-in sender's: rules, then the AI, not screened, not done. Undoing the
  *block's own record* (while it can still be undone) is the other way: it puts back the threads that block changed
  and the sender as they were before it; mail that arrived during the block stays done either way.
- **`sender.changed`** (`{ inboxId, address, blocked, sender? }`, to people's devices only) is sent when a sender
  becomes blocked or stops being blocked, by any way (a thread's action, an approved proposal, `allowSender`, an
  undo), and when mail from a blocked sender is stored. `sender` is their `BlockedSender` as it is now while blocked,
  and absent once they aren't.

## Actions and undo

- `act` takes several threads and one action. It returns every named thread as it is now, and one record per
  thread it changed or proposed to change. A thread the action wouldn't change gets no record.
- `approve`, `reject`, `decide` and `undo` answer in the same shape.
- **What each action does:**
  - `categorize` sets the category, `categorizedBy` and `categorizedByActor` (who did it). It lets no sender in, and a
    screened thread stays screened, except that a thread put in `otp` stops being screened (its sender still isn't let
    in) and loses its summary, since one-time codes are never summarized; the mailbox's own filing under Screening
    keeps even that screened. **The server's AI at the screening gate** follows its own rule instead (see
    [Rules and learning](#rules-and-learning)): its categorize unscreens a thread only when the server's own check
    confirms a kind of mail that may skip Screening, and then sets `skippedScreening`; otherwise the thread stays
    screened, `otp` included. Nobody can choose `unknown`. A person's `categorize` is how a
    category is corrected (see [the server's AI](contract-ai.md)).
  - `done` marks it done, takes it off its stack and clears a come-back time. `not_done` reverses only `done`.
  - `stack` puts it on a stack and clears `done`. `unstack` takes it off.
  - `come_back` sets the time and clears `done`. `cancel_come_back` clears the time.
  - `read` and `unread` set every message in the thread.
  - `allow_sender` lets the thread's sender (`Thread.sender`) in: every screened thread of that sender stops being
    screened, and later mail from them isn't screened.
  - `block_sender` marks that sender's threads done, and later mail from them arrives done, or, in someone else's
    thread, changes nothing a person sees (see [Sync](contract-sync.md#sync)).
  - `trash` sets `trashed`. Until the trash is undone, any other action on the thread answers `conflict`.
    `thread(id)` still returns it.
- **Undo** puts the thread back exactly as the action found it: category, screened, done, stack, come-back time,
  unread and trashed. It sets the record to `undone`; it doesn't add a second record. A record stays undoable until a
  later action changes the same part of the thread, or the provider can no longer reverse it.
- **Undoing a `categorize`** puts the category back and sets `categorizedBy` and `categorizedByActor` to whoever undid
  it (the person or an agent), so the server's AI doesn't decide it again. A thread whose category goes back to `unknown` this way stays
  in Home and out of the triage queue.
- **Undoing `allow_sender` or `block_sender`,** which change every thread from the sender: the undo always puts
  the sender back as they were (unknown, let in or blocked). It puts back each thread the action changed, unless
  where that thread is has changed since: its category, screened, done, stack, come-back time or trash. Reading it,
  a summary or a come-back time passing doesn't count. Changed threads are left as they are. Such a record stays
  undoable until a later `allow_sender` or `block_sender` of the same sender is applied.
- **Writing back** to the provider happens after the call returns. If the provider refuses:
  - an action's record becomes `failed`, with `error`, and the thread is put back, in each part the action
    changed and nothing has changed since. A part a later action changed keeps the later change, and that later
    action's undo then puts the part back to where it was before the failed one;
  - an undo is taken back the same way: the thread returns to how it was before the undo, in each part nothing
    has changed since, and the record stays `applied`, with `error` saying the undo was refused. It stays
    undoable, unless a later action changed a part it changed.
  If the provider takes the change but adds a note, the record that caused the write-back gets it as `note`; a
  later note replaces an earlier one. Either way the news arrives as `action.recorded` and `thread.changed`
  events, not in the call's answer.

## Rules and learning

- **A new thread delivered to the provider's inbox** is sorted by the first of these that applies, then summarized:
  1. **The new message's sender is blocked:** it arrives done. Nothing else happens, and the AI never sees it.
  2. **An enabled rule matches:** the rule's `then` actions are applied in order: a rule the person taught always
     applies, whatever the trust; a rule an agent made, under the trust table. Its `hits` goes up and the thread's
     `reason` is the rule's `text`. A `categorize` in it sets `categorizedBy` to `rule` and `categorizedByActor` to the
     rule, also when it is only proposed. The thread isn't screened. Unless the rule set or proposed its category, the
     server's AI then categorizes it.
  3. **Its sender hasn't been let in:** the server's AI categorizes it first, if it may process the thread. **Some
     kinds of mail skip Screening** without letting the sender in (the owner's decision of 2026-11-25): one-time codes,
     sign-in links, email confirmations, security alerts, password resets and account changes, receipts and order
     updates, bookings, and payment alerts. **A model's answer alone never lifts the gate:** the server's own check
     must also hold for the message the model read: the mailbox provider's checker proved its From domain (Gmail's;
     not a public mail domain's or a shared platform's), it looks machine-sent, it has the shape of mail sent to this
     person by that organisation alone (no List-Id, every Reply-To at the From's own domain, To or Cc naming the inbox,
     not a help desk's or shop's tenant on its platform), and it shows that kind's evidence (see
     [mail as untrusted input](contract-ai.md#mail-is-untrusted-input-to-a-model)). A one-time code needs only the
     proof, machine-sent mail addressed to the inbox and a code; in an IMAP inbox, whose provider has no checker,
     those without the proof, as before 2026-11-25. For an answer of `otp` with such a code, that is all. Otherwise,
     when the category may be one of the kinds and the server's check could hold for one of them, the AI is asked once
     more which kind it is, or none. A kind counts only in its own categories (core's `SCREENING_PASS_CATEGORIES`): a
     code in `otp`; a sign-in link or an email confirmation in `otp` or `notification`; a security alert in
     `notification`; a password reset or account change in `notification` or `otp`; an order update in `receipt` or
     `notification`; a booking or a payment alert in `notification` or `receipt`. **An `invoice` never skips
     Screening.** When it holds, the thread is in that category, not screened, `skippedScreening` names the kind, and
     its sender still isn't let in. Otherwise the thread stays screened in the category the model gave (`otp`
     included); when the AI may not process the thread, or gives no answer it accepts, it is screened in `unknown`.
     **Only while the server holds the new thread for the AI's answers** is it judged: held, it is screened but isn't
     written back, so mail that skips Screening is written back once, to its category's label or folder, never to
     Screening and out again. Mail that arrived while the AI was off, paused or failing, or whose answer failed, is
     written back under Screening and stays screened when the AI categorizes it later; and mail that joins the thread
     while it is held means the answers about the earlier message don't count. A person's own `categorize` to `otp`
     lifts the gate as before, without a kind. (A sender let in as one of the person's own when the mail arrives,
     below, never reaches this step.) **Mail joining a thread that skipped Screening** from anyone not let in (its own
     sender, or someone threaded onto it) screens it again, drops the kind and is judged by this step again, the newest
     message read: a qualifying update skips Screening again, held unwritten meanwhile; anything else waits in
     Screening. The AI never makes such a thread a `conversation` while its sender isn't let in.
  4. **Otherwise** (its sender is let in): the server's AI categorizes it.


  Then the server's AI summarizes it, unless it is `otp`. The AI's steps happen only when it may process the thread
  (see [the server's AI](contract-ai.md)). Until then, and whenever it can't, the thread is `unknown`, has no summary,
  and shows in Home unless it is screened, done or stacked, so nothing is hidden when the AI isn't working.
- **A new thread the provider delivered outside its inbox keeps the person's own filing** (a Gmail filter or a
  server-side rule put it there): a filed category's label or folder is that category (`categorizedBy: "mailbox"`),
  the Screening label or folder screens it, a stack's label or keyword is that stack, and otherwise it is done. No
  rule runs, it isn't screened unless it was filed under Screening, and its sender isn't let in by it. The AI then
  processes it like any thread it may process: a done one isn't. (So a filing under Screening holds even a code.) A
  blocked sender's mail is done wherever it arrives. Mail that joins an existing thread goes where that thread
  belongs, wherever it was delivered.
- **Letting a sender in.** Mail from a sender is screened until that sender is let in. A sender is let in by
  `allow_sender`, by the inbox having sent mail to them (the mailbox's own mail, above, or a draft it sends), by
  being in the first sync's history (except the senders of
  threads filed under Screening there), by writing in a thread that isn't screened (for example someone copied on
  a conversation the person is part of; not into one that skipped Screening while its sender isn't let in: writing
  into such a thread lets nobody in, its own sender included), or, since 2026-11-25, **by being one of the person's
  own when their mail arrives:** another inbox connected on this server (its exact address), or a person at this
  inbox's own domain (exactly, not a subdomain) when that domain isn't a public mail domain or a shared platform's
  (core's `isPublicMailDomain` and `isSharedPlatform`): mail that looks machine-sent or carries a List-Id isn't a
  colleague's (a group relaying an outsider's post as "X via info@company", a help desk or marketing tool sending as
  the company). Both only when the mailbox provider's checker proved the From domain (`ProviderMessage.fromCheck`, as
  for [sender pictures](contract-avatars.md); only Gmail's is trusted, so neither applies to an IMAP inbox), for new
  mail the provider didn't file under Screening, never for the first sync's history, and with the AI on, off or
  failing alike. **Every way of letting a sender in also unscreens their other threads,**
  those the mailbox filed under Screening included, except the first sync's history, which lets its senders in
  without lifting anyone's screening. None of these lets in the inbox's own address; only `allow_sender` does. A
  blocked sender stays blocked until `allow_sender` lets them in or the
  block is undone. A sender a rule matched isn't let in by that; their mail isn't screened while the rule sorts it
  first. Deciding a category, here or at the provider, lets nobody in, and neither does mail that skipped Screening.
- **Rule order:** rules a person taught (source `person` or `correction`) are checked first, newest first.
  Then rules an agent made, newest first. The first match wins. So the latest thing a person taught always
  beats what came before, and a person's rule always beats an agent's.
- A rule's `domain` also matches subdomains. Its `listId` matches a message's `listId`. A rule holds only the
  action kinds in `RULE_ACTIONS`, `categorize` among them. Rules run only for new threads, never for mail joining
  one.
- **A rule an agent creates** has source `agent` and starts disabled. Only a person turns a rule on. When an
  agent changes the `match` or `then` of an enabled rule an agent made, the rule is switched off until a person
  turns it on again. Changing only its `text` leaves it on.
- **Every rule says who made it** (`createdBy`): the person's device, also when they answered a teach prompt, or
  the agent. A person changing an agent's rule doesn't change `createdBy`. A rule made before rules recorded their
  maker (a store from before the fourth revision) says `system`.
- **Rules have versions and events.** Creating, changing, turning on or off and sorting mail raise a rule's
  `version` and send `rule.changed` with the rule; deleting sends `rule.removed`. When rules sort a batch of new
  mail, each rule that sorted any sends one `rule.changed` for the batch, carrying its new `hits`, not one per
  thread. Removing an inbox sends only `inbox.removed`.
- **Teaching:** when a person undoes a rule's, an agent's or the server's AI's action, or changes a thread's category,
  `act` and `undo` may return a `TeachPrompt`: one question and the rule it would create, for example "Always treat
  mail from this sender as a newsletter?". There is no prompt when a rule the person taught already says the same
  for that sender. `answerTeach` with yes creates the rule, enabled, with source `correction`, so it applies to the
  sender's next mail at once, whatever the inbox's trust. Prompts expire after a day.

## Sync and providers

How the server takes in mail and keeps the mailbox in step, and what a mail provider must do, are in
[contract-sync.md](contract-sync.md). Two rules to keep in mind here: **changes made at the provider win,** and
**a conversation or undecided thread is in the provider's inbox exactly when it shows in Home** (a notification stays
under its label or folder).

## The server's AI

What the server's own AI does, its settings and status, what it processes and when, what leaves the server, how
mail is passed to a model, and how its decisions are recorded and corrected are in [contract-ai.md](contract-ai.md).

## Triage by an outside agent

- `triageQueue` returns the triage queue (see [Lists](#lists)): `unknown` threads that the server's AI won't process.
  While the AI works, only threads whose answer the AI gave was dropped (until incoming mail joins them) are in it:
  its history is all synced mail, however old.
- `decide` takes one decision per thread: the category, whether it is done, what it needs, and a reason. It is
  applied under the trust table like any agent action: a category that changes is a `categorize`, recorded. It sets
  `categorizedBy` to `agent` and `categorizedByActor` to the agent (also when the category didn't change or is only
  proposed) and stores `need` and `reason` on the thread.
- A person may call both too; their decisions set `categorizedBy` to `person` and `categorizedByActor` to their
  device.
- `triage.pending` says how many threads wait in an inbox's queue; it changes when the AI's state does.

## Inboxes

- An inbox's provider is `gmail` or `imap`. Its credentials are `GmailCredentials` or `ImapCredentials`.
- **Its `connection`** is what the server stored of its credentials that isn't secret, so a form can show it
  again: for IMAP each server's host, port, TLS (`secure`) and user name, for IMAP and SMTP, and whether a copy
  of sent mail is saved; for Gmail the client id, and `signIn: "google"` when it was connected by signing in with
  Google. Never a password, a client secret or a token. The provider
  supplies it (`MailProvider.connection()`). An inbox whose stored credentials no provider could describe (a store
  from before the fourth revision) lists with an empty host and user (IMAP, with ports 993 and 465) or an empty
  client id (Gmail), so it still lists and can be given new credentials; interfaces show such fields as unknown.
- **Its `icon`** is one of `INBOX_ICONS`, in the order pickers show them: `person`, `building`, `briefcase`, `house`,
  `shop`, `globe`, and since 2026-11-20 (the owner's request) `plane`, `wallet`, `family`, `rocket`, `school`,
  `heart`, `star`, `leaf`; anything else is `invalid`. A new inbox takes the next of person, building and briefcase in
  turn (by how many inboxes there are) unless it is given one.
- **Its `position`** is its place in the profile switch and the inbox list, from 0, no two alike and no gaps. A new
  inbox comes last. Setting an inbox's `position` moves it there and renumbers the others; removing one closes the
  gap. Each inbox whose position changes raises its version and sends `inbox.changed`.
- **There is no per-inbox AI switch** (the owner's decision of 2026-11-17, reversing the same day's earlier one).
  Once AI credentials are set, the server's AI processes every inbox's mail, those connected later too; without them
  it processes none. Setting the key is the person's consent ([the server's AI](contract-ai.md)). An inbox has no
  `aiProcessing`, and connecting or changing one with it is `invalid`.
- **Gmail by signing in with Google** (person only, when the host has set it up): the server runs Google's sign-in
  and keeps the token, and connects a new inbox or reconnects one in place
  ([sync and providers](contract-sync.md#connecting-gmail-by-signing-in-with-google)).
- **Changing its credentials** (`credentials` in `InboxPatch`) is for a person only. They take the same shape as
  when connecting and **replace the stored ones whole**, so a client sends the secrets again together with the
  details it shows from `connection` (and whatever the person changed). `connection` doesn't carry IMAP's
  `address`: a client sends the inbox's own address as `ImapCredentials.address` only when the IMAP login differs
  from it. The server verifies them with the provider before storing them. If that fails, nothing in the patch
  changes and the call answers `provider_error` with the provider's words. If the provider names another address
  than the inbox's, nothing changes and the call answers `invalid`. On success its status is `connecting` until its
  next good sync (`ok`) or a failure that needs attention; a paused inbox stays paused, and is `connecting` once
  resumed. Either starts the run of failures afresh.
- **Why it needs attention** (`statusReason`, 0.1.2): with `needs_attention`, `needs_sign_in`, `host_setup`,
  `provider_error` or `not_syncing`, so an interface offers the step that fits; a refused sign-in or the host's setup
  at once, a failure that may pass after ten minutes, and a sync that stopped finishing after the larger of 15 minutes
  and five polls ([sync](contract-sync.md#when-an-inbox-needs-attention)). Absent from a server before 0.1.2.
- **How far its first sync has got** (`firstSync`, the owner's decision of 2026-11-23): while the first sync runs,
  `fetched` of the `total` messages its window holds, shown once the first sync has run two seconds and then at most
  every two seconds, each change with a new version and `inbox.changed`; gone when the first sync is done, with the
  status turning `ok`. It stays while the inbox is paused or needs attention. Interfaces show it while the inbox is
  `connecting` or `ok`, in core's words: "Fetching your mail · 120 of 340"
  ([sync](contract-sync.md#sync), "How far a first sync has got").
- **Pausing** (`paused: true`) stops syncing and writing back (see [Sync](contract-sync.md#sync)). The change answers
  at once; a sync running then, a first sync's included, stops once the batch being fetched is stored. The server
  reads nothing from the provider: `syncInbox`, `sendDraft` and fetching an attachment answer `conflict` while it is
  paused. Checking new credentials still asks the provider, since a person asked for it. Pictures from the web still
  load: they come from the web, not the mailbox. Resuming makes it `connecting` and syncs it.
- **Removing an inbox** deletes the server's copy of its mail and summaries, its rules, history, drafts and guide,
  and the pictures from the web it kept for it, and ends agents' access to it. Briefs no longer show its section. It changes nothing at the provider: labels and
  folders made there stay. An inbox connected by signing in with Google has its token revoked at Google (see
  [sync and providers](contract-sync.md#connecting-gmail-by-signing-in-with-google)). It can't be undone. It answers
  at once, a running sync stopping in the background with nothing more stored, and the same address may be connected
  again straight away, as a new inbox. The server sends `inbox.removed`, and a client drops everything it
  holds for that inbox.

## Drafts and sending

- Anyone with access to an inbox may write drafts in it. A person may change or delete any draft; an agent only a
  draft an agent wrote (`needs_person` otherwise).
- Only a person may send. Sending goes `sending`, then `sent` or `failed` with `error`. A refused send is not
  an error response: the call returns the draft in state `failed`.
- **A draft left `sending` by a stop** (the server stopped between starting the send and the provider's answer)
  becomes `failed` at the next start, with an `error` that says the server stopped while sending it, that it may
  have gone out, and to check the Sent folder before sending it again. `draft.changed` carries it. It can then be
  changed, deleted or sent again like any failed draft.
- If the provider sends it but adds a note, for example that no copy was saved to Sent, the draft is `sent` with
  `note`. **A sent draft with a note is kept for a day** from its `updatedAt` (when it was sent), so the note can be
  shown: `thread(id)` includes it in `drafts`, and `draft.changed` carries it. Then it is deleted with
  `draft.removed`.
- **A sent draft without a note isn't kept:** `draft.changed` carries it as `sent`, then `draft.removed` follows.
- `listDrafts` lists only `draft` and `failed`.
- A sent reply appears in its thread at the next sync.

## Briefs

- `writeBrief` stores a brief for a period. The caller supplies each section's summary and highlights, each a
  thread and a line. The server fills in each highlight's `subject` (its thread's subject when the brief is
  written) and the counts: the threads rules or agents acted on in the period, counted by where each is now (its
  category, plus `done` if it is done; a trashed thread counts only as `trash`). Silent records, and so the AI's,
  don't count. Sections for inboxes the caller can't see are dropped.
- `latestBrief` returns the newest one the caller may see, with sections for hidden inboxes removed.

## Pictures from the web

How the server shows the pictures a message takes from the web (through itself, trackers taken out before anything
is fetched, held back for screened and blocked senders), the picture route and what it fetches are in
[contract-pictures.md](contract-pictures.md). Two rules to keep in mind here: **a message's `html` loads nothing from
the web by itself,** and **only a person's device may load a picture.**

## Sender pictures

`Thread.avatar` and `Message.avatar` name an organisation's own site icon to show instead of initials; the rules, the
fetching and the route are in [contract-avatars.md](contract-avatars.md). Two rules to keep in mind here: **a picture
is shown only when the mailbox provider's own checker proved the From domain and the sender is let in** (never for a
screened or blocked sender, a person, or a mailbox provider's domain), and **when a thread's picture changes its
version rises.**

## REST

- JSON in and out, except `GET /v1/google/callback`, which answers the person's browser with a page.
  `core/src/api.ts` lists every route, who may call it and which service method it calls.
  A route's request body is that method's input and its response is that method's result.
- `GET` routes take the query fields of `ListQuery` (`inboxId`, `cursor`, `limit`) as query parameters, plus
  search's (`q`, `inboxIds`, `kinds`, `from`, `to`, `subject`, `hasAttachment`, `after`, `before`, `unread`, `tz`:
  [search](contract-search.md#what-a-search-takes)), and for Handled `states` (comma-separated), `includeSilent=true` and `attentionOnly=true`
  (`true` or `false`; anything else is `invalid`). `:category` in `GET /v1/categories/:category` is one of the seven
  categories, or several joined by commas (`invoice,receipt`) for one merged list, and `:stack` one of the stacks;
  anything else, an empty name included, is `invalid`.
- Bodies that differ from the service types:

| Route | Body | Response |
|---|---|---|
| `POST /v1/actions/approve`, `/reject` | `{ "actionIds": [..] }` | `ActResult` |
| `POST /v1/teach/:id` | `{ "accept": true }` | `Rule` or `null` |
| `POST /v1/triage/decisions` | `{ "decisions": [..] }` | `ActResult` |
| `POST /v1/inboxes/:id/rules` | `RuleDraft` without `inboxId` | `Rule` |
| `PATCH /v1/ai` | `AiSettingsPatch` (`credentials: null` removes the AI key) | `AiSettings`, once the test that new credentials or models start has run |
| `POST /v1/ai/test` | none | `AiStatus` |
| `GET /v1/ai/disclosure` | none (`gateway=vercel`, `provider=openai` or `provider=anthropic`) | `AiDisclosure`: the words to show before saving a key for that service |
| `GET /v1/ai/usage` | none (`tz=<IANA time zone>`, default `UTC`) | `AiUsage`: today, the last 7 and the last 30 days, by job and model |
| `GET /v1/first-sync`, `PATCH /v1/first-sync` | none; `{ "days": n }` | `FirstSyncWindow` |
| `DELETE` routes, `POST /v1/inboxes/:id/sync` | none | `204` |
| `GET /v1/messages/:id/attachments/:attachmentId` | none | the file's bytes with its type |
| `GET /v1/messages/:id/pictures/:pictureId` | none | the picture's bytes, with the type read from them ([pictures from the web](contract-pictures.md)) |
| `GET /v1/avatars/:id` | none | a sender picture's bytes: PNG, JPEG or WebP, kept for good ([sender pictures](contract-avatars.md)) |
| `GET /v1/search` | none (the query in parameters) | `SearchResult`: the threads with where they matched, `understood`, `people` ([search](contract-search.md)) |
| `GET /v1/search/remote` | none (the same parameters) | `RemoteSearchResult`: older mail in each inbox's mailbox, how each answered; nothing stored |
| `POST /v1/search/remote/:id/open` | none | `ThreadDetail`: that conversation brought in, placed as the mailbox has it; the same thread when called again |
| `POST /v1/search/ask` | `SearchAskInput` (`{ "question", "inboxIds"?, "tz"? }`) | `SearchAskResult`: `understood` and `text` to search with, `found`, the AI's state; no mail ([asking in a sentence](contract-search.md#asking-in-a-sentence)) |
| `GET /v1/senders` | none (`state=blocked`, `inboxId`, `limit`, `cursor`) | `Page<BlockedSender>`: the blocked senders, newest block first ([blocked senders](#blocked-senders)) |
| `POST /v1/senders/allow` | `{ inboxId, address }` | `ActResult`: the `allow_sender` record, if one was made, and the threads it changed |
| `GET /healthz` | none | `{ "ok": true }` |
| `POST /v1/google/sign-ins` | `GoogleSignInInput` | `GoogleSignInStart` |
| `GET /v1/google/sign-ins/:id` | none | `GoogleSignIn` |
| `GET /v1/google/callback` | none (Google's `state`, `code`, `scope` or `error` in the query) | a page, `200` or `400`; for a sign-in that proved the owner's email, `303` to the dashboard's `/claim?proof=<proof>` |
| `POST /v1/owner/claim` | `OwnerClaimInput` (`{ password, name, email?, proof? }`) | `PairResult` ([the owner's password](#the-owners-password)) |
| `POST /v1/owner/claim/google` | none | `OwnerClaimStart`: Google's address, to prove the host's owner email |
| `POST /v1/owner/sign-in` | `OwnerSignInInput` (`{ password, name }`) | `PairResult` |
| `GET /v1/owner`, `PUT /v1/owner/password` | none; `{ password }` | `Owner`: the owner's email, whether a password is set and when, never the password |
| `POST /v1/owner/recovery-code` | none | `RecoveryCodeAnswer`: which code waits (`owner` or `recovery`) and until when; never the code |
| `GET /v1/google/setup` | none | `GoogleSetup`: the browser agent's prompt with the redirect address filled in, the manual steps, the client's state and what is missing ([sync and providers](contract-sync.md#connecting-gmail-by-signing-in-with-google)) |
| `PUT /v1/google/client` | the JSON file Google's console downloads for a Web application client, as it is (`?replace=true` to replace a saved client file, used or not, or the client inboxes were signed in with) | `GoogleClientSaved`: the client's id, `replaced`, `googleSignIn` after the change, a redirect hint; never the secret |

- **Statuses:** `200` with a body or `204` without. Never `201`.
- **Errors:** every error is `{ "error": { "code", "message" } }` with the status in `ERROR_STATUS`. A
  `rate_limited` answer also carries a `Retry-After` header with the whole seconds to wait (the service gives
  them as `ServiceError.retryAfter`).
- **Events:** `GET /v1/events` is a server-sent event stream. Each event is one `MailEvent` as JSON in `data:`,
  with the event's `type` as the SSE `event:` name. The server sends a comment line every 25 seconds to keep
  the connection open. A client that reconnects reloads its lists; there is no replay.
- **Versions:** every change to an inbox, a thread, a record, a draft or a rule raises its `version` and sends
  `inbox.changed`, `thread.changed`, `action.recorded`, `draft.changed` or `rule.changed`. Several changes may
  share one event, so a version may rise by more than one. A client keeps whichever copy has the higher
  `version`. Deletions send `inbox.removed`, `thread.removed`, `draft.removed` or `rule.removed`.
- **Counts and the AI** carry versions too: `counts.changed` and `ai.status.changed` are sent at most once a second
  with the latest; `ai.settings.changed` is sent on every change of the settings, to people's devices only, and
  never carries the key. `sender.changed` (also people's devices only) carries no version: it says a sender is now
  blocked, with their item, or no longer blocked ([blocked senders](#blocked-senders)).
- **Syncing alone is not a change to an inbox.** When only `lastSyncedAt` moved, the inbox's version stays and no
  `inbox.changed` is sent; a client learns `lastSyncedAt` when it loads the inbox list. Any other change to the
  inbox (status, name, trust and so on) raises its version and sends the event.
- **Times** are ISO 8601 in UTC with whole seconds and `Z`, for example `2026-11-16T09:30:00Z`. No fractions.
- **Ids** are opaque strings.
- **One-line text.** A name (a device's, an inbox's) and what a rule matches on (`listId`, `subjectContains`) is
  trimmed, and is `invalid` when it holds a control character (C0, DEL, C1) or a line or paragraph separator (U+2028,
  U+2029): a name can't break a line of the server's log, and a match isn't quietly changed into another. Prose (a
  rule's text, an action's or a decision's reason, a brief's highlight line) is made one line instead: each of those
  characters becomes a space, every run of white space one space, and the result is trimmed; it is `invalid` only when
  nothing is left or it is too long, so one reason with a line break doesn't refuse a whole batch.
- **The dashboard** is mounted at the server's root. Two of its paths are part of the contract, so other
  interfaces may link to them: an inbox's page, `/inboxes/<id>` under the server's root (`DASHBOARD_PATHS.inbox` in
  `core/src/api.ts`), and setting up an unclaimed server, `/claim` (`DASHBOARD_PATHS.claim`), where the server's
  Google callback sends a proven owner. Every other dashboard path may change.

## Pairing and sign-in

- Every route but `/healthz`, `/v1/info`, `/v1/pair`, `/v1/google/callback`, and the owner's `/v1/owner/claim`,
  `/v1/owner/claim/google`, `/v1/owner/sign-in` and `/v1/owner/recovery-code` needs `Authorization: Bearer <token>`. A token belongs
  to one device: a person's app or browser, or an agent. `GET /v1/me` returns the device the token belongs to.
- A token comes from `POST /v1/pair` with a pairing code a person created. A code works once.
  - A wrong, used or expired code answers `unauthorized`.
  - **Wrong codes count per client address** (an IPv6 address by its /64), with wrong owner's passwords: after ten
    from one address in ten minutes, that address gets `rate_limited` (with `Retry-After`) until the oldest of them is
    ten minutes old, even with a good code; after thirty from one IPv6 /48, every address in it does; after a thousand
    from every address together, everyone does. The host says who the client is: Cloudflare's `CF-Connecting-IP`; on
    Node the connection's address, or, only when it comes from a proxy named in `USUAL_MAIL_TRUSTED_PROXIES`
    (addresses, ranges, `private` and `cloudflare`; a /0 range is refused at start), the right-most address in
    `X-Forwarded-For` that isn't one of those proxies. The counts are kept in memory; a restart forgets them. Cloudflare's door also answers 429 itself after
    five from one address.
- **An agent's token** is made by a person creating a pairing code of kind `agent` for chosen inboxes and
  pairing with it. There is no other way.
- **The owner's code.** Whenever no person's device is paired (at a start, after the last one signs out or is
  removed, or when the owner's code expires unused), the server makes a pairing code of kind `person` for the
  owner at once and prints it, once, when it is made. A new owner code ends the one before it. So the owner is never
  locked out until a restart.
  - A server run as an ordinary process also writes the code to `<data-dir>/owner-pairing-code`: the code and a
    newline, readable by the owner only. It removes the file once the code is used or expires, and writes it
    again with each new owner code.
  - **A later start keeps a code that still waits:** while the file's code is a valid, unused owner's code, the server
    keeps it and its log says one waits, until when and where its file is, without the code. The file is where the
    code is read, never the log. Without the file, or with a code no longer valid, it makes a new one.
  - Demo mode prints the code and writes no file (its store is new at every start, so every code is new).
- `DELETE /v1/devices/:id` with a caller's own id ends that caller's token. Only a person may revoke others.

### The owner's password

Decided by the owner on 2026-11-24. One owner per server, with a password (and an email, optional). Signing in with
it pairs the device as a person's: a browser or an app signed in that way is listed, kept and removed like any paired
device. Pairing codes stay: for agents, for the owner's other devices, and as the way back in.
- **`GET /v1/info`** answers `owner: OwnerInfo`: `password` (one is set), `claimable` (nobody has used the server yet:
  no password, no device ever paired, revoked ones included, and no inbox), and while claimable `claim`: `"password"`
  or `"google"`. A server without it has no password.
- **Claiming** (`POST /v1/owner/claim`, no token): an unclaimed server's first claim makes its caller the owner and
  answers `PairResult`, like pairing. Claimable is one-way: once the server has a password, an inbox, or any device
  (even one since revoked, by a browser's "Sign out" or an app's "Disconnect"), it answers `conflict` for good. The
  owner's code is then the way back in, and a server paired before passwords existed gets its password from a
  signed-in device. A claim ends the owner's code that waited (every unused person code, in the same write), and so
  does the first sign-in with the password while no person's device is paired.
  - **First visitor:** without an owner email, whoever claims first owns the server. The server's log says that it
    was claimed and from which device's name.
  - **The host's owner email** (`USUAL_MAIL_OWNER_EMAIL`, optional, every host): claiming then needs `proof`, which
    only Sign in with Google gives (`POST /v1/owner/claim/google`, no token: the identity scope `openid email`
    through the host's Google client and its usual redirect address, without a login hint, so the answer never holds
    the owner email; at most three waiting from one client address and a hundred in all, then `rate_limited` until the
    oldest expires). When the ID token's verified email (issuer,
    audience, expiry and `email_verified` checked; it comes straight from Google's token endpoint) is the owner
    email, compared exactly after lower-casing (the address the Google account shows, without removing dots or a
    `+` part), the callback sends the browser to the dashboard's `/claim?proof=<proof>`. A proof works once, for ten
    minutes, and is kept only as its hash, in memory. Without it `claimOwner` answers `forbidden`; with an unknown,
    used or expired one, `unauthorized`. The owner's email is then Google's, not one typed. A typed email is never
    proof. A value that isn't an email address keeps claiming closed. Without a Google client nothing can be claimed
    that way, and the owner's code still pairs.
- **The password:** at least `OWNER_PASSWORD_MIN` (12) characters, at most 256, compared after Unicode NFKC. Kept only
  as PBKDF2-SHA256 with a 16-byte salt and 100,000 iterations (the most Workers allow), in a form that names the
  scheme and the count.
- **Signing in** (`POST /v1/owner/sign-in`, no token): the right password answers `PairResult`; a wrong one
  `unauthorized`; none set yet `conflict`. Wrong passwords count with wrong pairing codes, per client address and for
  everyone together, as above.
- **Setting it** (`PUT /v1/owner/password`, a person): a first password or a new one, without the old one, since a
  person's device already has the owner's whole access. `GET /v1/owner` answers the owner, never the password.
- **A recovery code** (`POST /v1/owner/recovery-code`, no token), when the password is forgotten and no device is at
  hand: a pairing code of kind `person` that the server puts where its host puts the owner's code (the file and once
  in the log on Node; the owner's code's table on Cloudflare, never logged there) and never in the answer. While no
  person's device is paired, the owner's code already waits there and no other is made. One recovery code waits at a
  time, for 30 minutes (`RECOVERY_CODE_TTL_MS`), and works once; it is removed from its place once used or expired,
  and a restart forgets it from there. A person's code made on another device doesn't end it.

## Changing the contract

`core/` and this page change together, in one edit, by whoever coordinates the work. A part that needs a
change says exactly what and why in its report, and works around it locally until the change lands. Open
questions are kept in [agents/contract-questions.md](agents/contract-questions.md).
