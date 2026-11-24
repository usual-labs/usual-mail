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
an inbox's address, a chevron) and settings as 32-point glass over the wallpaper; the card as wide as the screen,
rounded at the top, running to the foot; at its foot Home (named), Feed, Receipts, Notifications and the screening
capsule with its count. Text and controls are the Mac's sizes (12-point text, 32-point controls).

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
- **`PhoneTopBar`**: search (opens over the stack, its field given the focus), the switcher, settings; search and
  settings lit while their page shows. The switcher's capsule names what shows (`PhoneSwitch.label`: an inbox by its
  address, "All inboxes", or the page) and opens the system's menu: every inbox and All inboxes (the one showing in
  the mail stack chosen), then To reply, Pinned and Snoozed with the server's counts as badges and Inbox (the one
  showing chosen), then "Add Gmail" (the shared sheet, "Add a Gmail account"). The rows are plain buttons, so the
  menu keeps no column for ticks; the chosen row's icon is a check mark instead (owner's words of 2026-11-24), and
  every icon is drawn into the same 18-point box (`Icon.menuImage`; the design package's inbox icons, as the rocket,
  showed larger than the app's own). The menu's words are cut to one line in the middle
  before they reach it, 16 characters at most (`PhoneSwitch.menuTitle`, "someon…y.example"; owner's words of
  2026-11-24, "dont let the items wrap, do ellipsis"; the full name stays the row's accessibility label). Tried and
  dropped the same day: the app's own popover in Geist 12 with the chosen row in bold (the owner: "its not native
  anymore"), and in the system's menu a bold title and a line limit, which it ignores, as it does any font: the
  system's menu stays, in its own type. Its ink follows the wallpaper under it (`RailTone`). The
  top row sits 16 above the card (the concept's 24, "a bit less" at the owner's word of 2026-11-24;
  `PhoneLayout.gap`).
- **The row at the card's foot** is the Mac's `TopBar` with `compact`: the tabs and the screening capsule; with a mail
  open the back button as an arrow alone and the mail's buttons; Settings' tabs as icons, the chosen one named;
  search's capsule back. No title capsule on To reply, Pinned, Snoozed and Inbox (the switcher names them). Settings'
  tabs sit in the middle of the row, not at its right as on the Mac (owner's words of 2026-11-24, "only in iphone";
  `TopBar.centres`). Each capsule takes touches 6 points above and below its 32. Snooze and more open upwards as
  popovers.
- **Without a pointer** (`Pointer.exists` false): a row's time always shows, and so does a seen notification's tick.
  A long press on a row shows the Mac's right-click menu (the same `contextMenu`).
- **Pages:** the card's side margin is `Theme.pageInset`, 16 on the iPhone (the concept's) and the Mac's 24.
- **Settings' Blocked tab:** Unblock is the light button (`LightButtonLabel`, the secondary one beside a step's dark
  button) in the middle of its row, not the Mac's link at the row's top (owner's words of 2026-11-24, "like a button.
  not primary though, secondary", the iPhone only; `BlockedRow`).
- **First run:** the cards are as wide as the screen leaves (`onboardingCard`), pairing's wordmark sits below the
  status bar, and its fields don't capitalise. The cards sit at the foot of the screen, not in its middle (owner's
  words of 2026-11-24; `OnboardingLayout.cardsAtFoot`): pairing's 24 from the screen's foot, and the screen keeps the
  keyboard's room, so "Connect to your server" rises above the keyboard whole (seen in the simulator); the steps after
  pairing at the foot of their safe area, 16 above it (not seen: the simulator's app is paired). Their two bottom
  corners follow the screen's (`OnboardingCardShape`, a `ConcentricRectangle`: the screen's radius less the card's
  distance from its edges, at least 16; the top 16; owner's words of 2026-11-24): about 31 on pairing's cards on an
  iPhone 18 Pro, 16 once the keyboard lifts the card away from the corners (both seen in the simulator).

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
    room is gone, so the switcher takes touches on its 32 points only.
  - The Inbox page's and search's one-line rows left the subject a few letters: `MailLine` (`Pieces/`) lays the same
    parts out on two lines on the iPhone and as before on the Mac.
  - The card stopped at the keyboard: its ground now runs under it.
- **Seen and left:** in the switcher's menu the Personal inbox's person icon draws solid (its grey fill, as a
  template); an inbox's address doesn't show under its name there; no badges showed (the sample's counts weren't
  checked). The pairing card was centred and didn't move for the
  keyboard (since 2026-11-24 it sits at the foot and rises above it).
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
  `Phone.xcconfig`): the tree on its hill, as the website's icons, a 720-pixel square of the wallpaper at 1024
  (`apps/scripts/make-app-icon.sh`, ImageMagick 7). The wallpaper is a free Unsplash photo under
  the Unsplash License (settled 2026-11-24, [decisions-licence.md](decisions-licence.md)).
- **The privacy manifest** (`AppPhone/PrivacyInfo.xcprivacy`): no tracking, nothing collected, and `UserDefaults`
  for the app's own settings (CA92.1). GRDB brings its own.
- `Config/Info.plist` already says the app uses no non-exempt encryption, so App Store Connect asks nothing about
  export compliance.
- Done once, at the owner's "submit for testflight": `--check` exported a signed 0.1.0 (a 10 MB package with the
  icon and both manifests), then the upload was accepted ("Upload succeeded") and App Store Connect showed the build
  processing. Not yet seen as ready, installed or run from TestFlight. The maintainer's record of it is in the
  workspace's private notes.

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
- **Narrow screens:** with Notifications chosen the tabs and the screening capsule need about 351 points; the row has
  362 on a 402-point screen (seen), 353 on a 393-point one and too little on a 375-point one.
- **Text size:** the design's fixed 10 and 12 points, which don't follow the iPhone's text size setting.
- Swipe actions on rows; drag and drop; the corner note of what the server is doing; a launch screen of its own; dark
  mode; iPad; notifications (the server would have to push); a run on a device.
- `PhoneWindow` repeats `MailWindow`'s small helpers (read, back, act, the kept scroll places).
