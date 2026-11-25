# Apps: the card's lists

Split out of [apps.md](apps.md) on 2026-11-25 to keep it under 500 lines: what each list in the card shows and how, in
`UsualMailUI` (`Home/` and `Lists/`), on the Mac and, through the same views, the iPhone
([apps-phone.md](apps-phone.md)). The rail, the window, navigation, Settings and the rest of the screens are in
[apps.md](apps.md); the data they read is in [apps-kit.md](apps-kit.md).

- **Home** (`Home/`): `HomeList` takes `MailLists.home` (conversation and uncategorized mail, core's
  `HOME_CATEGORIES`, that is let in, not done,
  on no stack and not snoozed) in the chosen profile, and splits it into New (unread) and Seen (read), newest first; empty sections are left out, and an
  empty Home says "Nothing needs you." Each item (`HomeItem`): the sender's initials on one of the design's six
  colour pairs (`Avatar(name:key:avatar:)`; when the server sends a sender picture, an organisation's site icon, it fades
  in over the initials at the same 16 points, `fill` clipped to the circle or `inset` on a white disc, and the row then
  takes both picture and name from `thread.sender` (`HomeWords.shownSender`); outgoing lines and Screening keep
  initials; keyed on the address, else the display name, else the subject, never the thread id; the
  same in every run; initials by `Pieces/Initials.swift`: words split at spaces only, so "Shop.de" is S; an address
  alone uses its local part; titles, lowercase leading particles and suffixes skipped; "Last, First" swapped; emoji
  and symbols skipped; at most two characters, never grown by uppercasing; CJK one character; "?" with no letters), the subject, and under it "Sender - what it
  is about" in two lines at most, cut with an ellipsis after the second (owner's correction of 2026-11-18: the
  ellipsis at two lines, while the server's AI aims for a one-line summary): the server's `summary`, shown only as
  plain text, or the snippet while there is none, its line breaks and runs of spaces made single spaces
  (`HomeWords.oneLine`). A summary that arrives later (`thread.changed`) shows at once. When something
  shown has no summary, one quiet line under the list says why (`AIWords`, from the AI status): not set up, paused,
  the key refused, the model unknown, out of credit, unavailable, with how many mails wait. The time ("now", "6m ago", "3h ago", "Yesterday", "Sat", "3 Nov") shows
  only on hover.
- **Feed** (`Lists/FeedView.swift`, `FeedPosts.swift`; owner's request of 2026-11-18: "each mail content shown as a
  post in the feed like instagram"): every newsletter (the copy's newsletter list, in the chosen profile) as a post in
  one scrolling stream, newest first. A post: the sender's initials, name and time ago (always shown) in a header row,
  the subject (13, medium), the summary as a caption (two lines, plain text), then the newest incoming message in
  full through the mail page's `MessageBody` (HTML with the picture line, or linked text; the snippet if nothing can
  be had), no clipping. A hairline with 32 points either side between posts. The header and subject open the mail
  page and carry the row's right-click menu. Each post fetches its messages only as it comes near the screen
  (`LazyVStack`) through `MailStore.detail(threadID:)`; `FeedPosts`, held by `MailWindow`, fetches a thread once and
  again only when its message count or last time changes. **Showing a post doesn't mark it read**; opening it does.
  Coming back from the mail page starts the feed at the top. Each HTML post is its own web view (likely its own
  WebKit process, and posts scrolled past stay alive), not measured yet.
- **Notifications** (`Lists/NotificationsView.swift`, `NotificationSections.swift`, `EventWords.swift`, owner's "Yes,
  build both" of 2026-11-19): `notification` threads in sections Today (the event's date is the person's local
  date; by time, a missing time last), Coming up (soonest date, then time) and Earlier (no date or a past one, newest
  mail first), headings like Home's "New", an empty section not shown, re-sorted each minute (`TimelineView`), so at
  midnight. A row with an event status reads "{status} · {when}" ("Out for delivery · today, 3:15–6:15 pm";
  "tomorrow", "yesterday", a weekday within six days, else "Thu 19 Nov"; times per the person's 12- or 24-hour
  setting, a window with an en dash) over "Sender - about"; a status without a date of its own takes the mail's day
  in the same words ("Out for delivery · yesterday"), so it never reads as current; without a status, Home's row. The date is the mail's own
  reading, never converted. The mail page's box shows the event line over `about`. Home doesn't list them.
  One row per `event.group` (`Lists/NotificationRows.swift`): the group's newest thread, its section by that thread,
  unread if any is; a 10 pt "N updates" button at the subtitle's right end expands the older threads inline, 22 pt in,
  remembered per group for the session; opening the row marks every unread thread in the group read as one silent
  action (`MailStore.markRead(opening:)`), an older row only itself; the row's menu acts on the whole group with one
  undo. `MailStore.now` is the clock these use (fixed in sample mode).
  **Seen tick** (`Lists/SeenTick.swift`, owner's words of 2026-11-20; seen is the read state, the coordinator's
  decision): a 24-pt button at each row's right end, an empty ring (`circle`) until seen, then a ticked ring
  (`checkmark-circle-02`), in the time colour; always shown on unseen rows, on hover for seen ones; tooltip "Mark as
  seen" / "Mark as unseen" to its left (`Tooltip` edge `.leading`, so the card's edge doesn't cut it). A click marks
  the row's unread threads read (`markRead(opening:)`) or all of them unread (`markUnread(_:)`), silently, with no
  undo; a group is seen only when all its threads are read. A seen row is dimmed: title and subtitle in `Theme.time`,
  avatar at 50%, the count in `Theme.quietTime`, fading with `Motion.reveal`; it keeps its place (the sections ignore
  read state). The menu's Mark as read/unread agrees. Only Notifications (`HomeItem`'s opt-in `seen:`).
- **To reply, Pinned and Snoozed** (`Lists/RailList.swift`, `RailListView.swift`, `SnoozeWords.swift`, owner's request of
  2026-11-20: "when I set something manually to snooze, reply or pin, it should appear in those lists"): the copy's
  `replyLater` and `setAside` stacks (newest first) and `waiting` (soonest come-back first);
  Home's row, money rows for receipts and invoices, event rows for notifications; Snoozed rows always show "until …"
  ("until 18:00", "until tomorrow 09:00", "until Mon 09:00", "until 3 Dec, 09:00"); empty: "Nothing to reply to." /
  "Nothing pinned." / "Nothing snoozed.". The mail page's reply-later, pin and snooze buttons turn into "Remove from
  To reply", "Unpin" and "Unsnooze" (lit) for a mail already there. Each is its own stack at the normal width, every
  inbox listed (Navigation). The row menu adds "Unsnooze".
- **Receipts** (`Lists/CategoryList.swift`, `CategoryListView.swift`, owner's request of 2026-11-18). Receipts lists invoices and
  receipts as one list, each row a money row (`Lists/PaymentWords.swift`, owner's words of 2026-11-19): the title
  "To be paid: €49.00 to Paperloop", "Paid: … to …", "Will be charged: … by …" (a bill collected automatically, the
  owner's third title of 2026-11-19) or "Refunded: … by …", the verb from `payment.state` (paid, scheduled, due), else
  the category (invoice: to be paid; receipt: paid); a date only as "on 2 Dec" (scheduled) or "due 30 Nov" (due),
  never when paid; the avatar is the sender's (its picture too) only when the title's party is the sender's own
  organisation (`Lists/PartyMatch.swift`: words of the party, case, accents and legal endings aside, the start of the
  sender's display name or its domain's name label, or the other way round, word for word; when unsure, no), else
  the party's initials on its own colour, so a marketplace's refund naming the merchant shows the merchant's initials; the amount from `payment.amount`'s minor units with ISO 4217 digits (a table, as the server's;
  Foundation is wrong for IQD, HUF and others) in the person's locale; a zero amount counts as none (a model's 0;
  the server drops it too, the app keeps it as a second guard); missing facts degrade ("Paid to …", the
  subject prefixed "To be paid · " or "Paid · "); the subtitle is `what` plus " · due 30 Nov", else the snippet; no
  kind word, the time on hover. The mail page's summary box shows the same two lines for these threads. Receipts
  lists them from the copy's category lists (the contract's: let in, not done, never trashed, stacked and
  snoozed ones included), each thread once, newest first, in the chosen profile, with Home's row (`HomeItem`) opening
  the same mail page; each row says "Invoice" or "Receipt" in the time's place until hovered. Empty: "No receipts
  or invoices." The design's frame shows only the tab chosen over Home's card, so Home's layout stands. No unread
  badge: the counts have no per-category unread number.
- **The Inbox page** (`Lists/InboxView.swift`, `AllMailList.swift`, `Shell/Navigation.swift`, owner's words of
  2026-11-19: "a mirror of what they see in their gmail account"): the rail's inbox button widens the card by up to
  200 pt (700 → 900 at 1512 and 1320 wide, sides 300 → 200; at 1100 the sides go 190 → 90; at 820 nothing grows) and
  is its own stack with a title capsule (Navigation). The list: every thread of every inbox that isn't
  trashed or done, any kind, screened included, newest first; one compact row (avatar, sender and message count, a
  quiet label word for filed kinds, subject — snippet, a paperclip, the date: the time today, "18 Nov" this year,
  "18/11/2025" before), unread in a bolder weight; no summaries, sections or grouping; the row's menu; lazy rows, the
  list re-filtered only when the copy changes; the scroll place kept while a mail is read. Archived mail isn't listed
  (owner's decision below). The rail now keeps 12 pt from the window's edge between about 920 and 1320 wide.
- **Snoozed out of sight** (coordinator's decision of 2026-11-20): Feed, Receipts, Notifications (a group shows its
  next unsnoozed thread; a fully snoozed group disappears) and the Inbox page leave out waiting threads at
  `store.now`; only Snoozed lists them (and To reply or Pinned when also stacked). Unsnoozing brings a mail back at
  once. The server's category lists are to follow in the contract; the app's filter stays as a second guard.
- **The row's right-click menu** (`Home/RowMenu.swift`, owner's request of 2026-11-18), on Home and Receipts rows
  and Feed's post headers: Open; Mark as read or unread; Archive; Reply later or Remove from To reply, Pin or Unpin, Snooze ▸ and Unsnooze
  (the reading bar's choices); Move to ▸ Conversation, Newsletter, Receipt, Invoice, Notification with the current one
  ticked; Block sender (when the thread has a sender) and Move to Trash, destructive. Each is `store.perform`, so the
  undo strip says what happened ("Marked as read.", "Taken off its list.", "Moved to notifications." were added)
  and a category change brings the teach question. Right-clicking only shows the menu. Left out: "Always file this
  sender under" (the store has no rule creation; the teach question covers it).
