# Apps: the data layer (`apps/Packages/UsualMailKit`)

Split out of [apps.md](apps.md) on 2026-11-18 to keep it under 500 lines: the models, the API client, the
on-device copy and the store the Mac screens read. The screens are in [apps.md](apps.md).

## What is implemented

- **Models** mirror `core/src/domain.ts`, `ai.ts`, `service.ts` and `events.ts`, field for field, on the contract's
  **fifth revision** (2026-11-17, with its follow-ups: the contract in three pages, `docs/contract.md`,
  `contract-ai.md`, `contract-sync.md`). A test encodes the decoded `sample.json` back and compares it with the original.
  - Fifth revision (`Models/Category.swift`, `AI.swift`, `Counts.swift`): a thread's `category` (`Category`:
    `.conversation, .newsletter, .invoice, .receipt, .notification, .otp`, and `.uncategorized` for the contract's
    `"unknown"`; a value this app doesn't know stays `.unknown(raw)`, kept whole, and lists and counts treat it as
    uncategorized via `isUncategorized`/`listed`), `categorizedBy` (`CategorySource`: ai, rule, agent, person, mailbox),
    `screened` and `summary`; `pile` and `triage` are gone. An inbox's `icon` (`InboxIcon`: person, building, briefcase,
    house, shop, globe) and `position` (the per-inbox AI switch is gone: consent is the AI key). `Doer.ai(job:model:)`
    (`AiJob`: categorize, summarize). `ActionInput.categorize(Category)` replaces `move`. Brief counts by category
    (`count(in:)`, `doneCount`, `trashCount`). `Counts` (`all`, `inboxes`, `version`, `counts(for:)`) of
    `ThreadCounts` (home, unread, categories, stacks, waiting, screened). `AiStatus` (state, detail, job, lastRunAt,
    pending, version; `AiState` with `needsAPerson`), `AiSettings` (connection, credentialsSet, jobs, paused,
    version), `AiConnection` (gateway or direct, an unknown kind kept whole),
    `AiCredentials` and `AiSettingsPatch` (the key is sent, never stored on the device). Events `counts.changed`,
    `ai.status.changed`, `ai.settings.changed`.
  - The AI history setting is gone (2026-11-18, the server's Part B): no `historyDays`, `maxHistoryDays` or
    `beyondHistory`; the AI works through every synced thread that isn't done. The one knob for old mail is the
    first sync's window (`Models/FirstSync.swift`): `FirstSyncWindow` (days, `setBy` `FirstSyncSetter`:
    environment, settings, `serverDefault` for "default"; `changeable`) and `FirstSyncWindowPatch`; and since
    2026-11-23 how far a first sync has got: `Inbox.firstSync` (`FirstSyncProgress`: fetched, total; `count` "1,200 of
    3,400" and `words` "Fetching your mail · …", core's words mirrored; `sum` of the inboxes that have one, nil when
    none has),
    `Inbox.fetching` (the count while `connecting` or `ok`) and `Inbox.isFetching` (`connecting`, or a first sync still
    running); kept in the on-device copy with the rest of the inbox's JSON;
    `APIClient.firstSync()`/`updateFirstSync(_:)` (`/v1/first-sync`); `MailStore.firstSyncWindow` (filled in the
    refresh for a person), `loadFirstSyncWindow()`, `updateFirstSync(days:) -> Bool` (a refusal, `invalid` or
    `conflict`, goes to `problem`; a window saved during a refresh isn't overwritten by it). Onboarding's
    "How much old mail?" step uses it.
  - AI usage (2026-11-18, Part C; `Models/AiUsage.swift`): `AiUsage` (since, timeZone, `periods` today,
    last7Days, last30Days; `rows(in: AiUsagePeriod)`), `AiUsageRow` (job, model, requests with failures included,
    failed, input/output tokens or nil, `tokensPartial`, `cost` `AiUsageCost` {amount, currency} or nil,
    `costPartial`), one row per job and model. `APIClient.aiUsage(timeZone:)` (`/v1/ai/usage?tz=`) and
    `MailStore.aiUsage`/`loadAiUsage(timeZone:)`. Person-only: `needs_person` and an unreachable server leave it
    nil quietly; anything else goes to `problem`. No event: Settings asks again.
  - Pictures through the server (2026-11-18, `docs/contract-pictures.md`; `Models/RemotePictures.swift`):
    `Message.remotePictures` (`RemotePictures`: shown, trackersRemoved, trackers, `heldBack` `PicturesHeldBack`
    screened, blocked or unknown; absent when the HTML takes nothing from the web, encoded only when present; kept in
    the copy's message JSON, no schema change) and `APIClient.picture(messageId:pictureId:) -> AttachmentData`
    (`/v1/messages/<id>/pictures/<picture id>`, the person's token; 404 `not_found`, 502 `provider_error`, 403
    `needs_person`; a refused picture comes as a blank 200 GIF, 502 is only a site that failed).
    `Message.htmlTooLarge` (the server left out HTML over 1,000,000 characters; absent decodes as false, written only
    when true).
  - `MailStore.detail(threadID:)` (`Store/MailStore+Detail.swift`, 2026-11-18, for Feed's posts): a thread's detail
    without marking it read or touching `openThread`/`openThreadID`: the server's copy, saved as `open` saves it, or the
    on-device copy offline; failures raise no problem.
  - `MailThread.payment` (`Models/Payment.swift`, 2026-11-19; core's `PaymentDetails`): party, amount {minor,
    currency}, refund, dueDate (a calendar date), what, `state` (`PaymentState` paid, scheduled or due; unknown or
    absent is nil); `MailThread.event` (`Models/NotificationEvent.swift`, 2026-11-19): status, about, when {date,
    time, endTime}, `group` (opaque, only compared), the mail's local reading, written only when present; re-sorting a thread clears it; only on processed receipt and invoice threads; kept in the
    copy's thread JSON (no schema change); re-sorting a thread clears it at once in the app.
  - Sender pictures (2026-11-19, `docs/contract-avatars.md`; `Models/SenderPicture.swift`, `Storage/SenderPictures.swift`):
    `MailThread.avatar`/`Message.avatar` (`SenderPicture`: picture, `fit` fill or inset with unknown as inset, size;
    written only when present). Only a picture of exactly `/v1/avatars/<32 lowercase hex>` has an `id`; anything else
    is initials. `APIClient.avatar(id:)`. `MailStore.senderPictures` caches: memory (`NSCache`, 400, which a critical memory-pressure event empties, and which
    then keeps no new stills until the pressure is back to normal: a row fades the picture in from disk; tests give a
    stand-in), disk under
    `Caches/UsualMail/Avatars/<id>` for good, one request per id at a time, a 404 or a refused picture remembered
    until the id changes or the app restarts, offline retried. Decoding: Content-Type PNG, JPEG or WebP and ImageIO
    agreeing, at most 4096 px a side read from the header, a still of the first frame at most 64 px. A
    `thread.changed` with a higher version for the open thread now refetches its detail (without marking read).
  - The amendment of 2026-11-17 (after the fifth revision, final): a thread's `sender` (the address screening, letting
    in and blocking are about) and `categorizedByActor` (who decided, by name). Letting a sender in or blocking them now
    changes, at once, every thread the copy's lists hold from that sender in that inbox (`MailLists.everyThread`;
    the named threads settle from the server's answer, the others from their events; a refusal takes all of them
    back). "Why it's here" names the agent, and a rule by its own text, looked up by its id. `APIClient.categories(_:)`
    asks for several categories as one list (`/v1/categories/invoice,receipt`), sending only known names and none
    when none are left; the paper trail will use it when its page is built. A one-time code may be screened; a
    person's own `otp` choice lifts the gate on screen, and the server's answer settles it.
  - Fourth revision, kept: `Inbox.connection` (`InboxConnection`: `.imap(imap:smtp:saveSent:)` with two `ServerLogin`s,
    `.gmail(clientId:)`, or `.unknown` kept whole for a kind a newer server sends); `Rule.version` and
    `Rule.createdBy`; the events `rule.changed` and `rule.removed`; `HandledQuery.attentionOnly`.
  - An older server's store may give an empty host, user or client id; those decode and show as "Not known". A rule
    from before rules recorded their maker has `createdBy` `system`.
  - New credentials have their own types, in core's shapes: `ImapCredentials`, `GmailCredentials` and
    `InboxCredentials`, whose `json` goes into `InboxPatch.credentials`. They are never stored on the device.
  - Signing in with Google (`core/src/google.ts`, 2026-11-17): `ServerInfo.googleSignIn` (`GoogleSignInInfo`:
    available, the redirect address, what is `missing`; nil from an older server, which can't), `.gmail(clientId:
    signIn:)` with `InboxConnection.signsInWithGoogle`, and `GoogleSignInInput`, `GoogleSignInStart`, `GoogleSignIn`
    with its open `state` and `failure`. `APIClient.startGoogleSignIn(_:)` and `googleSignIn(id:)`.
    `GoogleSignInFlow` (`Store/`) runs it: asks `/v1/info` whether the server can (else says in words what whoever
    runs it must set up), starts a sign-in (a reconnect sends only `inboxId`), opens Google's page (a web page only:
    http or https), then asks once a second until it is connected, failed (the server's words, else its own per
    failure) or `expiresAt` plus 15 s has passed; once connected it refreshes the store so the inbox appears. Leaving
    the screen cancels the asking; the server lets the sign-in expire. While `/v1/info` says the client is `missing`,
    the flow's step is `.needsClient` and the screens show the guided set-up.
  - The host's Google client from this device (`core/src/google-client.ts`, `google-setup.ts`, 2026-11-21;
    `Models/GoogleClient.swift`): `GoogleSetup` (googleSignIn, `client` `GoogleClientState` {source
    `GoogleClientSource`, clientId, changeable, reason, `note`}, prompt, promptNote, `steps` of `GoogleSetupStep` {id
    `GoogleSetupStepId`, title, lines, url, `copy` of `GoogleSetupValue`}, noAddress) and `GoogleClientSaved`
    (clientId, replaced, googleSignIn, redirectHint). `APIClient.googleSetup()` (`GET /v1/google/setup`) and
    `setGoogleClient(file:replace:)` (`PUT /v1/google/client`, `?replace=true` when asked): the file's `Data` is the
    body byte for byte, never decoded and written again, with `Content-Type: application/json`; `APIClient.Method`
    gained `put`. `GoogleClientFile` (`Store/GoogleClientFile.swift`): `maxBytes` 16,384 and `read(at:)`, a
    regular file only (opened without waiting, a link followed), at most one byte more. `GoogleClientSetup`
    (`Store/GoogleClientSetup.swift`, the onboarding session's set) runs the screen: loading and quiet re-asking, what
    it offers (`shown`: host only, or the paths), one file at a time (`isBusy`, `stop()`), the set-up asked again
    before sending and after a `conflict` (Replace it only while a device may still give a client), and `Settled`
    (`.saved`, or `.alreadyThere` for a client given elsewhere) handed back; `MailStore.googleSignInChanged` updates
    `serverInfo`. Described in [apps-onboarding.md](apps-onboarding.md).
  - The AI switch per inbox is gone (owner's decision of 2026-11-17: the key turns it on for every inbox):
    `Inbox.aiProcessing` and the patch fields were removed, so the app neither needs nor sends it. Consent is given
    when the key is saved, after showing `APIClient.aiDisclosure(for:)` (`AiDisclosure`, `GET /v1/ai/disclosure`) as
    the server words it.
  - `Thread` is `MailThread` (Foundation has a `Thread`); `Actor` is `Doer` (Swift has an `Actor` protocol).
  - String unions are enums with an `.unknown(String)` case; unknown actions, actors, connections and events keep
    their JSON.
  - `Versioned` is the protocol for things with a `version`: inboxes, threads, records, drafts and rules.
  - `ActionRecord.needsALook` is Handled's `attentionOnly` test: failed, or an `error` or a `note`.
  - `Draft.isKept` is false for a sent draft without a note, which the server doesn't keep. `Draft.sentNoteKept` is
    the day a sent draft with a note is kept.
  - `ThreadPlacement.applying(_:by:)` follows the contract's "What each action does", over category, screened, done,
    stack, come-back time, unread and trashed. It is only the guess shown before the server answers: `categorize` sets
    the category and `categorizedBy` (to the person by default; a one-time code also loses `screened` and `summary`);
    `allow_sender` clears `screened` on the named thread, the sender's other threads following through their events.
  - `Address.parseList` reads To, Cc and Bcc fields. `DraftInput.reply(to:)` and `replyAll(to:ownAddress:)` build
    replies in the thread's inbox.
  - Times go out as whole seconds in UTC (`2026-11-16T09:30:00Z`). Times coming in may have fractions or offsets.
- **`APIClient`**: one method per route in `core/src/api.ts`, the fifth revision's `home`, `category(_:_:)`, `stack`,
  `waiting`, `screening`, `counts`, `aiSettings`, `updateAiSettings(_:)`, `aiStatus` and `testAi` included; `/v1/now`
  and `/v1/piles` are gone. `handled` sends `includeSilent=true` and
  `attentionOnly=true` when asked. Errors become `APIError.server(code:message:status:retryAfter:)`. A server it
  can't reach is `APIError.unreachable` with the reason in words for the common cases (`APIError.reason(for:)`:
  "This device is offline.", "Nothing answered at its address.", …) and none otherwise, so no system error code
  shows; it keeps the system's reason as `cause` for a screen that words a case its own way. The transport is a
  protocol, so tests need no network.
- **Pairing's words** (`AppSession.pairingProblem(_:address:)`, the owner's approved copy of 2026-11-17 from the
  onboarding session): nothing answered at the typed address (check it, and `usual-mail status`); no secure
  connection (the scheme); a code that didn't work (mistyped, used or expired; `usual-mail pair` or
  `owner-pairing-code` in the server's data folder; on Cloudflare, the server's address opened again and Data
  Studio, or the dashboard's Devices and agents page, added 2026-11-24); "Too many wrong codes. Wait …, then try
  again." This session's own words for the Mac itself being offline.
- **The owner's password** (2026-11-24, `Pairing/AppSession+Owner.swift`, `Models/Owner.swift`; the contract's
  "The owner's password"): `ServerInfo.owner` (`OwnerInfo`, nil from an older server, `.none`); `APIClient`'s
  `signInOwner`, `claimOwner`, `owner`, `setOwnerPassword`. `AppSession.passwordStep(address:)` reads `/v1/info` and
  answers `.signIn`, `.claim`, `.claimInBrowser` (the host named an owner email: words to set it up in a browser) or
  `.codeOnly` (no password yet: words to pair with a code, then set one in Settings); `signIn(address:password:)`;
  `claim(address:email:password:again:)`, which refuses two passwords that differ or one under 12 characters before
  asking. Pairing, signing in and claiming share `connect(address:trade:refused:)` (the address checked, the server
  checked with `speaksTo`, the token kept, the copy opened); `pair` still refuses an empty code before asking.
  Refusals: "That password is wrong. Forgot it? …", "Too many wrong codes or passwords. Wait …", and `conflict` or
  `forbidden` in words. Tests: `OwnerPasswordTests` (5), the stand-in's `SampleServer+Owner.swift`.
- **`EventStream`**: reads `GET /v1/events` with its own server-sent events parser, reconnects with backoff (1 s
  doubling to 60 s, honouring `retry:`), and stops on 401. Unchanged since the first round.
- **`LocalStore`** (SQLite through GRDB): the on-device copy. Schema `v5` adds `category` and `screened` columns,
  takes an inbox's `position` from the inbox, and a `state` table that keeps the counts, the AI status and the AI
  settings by version (no secret is in them). Earlier JSON doesn't decode under the fifth revision, so `v5` drops the
  tables and the next refresh fills the copy again (as `v2` to `v4` did).
  - **Lists, as the contract's "Lists" table defines them** (`MailLists`): `home(inbox:)` (conversation and
    uncategorized, not screened, not done, on no stack, not waiting; by the later of the last message and a passed
    come-back time), `threads(in: Category, inbox:)`, `threads(on: Stack, inbox:)`, `waiting(inbox:)` (soonest first)
    and `screening(inbox:)`. Every list but screening leaves out screened threads and every list trashed ones; they sort
    newest first, equal times by id descending. `inboxes` by `position`. Handled: rules', agents' and the AI's records in the asked states (default proposed and
    applied), each with its thread; silent ones only when asked, with a count of the ones left out. Drafts: `draft`
    and `failed` only, so a sent draft never shows there. Rules: each inbox's, oldest first.
  - **What needs a look** (`MailLists.attention`): records that failed or carry an error or a note, from every state
    and whoever made them (the person's own change the provider refused too, since the final review's decisions of
    2026-11-17), never silent, newest first. The same records Handled with `attentionOnly` gives. Handled's own list
    stays rules' and agents' records.
  - **Writes keep the higher version** for inboxes, threads, records, drafts and rules. An equal version replaces
    the copy, so the server's copy can take back a change shown before it answered.
  - **Sent drafts:** writing a sent draft without a note removes it instead. A sent draft with a note stays in its
    thread's drafts until `draft.removed`, until the thread's server copy no longer has it, or until a refresh finds
    its day over (`dropSentDrafts`, by `updatedAt`). A sent new message, with no thread, goes at the next refresh.
  - **Trashed threads stay while a record is held.** A refresh removes a stored thread that is not done (or is
    trashed) and that it didn't see in any list, except a trashed thread the copy holds a record for.
  - `thread.removed` takes the thread, its messages and its records away. `inbox.removed` takes everything of the
    inbox.
- **`MailStore`** (`@MainActor`, `@Observable`): the state the screens show.
  - `start()` shows the copy on disk, refreshes, then follows events until its task is cancelled.
  - **A refresh** fetches every not-done thread (the seven categories and screening, up to 10 × 200 each; also Home,
    the stacks and waiting), the counts, the AI status and, for a person, the AI settings (a refusal leaves them as
    they were), the newest Handled page with silent records, the newest page of what needs a look (`attentionOnly`),
    every proposal, drafts, the latest brief and each inbox's rules.
  - **Counts and the AI** (`counts`, `aiStatus`, `aiSettings`): from the refresh and their events, the higher version
    kept, also on disk. Badges and Home's New count come from `counts`, so they don't move with an action until
    `counts.changed` arrives. `updateAiSettings(_:)` (the key is taken out of any error words) and `testAi()`.
  - **Events apply at once,** in arrival order, during a refresh too. `rule.changed` stores the rule by version and
    `rule.removed` deletes it, so a rule an agent suggests shows without a refresh. `draft.removed` drops the draft.
  - **What the refresh watch still does** (`RefreshWatch`): removal only. Versions settle every overwrite, rules
    included. A list that no longer has something says nothing about when it went, and a removal leaves no copy to
    compare. So a thread, record, draft, inbox or rule that changed on the device or through an event while the
    refresh fetched isn't removed for being missing from its lists, and one removed meanwhile isn't brought back. The
    brief has the same guard. Switching the watch off for rules makes two tests fail (checked in a scratch copy):
    a rule made by an event during a refresh, and a rule removed by an event during one.
  - **Actions** (`perform`, `undo`, `undoLastAction`, `approve`, `reject`) show at once. The answer's
    `ActResult.threads` and `records` replace what was shown, unless an event brought a higher version meanwhile. A
    refusal takes the change back. `PendingChanges` keeps unconfirmed changes on top of the server's newest copy.
  - **Opening a thread marks it read** (`open(threadID:)`), as the person's own `read` action, without an Undo strip.
    `markingRead: false` only looks (the previews use it).
  - **Silent records:** the copy holds them; Handled leaves them out until `showSilent(true)`.
  - **Inboxes and rules:** `updateInbox(_:_:)`, `setRule(_:enabled:)` and `deleteRule(_:)` wait for the server and
    keep its answer. `dashboardURL(inboxId:)` is the dashboard's inbox page, the contract's `DASHBOARD_PATHS.inbox`:
    `/inboxes/<id>` under the server's root, the id percent-encoded, a path prefix kept.
  - **New credentials:** `changeCredentials(_:to:)` sends `InboxPatch(credentials:)` and answers `.saved(inbox)` or
    `.refused(words)`. The words are the server's: the provider's on `provider_error`, "These credentials are for …"
    on `invalid`, or why the server couldn't be asked. Any secret typed (four characters or more) is replaced with
    "•••" in them. It raises no problem alert; the form shows the answer. On success the inbox is `connecting`, or
    stays `paused`.
  - **A paused inbox** (`Inbox.isPaused`): the server answers `conflict` to sending and to fetching a file. When the
    copy holds the inbox as paused, the problem says so in words (`Inbox.pausedWords`); otherwise the server's own
    words show. Actions on its threads still apply and are recorded.
  - **Drafts:** `saveDraft`, `send(_:)` (save, then send), `send(draftID:)` and `deleteDraft`. A refused send is the
    draft in state `failed` with its `error`, not an error. A send that worked without a note drops the draft at once;
    with a note it stays in its thread.
  - **Brief:** a refresh stores the latest brief; `brief.ready` fetches the new one. Only the newest is kept.
  - **Search:** `search(_:inboxId:after:limit:)` asks `GET /v1/search` for one page. It returns nil when the server
    can't be reached.
  - **Attachments:** `file(for:in:)` fetches one into a temporary file named after it.
  - A 401 anywhere calls `onUnauthorized`.
- **Pairing and disconnecting** (`AppSession`): a new pairing deletes the copy kept for that server's address before
  opening a new one, as signing out does. Found pairing again with a reset demo server: the old copy's higher versions
  would have outranked the new store's (`pairingAgainStartsAFreshCopy` failed first).
- **Sample data**: `SampleData` decodes the bundled copy of `core/fixtures/sample.json` (fifth revision: 16 threads
  over the seven categories, AI working with 5 waiting, a 30-day first-sync window and AI usage); `LocalStore.sample()` and
  `MailStore.sample()` fill a store from it, counts, AI status and settings, the first-sync window and usage included, for the sample mode and tests. `SampleData.detail(threadId:)` leaves out sent
  drafts without a note, as the server does.

## Decisions

- **SQLite through GRDB 7.12.0 (exact), not SwiftData.** `Sendable` value models, SQL for the lists' filters and
  sort keys, an in-memory database for tests.
- **The lists come from the copy, not from server pages.** So an action or an event shows in every list at once,
  offline too.
- **Versions decide between copies; `RefreshWatch` covers removal only,** now for rules as for everything else. The
  final review agreed: a refresh learns a missed `rule.removed` only by the rule's absence from the fetched list (no
  replay), and without the watch that absence would also remove a rule an event made mid-refresh, or bring back one
  an event removed.
- **What needs a look is its own fetch and its own list,** because Handled's default page leaves failed records
  out. It is shown first in Handled, not as a separate screen; the sidebar's Handled badge still counts proposals
  only, since a failed record stays failed.
- **New credentials** go through `MailStore.changeCredentials`, starting from `Inbox.connection`, sending the inbox's
  address only when the IMAP login isn't it, as the dashboard does. The form that used it went with the old UI.
- **A sent draft without a note is dropped at once,** without waiting for `draft.removed`, since the server never
  keeps it.
- **Paused words come from the copy:** the app still asks the server, and says the inbox is paused only when its copy
  holds it as paused; the app offers no pause or resume.
- **Inbox and rule changes wait for the server** instead of showing at once.
- **Plain http only to private hosts** (`ServerAddress`).
