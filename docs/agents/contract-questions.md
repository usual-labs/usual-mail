# Open contract questions

Questions the parts raise while building against `core/` and [contract.md](../contract.md). They are settled
together in one change to both, once no part is mid-build. Until then each part keeps its own workaround, noted
in its own file. Remove a question from this page when the contract answers it.

**On 2026-11-18 the coordinator answered 72 and 73:** the cost is looked up at Vercel's AI Gateway by generation id
(built; [server-ai.md](server-ai.md)), and an agent's token on the person-only routes gets `needs_person`. The
onboarding window step moves before connecting Gmail (71, but for 0 days, which is with the owner).

**On 2026-11-18 the owner's decisions answered 49 and 70:** the history setting left the contract (`historyDays`,
`maxHistoryDays`, `beyondHistory`); the AI works through all synced mail that isn't done, and the first sync's window,
which a person now reads and sets (`GET`/`PATCH /v1/first-sync`), is the one setting for old mail.

**On 2026-11-17 the coordinator decided the review's findings on the fifth revision,** and they were written into the
contract the same day (its second amendment): 41 (several categories in one list), 42 (`Thread.sender`), 43
(`Thread.categorizedByActor`), 46 (saving AI settings answers after its test), 47 (the key in no form in the status,
events, logs or errors), 48 (core's one copy of the words, `core/src/ai-words.ts`), 50 (removing the key is
`credentials: null`; `usual-mail ai remove` and the dashboard's AI page offer it, asking first), 51 to 56 (confirmed as
built and written down), 57 (a summary request carries no address; a blocked sender's mail is never sent), 58 (on the
gateway, categorizing needs a decision model; a wrong kind fails the test in words), 59 (recent filed history isn't
done), 60 (what lives only on the server, senders' standing included), 61 (a rule the person taught always applies)
and 62 (a model's `otp` alone never lifts the gate). The pass raised 63 to 65 below.

**The fifth revision (2026-11-17)** followed the owner's change of architecture (the server's own AI, categories,
Home, counts). It answered none of the questions still open below, and left the owner's open on purpose (31 to 35,
and 38 as reworded). Writing it raised 36 to 40; the coordinator's follow-up the same day answered 39 (the AI never
takes a conversation out of Home by itself) and the one-time-code half of 38 (a code is never held back by
screening). Building it and its independent review the same day raised 41 to 62 (from the Mac app, the interfaces,
the server and the review); each part works around them as its note says.

On 2026-11-17 the coordinator decided questions 23 to 29 from the final review of the first milestone, and they were
written into the contract the same day (an amendment to the fourth revision):

- 23: a message that leaves spam is sent whole in `upserted`, never as `changed`; the server treats it as new mail
  where it now sits. Trash is unchanged.
- 24: every list orders by the whole second it publishes, then id, descending (the triage queue the other way
  round), and cursors follow it; the apps' order didn't change.
- 25: `attentionOnly` returns records that failed or carry an error or a note whoever made them, the person included;
  Handled's ordinary list stays rules' and agents'.
- 26 to 29, wording only: an inbox the provider couldn't describe lists with empty host, user or client id;
  `Rule.createdBy` is `system` for rules made before rules recorded their maker; a sent draft with a note is kept a
  day from its `updatedAt`; a client sends the inbox's own address as `ImapCredentials.address` only when the IMAP
  login differs from it.
- Also decided, from the review's known issues: a draft left `sending` by a stop is `failed` at the next start,
  saying it may have gone out.

Question 30 stays open, reworded below; the contract now says that what needs a look doesn't shrink by itself yet.

The questions the third round raised were decided by the coordinator and written into the contract's fourth
revision on 2026-11-17. The main changes were:

- `Rule` gained `version` and `createdBy`; `rule.changed` and `rule.removed` are sent on every create, change,
  switch and deletion, and once per rule for each batch of new mail it sorted (its `hits`).
- An agent may change or delete only a draft an agent wrote; the service enforces it. A sent draft with a `note`
  is kept for a day in its thread's `drafts`; one without is removed (`draft.removed`).
- `HandledQuery.attentionOnly` (REST `attentionOnly=true`): only records that failed or carry an error or a note.
- `Inbox.connection`: how it is connected, without secrets, described by the provider (`MailProvider.connection()`).
  New credentials still replace the stored ones whole. After new credentials an inbox is `connecting` until its
  next good sync.
- A paused inbox reads nothing from the provider and writes nothing to it; its actions are written back once it is
  resumed. `/inboxes/<id>` is the one dashboard path other interfaces may rely on (`DASHBOARD_PATHS`).
- Sync: the server stores the ref `apply` returns before its next `sync`; moving from the inbox to a pile's folder
  or label is a change of pile; a stack added with a move into the inbox wins; the first sync's archived threads are
  done in every pile; new mail filed outside the inbox keeps the person's filing; spam is treated like trash and new
  mail to spam is ignored.
- Undoing an allow or a block counts a thread as changed only if where it is changed. A refused write-back never
  overwrites a later change.

The 28 questions from the second round and the review of 2026-11-17 were answered in the contract's third revision
of 2026-11-17. The main changes were:

- `Inbox` and `Draft` gained `version`. Every version may rise by more than one; of two copies, keep the higher.
  A sync that only moves `lastSyncedAt` raises no version.
- `ActionRecord` gained `silent` and `note`, `Draft` gained `note`, `Message` gained `listId`, `AttachmentMeta`
  gained `contentId`, and a brief's highlights carry their thread's `subject`.
- In an `act_silently` inbox, what rules and agents apply cleanly is silent: undoable, but left out of Handled
  (unless `includeSilent`), a brief's counts and "what needs you". A refusal or a note ends the silence. Handled
  keeps the records of trashed threads.
- Undoing `allow_sender` or `block_sender` always restores the sender and skips threads changed since.
- At the provider, a People thread is in the inbox exactly when it shows in Now, so stacked and waiting threads
  are archived. Moving one back into the inbox there puts it in Now.
- A sender is screened until let in, and the ways of letting in are listed. Sorting a thread out of Screening lets
  its sender in for later mail.
- A person may change an inbox's credentials; removing an inbox is described. `ProviderKind` lost `outlook`.
- `GET /v1/me`; `Retry-After` on `rate_limited`; the owner's code file, and a new owner code whenever no person's
  device remains; agents' tokens only through pairing; the connector takes agents' tokens only; mounted
  interfaces get the full URL.
- Providers: what a reset listing includes, `changed` for unknown refs, `limit`, placement while trashed,
  `inInbox` only with People, and exact removals instead of a reset.

The 36 questions from the first four parts were answered in the contract's revision of 2026-11-16. The main
changes were:

- `Thread` gained `trashed` and `version`; `ActionRecord` gained `version`.
- `act`, `undo`, `approve`, `reject` and `decide` all return `ActResult`, which now carries the threads.
- Now leaves out threads on a stack; a thread on a stack is never done; a no-op records nothing.
- Rules a person taught are checked first, newest first, so a correction always takes effect. A rule an agent
  creates starts disabled.
- Providers may report a stack as unknown, send flag-only changes, signal a reset, and add a note to a result.
  `untrash` says where the message goes.
- Pairing errors, the pairing limit, revoking oneself, whole-second times and the first sync are spelled out.

## Still open

Left open on purpose in the third and fourth revisions of 2026-11-17, and raised since. Numbers 1 to 20 are the ones
the questions had in the second round.

### Clients and lists

1. **Changes since a point, for clients.** A full refresh is about nine requests plus one per inbox and reads
   every not-done thread, and removal is known only by absence or `thread.removed`. A changes-since route would
   scale better and replace the apps' `RefreshWatch`. Not needed for the first milestone.
2. **Replay of missed events.** Versions let a client order what it has, but after a reconnect it still reloads
   its lists.

### Sign-in

20. **The pairing limit is counted for the whole server,** in memory. While it holds, even a good code is
    refused, so anyone who can reach `/v1/pair` can keep it shut, the owner's own code included. A restart
    clears it.

### Raised while adopting the fourth revision (2026-11-17)

21. **Agents see `Inbox.connection`.** `listInboxes` gives an agent the inboxes it may see, whole, so it learns the
    mail servers' names and the login names. None of it is secret, but an agent doesn't need it. The connector
    doesn't show it (`list_inboxes` leaves it out); REST does. Should the service leave it out for agents?
22. **A paused inbox's attachments and sending.** "Reads nothing from the provider" makes fetching an attachment
    and sending a draft answer `conflict` while paused, so the apps can't open a file of a paused inbox. Is that
    the intent, or should those two be allowed as a person's explicit acts, as checking new credentials is?

### Raised in the final review of the first milestone (2026-11-17)

Questions 23 to 29 were answered on 2026-11-17 (see the top of this page).

30. **What needs a look doesn't shrink by itself.** A failed record stays failed, and nothing lets a person mark it
    seen or dismiss it, so "what needs you" (Handled with `attentionOnly`) keeps every refusal for good, now the
    person's own refused changes too. The contract says so as it stands. Should a person be able to mark a record
    seen, or should what needs a look leave out records older than some time? (Raised by the apps; reworded
    2026-11-17.)

### Open with the owner (fifth revision, 2026-11-17)

Left open on purpose; the contract builds none of them.

31. **Where notifications and one-time codes are shown.** Both are categories with their own list routes and labels,
    and neither is in Home. A one-time code is never summarized and never held back by screening, but the Mac design
    places neither. A session proposed notifications in the paper trail behind a filter, or only in the classic
    inbox, and a one-time code shown briefly then filed away.
32. **What "New" in Home means.** For now it is unread (`Thread.unread`, counted as `ThreadCounts.unread`). The owner
    also said "new since last time the user came in and not seen", which needs a last-visit time the person's devices
    share. The contract leaves room for it and doesn't build it.
33. **Whether a profile is one inbox or a group** (personal, company, work). Today each inbox is a profile, with
    `icon` and `position`.
34. **Whether Handled, proposals and the brief appear anywhere in the new Mac design.** They stay in the contract and
    the server; the Mac app shows none of them yet. A session proposed showing "why it's here" on an item (from
    `categorizedBy` and `reason`) with correction by changing the category.
35. **Which AI key comes first:** Vercel's AI Gateway, or OpenAI's or Anthropic's own key. The contract supports all
    three; the server's default models depend on it.

38. **Should a notification from a sender who isn't let in be screened?** One-time codes skip the gate now (the AI
    categorizes first, and since 2026-11-17 the server's own check must hold too). A notification from a service never seen before (a new sign-in, a shipping notice) still
    waits in the screening list. Should notifications skip it too, or stay gated?

### Raised while writing the fifth revision (2026-11-17)

36. **A route for the classic inbox.** The Mac design's "traditional inbox to explore" shows every mail; today only
    search lists done and screened threads together. A list of every thread (not trashed), newest first, would serve
    it.
37. **Should category lists include done threads?** They hold threads that aren't done, as piles did, so a receipt a
    rule marked done is in no list but search. A paper trail may want done ones too (a `done` query parameter).
40. **Who sets the AI key first.** The Mac app comes first and the dashboard later, but a key is set only through
    `PATCH /v1/ai`. Since 2026-11-17 the command (`usual-mail ai set`) and the dashboard's AI page both set it; the
    Mac app's settings show only the AI's state. Left: whether the Mac app should set it too.

### Raised while building the fifth revision, and in its review (2026-11-17)

41 to 43, 46 to 48 and 50 to 62 were answered on 2026-11-17 (see the top of this page). Still open:

From the Mac app:

44. **Tab badges lag behind actions, and are stale offline.** Badges come from `counts`, which only the server
    computes; after an action they change when `counts.changed` arrives, and offline not at all. Either the contract
    accepts that, or clients compute counts from their copy (with the risk of disagreeing).
45. **A category the app doesn't know is in no list it reads.** The app fetches the seven category lists by name, so
    threads in a category a newer server adds would never be fetched, though the app would show them as unsorted. A
    route that lists every not-done thread (see 36) or a rule that new categories also appear somewhere known would
    cover it. (The merged list of 41 takes only known names.)

From the interfaces (command, dashboard, connector):


### Raised while carrying out the review's decisions (2026-11-17)

63. **Does an outside agent's `otp` need the server's check too?** Decision 62 covers the server's AI: its `otp` lifts
    the screening gate only when the mail is machine-sent and holds a code. An outside agent (also a model reading
    mail as untrusted input) and an agent's rule still lift it with `otp` alone, under trust; a person's choice lifts
    it as before. Should agents' and agents' rules' `otp` need the same check?
64. **Addresses inside the text a categorize request sends.** The summarize request replaces every address with
    `[address]`; the categorize request sends the newest message's sender name and address on purpose, and its text
    as written, which may quote other addresses ("write to ops@…"). The words say exactly that ("that message's
    text"). Should the categorize text have addresses replaced too, keeping the sender's own field?
65. **A blocked sender's mail inside someone else's thread** is kept and hidden (decision 8), and stays where the
    thread is at the provider, so the provider's own app shows it in the thread. Should the server archive or label
    such messages at the provider, and should letting the sender in again refresh the threads they wrote into (see
    [known issues](known-issues.md))?

### Raised while building Sign in with Google (2026-11-17)

66. **Bind a Google sign-in to the browser before hosting.** The `state` is single-use, ten minutes, 256 bits and kept
    for the device that started it, but nothing ties it to the browser that opens Google's address: whoever holds that
    address could finish the sign-in with their own account and connect their mailbox to the person's server. On the
    owner's Mac the loopback redirect limits that to a browser on the same machine. A hosted server should have the
    app open a server address first that sets a cookie and redirects to Google, and the callback should require it.
67. **An event for how a sign-in ended.** The outcome route is polled (the command asks every second); the usual
    `inbox.changed` comes on success, nothing on failure. Should the device that started it get a
    `google.signIn.changed` event, so the Mac app needn't poll?
68. **A Google sign-in for an address connected over IMAP** connects a second inbox (Gmail) beside the IMAP one, as
    connecting by hand does today (inboxes are unique per provider and address). Should it offer to replace the IMAP
    inbox instead?
69. **Revoking a failed sign-in's tokens.** A sign-in refused after Google issued tokens (another account, a scope left
    out) drops them unrevoked, because revoking ends the account's whole grant and could end a working inbox. Should
    the server revoke when it knows no inbox of that account uses this client?

### Raised by the owner's decisions of 2026-11-18

71. **"Only new mail" (0 days) in the first sync's window** (with the owner). The onboarding step moves before
    connecting Gmail with 7 and 30 days (the coordinator, 2026-11-18); the server takes 1 to 36,500 days. Should it
    take 0, and what would IMAP's day-granular search make of it?

### Raised by pictures from the web (2026-11-18)

74. **The error code for a picture that can't be had.** The picture route answers `provider_error` (502) with the
    reason ("The picture couldn't be loaded: its site answered 404"), reusing the code for a refusing mail provider
    rather than adding one. Keep it, or add `picture_refused`?
75. **A message whose HTML holds only trackers** comes without `html` once they are taken out, so apps show its text
    part. Keep that, or send an empty `html`?
76. **Agents and pictures.** The triage queue and `thread(id)` give an agent the rewritten HTML, whose picture
    addresses an agent's token can't open (`needs_person`). Should agents get `remotePictures` at all, or the HTML with
    pictures left out instead of pointing at a route they can't use?

77. **`htmlTooLarge` and its cap.** HTML over 1,000,000 characters is left out and the message carries
    `htmlTooLarge: true` with its text (built after the security review, 2026-11-18). Keep the flag and the number,
    or clip the HTML instead, as Gmail does at about 100 KB?
78. **"Outgoing" from the provider's evidence only.** Closed 2026-11-18: the coordinator decided it, and it is built
    (decisions-pictures.md, contract.md "The mailbox's own mail"). The third review narrowed it: a copy the server
    sent counts only with the same recipients and words, and a Message-ID alone never makes a message the inbox's own.

For the design system (missing icons, the focus ring, the hat list and specs not written yet), see
[improvement ideas](improvement-ideas.md); those are not contract questions.
