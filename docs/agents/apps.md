# Apps (`apps/`)

The Swift side of Usual Mail: a package that talks to the server and keeps mail on the device (`UsualMailKit`), a
package of SwiftUI screens (`UsualMailUI`), the Mac app, and since 2026-11-20 the iPhone app
([apps-phone.md](apps-phone.md): a second target on the same packages; run in the simulator on the sample and on the owner's server). The data layer
is the first build's fourth round (2026-11-17). **The screens were rebuilt from scratch on 2026-11-17** to the
owner's Figma design: a minimal Mac app of Liquid Glass over a wallpaper, Home first, the other tabs one at a time.

Decided by the owner on 2026-11-17: the Mac app comes first (the web dashboard later); Home holds the conversations that need the person (notifications joined Home on 2026-11-18,
"notifications should go to Home not in receipts", and left it on 2026-11-19 once they had their own tab, "the Home
should not show notifications anymore"), New (unseen) above Seen; every AI step, including each mail's one-line summary and the labels that route newsletters and receipts
elsewhere, runs on the server with the owner's API keys, and the apps only show the result; an email opens inside the
card.

The new screens were seen on this Mac on core's sample data and compared with the Figma frame (below). Nothing was
clicked or typed, because this Mac gives the session no Accessibility.

## What is implemented

### `Packages/UsualMailKit` (no UI)

Models, the API client, the on-device copy (SQLite through GRDB), the live event stream and `MailStore`, the state
the screens show: described in [apps-kit.md](apps-kit.md).

### `Packages/UsualMailUI` (the Mac's screens; what the iPhone shares is in [apps-phone.md](apps-phone.md))

The design is the Figma file "Untitled", frame "MacBook Pro 14" - 1" (node 1:2, 1512 × 982), of 2026-11-17.

- **Look** (`Theme/Theme.swift`): Geist Sans from the design package (`UsualMailDesign`, path `../../../design/swift`,
  package identity `swift`) at the design's fixed 10 and 12 points (16 for a subject being read; the design's bold
  is the package's semibold); the design's colours: ink black, secondary black at 50%, section titles at 30%, times
  #A1A1A1, icons #141B34, the card #F7F7F7 at 85% over a material, controls white at 30%. Light only for now: the
  window asks for light.
- **Assets** (`Resources/Assets.xcassets`, compiled with the package): the design's 14 icons as SVGs downloaded from
  Figma (Hugeicons, Stroke Rounded, 16 points; drawn as they are, not tinted, since the person icon has a grey fill),
  and the wallpaper, 3840 × 2160, from the same file. The inbox icons plane, wallet, family, rocket, school, heart,
  star and leaf (2026-11-19) come from the design package's `UsualIcon` images (Airplane01, Wallet01, UserGroup,
  Rocket01, School01, Favourite, Star, Leaf01), drawn as templates. `Icon` names them (`Theme/Icon.swift`). The back arrow is the
  design package's `back`. Every icon draws with a 1-point stroke at 16 points (owner's direction of 2026-11-18): the
  design's home-02 had 1.5 and was set to 1; house-03, store-01, globe-02, tag-01, delete-02 and arrow-turn-forward,
  drawn in a 24-point box, went from 2.25 to 1.5 (1 at 16).
- **Window** (`Shell/MailWindow.swift`, `MailLayout`): the wallpaper fills it under a hidden title bar, and dragging
  the wallpaper moves the window. Three columns as in the design (300, 700, 300, 10 apart, 100 from the top); in a
  smaller window the sides give way first down to 56 (the rail 12 from the edge), then the card; the top is 10% of the
  height, between 52 and 100. Opens at 1512 × 982; at least 820 × 560.
- **Rail** (`Shell/Rail.swift`; rearranged at the owner's request of 2026-11-19): glass buttons of 32, top to bottom:
  search; the profile switch in one pill (a circle for every
  inbox, then one icon per inbox, the design's person, building and briefcase in turn, until a person picks; the name
  shows on hover; it filters Home and the screening count); the classic inbox; settings. Profiles are the inboxes in
  `position` order, each with its own `icon`; house, shop and globe, which the Figma file lacks, were drawn from the
  same Hugeicons free set at the same size and stroke. Last in the pill, a plus (`plus-sign`, "Add a Gmail account"; owner's request of
  2026-11-19) opens a sheet with the shared `GoogleSignInStep` (`Shell/AddGmail.swift`; a sheet because a popover would
  close when the browser comes forward and the step stops following the sign-in): connected, signed in again in place
  for an account already there, the server's reason on failure, or its explanation when Sign in with Google isn't set
  up (without a Google client, the guided set-up of [apps-onboarding.md](apps-onboarding.md), here, in Settings and in
  search's sheet); the new inbox joins the switch through the store's refresh, the profile doesn't change. Then To reply, Pinned and Snoozed
  (own `Place` cases, the launch values unchanged; selected like the inbox button, the glass tinted), the classic inbox,
  and settings pinned to the rail's foot as far from the bottom as the rail's top is from the top. Four inboxes fit in
  the pill at the smallest window (820 × 560), 16 at 1512 × 982; beyond that the inboxes scroll inside the pill, the
  all-inboxes circle and the plus fixed, their tooltips drawn outside it (`hostsTooltips()`); `Shell/RailFit.swift`.
  The profile pill's glass is clear like the other rail buttons at rest (owner's direction of 2026-11-20; it was
  tinted, which read as selected), and not interactive, as it holds several buttons. Every rail icon takes the
  wallpaper's tone under it (`Shell/RailTone.swift`, `RailIcon`, the coordinator's decision of
  2026-11-19): the design's own colours over light wallpaper, white at 92% over dark, worked out from the button's
  frame and the window's size each time either changes (`WallpaperTone`, as the corner note); the glass is unchanged.
  **It opens** (owner's words of 2026-11-20; `Shell/RailOpening.swift`, `RailLabel.swift`): the pointer resting 0.35 s
  on it (the tooltip's wait) widens every capsule to 184 with the app's spring, icons in place, names beside them in
  the wallpaper's tone; leaving narrows it at once; a mail drag opens it at once from its start (see drag and drop).
  The card never moves: below 1092 wide (1292 on the classic inbox) the open rail lies over the card's edge, its
  buttons white at 70% with dark icons. Reduce Motion: no spring. To reply, Pinned and Snoozed carry the server's counts
  (`counts(for: nil)`, every inbox, since the stacks: `reply_later`, `set_aside`, `waiting`; never from the copy): open, at the name's right
  in the time colour; narrow, a 14-high white capsule at the top-right with a 9-point number, drawn above the rail's
  glass container (`railBadges()`; see known-issues); none hidden, "99+" above 99. The all-inboxes circle, picked, has a dot in it (`radio-button`, `.allInboxesChosen`).
- **Tabs** (`Shell/TopBar.swift`, `Shell/Place.swift`): Home, Feed (newsletters; the design's name, frame 8:71, so
  the raw value and launch option stay `reads`), Receipts (invoices and receipts; the design says "Fax", kept
  Receipts), Notifications (owner's request of 2026-11-19; icon `notification-square` from the Hugeicons free set,
  a square with a badge dot, so it isn't taken for Snoozed's bell), shown only in the mail stack (see Navigation);
  glass capsules 32 high, the selected one lit (see Navigation) and named, the others icons with the name on hover; at the right the
  screening queue with how many wait (`counts.screened`, or the copy's screening list before the first counts).
- **Navigation** (`Shell/Navigation.swift`, `ScrollPlaces.swift`; the owner's words of 2026-11-20, "the stuff from
  sidebar will each be their own stack", which replaced their earlier request the same day for one "← {previous}"
  capsule on the rail pages): six stacks, `Destination`: mail (the switcher's profiles), To reply, Pinned, Snoozed,
  the Inbox page and Settings, each kept as left for the session (the mail stack its profile, tab and open mail; each
  list its open mail and scroll; Settings its tab). The mail stack shows the tabs; Settings only its own tabs; the four
  others one quiet title capsule (icon and name, clear glass, not clickable), which becomes "← {page}" with a mail open.
  No stack has a way back; the current stack's rail button is lit and does nothing pressed again. **Chosen is lit**
  everywhere (2026-11-20, after captures showed tints 2–9 levels apart over the sky): the current rail button, the
  chosen tab, Settings' chosen tab and the mail page's chosen buttons get white at 80% under clear glass with dark ink
  (`GlassControl`'s `lit`, `RailLook.lit`; the owner kept it on the main tabs: "Keep it lit"), pinned by pixel tests. The switcher marks
  a profile only in the mail stack; a profile clicked elsewhere goes to the mail stack at its last tab. Outside the mail
  stack the lists take every inbox and the rail's counts are overall (always). Esc closes an open mail, else nothing.
  Search (magnifier or ⌘K) opens over any stack with "← {page}", leaving it untouched: [apps-search.md](apps-search.md).
- **Motion** (`Theme/Motion.swift`, owner's direction of 2026-11-17: Apple's animations, everything appearing in a
  blur reveal): one spring (`Motion.move`, 0.42 s, little bounce) for switching tabs and places, the profile switch and
  opening or closing a mail; a reveal (`BlurReveal`: 10 points of blur and no opacity to sharp and whole, 0.4 s) for
  anything appearing; a quicker blur-out (0.18 s) for anything leaving. Switching tabs, the last tab's name blurs out
  as its capsule narrows and the new one's comes into focus as it widens; the screening count reveals. A screen
  (`handOver`) only fades out while the next reveals its own parts: Home's section titles and items one after another
  (35 ms apart, none waiting more than 0.3 s), the reading view's back button, header and each message, a
  placeholder, Settings, the pairing card. The hover time reveals and blurs out in place. Under Reduce Motion only the
  opacity changes. The owner clicked through it on 2026-11-17 and said it "feels right"; this session never watched it
  run (no pointer, and the capture tool finds the window after the reveal ends).
- **The card** (`Card`): the content's frosted panel, 700 wide, rounded at the top only, running to the window's
  bottom edge.
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
- **Drag and drop onto the rail** (`Pieces/MailDrag.swift`, `Shell/RailDrop.swift`, owner's request of 2026-11-20):
  a row (Home, Receipts, Notifications with a group row carrying the group, To reply, Pinned, Snoozed, Feed post
  headers, the Inbox page) drags as a small glass pill with its sender and subject (an app-only type declared in
  `Config/Info.plist`; drags from outside are refused). The rail opens the moment a drag starts (owner's words of
  2026-11-20, "the side bar items should extend … to make drop easier"; `Pieces/MailDragState.swift`): when SwiftUI
  makes the drag item with a button held (after 6 pt of movement if made on mouse-down, so a click doesn't flash it).
  The three list buttons take the chosen tint and the one under the pointer grows to 1.1×; search, the switcher, Inbox
  and Settings dim to 45% (icons and names, fading). A drop on To reply or Pinned stacks the mail (nothing on its own
  stack) and the rail narrows 0.35 s later; on Snoozed it opens the five snooze choices in a popover (closing it
  leaves the mail) and narrows when they close; through `store.perform` with the undo strip. The drag ends on a drop,
  the row's session ending, or a watchdog that looks at the mouse every 100 ms during a press or drag and ends it after
  two looks with no button held (drops elsewhere, outside the window, Esc); then it narrows at once, unless the pointer
  rests on the rail (`Shell/RailPointer.swift` reads it from the window, rechecked every 100 ms until a hover reports).
  Over the card in a narrow window the open rail takes no drops; only its column up to the card's edge does. Rows have
  no text selection. The real gesture is covered only by tests (no pointer).
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
- **The mail page** (`Reading/`, Figma frame "MacBook Pro 14" - 9", node 8:961, the owner's direction of
  2026-11-17): clicking an item opens it in the card, and the row above the card (`TopBar`) changes as the owner set out
  on 2026-11-17: the chosen tab stays where it is and becomes the back button, its name kept and only its icon turning
  to the arrow in a blur (Esc too); the tabs that share an action's icon (To reply, Pinned, Snoozed) slide to the right
  on the spring and become reply later (`reply_later`), pin (`set_aside`) and snooze, their glass turning frosted as
  buttons are; archive (`done`) and more (`…`), which no tab stands for, pop in as glass from small to full size
  (`glassEffectTransition(.materialize)` and `glassPop`, no blur), and Reads, Receipts and the screening queue pop out
  the same way. Each capsule keeps its glass (`glassEffectID`) while it stays. From a tab that is itself an action's
  (Pinned), that action's button pops in on its own. Snooze and more open glass popovers
  (`Shell/BarMenus.swift`) whose rows each carry an icon (the system menus showed none): snooze offers later today
  18:00, tomorrow 08:00, Saturday 09:00, next Monday 08:00 and tomorrow if nobody has answered (`SnoozeChoice`); more
  starts with "why it's here", then "Move to feed" (`categorize` newsletter), "Move to paper trail", which opens to
  "As an invoice" and "As a receipt", "Forward" and "Label" (both disabled: forwarding comes with writing mail, and
  the contract has no labels), and "Remove" (`trash`). Each action takes the mail out of Home, so the card goes back to Home, and an undo strip
  (`UndoStrip`) at the card's foot says what happened ("Archived.", "Moved to the feed.") with Undo for six seconds;
  when the server returns the teach question, the strip asks it with Yes and No instead. In the card (`MailPage`):
  the subject (Geist Medium 16) with when on the right, the sender as "Name (address)" with initials (owner's choice of 2026-11-20), the summary
  as "Sender - summary" in a white box with a #E5E5EA edge (only when there is one), then the mail as its sender
  wrote it: HTML set in Geist 12 at 75% black with underlined links (the fonts travel in the page as `data:`, which
  the policy allows, since the web view's process can't see the app's fonts), or text with its web and mail
  addresses as links. Pictures from the web show at once, through the person's server (below); a quiet 10-point line
  in the time colour above the mail says "2 trackers removed" (hover: "From HubSpot and Mailchimp"), "Pictures show
  once you let this sender in." or "Pictures from blocked senders aren't shown." (`Reading/PictureWords.swift`), joined
  with " · " (only the last keeps its full stop). When the server left out HTML over 1,000,000 characters
  (`Message.htmlTooLarge`), the text shows with "This message is too long to show as designed" first in that line.
  Earlier messages of a thread are folded
  to a line (who, first words, when) that opens on a click; the newest is open.
- **Reading, before the mail page** (replaced): clicking an item turned the card into the email: a glass "Home" button
  (Esc too), the subject, the summary (plain text), "why it's here" (`WhyWords`: the category and who decided it, with
  a rule's or agent's reason: "Invoice, sorted by the AI", "Receipt, as your mailbox files it", "Not sorted yet"),
  then each message with its sender's initials, name ("You" for your own) and time, and its text, or its HTML on the card's ground (no page colour of its own, the system font at 13, remote pictures held
  back). Opening marks it read, so it is under Seen on the way back. Drafts and actions aren't shown yet.
- **Screening** (`Screening/`, Figma frame "MacBook Pro 14" - 8", node 8:833, built 2026-11-17): the screening
  capsule at the top right is chosen, tinted and named "Screening" (elsewhere it shows how many wait), and every tab
  is plain. The card says how many new items wait ("16 New Items", 12-point bold #C7C7CC; the server's
  `counts.screened`), then one row per sender in an inbox (`ScreeningList`, by `sender`, newest first): initials,
  "Name (address)" with the time beside it in #AEAEB2, then what it is about (the summary, or the opening words; never
  the sender again), and on the right, grey as drawn, a chevron when the sender sent more, let in (✓,
  `allow_sender`) and block (✕, `block_sender`). The chevron opens the sender's older mail beneath, indented, and
  turns over; they carry no buttons, since letting in and blocking are about the sender. Both actions show at once on
  every thread of that sender (the data layer's sibling change), and the undo strip says "Let in." or "Blocked." with
  Undo. Clicking a row (its words, not its buttons) opens the mail page (owner's yes of 2026-11-17): the Screening
  capsule travels to the left and becomes the back button, "← Screening", only its icon changing, in a blur; every
  tab pops out, and let in, block and more pop in on the right as glass buttons (the grey screening icons drawn in the
  icon colour there). Letting in or blocking from the mail page goes back to Screening with the undo strip.
- **Hover and the pointer** (`Pieces/Glass.swift`, owner's direction of 2026-11-18: "should react to hover", "all
  clickable elements should change the mouse cursor to pointer"):
  - `PlainControlStyle` shows the pointing hand while a button is enabled, and tells its label when the pointer is
    over it (the `isControlHovered` environment value), so each control answers in its own way:
    - glass controls (`GlassControl`: the rail, the tabs and bar buttons) brighten: a clear one takes white at 15%,
      a tinted one goes to 45%;
    - the dark button lightens;
    - the Undo pill brightens;
    - an unpicked profile comes half-way up;
    - rows (Home, Screening's read area, earlier messages on the mail page) get a soft 3.5% highlight (`rowHover()`)
      reaching 8 points past their edges;
    - Screening's icon buttons turn the icon colour on a soft circle.
  - Link-style and system buttons take the hand with `.pointer()`. Menu rows keep their own highlight.
  - Tooltips (`Pieces/Tooltip.swift`, `.tooltip(_:edge:)`, owner's direction of 2026-11-18) replace `.help` on the
    icon-only controls:
    - the label comes 0.35 s after the pointer rests, in a blur reveal, and goes when it leaves;
    - it is a small frosted label, not glass, so it doesn't melt into the glass tabs;
    - it sits under the unopened tabs, the screening button and the mail page's buttons;
    - it sits to the right of the rail's buttons and profiles, the rail drawn above the card for it;
    - an open tab, already named, has none.
    `-UsualMailShowTooltips YES` (debug) shows them all at once for captures; placement was checked that way, the
    hover itself not.
  - Not seen on screen: nothing here can move the pointer.
- **What the server is doing** (`Shell/ActivityNote.swift`, owner's direction of 2026-11-18): a line of 10-point text
  in the window's bottom-right corner, in the right column when it has room (at least 120 points): "Fetching mail
  from {inbox}…" (or "{n} inboxes") while an inbox is fetching (`Inbox.isFetching`: `connecting`, or a first sync
  still running), with how far it has got once the server says, "Fetching mail from {inbox} · 120 of 340" (several
  inboxes add up those that have a count, "…" only when none has; 2026-11-23, `FirstSyncProgress.sum`), and "Sorting and summarizing · {n}
  left" while the AI works with threads pending (its status comes at most once a second, a first sync's count at most
  every two). No container: the words are black where
  the wallpaper under them is light and white where it is dark (`Shell/WallpaperTone.swift` reads a 160-pixel grey
  copy of the wallpaper and works out which part lies under the words in a window of that size; above 0.55 counts as
  light), with a faint shadow of the other colour. They come in a blur reveal and leave when nothing is happening;
  AI problems stay in Home's note.
- **The first run** (the onboarding session's `Onboarding/`, described in [apps-onboarding.md](apps-onboarding.md)):
  `MailWindow` shows `OnboardingView(session:)` over the whole window, with no rail or tabs, while
  `Onboarding.isNeeded(store)`: once the server has answered, while it has no inbox, no AI key, or this Mac hasn't
  finished the first run with it. Before a Mac with no copy hears from the server, only the wallpaper shows
  (`MailWindow.Stage`). The store runs underneath either way. Sign in with Google's button (`GoogleSignInStep`) is
  also used in Settings.
- **Settings** (`Settings/`, owner's request of 2026-11-20 for tabs; the coordinator's approved spec): its own stack,
  the top row only its five glass tabs, Accounts · AI · Appearance · Blocked · About
  (`SettingsTab.swift`; icons user-account, ai-magic, paint-board, user-block-01, information-circle from the
  Hugeicons free set); the chosen one lit with icon and name, the others named once the card is its full 700 wide
  (windows from about 840), icons with tooltips below; the tab remembered for the session in `Navigation`. No tab
  title; group titles, rows and one quiet line where needed; one file per tab, `SettingsView.swift` a small shell.
  - **Accounts** (`AccountsTab.swift`): the inboxes, each with its icon picker (`InboxIconPicker.swift`, the contract's
    fourteen icons; a save waits for the server, a refusal shows in red), name, address, state ("Needs you" and the
    reason in red; while a first sync runs, core's "Fetching your mail · 120 of 340", `InboxWords.status`) and, for
    Gmail, "Sign in with Google again…"; "Add a Gmail account…" (the shared sheet,
    `Shell/AddGmail.swift`); the paired server, its password (`ServerPassword.swift`, 2026-11-24: "Password set …" or
    "No password yet", and "Set a password…"/"Change the password…" opening two secure fields inline, saved with
    `PUT /v1/owner/password`, hidden when `GET /v1/owner` can't be read) and "Disconnect from this server…" at the
    foot. It doesn't set the AI key; if it ever does, it must first show the server's disclosure, as onboarding does.
  - **AI** (`AITab.swift`, `AIUsageSection.swift`, `UsageTable.swift`): Service (each job's model), State with how
    many wait, and Usage: "Today · 7 days · 30 days", one table of requests, tokens and cost per job ("not reported",
    "at least …"), asked of the server while Settings is open, at most every 5 seconds, hidden until it answers.
  - **Appearance** (`AppearanceTab.swift`, `Shell/Background.swift`, `BackgroundPicture.swift`), an app setting on
    this Mac: "Choose a picture…" (the system picker; the sandbox's user-selected read-only entitlement) copies it at
    once into Application Support/UsualMail/Background, its first frame, at most 3840 px on the long side, JPEG or
    PNG; an undecodable file is refused in words and nothing changes. "Use the default" removes the copy. "Soften the
    background" (off by default): a 10-point blur and 12% black. A small preview. `WallpaperTone` is rebuilt from the
    picture and the softening; a busy picture's worst case is about 3.1:1, so the corner note gets a stronger halo.
  - **Blocked** (`BlockedTab.swift`; kit `BlockedSenderList`, `MailStore+Senders.swift`, `APIClient+Senders.swift`):
    the server's blocked senders in the profile, newest block first: initials, name and address, the inbox under all
    inboxes, "Blocked 12 Nov by you · 3 messages since" (by the agent's or rule's name; no count for zero), Unblock
    (`POST /v1/senders/allow`; "Unblocked." with Undo, no strip when no record came back). `sender.changed` keeps it
    current; it reloads on reconnect. "No blocked senders."; the server's explanation once under the list.
  - **About** (`AboutTab.swift`): the manifesto (`WelcomeStep.manifesto`, as it is), mail.usual.dev, the source link
    (`ProjectLinks.repository`) hidden until `ProjectLinks.isPublished` is true, the app's version and build, and the
    server's and API version (`/v1/info`; "Sample data, no server" in the sample). No licence list exists to show.
- **Pairing** (`Onboarding/PairingView.swift`): a frosted card on the wallpaper: the Prociono wordmark, one
  line, the server's address and the code, a black "Pair" pill (`DarkButtonLabel`, shared with Sign in with Google);
  the problem in words. The onboarding session is turning it into Welcome, then the choice of server, then this.
- **Mail page edges** (`Reading/ReadingView.swift`, owner's direction of 2026-11-18: Apple's native effect): the
  header (subject, when, who) is pinned as a bar over the scroll view (`safeAreaBar`), and the summary and the mail
  scroll beneath it under the system's own scroll edge effect in its default style
  (`scrollEdgeEffectStyle(.automatic, for: .top)`), so no line shows at rest (owner: "hide the line"). Measured on
  the captures: the `.soft` style draws the header area a shade lighter with a dark one-pixel line along its foot
  even at rest; `.automatic` draws nothing at rest and that backing and line only once mail lies under the header,
  as under a toolbar. Hiding the effect removes the line for good but leaves mail showing behind the header's words. Tried and removed the same day at the owner's word ("looks awful"): stacked materials,
  then a private-API variable blur (`CABackdropLayer` with `variableBlur`) in several tunings. Nothing at the bottom
  edge.
- **HTML mail** (`Thread/HTMLMail.swift`, `Thread/HTMLMailView.swift`): kept from the first build (the sanitizer's
  output in a locked-down web view). New: a transparent page, 13-point text, no outer margin, and on the Mac the web
  view draws no background of its own (WebKit's `drawsBackground`, set only when WebKit answers to it). No scroll
  bars anywhere in a mail (`*::-webkit-scrollbar{display:none}` and `scrollbar-width:none` in the base style, owner's
  direction of 2026-11-18); a part wider than the card still scrolls sideways. The web view
  is as tall as its page, so on the Mac it hands scrolling up and down to the mail page around it
  (`MailWebView.scrollWheel`); WebKit kept those events, so the page didn't scroll with the pointer over a mail
  (owner's report, 2026-11-18). Sideways scrolling stays with a mail wider than the card.
  - **Pictures through the server** (owner's choice of 2026-11-18, "what HEY does"; `docs/contract-pictures.md`):
    the server's HTML holds no web address for a picture, only `/v1/messages/<id>/pictures/<picture id>`, and drops
    trackers and remote fonts. `HTMLMail.document(for:)` maps this message's paths (in `img src`, `background`,
    style attributes with `&quot;` and `<style>` url/image-set) to `usualmail-attachment://picture/<id>/<picture id>`;
    another message's path, or a malformed one, stays as it is and loads nothing. The page's policy is always
    `img-src usualmail-attachment: data:` and `font-src data:`, never http or https. `AttachmentSchemeHandler` serves
    a picture only for the message on show and only an id its HTML shows, fetched with the device's token
    (`APIClient.picture`), with the server's Content-Type; a 404, 502 or no connection fails it, and WebKit shows the
    alt text or the empty space. The web view reloads when the message's HTML changes, so letting a sender in brings
    its pictures. The "Show them" bar is gone. An app from before shows no web pictures from such a server, and this
    one none from an older server: update both together.
- **Launch options, debug builds only** (`Shell/LaunchOptions.swift`, `LaunchOptions.current`): `-UsualMailSample
  YES` shows core's sample with no server (`SampleMailView`; it reads as offline, so opening doesn't stick);
  `-UsualMailPairServer <address> -UsualMailPairCode <code>` pairs at launch when the Mac isn't paired (`pairIfAsked`);
  `-UsualMailPlace home|reads|receipts|reply|pinned|snoozed|screening|search|inbox|settings`, `-UsualMailInbox <id>`
  (the profile) and `-UsualMailThread <id>` (read in the card) say where the window opens; `-UsualMailWindowSize
  <w>x<h>` gives the window that content size once it opens; `-UsualMailSettingsTab accounts|ai|appearance|blocked|about`,
  `-UsualMailSearch <text>` (searched at once, never Ask or older mail) and `-UsualMailRailOpen YES` (the rail held
  open). They exist so screens can be looked at and captured on a Mac where nothing may drive the window.
  - The sample, pairing at launch and the sizing are inside `#if DEBUG`; in a release build `LaunchOptions.current`
    reads nothing. Checked 2026-11-17 on the first UI: a Release binary held none of the option names.
  - The pairing code is used once and kept nowhere: not in a file, not in a log. It is visible in the process's
    arguments while the app runs. Only the token pairing gives is saved, in the Keychain.
- **Removed on 2026-11-17** (kept outside the repository as a backup in the session's scratch area, which a reboot may
  clear): Now, Brief, Handled, Drafts, the inboxes and their pages, the credentials sheet, rules, compose and the reply
  sheet, search, the old thread view and its actions, the status strip and Undo, the menu commands and shortcuts, the
  hats and the four pieces' views, the words for them, the iPhone tabs and previews. The data layer behind them
  (actions, undo, drafts, credentials, rules, search) is still in `UsualMailKit`.

### App target

`App/UsualMailApp.swift`, target `UsualMail`, bundle id `labs.usual.UsualMail` (`Config/Shared.xcconfig`): one
`Window` with a hidden title bar, light, 1512 × 982 by default, and in debug builds the launch options. macOS 26,
Swift 6 language mode. The iPhone app is the target `UsualMailPhone` (`AppPhone/`, `Config/Phone.xcconfig`).

## How to build and check

```sh
apps/scripts/check.sh          # format lint, both packages' tests, the Mac and iPhone builds (unsigned)
apps/scripts/check.sh --fast   # without the builds (`macos` or `ios`: one build alone)
apps/scripts/copy-sample.sh    # after core/fixtures/sample.json changes
```

- Xcode 27.1, Swift 6.4. The first build needs the network once, to fetch GRDB.
- Keep the Mac unlocked while the tests run: one test saves, reads and deletes a Keychain item.
- `SampleFreshnessTests` fails when the bundled sample differs from core's. Run `copy-sample.sh`.
- Format with `swift format format --in-place --recursive` on the same paths `check.sh` lints.
- To sign or run on a device, copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored).

**Build and launch the Mac app by hand** (2026-11-18): `scripts/run-mac.sh` builds Debug signed with this Mac's
"Apple Development" certificate and opens it. A plain `xcodebuild` of Debug signs the same way through the gitignored
`Config/Local.xcconfig`. Every build then keeps one signature, so one "Always Allow" at the Keychain prompt lasts.
Never pass `CODE_SIGN_IDENTITY=-`, `CODE_SIGN_STYLE` or `DEVELOPMENT_TEAM` for a build that gets launched: an ad hoc
build brings the password prompt back. Only `check.sh`'s unsigned build, which launches nothing, may skip signing.

```sh
cd apps
scripts/run-mac.sh                                                    # build, sign, quit the old one, open
open build/DerivedData/Build/Products/Debug/UsualMail.app --args -UsualMailSample YES   # the sample, no server
```

Several sessions launch the owner's app: say so to the others before launching, and reopen it at 1512 × 982 on the
owner's own server when a capture is done.

In zsh, pass each launch option as its own words; a variable holding `-UsualMailSample YES` arrives as one argument
and the app then shows pairing. The app's data lives in its container, `~/Library/Containers/labs.usual.UsualMail`.

**Checks run 2026-11-17 on this Mac, on the fifth revision:** `apps/scripts/check.sh` exited 0: lint clean,
`UsualMailKit` 252 tests in 46 suites (`FifthRevisionModelTests`, `FifthRevisionStoreTests` new; every test that used
piles, triage, `move` or `/v1/now` rewritten; the stand-in server split into `SampleServer` and
`SampleServer+Views`; `SenderTests` and the fresh-copy pairing test after the amendment: 256 in 47; with
`GoogleSignInModelTests` and `GoogleSignInFlowTests`, 266 in 49 on 2026-11-17 evening) and `UsualMailUI` 48 in 10
(`ExplanationTests`, `MotionTests`, `MailPageTests`, `TopBarTests`, `ScreeningTests` new) passed, the unsigned Mac
build succeeded with no warnings (`LocalStore.state` now asks for a `Sendable` value, which quietened the last one).

## Structure

```
apps/
  UsualMail.xcodeproj     hand-written; App is a synchronized group; both packages are local
  App/, AppPhone/         the Mac's @main app, the iPhone's
  Config/                 xcconfigs (Phone.xcconfig: the iPhone's), Info.plist (ATS), Mac entitlements
  Packages/UsualMailKit/  Models/ API/ Events/ Storage/ Store/ Pairing/ Sample/ Resources/sample.json
  Packages/UsualMailUI/   Theme/ Pieces/ Shell/ Phone/ Home/ Reading/ Screening/ Lists/ Onboarding/ Settings/
                          Thread/ Resources/Assets.xcassets
  scripts/                check.sh, copy-sample.sh, run-mac.sh, testflight.sh and make-app-icon.sh (the iPhone's)
```

## Tests worth knowing

In [apps-tests.md](apps-tests.md).

## Decisions

The data layer's decisions are in [apps-kit.md](apps-kit.md) ("Decisions").

- **The look is the Figma design's,** with the design package's fonts. Its sizes and colours are written in
  `Theme.swift` and the views, since the design package's tokens don't hold them yet.
- **HTML mail is held back twice:** the server's sanitizer, then the web view's settings and the page's policy.
  The page never reaches the web; pictures come only through the person's server.
- **One Mac window,** since it holds the live connection.

## What the design package lacks for the new design

- The design's icons (search-01, circle-small, male-02, building, briefcase-07, archive-04, settings-01, home-02,
  carousel-vertical, invoice-01, message-circle-reply, pin, notification-snooze-01, entrance-stairs) and its
  wallpaper live in the apps' own asset catalog. Checked on 2026-11-23: all 38 icons there are Hugeicons' free (MIT)
  drawings (`male-02` with a grey fill added); the wallpaper is a free Unsplash photo under the Unsplash License
  (settled 2026-11-24, [decisions-licence.md](decisions-licence.md)).
- Its sizes (10 and 12 point text, 16 point icons, 32 point controls), colours, the six avatar pairs and a bold
  Geist (the package ships up to semibold).
- **The package identity is `swift`** (from the folder name).

## Where the contract is awkward for a client

- **Removal is only by absence** (or `thread.removed`, `draft.removed`, `inbox.removed`, `rule.removed`); a
  changes-since route (open question 1) would replace the full refresh and the watch.
- **What needs a look never shrinks:** a failed record stays failed, and nothing lets a person mark it seen (the
  contract now says so; still an open question). The app shows the newest 200 from the server, plus any the copy
  holds.
- **A trashed thread kept for its record can go stale:** if it is taken out of the trash elsewhere while no event
  reaches the device, no list the refresh reads has it unless its record is on Handled's newest page.

## Not done

- **Archived mail (the owner's decision of 2026-11-19):** "archived mails only appear in search box later. when we
  implement". No list shows done mail, the Inbox page included ("like Gmail's inbox"); search, built since, is the only
  way to it (its Archived chip, [apps-search.md](apps-search.md)). So the Inbox page has no "include archived" switch
  planned.
- Screens for reply, approve, compose, drafts, inbox settings and new credentials (the data layer has them); offline
  and problem messages (recorded, not shown); keys beyond ⌘K, Esc, Return, search's and the first run's ←/→; dark mode.
- Choosing a profile's order (`InboxPatch.position` exists; no server change needed); changing the first sync's
  window in Settings (`updateFirstSync(days:)` exists; onboarding uses it).
- Actions taken offline are taken back, not queued (data layer).

## Onboarding is another session's (2026-11-17)

At the owner's request a second session, "Usual Mail onboarding experience", works on the first run (getting a
server, pairing, Connect Gmail, the AI key and consent per inbox, first sync, arriving in Home). Nothing was
committed then and there was no branch, so the two sessions split by file:
- **Its own:** `UsualMailUI/Onboarding/` (the pairing card, Connect Gmail and `GoogleSignInStep`), `GoogleSignIn.swift`,
  `GoogleSignInFlow.swift`, `GoogleSignInTests.swift`, test files named `Onboarding…`, and its notes in
  `apps-onboarding.md`.
- **Everything else here:** this session's. Changes elsewhere are asked for first.

The split, today's onboarding and the working rules are in the sessions' shared notes (`apps-onboarding-split.md`).
Agreed since:
- `MailWindow` shows its `OnboardingView` over the whole window (no rail or tabs) while
  `Onboarding.isNeeded(store)`; wired 2026-11-17 evening, replacing the old "Connect your mail" card.
- Its one screenshot goes in this package's asset catalog as `onboarding-screenshot`.
- The pairing words above are the owner's.

## Runs on this Mac

What was seen when the app ran (the sample, the demo server, a real server with the owner's Gmail, the Keychain prompt
after each rebuild) is in [apps-runs.md](apps-runs.md), and what was never seen under its "Not verified".
