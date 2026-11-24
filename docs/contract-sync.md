# The contract: sync and providers

Part of [the contract](contract.md) (fifth revision, 2026-11-17, as amended the same day, again after its review,
and after the owner's first run against Gmail: the first sync's days; and on 2026-11-23: how far a first sync has
got). Shapes are in `core/src/provider.ts` and `core/src/first-sync.ts`; the words, lists, actions and the sorting of
new mail are on the contract's main page.

## Sync

- **Noticing new mail.** The server checks every inbox on a timer (every minute unless the host is set otherwise).
  A provider's `watch` brings changes sooner where it has one: IMAP watches INBOX with IDLE. Gmail has none yet.
- **Gmail's push notifications are a later step.** They need, in the Google Cloud project that holds the person's
  OAuth client: the Pub/Sub API turned on; a topic; the Pub/Sub Publisher role on that topic for
  `gmail-api-push@system.gserviceaccount.com`; and a subscription the server reads. A pull subscription needs no
  public address, since the server asks Pub/Sub for messages; it needs a token allowed to read that subscription (for
  example the Pub/Sub scope added to the server's Google sign-in). The server would then call Gmail's `users.watch`
  with the topic at least every 7 days (Google recommends daily) and treat each notification (the mailbox's address
  and a history id, at most one a second per mailbox) as a reason to sync at once. Google may delay or drop
  notifications, so the timer stays. (From Google's Gmail and Pub/Sub documentation, read 2026-11-17.)
- **Which stored message new mail is** (decided 2026-11-18, after the pictures' third security review). A
  Message-ID is written by the sender, and everyone the person writes to learns it, so **a Message-ID alone never lets
  new mail change a stored message**: its content, sender, `outgoing` or placement. The same message at the provider
  is its ref (a Gmail message id; an IMAP folder and UID). On IMAP, where a move by another app or a new UIDVALIDITY
  gives a message a new ref, and the same message can sit in INBOX and Sent at once, a reported message with the same
  Message-ID **and the same content** (addresses but Bcc, subject, date, text, HTML, attachments) is the same message.
  Everyone who received a message knows its content too, so such a copy changes the stored message only when no one
  else could have sent it:
  - With the same evidence (both Sent or neither), it is the message moved there **once the stored copy's ref is
    reported removed**: in the same batch it takes the new ref and placement at once; otherwise the server holds the
    copy (`held_copies`, its later changes kept with it, forgotten when its own ref goes) and the move
    completes when that removal comes. Until then nothing changes.
  - A copy with Sent evidence of a message stored from another copy makes it the inbox's own (its thread's sender and
    screening are worked out again as if it had arrived that way; the stored copy stays the one placed).
  - A copy without evidence of a message stored as the inbox's own changes nothing.
  - In both, the other copy is held too, so the message stays, under the other copy's ref, when the stored copy goes.

  Gmail ids never change, so on Gmail only the ref counts. Anything else is a separate message from whoever it says
  it is from; one filed as spam or trashed on arrival isn't taken at all. Within one sync, of two copies at the same
  time, the one with Sent evidence is taken first.
- **The first sync is history.** The server takes mail from the last 30 days, or as many as the first sync's window
  says (`FirstSyncWindow.days`; the AI works through all synced mail that isn't done, so this window is the one setting
  that decides how much older mail it processes), as the provider has it: a filed category's label or folder is that category
  (`categorizedBy: "mailbox"`), the Screening label or folder screens it, a stack's label or keyword is that stack, and
  the senders of threads not filed under Screening are let in, without lifting anyone's screening. No rules run. A
  thread under no category's label is `unknown`, and the server's AI processes the history as
  [the server's AI](contract-ai.md) says. Which of it is done:
  - archived without a stack, under no filed category's label or folder: done;
  - under a filed category's label or folder, out of the inbox, on no stack: **not done**, however old inside the
    synced window, so a new server's category lists show the mail the first sync took (since 2026-11-18; before,
    only those within the AI's history days, a setting since removed, were);
  - filed under Screening: screened and not done, however old;
  - in the inbox or on a stack: not done.
- **How many days the first sync takes is a setting of the server that persists** (2026-11-17, after the owner's
  first run against Gmail). It is `syncDays` in `<data-dir>/settings.json`, which `usual-mail init` asks for and
  `usual-mail sync-days` changes; the data directory is what Node mode and Docker mode both keep, so every start finds
  it. `USUAL_MAIL_SYNC_DAYS`, where the server starts, wins over it (with Compose, that is the way to set it). 30
  without either. A window counts back from when each inbox was connected.
  - **A person reads and sets it** (2026-11-18): `GET /v1/first-sync` (`firstSyncWindow`) answers
    `FirstSyncWindow` (`days`; `setBy`: `environment`, `settings` or `default`; `changeable`), and `PATCH
    /v1/first-sync` with `{ "days": n }` (`updateFirstSyncWindow`) sets it, both a person's only (an agent's token
    gets `needs_person`). Whole days from 1 to 36,500 (`FIRST_SYNC_MAX_DAYS`), otherwise `invalid`; `conflict` while
    `USUAL_MAIL_SYNC_DAYS` sets it, or where the host keeps no settings (demo mode), with `changeable` false. The new
    number is written to settings.json (owner-only, whatever else the file holds kept) and applies at once, with no
    restart; the same number changes nothing. `usual-mail sync-days` writes the same file and restarts a server `init`
    set up, which has the same effect.
  - **Made smaller,** it takes effect for a first sync in progress: from its next sync round the provider is opened
    again with the new window, so mail older than it is no longer fetched; what was already fetched beyond it stays
    (nothing is deleted, and the AI processes it like all synced mail).
  - **Made larger,** it applies only to inboxes connected afterwards: an inbox already connected, its first sync
    running or finished, keeps what it has; fetching more for it would be a new first sync, which only removing it
    and connecting it again starts. Not built.
  - **No 0:** "only new mail" isn't a window the server takes (1 day is the least).
- **How far a first sync has got** (the owner's decision of 2026-11-23, after a first real run, where an inbox said only
  "connecting" for minutes). While an inbox's first sync runs, the inbox says how far it
  has got: `Inbox.firstSync` (`FirstSyncProgress`: `fetched` of `total`), which every interface shows in core's words,
  "Fetching your mail · 120 of 340" (`firstSyncWords`; `firstSyncCount` is "120 of 340", thousands with commas).
  - **What is counted:** messages, not conversations, as the provider lists the window (spam and trash in it too).
    `total` is what the window holds, fetched and still to fetch, as the provider counts it now: never below
    `fetched`, and lower when the window is made smaller while the first sync runs (above), or when mail in it leaves
    the mailbox before it was fetched. What arrives meanwhile is new mail, not counted.
  - **Where it comes from:** the provider, with every batch of the first sync (`SyncBatch.progress`), counted from its
    cursor, so the count goes on across sync rounds, restarts and a Durable Object's eviction; and, for a slow batch,
    while it runs (`SyncOptions.onProgress`; Gmail after each message, about one a second within its quota). Such an
    interim count may run ahead of what is stored: after a restart in the middle of a batch the count goes back to
    what the stored cursor stands for, at most one batch.
  - **When it shows:** once the first sync has run `FIRST_SYNC_PROGRESS_EVERY_MS` (two seconds) in this server process,
    then at most that often; a count heard in between waits for the next. A first sync that ends sooner never shows
    one, so a small mailbox goes from `connecting` to `ok` as before. Each count shown is written to the inbox (the
    inbox list has it, also after a restart), raises its version and sends `inbox.changed`.
  - **While it is present the first sync is still running, whatever the status.** It stays, at the count it reached,
    while the inbox is paused or needs attention (interfaces show those instead), and the first sync goes on from
    there. Pausing stops it once the batch being fetched is stored (the pause answers at once; see "A paused inbox"
    below), so no count is sent while it is paused, and resuming goes on from the stored cursor, its first count again
    two seconds in. New credentials keep the count too, and the first sync goes on from the cursor with them. It goes
    when the first sync is done, together with the status turning `ok` (one version, one
    `inbox.changed`). A first sync longer than one sync's rounds (10,000 batches: 250,000 messages on Cloudflare)
    shows `ok` before it is done, still with its count. Later syncs never show one.
  - A provider that can't count sends none; the inbox then says `connecting` without a count, as before. So does a
    first sync begun by a build from before 2026-11-23 until its next batch, which counts from where the new build
    took over.
- **After that,** new mail starts a thread or joins one by its `threadKey`. A new thread is sorted or keeps its filing
  as [Rules and learning](contract.md#rules-and-learning) says. New mail in a done thread brings it back, unless the
  new message's sender is blocked or the thread is trashed. A reply from someone else ends a `comeBackIfNoReply` wait.
- **A blocked sender writing into an existing thread changes nothing a person sees.** The thread keeps its place in
  every list (its `lastMessageAt`), its snippet, its unread state, its participants, message count and attachments,
  and its version; no `thread.changed` is sent for it. A `comeBackIfNoReply` wait doesn't end, a done thread doesn't
  come back, and the message isn't among `thread(id)`'s messages or a triage item's. Nothing of it is sent to a model,
  and it makes no work for the AI. The server still holds it, as the mailbox does. (A thread the blocked sender started
  still shows their messages; it is done, so only search finds it.)
- **New mail joining a thread isn't a move.** Wherever the provider delivers mail that joins a thread, the server
  writes it to where its thread belongs (see [Providers](#providers)).
- **A host may keep a message only up to a size** (2026-11-21). On Node every message is kept as it came. On
  Cloudflare a stored message's text, HTML and headers together stay within 1,900,000 bytes (a Durable Object's row
  holds at most 8 MB): over that, headers no message needs that long are cut when they alone take more than a quarter
  of it, then the HTML is left out and the text kept (made from the HTML when there is none or only a stub of it),
  then the text is cut, each with a note at the end of `text` saying to open the message in the mailbox. The mailbox
  keeps the whole message; the same message read again is kept the same way.
- **Spam.** A thread whose incoming messages are all in the provider's spam is treated like a trashed one: it is
  `trashed`, in no list, and taking it out of spam there takes it out of the trash here. New mail delivered to spam is
  ignored, and never reaches the AI. When such mail is taken out of spam there (Gmail's "Not spam", or a move out of
  the junk folder), the provider sends it whole (see [Providers](#providers)) and it arrives as new mail delivered
  wherever it now sits: in the inbox it goes through the steps for a new thread, anywhere else it keeps that filing.
- **Changes made at the provider win:**
  - Archiving a thread there (out of the inbox, under no filed category's label or folder) marks it done here.
  - Moving it into the inbox there puts it in Home: `conversation` (decided by the mailbox), not screened, not
    done, off its stack and no longer waiting. The server then removes the stack's label or keyword and any
    category's or Screening label or folder it still has. A stack's label or keyword added at the same moment wins:
    the thread is on that stack instead.
  - Moving it from the inbox to a filed category's label or folder, or adding that label, changes its category
    (decided by the mailbox). It isn't done by that.
  - Removing a filed category's label there, or moving its message from the category's folder to the archive, makes
    it a `conversation` decided by the mailbox (no label means a conversation), done when it is out of the inbox.
  - Adding the Screening label or moving it into the Screening folder screens the thread; removing it, or moving the
    thread out, stops screening that thread. Its sender isn't let in or out by it. This is the mailbox's own filing,
    not the sender gate: it holds even a one-time code (no `categorize` to `otp` lifts it), and letting the sender in
    lifts it.
  - Adding a stack's label or keyword there puts it on that stack, even when it was archived at the same time.
    Removing it takes it off; a `conversation` or `unknown` thread that is then out of the inbox and not waiting is
    done.
  - Trashing it there trashes it here, and taking it out of the trash there takes it out here.
  - The seen flag sets read and unread.
- **When a come-back time passes,** nothing on the thread changes except its version, which rises, so it ends no
  undo. The server sends `thread.changed`, and a thread that now shows in Home goes back into the provider's inbox.
  A time that passed while the server was stopped is handled at the next start.
- **The server never places or flags outgoing mail,** so Sent stays as the provider keeps it.
- **A paused inbox isn't synced or written back.** The pause answers at once, with the inbox `paused` and
  `inbox.changed` sent. A sync running then (a first sync's included) stops once the batch being fetched is stored,
  in the background: that batch isn't cut short (up to 200 messages on Node, which a Gmail first sync takes about two
  and a half minutes to fetch, and 25 on Cloudflare), and nothing more is fetched. New credentials likewise answer at
  once; the running sync stops after its batch, and the inbox syncs again with the new credentials, from where it
  was. Removing an inbox answers at once too: it is gone from lists and sends `inbox.removed` before the answer, its
  address may be connected again straight away (a new inbox), and the batch a running sync was fetching for it is
  dropped. Actions
  on its threads still apply here and are recorded; a come-back time still passes, and the AI may still process
  threads the server holds. What they change is written back when the inbox is resumed, after its first good sync,
  where a change made at the provider meanwhile wins as usual. A refusal then fails the records as any write-back
  does.
- A message with a ref the server doesn't know is matched by its Message-ID and content before it counts as new,
  because a move gives a message a new ref (see "Which stored message new mail is" above).
- A thread whose messages are all gone at the provider is removed, with `thread.removed`.
- A failed sync sets the inbox to `needs_attention` with the reason in `statusDetail`.

## Providers

The server keeps the provider in step, so the provider's own app shows roughly the same picture and a new server can
read back what this one worked out. **A conversation or undecided thread is in the provider's inbox exactly when it
shows in Home.** A notification (in its own list, not Home, since 2026-11-19) stays as every filed category does,
out of the inbox under its label or folder, so making it done changes nothing at the provider; the person's own mail
app shows it under that label, done or not.

| In Usual Mail | At the provider |
|---|---|
| In Home: `conversation` or `unknown`, not screened, not done, on no stack, not waiting | In the inbox, under no category's or Screening label |
| `conversation` or `unknown`, not screened, and done, on a stack or waiting | Out of the inbox (archived), under no category's label |
| A filed category, not screened, whatever its state | Out of the inbox, under that category's label or folder |
| Screened | Out of the inbox, under the Screening label; with Gmail also under its filed category's label. IMAP keeps one folder per message, so a screened message is in the Screening folder and only the server keeps its category |
| On a stack | Also carries the stack's label (Gmail) or keyword (IMAP) |
| Read or unread | Seen flag |
| Trashed | The provider's trash |

- **Labels and folders** live under `Usual Mail/`: `Newsletters`, `Invoices`, `Receipts`, `Notifications`,
  `One-Time Codes`, `Screening`, `Reply Later`, `Set Aside`. `conversation` and `unknown` have none.
- **No label means `conversation` or `unknown`,** so the mailbox can't tell them apart: a new server reads a thread in
  the inbox under no label as `unknown`, and its AI decides it again (about two requests for each thread in the
  inbox); an archived one stays `unknown` until new mail brings it back. So a person's correction to `conversation`
  is the one decision not written back, and it is lost with the server (why: see
  [the mailbox is the main database](contract.md#the-mailbox-is-the-main-database)).
- **Known only to the server, and lost with it:** come-back times, summaries, whether a thread in a filed category is
  done (a new server reads those its first sync takes as not done), and whether a sender is
  let in or blocked (a new server lets in the senders of its first sync's history, except those filed under
  Screening, and knows no block). At the provider a waiting `conversation` thread looks done, and so does a stacked
  one in a mailbox that can't keep stacks.
- **Earlier revisions' piles.** No real mailbox has been connected to any build, so nothing at a provider needs
  moving. A server store from the fourth revision upgrades: `people` becomes `conversation`, `reads` becomes
  `newsletter`, `receipts` becomes `receipt`, a `screening` thread becomes screened in `unknown`; `triage` becomes
  `categorizedBy` (`by_rule` rule, `by_agent` agent, `by_person` person, `pending` none). A thread nobody had decided
  (`pending`) becomes `unknown` whatever its pile, a pending one in `people` included, since a decided category always
  says who decided it. Upgraded threads have no `categorizedByActor`. A `move` in a record or a
  rule becomes a `categorize` to the matching category; a move into `screening` has none, so such a record is dropped
  and such an action leaves its rule, and a rule left with no action is switched off.
- **Gmail** writes labels with one modify per message (5 of a mailbox's 6,000 quota units a minute), so categorizing
  costs about as much as the piles' moves did. Its labels are per message; the server places every message of a
  thread alike.
- **What a provider must do:**
  - Say what of its credentials isn't secret (`connection()`), without the network.
  - Call a message `outgoing` only on its own evidence that the mailbox sent it: Gmail's SENT label, IMAP's Sent
    folder. Never because From names the mailbox: anyone can write that (the decision of 2026-11-18). The server adds
    one more piece of evidence of its own: a copy of exactly what it sent from that inbox (its Message-ID with the
    same From, To, Cc, subject, text, HTML and attachments; what it sends is text only, so the copy has neither).
  - Give each message a ref that stays its identity while it stays where it is; a new ref is a new message unless
    the server recognises it by content (above). **Report every ref the server holds as removed when it goes**,
    including a ref `apply` returned for a move the provider made itself (IMAP: a message another app moved on
    before a sync saw it where it was moved to): without that removal the server takes the copy where it went for
    someone else's copy, and holds it.
  - Report a placement exactly as `apply` last wrote it: `category` as the filed category or `null` for none,
    `screened` for the Screening label or folder. Anything else reads as a change made elsewhere. While a message is
    trashed or in spam, only that counts in its placement.
  - Leave `category` out where it can't keep one: IMAP while a message sits in the Screening folder. The server then
    keeps the category itself.
  - Report mail delivered outside the inbox where it landed: a filed category's label or folder as that category,
    the Screening label or folder as screened, archived as out of the inbox with no category, spam as `spam`.
  - Report `stack` as the stack, `null` for none, or leave it out when the mailbox can't keep stacks. The
    server then keeps the stack itself.
  - Treat a ref as a location. Return the new ref when `apply` moves a message. The server stores that ref before
    its next `sync`, so the provider may then report the message under it in `changed`. In `sync`, a moved
    message's new ref arrives before or with the removal of its old one.
  - Send flag and placement changes as `changed` when it can, so the message needn't be fetched again. The server
    ignores a `changed` entry for a ref it doesn't hold.
  - **Send a message that leaves spam whole, in `upserted`, never as `changed`,** also when it moved the message
    itself. The server ignored it while it was in spam and doesn't hold it, so it would drop a `changed` entry. The
    server then treats it as new mail delivered wherever it now sits. Leaving the trash needs no such care: the
    server holds trashed threads.
  - Count `upserted` and `changed` together against `limit`. Removals don't count.
  - **Say how far a first sync has got** (2026-11-23): `progress` (`sent`, `total`) on every batch of the first sync,
    from the call with a `null` cursor to the batch that sends the last of its window (an empty window: one batch, 0 of
    0), counted from the cursor so it carries on in a new provider; none on later batches. `total` is what was sent and
    what is still to send inside the window as narrowed. A provider whose batches are slow calls `onProgress` while one
    runs. Gmail: the listing's ids (`n` in its cursor, kept with `f`), `onProgress` once the window is listed and after
    each message. IMAP: the messages of its "first" backlogs (`fs` in its cursor), searched again at each call, so
    removals and a smaller window lower the total; no `onProgress`, since a batch is quick.
  - **Narrow a first sync in progress to a later `since`.** When it is created with a later `since` than the window a
    first sync still being sent began with (the window was made smaller), send nothing older than it from then on, and
    report nothing it sent as removed: a listing after it lost its place still covers the window the first sync began
    with. An earlier `since` never widens a first sync. Mail that arrives later is still taken whatever its date.
  - Set `reset` when it lost its place and is listing its window again. The listing is every ref in `upserted`
    and `changed` from the batch that sets `reset` until a batch says `more: false`, in that call or a later
    one. When it ends, the server drops what it didn't include. A provider that can still say exactly which refs
    are gone (IMAP after a UIDVALIDITY change) may report them as removed instead, after their new copies.
  - Expect `inInbox: true` in `place` and `untrash` only with `category: null` and `screened: false`, and refuse
    anything else.
  - Put an untrashed message where the `untrash` op says.
  - Use `note` for something a person should know about a change that worked, and `error` only with
    `ok: false`. The server shows an op's note on the action record that caused it, and a send's note on the
    draft.
- **Optionally, search the mailbox itself** (`search` and `fetchThread`, both or neither; 2026-11-20,
  [search](contract-search.md#older-mail-in-the-mailbox)): find conversations by the words, phrases, exclusions and
  filters the server gives (`ProviderSearchQuery`), translated into its own query language, newest first, a page at a
  time, leaving out spam and trash, each light (its key, subject, newest sender and time, its own preview, whether it
  has an attachment, how many messages, whether any is in the inbox); and read one conversation whole, every message as
  `sync` would send it (refs, placement, flags, `outgoing` on its own evidence), oldest first. Both are read-only:
  nothing changes at the provider. Gmail has them (its own search operators, `threads.list` and `threads.get`); IMAP
  doesn't yet, and the server answers `unsupported` for such an inbox. The provider contract's tests check either both
  or neither, and with them every point above (`mail/src/testing/contract-search.ts`). The search text goes to the
  person's own mailbox provider, never to the AI service.
- Stacks, come-back times and categories move messages at the provider often, so a provider should avoid fetching a
  message again after a move it made itself, where it can.
- Batches may arrive in any order. The server orders mail by its date.

## Connecting Gmail by signing in with Google

Shapes are in `core/src/google.ts`, `core/src/google-client.ts` and `core/src/google-setup.ts`. Added on 2026-11-17 for
the owner's first run against their own mailbox: one Google client the host owns, the server on the host's Mac first.
Google's documentation behind it (OAuth 2.0 for web server applications and for installed applications, Using OAuth
2.0, the Gmail API's scopes and `users.getProfile`, unverified apps, managing an app's audience, restricted scope
verification) was read on 2026-11-17. **It has run against Google once** (the owner's own sign-in, the same day: it
worked); the tests use a fake of Google's endpoints built from that documentation.

- **The Google client is the host's.** A Google OAuth client of type **Web application**, whose authorized redirect URI
  is exactly `<the server's root>/v1/google/callback`. The server gets it from the environment where it starts (it
  wins), or from where the host keeps it: on Node a file in the data directory that only the owner can read, written by
  the host (`usual-mail google set`, or by hand) or **by a person's own paired device through `PUT /v1/google/client`**
  (the owner's decision of 2026-11-21: a sandboxed app can't write the server's folder, and a hosted server has no
  folder). No route, event or log returns the secret. `ServerInfo.googleSignIn` says whether sign-in is available, the
  redirect address to register, and what is still missing (`client`, `address`).
- **The guided set-up** (`GET /v1/google/setup`, person only; `GoogleSetup`) serves the same words to every app and the
  command: `googleSignIn` as above; `client` (`GoogleClientState`: where it comes from, `environment`, `saved` or
  `none`; its id when there is one, never the secret; `changeable`, whether a device may give one now, and while not,
  `reason` in words; and `note`, optional, when something needs saying first: a saved client file the server doesn't
  use, or inboxes signed in with a client the server doesn't have now, with their client ids); and, while the server knows its own address, `prompt` (the browser agent's prompt of
  [google-setup-agent.md](google-setup-agent.md) with that address on its redirect line, the Gmail addresses and the user
  type left `[FILL IN: …]`), `promptNote` (what to do with it) and `steps` (section 1 of
  [google-setup.md](google-setup.md) as seven `GoogleSetupStep`s: `id`, `title`, one or two `lines`, the console `url`,
  and values to `copy`: the project and app names, the scope, the redirect address, the client's name). Without an
  address there is no prompt and no steps, and `noAddress` says the host must set `USUAL_MAIL_PUBLIC_URL`; no app can.
  The words are core's (`googleSetup`); core's check fails when the prompt and the guide's code block differ.
- **Giving the client** (`PUT /v1/google/client`, person only; an agent gets `needs_person`). The token is checked
  before any of the body is read. The body is the JSON file Google's console downloads for a Web application client, as
  it is, at most `GOOGLE_CLIENT_FILE_MAX_BYTES` (16,384 bytes: refused at once when Content-Length says more, and
  otherwise as soon as more has arrived); the server checks it as `usual-mail google set` does
  (`readGoogleClientFile`) and keeps it unchanged. It answers `GoogleClientSaved`: `clientId` (as an inbox's
  `connection` shows it); `replaced`, true when something was replaced (a saved client file, used or not, or inboxes
  signed in under another client id, which must now sign in again); `googleSignIn` after the change; and
  `redirectHint` (`googleRedirectHint`'s words) when the file lists redirect addresses but not the server's. Refused,
  with nothing saved, in the server's own words and never with any of the file: `unauthorized` without a token, also
  for a body too large; `conflict` while the environment gives the client, while the server keeps none (demo mode),
  and, without `?replace=true`, while there is anything to replace: a client file the server uses (another client
  stops every inbox connected by signing in with Google until each signs in again; the same client id keeps them
  working, and the words say which), a client file it refuses (others can read it, or it isn't a Web application
  client's: the words say why and how the host fixes it, or that confirming replaces it), or, with no file at all,
  inboxes signed in under another client id (for example while the environment gave the client, which the host then
  removed; the words name their client ids), each answered in words for a person that end by asking to confirm and
  name no flag, since an app shows them above its own button (a caller confirms with `?replace=true`); `invalid` for a
  file too large, not JSON, a Desktop app client's (`installed`) or one without `web.client_id` and
  `web.client_secret`, and for `replace` other than `true` or `false`; `internal` when the host couldn't keep it.
  Neither set-up route is a `MailService` method: the server serves them itself, like the callback.
- **The server knows its own address from its host's settings, never from a request,** with one exception below. On
  the host's own machine it is the loopback address and port it listens on (`http://127.0.0.1:8585/v1/google/callback`
  for a server on port 8585); a server listening on every address needs its public HTTPS address set. Google takes
  plain HTTP only for loopback addresses. **The exception (the owner's decision of 2026-11-21): a host whose platform
  routes only chosen hostnames to the server,** Cloudflare, takes the request's own host, for that request only and
  never stored, and only when it is a hostname routed to the server on purpose: the Worker's own workers.dev address,
  or the host of `USUAL_MAIL_PUBLIC_URL` (a custom domain). Always `https://`. Any other host, and anything outside a
  request, gives no address (`missing` includes `address`), and a forwarded host header never counts.
- **Starting** (`POST /v1/google/sign-ins`, person only; `conflict` while it isn't available) connects a new inbox,
  with an optional name (default the mailbox's address), colour (default the slate hat) and icon, or, with `inboxId`,
  reconnects that Gmail inbox in place (another provider's inbox is `invalid`). It answers with Google's address to
  open in the person's browser and when it expires, ten minutes on. The address asks for the one scope
  `https://www.googleapis.com/auth/gmail.modify` (read, change, label and send mail; never delete it for good), offline
  access with consent (`access_type=offline`, `prompt=consent`, so Google gives a refresh token every time), PKCE
  (`S256`), and a random `state` of 256 bits. A reconnect names the inbox's address as `login_hint`; a new inbox also
  asks Google to show the account chooser (`prompt=consent select_account`). No other scope: the mailbox's address
  comes from Gmail's `users.getProfile`, which `gmail.modify` allows.
- **Coming back** (`GET /v1/google/callback`, no token: it is the person's browser, sent back by Google). The server
  finds the sign-in by its `state`, which works once, for ten minutes; anything else gets a page that says the sign-in
  isn't one it waits for, and nothing happens. It exchanges the code with the PKCE verifier and the same redirect
  address, checks that the granted scopes include `gmail.modify` and that Google gave a refresh token, asks Gmail which
  address the mailbox is, and then:
  - reconnecting: refuses another account than the inbox's (`wrong_account`; nothing changes), or replaces the inbox's
    credentials in place, as changing credentials does (`connecting` until its next good sync; a paused inbox stays
    paused; rules, history and settings stay);
  - connecting: when a Gmail inbox with that address exists, reconnects that one in place (the name, colour and icon
    given are not used); otherwise connects a new inbox (trust `suggest`, last in the list).
  Either way the usual `inbox.changed` is sent. With an AI key set, its mail goes to the AI like every inbox's (there
  is no per-inbox switch since the owner's decision later that day).
- **The page** says it worked and to go back to Usual Mail, or why it failed in words a person can act on. It shows
  only the server's own sentences and the mailbox's address, escaped; never the code, the state, a token or anything
  Google wrote (an `error` Google sends back is only matched against the codes the server knows). It loads nothing,
  runs no script, holds no form, sends no referrer, and is never cached or framed. Its status is `200` when it worked,
  `400` otherwise.
- **The outcome** (`GET /v1/google/sign-ins/:id`) is for the device that started the sign-in only; any other device
  gets `not_found`, an agent `needs_person`. It is `waiting` until the person comes back or it expires, then
  `connected` (with `inboxId` and `reconnected`) or `failed` (with `failure` and the page's words in `message`). It
  can be read for an hour from the start. Sign-ins live in the server's memory: a restart ends those still waiting.
- **Failures:** `declined` (the person didn't allow it: Google's `access_denied`), `scope_missing` (Gmail access left
  unticked), `no_refresh_token`, `expired`, `wrong_account`, `cancelled` (the device that started it, or the inbox being
  reconnected, was removed meanwhile), `google_error` (Google refused, or sent another error back), `mailbox_error`
  (Gmail didn't accept the new access). A failure connects and changes nothing.
- **Tokens.** An inbox connected this way keeps, sealed like other mailbox credentials, only the client's id and the
  refresh token; the server adds the host's client secret whenever it opens the mailbox, so the host can change the
  secret without anyone signing in again. Its `connection` says `signIn: "google"`. When Google refuses the token (it
  was revoked, it expired after seven days in Testing, the account's password changed), the inbox needs attention with
  words that say to sign in with Google again, and nothing else changes. When the host's client is gone, or is another
  client than the one the token belongs to, the inbox needs attention with words that say so.
- **Removing an inbox connected this way revokes its token at Google** (`POST https://oauth2.googleapis.com/revoke`),
  after the removal, in the background; a refused or failed revocation doesn't stop the removal and is only noted in
  the log. Google's documentation says revoking ends the whole grant of that Google account to the client's project:
  every token of it, so also that account's access through the same client on another server. A token given by hand
  is the person's own and is not revoked. Reconnecting doesn't revoke the old token (Google would end the new one with
  it), and a sign-in that fails after Google issued tokens drops them without revoking them (revoking could end an
  inbox of that account that works); the person can remove the access in their Google Account.
- **Safety.** The `state` can't be guessed (256 random bits; the server keeps only its SHA-256), used twice, used after
  it expires, or read by another device. The callback can't connect an attacker's mailbox to a person's server unless
  the attacker holds that person's Google address for the ten minutes it works; on a loopback redirect only a browser
  on the server's own machine reaches the callback. An agent can never start a sign-in or read one, nor give the server its client or read the set-up; the callback
  connects only for the person's device that started it, and only while that device is paired. Nothing redirects to an
  address taken from a request, except, on a host whose platform routes only chosen hostnames to the server
  (Cloudflare), the request's own host when it is one routed there on purpose (above); a forwarded host header never
  counts. The client secret, refresh and access tokens, the code and the verifier appear in no
  response, event, log or file, except sealed in the store and in the host's own client file.
- **Credentials given by hand** (`credentials` when connecting or changing an inbox) stay as they were: the client id,
  secret and refresh token. They may not carry `signIn` (`invalid`).
- **Google's rules,** as the command and the dashboard tell a host (`GOOGLE_RULES_WORDS`): `gmail.modify` is a
  restricted scope; until Google verifies the app, Google warns that it isn't verified before anyone signs in, and an
  app only its developer or a few people they know use needs no verification; while the consent screen is in Testing
  only the listed test users (up to 100) can sign in and each sign-in stops working after seven days, so the person
  signs in again weekly; published and unverified, an app takes at most 100 users ever and keeps the warning; a server
  hosted for other people needs Google's verification and, for a restricted scope, a security assessment by an assessor
  Google names, repeated every year.
