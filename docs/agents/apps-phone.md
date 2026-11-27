# Apps: the iPhone app (`apps/AppPhone`, `UsualMailUI/Phone`)

Started 2026-11-20 at the owner's request, from their concept picture (one iPhone frame, 414 points wide, of Home).
**Run once in the simulator** that day, at the owner's "Yes, run it" (an iPhone 18 Pro, iOS 27.1, on core's sample
with no server, then paired with the owner's own server): what was seen is under "Seen in the simulator". Never on
a device. The Mac
app's screens are in [apps.md](apps.md); the data layer both use is in [apps-kit.md](apps-kit.md).

## The owner's concept (2026-11-20)

"The content would be full width. The tabs and controls will come to down from top of the content container, and also
on top on left you would have the search. In middle, we would have a drop down selector, which would include all the
inboxes and also all the other pages like reply, pin, snooze, and the main inbox. And on the right would have the
setting page. Everything else would be kinda the same." The picture shows Home: search, the switcher (a person icon,
an inbox's address, a chevron) and settings as 32-point glass over the wallpaper (44 since 2026-11-25); the card as wide as the screen,
rounded at the top, running to the foot; at its foot Home (named), Feed, Receipts, Notifications and the screening
capsule with its count. Text and controls are the Mac's sizes (12-point text, 32-point controls; the controls 44
points since 2026-11-25, below).

## How it is built

- **One project, two app targets, the same packages** (the owner's "Yes, start" of 2026-11-20 to that recommendation;
  [decisions.md](decisions.md)). `UsualMail` is the Mac app (`App/`), `UsualMailPhone` the iPhone app (`AppPhone/`,
  its settings in `Config/Phone.xcconfig` over the project's `Shared.xcconfig`; iPhone only, upright, iOS 26; the same
  bundle id, display name and `Config/Info.plist`). Each has a shared scheme of its name.
- **`UsualMailUI` builds for both.** What only one platform can compile is fenced by file: the Mac's window, rail,
  rail labels and pointer reading (`MailWindow`, `Rail`, `RailLabel`, `RailPointer`, and `AddGmailButton`) are
  `#if os(macOS)`; the iPhone's shell (`Phone/PhoneWindow.swift`, `PhoneTopBar.swift`) is `#if os(iOS)`. The rest of
  the Mac's shell compiles on the iPhone unused. Small differences are one `#if` each: the wallpaper's brightness from
  a `UIImage`, `Links.open`, `linkStyle()`, `pointer()`, `Pointer.exists`, `mailDraggable` (nothing on the iPhone),
  the launch options' window size.
- **Shared between the two windows:** `Navigation` (the six stacks and what each keeps), `Pages` (the card's content
  for a place; taken out of `MailWindow`), `WindowBar` (the two `TopBar`s, one hidden; taken out of `MailWindow`),
  `MailStage` (waiting, first run, mail), `MailLayout` and `RailCount` (their own files now), and every page.

## What is implemented

- **`PhoneWindow`** (`RootView` shows it once paired): the wallpaper under everything; `PhoneTopBar`, then `PhoneCard`
  holding `Pages`; `UndoStrip` and `WindowBar` in a bottom safe-area inset, so lists end above the row and are meant
  to scroll under it. The card's ground runs under that row and the home indicator. The first run and the wait before
  the server's first answer are the Mac's (`MailStage`). Coming back to the front refreshes the store, since iOS stops
  the connection in the background and events aren't replayed.
- **`PhoneTopBar`**: the switcher at the left, search at the right (opens over the stack, its field given the focus,
  lit while its page shows), nothing between (the owner's words of 2026-11-25: "remove the setting button and then
  move it into the center drop down menu ... move the search control to the right side and then the drop down menu
  to the left side. So center will be empty"; until then search sat at the left, the switcher in the middle and a
  settings button at the right). The switcher's capsule names what shows (`PhoneSwitch.label`: an inbox by its
  address, "All inboxes", or the page, Settings too) and opens the system's menu: every inbox and All inboxes (the one
  showing in the mail stack chosen), then To reply, Pinned and Snoozed with the server's counts as badges and Inbox
  (the one showing chosen), then Settings (chosen while it shows). "Add Gmail" left the menu the same day: adding a
  Gmail account is Settings' Accounts tab's "Add a Gmail account…", under the inboxes. The rows are plain buttons, so the
  menu keeps no column for ticks; the chosen row's icon is a check mark instead (owner's words of 2026-11-24), and
  every icon is drawn into the same 18-point box (`Icon.menuImage`; the design package's inbox icons, as the rocket,
  showed larger than the app's own). The menu's words are cut to one line in the middle
  before they reach it, 16 characters at most (`PhoneSwitch.menuTitle`, "someon…y.example"; owner's words of
  2026-11-24, "dont let the items wrap, do ellipsis"; the full name stays the row's accessibility label). Tried and
  dropped the same day: the app's own popover in Geist 12 with the chosen row in bold (the owner: "its not native
  anymore"), and in the system's menu a bold title and a line limit, which it ignores, as it does any font: the
  system's menu stays, in its own type. A row shows the inbox's name only, not its address (the owner's word of
  2026-11-25, "Hide them", once the address had begun to show under it); a row's texts and picture are the button's
  own label, since from a `Label` the menu took the first text only and the line under a name never showed. An inbox
  that stopped syncing (`Shell/SyncWarning.swift`, in
  [apps.md](apps.md)) has the red triangle for its icon, drawn as it is (`Icon.warningMenuImage`), and "Stopped
  syncing" under its name. On the chosen inbox the check mark takes the triangle's place, as it takes any icon's;
  its "Stopped syncing" line stays, and so does the capsule's triangle: while any inbox has stopped, the capsule
  shows it before its chevron and says so to VoiceOver (`PhoneSwitch.warning`), so the menu tells without being
  opened. The notice over the
  lists is the Mac's. Seen on the sample in the simulator, 2026-11-25. Its ink follows the wallpaper under it (`RailTone`). The
  top row sits 16 above the card (the concept's 24, "a bit less" at the owner's word of 2026-11-24;
  `PhoneLayout.gap`). Its glass is 44 points high with 20-point icons and the switcher's 14-point words, larger than
  the Mac's 32 for a finger (`ControlSize`; owner's words of 2026-11-25, "make the header liquid glass controls size
  bigger"), so nothing takes touches beyond it.
- **The row at the card's foot** is the Mac's `TopBar` with `compact`: the tabs and the screening capsule; with a mail
  open the back button as an arrow alone and the mail's buttons; Settings' tabs as icons, the chosen one named;
  search's capsule back. No title capsule on To reply, Pinned, Snoozed and Inbox (the switcher names them). Its
  capsules are 44 points high with 20-point icons and 14-point words, 8 apart, 16 from the screen's edges like the
  top row (`ControlSize`, `PhoneLayout.barMargin`; owner's words of 2026-11-25, "make the bottom glass tabs and
  controls bigger"). The chosen tab is named only when the row fits it (`BarFit`, measured in Geist at that size
  against the row's width): on a 402-point screen "Notifications" fits beside a count of up to two digits (Not done,
  "Narrow screens"); where it doesn't, the chosen tab is its lit
  icon alone. On Settings the five tabs sit in the middle of the row, not at its right as on the Mac (`TopBar.centres`;
  owner's words of 2026-11-24, "only in iphone"); for a while on 2026-11-25 a back button sat at the row's left with
  the tabs at its right, at the owner's word, then went at their next ("bring back the settings tabs to center and
  remove the back button"); Settings is left from the switcher's menu. Its chosen tab is lit and named when it fits
  (on a 402-point screen even "Appearance" does). Snooze and more are the system's menus (`PhoneBarMenu`; the
  owner's words of 2026-11-25, "this menu does not look native", of the popovers they had been): snooze's times; why
  the mail is here as the menu's title (for a mail that skipped Screening, its line under the category's, `WhyWords.title`,
  over a section of its own with Let in and Block sender in red when it has a sender), Move to feed, "Move to paper trail" a submenu (as an invoice, as a receipt),
  Forward and Label greyed, and Remove in red, apart. The Mac keeps its popovers. Seen in the simulator; a long
  reason as the title wraps whole (four lines for an agent's). Its times are worked out every minute and on coming
  back to the front (`TimelineView`), as are the swipe's when its dialog opens, so a phone locked over 18:00 offers no
  "Later today, 18:00" (the review of 2026-11-25).
- **Settings on the iPhone:** an inbox's state sits under its address, not at the row's right, so a first sync's
  words never squeeze its name. "Sign in with Google again" keeps waiting when its row scrolls off and back: a
  `Form` puts away rows out of sight, cancelling the wait, and the step asks about the same sign-in again when its
  row comes back (`GoogleSignInFlow.resume`; the review of 2026-11-25).
- **Home's swipes** (owner's words of 2026-11-25): a row swiped left marks it seen (read: it moves from New to Seen),
  or a seen one unseen; swiped right, it snoozes, asking when with the menu's times. Each way is a setting in
  Settings' Appearance tab, "Swiping on Home" (`SwipeList`, `SwipeAction`, `SwipeSettings`: seen or unseen, snooze,
  reply later, pin, archive, unsubscribe, block sender or nothing), kept on the iPhone (`UserDefaults`, Home's keys as they were
  before the other lists came). The row follows the finger (`SwipeRow`; a UIKit pan
  that starts only for a sideways move, so the list scrolls as before and a tap opens), then resists past 132
  points, never going past 200 (`SwipeDrag`); behind it, a rounded box at the row's edge as wide as the room the row
  leaves, with the action's icon and words at that edge, the icons' navy on a faint grey until 88 points, then white on
  the ink with a tap of the haptics. Let go past 88, or flicked fast enough to get there (the drag carried on 0.15
  seconds at the finger's speed, as iOS judges a flick by where it would end), it acts as the row's menu does
  (`SnoozeChoice.input` gives snooze's times as the menu and the mail page give them). VoiceOver has the same two as
  actions, named as the menu names them ("Mark as read"), one when both ways do the same. Seen in the simulator on the sample: both ways
  moved the row and showed their words, and letting go of snooze opened its times; the sample takes no action (its
  menu's "Mark as read" doesn't either), so what they do there is the menu's, not seen.
- **Notifications' and the Feed's swipes** (owner's words of 2026-11-27: on Notifications "on one of them do the
  archive. So remove that notification from that list and then archive the email. And the other I don't know, choose
  something yourself, but they need to be changeable into the settings"; on the Feed, archive and unsubscribe): the
  same swipe as Home's, with its own two settings per list ("Swiping on Notifications", "Swiping on Feed"; the same
  choices). Notifications: left seen or unseen (as Home's left and as the row's tick), right archive (done: the row
  leaves the tab and the mail is archived in its mailbox). A group's row does it to every thread it stands for (seen
  marks its unread ones read, or all unread again once none is); an older row shown under its group, to its own. The
  Feed: right archive; left **unsubscribe** (since 2026-11-27, the owner's request: swiping a post "should unsubscribe
  from it, so I won't ever get that any feed from those or email from those"; docs/contract.md, "Unsubscribing"). It
  asks first in the system's dialog (`SwipeQuestion`: "Unsubscribe from Coffee Roasters Monthly?", then every effect
  named, since the security review of 2026-11-27: their mail archived now and later, and asking them to stop with their
  one-click link, an email sent from this inbox's address, or Browser Use opening their page when a key is set; "Undo
  only unblocks them; the request still goes."; a red Unsubscribe), then `MailStore.unsubscribe(threadID:)`: the row
  menu's Block sender, the strip saying "Blocked, and asking them to stop. Undo only unblocks." with Undo, then
  `POST /v1/threads/:id/unsubscribe`, which the server answers at once and carries on in the background (one-click,
  an email, the person's browser agent, or the page left to the person; how it goes shows under the sender in
  Settings' Blocked tab, apps.md). **On a server older than 0.1.5** (its version, asked on connecting, `GET /v1/info`;
  `MailStore.serverUnsubscribes`) the way set to unsubscribe blocks instead, asking as blocking, and the strip says
  "Blocked. Update your server to 0.1.5 to unsubscribe."; a server that didn't say its version and answers "No such
  route" gets those words as the problem, never a bare 404; Settings' Unsubscribing section says the server needs
  updating in place of the key's field. Block sender alone stays a choice, with its own question ("Block Coffee Roasters
  Monthly?"); the Feed's footer says both ask first. Unsubscribe's swipe shows the Blocked tab's icon
  (`user-block-01`); the free set's unsubscribe-like icons aren't in the catalog yet. A post's header and its body move
  as one (`SwipePart`, one `SwipeModel` per post): the box behind them spans the post, its words at the header, which
  stays stuck at the top; the hairline after the post stays. A swipe starting on the mail's own content moves it too.
  Seen in the simulator on the sample (2026-11-27): Archive and Seen behind a notification row, Archive behind a post
  from its header and from its HTML, and the block question; the sample takes no action, so what they do there is the
  menu's, not seen. The unsubscribe swipe and its question are tested (`SwipeActionTests`) and built for the iPhone,
  not run: no simulator was opened for it, and no server has answered its request with the apps yet.
- **A dot on a tab with mail not seen yet** (owner's words of 2026-11-27: "whenever in any of the tabs there is a new
  item which I haven't seen ... I haven't opened it and I haven't seen it, maybe. Then I need to see a dot on the
  tab"): Home, Feed, Receipts or Notifications at the card's foot gets an 8-point dot in the danger colour, ringed in
  white, at its icon's top right (`NewDot`), and VoiceOver hears "New mail", while it lists, in the profile showing, an
  unread thread that hasn't been there while the person looked at that tab (`TabNews`). Looking at a tab (its list, or
  a mail opened from it, with the app in front) counts what it lists as seen; reading a mail anywhere, or ticking a
  notification seen, takes it off too; new mail in a thread counts again. The chosen tab has none. The first time,
  everything the tabs list counts as seen, so unread mail from before lights nothing. Kept on the iPhone
  (`UserDefaults`, each tab's threads by id and newest mail's time, forgetting what the copy no longer holds); the
  server keeps none, and the Mac shows no dots. Seen in the simulator on the sample with an empty record given at
  launch: dots on Feed, Receipts and Notifications over Home, and Notifications' gone once looked at.
- **A swipe in from the left edge goes back from a mail** (owner's words of 2026-11-26, "slide from left to right from
  left of screen should act as back button like native ios gesture"): on the iPhone each list stays under the mail
  opened from it, hidden and untouchable (`ReadingStack`, through `Pages.stacked`; the Mac still swaps one for the
  other). A pan that starts within 30 points of the screen's left edge and moves right (`EdgePan`, `EdgeBack`; other
  pans under it, the mail's scrolling, wait for it to fail) moves the page with the finger, a shadow at its edge, on an
  opaque card ground; the list comes in from 30% of the width to its left, dimmed until the page has gone. Let go past
  35% of the width, or flicked there (0.15 s at the finger's speed; a flick back toward the edge stays unless past
  half), the page slides off and the mail closes with no fade of its own (`Pages.swipeBack`); short of it, the page
  springs back. VoiceOver's escape goes back too. Opening a mail puts the keyboard away, since search's field stays
  under it. A plain pan, not `UIScreenEdgePanGestureRecognizer`, whose start the simulator's injected touches never
  made. Seen in the simulator on the sample: a short slow pull stayed, a long one went back to Home with the list
  where it was, no flash; tapping a mail and the back button work as before.
- **Pulling a list down checks for new mail** (owner's words of 2026-11-26, "Add pull down to reload on iphone"):
  Home, Screening, Feed, Notifications, Receipts, the Inbox page, To reply, Pinned and Snoozed (`checksForMail` in
  `Pages`, a `refreshable`; not a mail, search or Settings). It asks the server to sync the profile's inbox, or every
  inbox where no profile is active, and fetches everything again meanwhile (`MailStore.checkForMail`); a paused inbox
  isn't asked. The spinner shows until that refresh is done, or ends at once when a refresh was already running
  (which then runs again for the pull); what the syncs find comes afterwards as events, as new mail always does. The
  refresh is a task of its own, so leaving the list mid-pull doesn't cancel it. A pull that couldn't reach the server
  says why in a capsule at the top of the list for five seconds (spoken to VoiceOver too), since the store's problems
  aren't shown in the window; a sync refused (paused meanwhile, an error) says nothing, as the refresh brings the
  inbox's state. The Mac has no pull. Tested in the Kit (the inboxes asked, a refusal, offline, leaving mid-pull);
  not tried on a phone yet.
- **Screening's let in and block** (and more from a sender) are a 20-point icon on a 40-point circle, always shown,
  where the Mac has a 16-point icon whose circle shows under the pointer (owner's words of 2026-11-25, "the reject and
  accept buttons should be bigger").
- **Feed's headers stick** (owner's words of 2026-11-25, "each items header should stick to the top and then scroll
  when next items comes"): each post is a section whose header (avatar, name, when; `FeedPostHeader`) is pinned while
  its post scrolls under it, until the next post's header pushes it away (`FeedView.pinned`, the iPhone only). While
  stuck it stands on the card's ground with a hairline under it, reaching the card's edges; in its place it has none.
  Seen in the simulator on a feed made to scroll for the check (two sample posts don't).
- **Notifications:** the seen tick is a 24-point ring in a 36-point target (the Mac's 16 in 24), and a notification's
  row doesn't show the mail's date at its right, as its title already says when (owner's words of 2026-11-25: "the
  check mark control should be bigger, and remove the duplicate date"); a row without an event (Home's words) keeps
  it.
- **Without a pointer** (`Pointer.exists` false): a row's time always shows, and so does a seen notification's tick.
  A long press on a row shows the Mac's right-click menu (the same `contextMenu`).
- **Pages:** the card's side margin is `Theme.pageInset`, 16 on the iPhone (the concept's) and the Mac's 24.
- **The card's top corners** are 26 points (`PhoneCard.radius`; 16 until 2026-11-25), as the system's inset cards and
  buttons inside it round (the owner's words: "increase the content pane border radius, so it matches the other
  buttons and cards within the page"). Settings' first section title has 20 points more above it
  (`SettingsType.firstSectionRoom`), as far below the card's top as the other titles are below their section before.
- **Settings' Blocked tab:** Unblock is a secondary button in the middle of its row (owner's words of 2026-11-24,
  "like a button. not primary though, secondary"): since 2026-11-25 the system's bordered button, a finger's size here
  and small on the Mac (`BlockedRow`), as Settings became the system's grouped form (apps.md, Settings).
- **First run:** the cards are as wide as the screen leaves (`onboardingCard`), pairing's wordmark sits below the
  status bar, and its fields don't capitalise. The cards sit at the foot of the screen, not in its middle (owner's
  words of 2026-11-24; `OnboardingLayout.cardsAtFoot`): pairing's 24 from the screen's foot, and the screen keeps the
  keyboard's room, so "Connect to your server" rises above the keyboard whole (seen in the simulator); the steps after
  pairing at the foot of their safe area, 16 above it (not seen: the simulator's app is paired). Their two bottom
  corners follow the screen's (`OnboardingCardShape`, a `ConcentricRectangle`: the screen's radius less the card's
  distance from its edges, at least 16; the top 16; owner's words of 2026-11-24): about 31 on pairing's cards on an
  iPhone 18 Pro, 16 once the keyboard lifts the card away from the corners (both seen in the simulator). "While your
  mail comes in" plays the iPhone's own clips, the phone's screen standing up in the card (owner's words of
  2026-11-25, "in iphone, the videos should show the iphone UI not mac UI!"; [apps-onboarding.md](apps-onboarding.md)),
  and its last slide says the inboxes are switched from the menu at the top.

## Seen in the simulator (2026-11-20, the sample)

- **As the concept draws it:** Home (the top row, the card, New and Seen with every row's time, the tabs and the
  screening count at the foot); the card's rounded top; lists running under the home indicator.
- **Worked when tapped:** a row opens the mail page (back arrow and five buttons at the foot); more's menu; the
  switcher's menu, a profile chosen, All inboxes again, the Inbox page; each tab (Feed's HTML posts, Receipts' empty
  words, Notifications with ticks and "N updates", Screening); Settings and its tabs' row; search with the keyboard up,
  its field focused and "← Settings" riding above the keys; a long press showing the row's menu; the welcome, "Where
  should Usual Mail run?" and "Connect to your server".
- **Found and fixed:**
  - The snooze and more popovers opened downwards, off the screen: on the iPhone `arrowEdge` is the popover's own
    edge, so the Mac's `.bottom` is right for both.
  - The switcher's capsule was 44 high: the 6 points of touch room around a `Menu`'s label were drawn as glass. The
    room is gone, so the switcher takes touches on its own glass only (44 points since 2026-11-25).
  - The Inbox page's and search's one-line rows left the subject a few letters: `MailLine` (`Pieces/`) lays the same
    parts out on two lines on the iPhone and as before on the Mac.
  - The card stopped at the keyboard: its ground now runs under it.
- **Seen and left:** in the switcher's menu the Personal inbox's person icon draws solid (its grey fill, as a
  template); an inbox's address didn't show under its name there (left so: the owner hid it on 2026-11-25); no
  badges showed (the sample's counts weren't checked). The pairing card was centred and didn't move for the keyboard
  (since 2026-11-24 it sits at the foot and rises above it).
- **Not seen on the sample:** the undo strip (the sample takes actions back and shows none; seen later on the
  owner's server, below), snooze's menu, actions against a
  server, Sign in with Google, the first run after pairing, a custom or dark wallpaper, other screen sizes.

### Paired with the owner's server (2026-11-20, at the owner's "Yes, pair it")

The simulator's app was paired with the server on this Mac (a loopback address, which a simulator reaches as it is)
with a code from `usual-mail pair --json`, handed straight to `xcrun simctl launch … -UsualMailPairServer
-UsualMailPairCode` and shown or stored nowhere; the token is in the simulator's Keychain, and the server lists the
device under the simulator's name (`usual-mail devices`). It went straight to Home, with no first-run steps.

- **Seen:** Home with real summaries, a long list scrolling and ending above the row at the foot; an HTML mail on the
  mail page, its pictures coming through the server, the summary box and the tracker line; the switcher's menu with
  the real inboxes.
- **Found and fixed:** mail showed through the glass of the row at the foot as it scrolled under it. `safeAreaBar`
  brought no scroll edge effect to lists this deep, so `PhoneCard` fades its content out within the row's height.
- **Seen and left:** an inbox named by its address wrapped onto two lines in the system's menu (cut to one line
  since 2026-11-24, `PhoneSwitch.menuTitle`).
- **One action, at the owner's "Yes, pin and undo":** a read mail pinned from its long-press menu left Home, and the
  undo strip ("Pinned." with Undo) showed centred just above the row at the foot; Undo put the mail back in its
  place and Pinned read "Nothing pinned." No other action was taken on real mail, and only mail already read was
  opened.

To run it again: `xcrun simctl spawn <device> defaults write labs.usual.UsualMail UsualMailSample YES`, then install
and launch the Debug build (`build/DerivedData-ios/Build/Products/Debug-iphonesimulator/UsualMail.app`); the launch
options are the Mac's (`-UsualMailPlace inbox` and the rest), read from the app's defaults.

A build installed over the paired app must be signed as the earlier one was (the gitignored `Config/Local.xcconfig`,
which a fresh worktree lacks): the pairing token is in the simulator's Keychain under `<team>.labs.usual.UsualMail`,
and an unsigned build (`CODE_SIGNING_ALLOWED=NO`) has no `application-identifier`, so it can't read it and opens on
Welcome, its copy untouched (seen 2026-11-24). Signed again, it opens on Home; don't pair again for it.

## Sending it to TestFlight (2026-11-20)

- `apps/scripts/testflight.sh` (after Usual Bot's): archives the `UsualMailPhone` scheme in Release for
  `generic/platform=iOS` and exports with `app-store-connect`, automatic signing, `testFlightInternalTestingOnly` and
  the build number from the time (`YYYYMMDDHHMM`, UTC); `--check` signs and exports into `build/TestFlight` without
  uploading. It needs `DEVELOPMENT_TEAM`, Xcode signed in to that team, and an App Store Connect record for the bundle
  ID. The archive is signed automatically whatever `Config/Local.xcconfig` pins for the Mac's Debug builds.
- **The icon** (`AppPhone/Assets.xcassets/AppIcon.appiconset`, `ASSETCATALOG_COMPILER_APPICON_NAME` in
  `Shared.xcconfig`): the tree on its hill, as the website's icons, a 720-pixel square of the wallpaper at 1024
  (`apps/scripts/make-app-icon.sh`, ImageMagick 7). The wallpaper is a free Unsplash photo under
  the Unsplash License (settled 2026-11-24, [decisions-licence.md](decisions-licence.md)).
- **The privacy manifest** (`AppPhone/PrivacyInfo.xcprivacy`): no tracking, nothing collected, and `UserDefaults`
  for the app's own settings (CA92.1). GRDB brings its own.
- `Config/Info.plist` already says the app uses no non-exempt encryption, so App Store Connect asks nothing about
  export compliance.
- Done once, at the owner's "submit for testflight": `--check` exported a signed 0.1.0 (a 10 MB package with the
  icon and both manifests), then the upload was accepted ("Upload succeeded") and App Store Connect showed the build
  processing. The maintainer's record of it is in the workspace's private notes. On 2026-11-25 it was seen
  installed from TestFlight on the owner's Mac, where macOS runs an iPhone-only app in a phone-sized window
  (288 × 545 points, which the app can't widen): the owner found onboarding there too narrow.
- **The Mac app** (2026-11-25, the owner's choice): the same record, since both targets share the bundle ID, so a
  Mac given a Mac build installs that instead. `testflight.sh --mac` archives the `UsualMail` scheme for
  `generic/platform=macOS`. The Mac app got the iPhone's icon (`App/Assets.xcassets`, every Mac size from the same
  square, full-bleed: macOS 26 rounds it, as Finder showed) and its privacy manifest (`App/PrivacyInfo.xcprivacy`).
  `--mac --check` exported a signed 0.1.0 (a 19 MB `.pkg`, Apple silicon and Intel, sandboxed, Apple Distribution),
  and build 202611251025 uploaded ("Upload succeeded") but App Store Connect failed it in processing (ITMS-90284):
  the four Swift package resource bundles in `Contents/Resources` still carried the archive's Apple Development
  signature, which the export doesn't replace ([known-issues.md](known-issues.md)). Since then the script takes those
  bundles' signatures off in the archive before the export, and `--mac --check` fails if anything in the exported
  app is signed by anyone but the app's signer: each sealed bundle, and since the review of 2026-11-25 each Mach-O
  file wherever it sits (`machos`, by what `file` reads; the guard before taking a bundle's signature off looks for
  them too). The script's usage says to run `--mac --check` before `--mac`. Both checks were tried on a copy of an
  archived app, clean and with an unsigned binary planted in a resource bundle (each caught it), not by an export,
  which registers a build. Build 202611251405, uploaded with that fix the same day, finished
  processing as valid and went into internal testing; the record gained its macOS version by itself, nobody added
  the platform by hand. Not yet seen installed from TestFlight.
- **`--check` registers a build upload** that stays "awaiting upload" in App Store Connect (the export with
  cloud-managed signing announces each build number). Harmless: the next number is always larger.
- **The iPhone's bundles** go out the same way: at the app's root, sealed as files, still Apple Development in the
  exported `.ipa` (seen 2026-11-25). App Store Connect accepts that for iOS (build 202611201656 is valid), so the
  script leaves them alone.
- **The builds with 0.1.5** (2026-11-27, at the owner's "build the application and create a new test flight version
  for both Mac and iPhone"), from `51ae4cd` (`v0.1.5`), each after its `--check`: iPhone 202611271637 and Mac
  202611271641, both valid in App Store Connect and in internal testing. Their version is still 0.1.0, as every build's
  has been. They unsubscribe against a server at 0.1.5 or newer, and only block against an older one.

## How to check

`apps/scripts/check.sh` now also builds the iPhone app for the simulator, unsigned (`check.sh ios` for that alone).
The tests run on the Mac only: `PhoneTests` covers the switcher's words and ticks and the compact row's items.

Checked 2026-11-21: `check.sh` exit 0 twice in a row (lint clean, `UsualMailKit` 496 tests in 79 suites,
`UsualMailUI` 382 in 57, the unsigned Mac build and the iPhone simulator build with no warnings). On 2026-11-20
`UsualMailKit`'s `SenderPicturesTests.twoLoadsAtOnceMakeOneRequest` had failed three runs of four, stopping `check.sh`:
the test depended on the Mac's memory pressure, not on the iPhone work, and was fixed on 2026-11-21
([known-issues.md](known-issues.md), Fixed).

## Not done, not verified

- **Never on a device;** other screen sizes unseen; of the actions, only pin and its undo were tried on a server.
- **Narrow screens:** at 44 points (since 2026-11-25) the row has 343 points on a 375-point screen, 361 on a 393 and
  370 on a 402 (seen). By `BarFit`'s sums (Geist at 14 points as CoreText measures it, `PhoneTests`), "Notifications"
  named needs 355 with Screening empty, 361 with a one-digit count, 367 with two and 373 with three: so on a 393-point
  phone its name shows with at most one digit, on a 402 with at most two, and never on a 375, where the chosen tab is
  its lit icon. The review of 2026-11-25 measured a little more (364 for one digit), so on a 393 the edge is that close;
  not seen on those screens.
- **Text size:** the design's fixed 10 and 12 points, which don't follow the iPhone's text size setting.
- Drag and drop; the corner note of what the server is doing; a launch screen of its own; dark
  mode; iPad; notifications (the server would have to push); a run on a device.
- `PhoneWindow` repeats `MailWindow`'s small helpers (read, back, act, the kept scroll places).
