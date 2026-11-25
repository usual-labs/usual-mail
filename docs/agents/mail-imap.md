# Mail: the IMAP provider

Part of [mail.md](mail.md), split out on 2026-11-21: how the IMAP provider (with SMTP for sending) places, syncs,
sends, watches and connects. Using it, the libraries, reading messages, the contract suite and the known limits shared
with Gmail stay in mail.md. The owner's inbox is Gmail; IMAP isn't used with real mail yet (known-issues.md).

## Folders, keywords and placement

| Usual Mail | IMAP |
|---|---|
| In Home (`conversation` or `unknown`, not screened, done, stacked or waiting) | INBOX |
| `conversation` or `unknown`, not screened, out of Home | The archive folder (`\Archive`, else Archive or Archives, else "Archive" is created) |
| A filed category, not screened | `Usual Mail/Newsletters`, `/Invoices`, `/Receipts`, `/Notifications`, `/One-Time Codes`, created on demand, under the server's namespace and delimiter |
| Screened, whatever its category | `Usual Mail/Screening`. A message has one folder, so a message there reports no `category`: the server keeps it |
| Stack | Keyword `$UsualMail_ReplyLater` or `$UsualMail_SetAside` (derived from the names) |
| Seen | `\Seen` |
| Trash | The trash folder (`\Trash`, else Trash, Deleted Items, Deleted Messages or Deleted; "Trash" is created) |
| Spam (read only; `place` moves out of it) | The junk folder (`\Junk`, else Junk, Spam, Junk E-mail, Junk Email, Bulk Mail). Its messages report `spam: true`; the server treats them as trashed and ignores new mail there. A message moved out of it, by another app or by `place`, is always sent whole |
| Sent (read only) | `\Sent`, else Sent, Sent Items, Sent Messages, Sent Mail; "Sent" is created on first send |

- Folders are found by special-use flags (RFC 6154), then by name. `\All` is never used. INBOX is always used.
- The server keeps a thread in INBOX exactly when it shows in Home: done, stacked and waiting conversations come as
  `place` with `category: null`, `screened: false`, `inInbox: false` and maybe a stack, so they sit in the archive
  folder, a stacked one with its keyword.
- A cursor from before the fifth revision that names the old pile roles (`reads`, `receipts`) is read as the
  categories they became (`newsletter`, `receipt`) instead of being refused as damaged. Their old folders aren't the
  new names, so the sync finds them gone; no real mailbox was ever connected to a build with piles.
- In the trash folder a message reports `trashed: true`; while it is there only that counts (contract), whatever
  the keyword says.
- **Stacks per folder.** A folder keeps stacks when its PERMANENTFLAGS allow the keywords (or `\*`, or none are
  sent). A message there reports `stack` as the stack or `null`. A message in a folder that can't keep
  keywords reports no `stack`, so the server keeps the stack itself.
- `place` and `untrash` work the same way: they move the message to the folder for `screened`, else `category`, else
  `inInbox`, from wherever it is (the trash included). The stack keyword is set where the message is, when that folder
  allows it, so it travels with the move. When a stack is wanted and the message moves, the target folder is
  checked and the keyword set there too. Only what differs is stored.
- When the stack can't be kept where the message ends up, the result is `ok: true` with `note`. `error` comes
  only with `ok: false`.
- `place` with `inInbox: true` and a category or Screening is refused (see Using it).
- `trash` moves the message to the trash folder. It leaves no marks; nothing remembers where it came from.
- A move returns the new ref: from COPYUID (UIDPLUS), else by searching the target's new UIDs for the
  Message-ID. Without either, `ok: true` with no ref, and the next sync reports the new location.
- **Moves it made itself** (`OwnMoves`): each new ref a move returns is remembered, in memory and bounded (10,000),
  except a move out of the junk folder: a message that leaves spam is always sent whole (contract, "Providers"),
  since the server ignored it while it was there. To tell, an `apply` call that moved a message lists the folders
  once if it hasn't yet (a move into INBOX didn't need to before); when they can't be listed, the move isn't
  remembered, so the message is downloaded once more, which is harmless.
  The server stores that ref before its next sync, so `sync` sends such a message as `changed` (its flags and
  placement) instead of downloading it again, then forgets it. A provider made after a restart doesn't know the
  move and downloads the message once; the server matches it by ref. Moves made by other apps are downloaded.
  A remembered ref whose message is gone before a sync saw it (another app moved it on: above the folder's last
  scanned UID, below UIDNEXT, not there) is reported removed with the other removals, then forgotten (`ownGone` in
  `imap/sync.ts`, since 2026-11-18): the server holds it and needs that removal to take the copy where it went. After
  a restart that ref isn't known, so it is never reported removed (a known limit, known-issues.md).
- Each op checks UIDVALIDITY and that the message is still there; if not, that op fails with "Sync again" and
  the others go on.

## Cursor

`imap1.` plus base64url JSON. Per synced folder:

- `p` path, `r` role, `v` UIDVALIDITY.
- `n`: UIDs from here up are new mail. `x`: how many messages sat below `n`. Fewer now means something was
  removed, and only then are the UIDs below `n` searched to find which.
- `u`: the UIDs reported, as compact ranges (`1:500,502:900`).
- `b` and `bk`: the backlog. UIDs below `b` are still to send, newest first. `bk` says why: `first` (the first
  sync, inside the `since` window), `reset` (UIDVALIDITY changed, inside the window) or `new` (a folder that
  appeared after the first sync, taken whole).
- With CONDSTORE: `m`, the HIGHESTMODSEQ up to which flag changes are reported; `ms`, `mc` and `mx` while a
  round of changes spans several batches (`mx`: UIDs sent whole meanwhile, not to be sent again as changes).
- Without CONDSTORE: `s` (reported UIDs that are unseen) and `k` (those carrying each stack keyword).
- `since` (top level: the window the first sync began with), `w` (the narrower window a smaller window gave the
  first sync's backlog), `fs` (how many messages of the "first" backlogs were sent, a first sync's count, kept while
  one remains; 2026-11-23, [mail.md](mail.md), "How far a first sync has got"), and `g`: folders that vanished or
  changed UIDVALIDITY whose removals are still owed.

A ref is `<UIDVALIDITY>:<UID>:<path>`. The cursor grows with gaps in each folder's UIDs and with the backlog
of a first sync; typically a few kilobytes.

## Sync

- Synced folders, in this order: INBOX, Sent, archive, the five category folders, Screening, junk, trash. Others are
  invisible. Each folder is selected again before it is scanned.
- One call scans every folder, then picks up to `limit`: new mail first (oldest first, merged across folders
  by arrival time), then flag changes, then the backlog (newest first, merged across folders by arrival time).
- New mail and the backlog are downloaded whole, except a message this provider moved there itself, which is only
  its flags, sent as `changed`. A flag change on a reported message is only its flags, sent as `changed`: an IMAP
  message's content never changes.
- **The first sync goes newest first.** Each folder's backlog is everything below the UIDNEXT it had when the
  first sync began, inside the `since` window. Mail that arrives meanwhile is new mail and goes first.
- Mail that arrives later is taken whatever its date. A folder first seen later is taken whole.
- **Removals and moves.** A move made in another app shows as new mail in one folder and a removal in another.
  The new copy has a new ref; the server matches it to the stored message by Message-ID **and** content, never by
  Message-ID alone, and takes it as a move only once the old ref is reported removed, since anyone who received the
  message knows both (the server's `sync/identity.ts`, [contract-sync.md](../contract-sync.md) "Which stored message
  new mail is"). So a ref is a message's identity, providers must never give one message's ref to another, and every
  ref the server holds must be reported removed when it goes.
  Removals are held back while new mail, or the backlog of a `reset` or `new` folder, is still waiting. The
  first sync's backlog doesn't hold them: a message moved after it was sent always comes back as new mail. So
  a removal waits at most until the new mail found with it has been sent. Before removals are reported, each
  folder's UIDNEXT is checked once more (STATUS); if mail arrived in a folder after it was scanned, they wait
  for the next call and `more` is true.
- **No `reset` for IMAP.** The cursor knows every UID it reported, so a folder whose UIDVALIDITY changed, or
  that vanished, reports each old ref as removed (after the new copies). That is what `reset` would achieve,
  without listing every other folder again.
- Calling `sync` again with the same cursor gives the same answer (plus anything newer).

## Sending

`send` composes the message, sends it over SMTP (Bcc in the envelope, not the headers), then appends a copy with
Bcc to Sent with `\Seen`, unless the credentials say `saveSent: false`. If saving the copy fails, `send` still
succeeds, since the message went out, and `note` says no copy was saved and why. `threadKey` isn't needed: the
thread key comes from the headers.

## Watching

`watch` opens a second connection on INBOX and uses IDLE, restarted every 4 minutes; servers without IDLE are
polled with NOOP. Calls are debounced by 250 ms. A dropped connection comes back with growing pauses (1 s up
to 60 s) and then calls back once. Only INBOX is watched. The server polls every inbox as well (since the review of
2026-11-17; before, a working watch stopped its poll, so mail a server-side rule filed into another folder waited
for the next INBOX change).

## Connections

- One IMAP connection for sync, ops and attachments, opened when needed and opened again after it drops.
  `sync` and attachment reads retry once on a fresh connection; ops, sending and saving to Sent never retry.
- After `quietMs` (60 s) without commands, a NOOP checks the connection before it is used again. If it doesn't
  answer within `probeMs` (10 s), a new connection is opened. Both cases are tested.
- A refused login (`authenticationFailed`, `AUTHENTICATIONFAILED`) is an error named `SignInRefused` (core's
  `SIGN_IN_REFUSED`, 0.1.2), "The IMAP server at … refused the user name or password.", so the server says at once
  that the inbox needs a new password; every other failure may pass (`readableError`). imapflow marks any NO or BAD to
  LOGIN or AUTHENTICATE as `authenticationFailed`, so one whose `serverResponseCode` says the server can't sign anyone
  in just now (RFC 5530's `UNAVAILABLE`, `INUSE`, `LIMIT`, `SERVERBUG`), or Exchange's "authenticated but not
  connected", is a plain error instead: "… can't sign in just now: …", which waits out the grace
  (`test/unit/imap-login-errors.test.ts`; the server review of 0.1.2).
- Timeouts: connect 30 s, greeting 16 s, socket 120 s. `close` waits at most 3 s for LOGOUT, then drops the
  socket, and stops every watcher.
- Without implicit TLS, STARTTLS is required unless the host is this machine. On this machine (bridges such as
  Proton Mail Bridge) self-signed certificates are accepted.
