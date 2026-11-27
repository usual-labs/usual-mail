# Apps: tests worth knowing

Which tests guard what in `apps/` (UsualMailKit and UsualMailUI). The apps themselves are described in
[apps.md](apps.md); `apps/scripts/check.sh` runs them all.

- `SwipeActionTests` (UI, 2026-11-25): Home's swipes on the iPhone, left marking seen and right snoozing unless
  Settings says otherwise; seen following New and Seen (read, or unread again), snooze asking when first, reply
  later, pin and archive doing what the mail page's buttons do, the way back for a mail already there. Since
  2026-11-27 also Notifications' and the Feed's defaults and their own settings, a group's row acting on every thread
  in it, and block asking first and needing a sender; and the Feed's left unsubscribing: asking first in its own words
  ("Unsubscribe from Kestrel Roasters?", its red button), blocking the sender the row names, needing a sender, block
  still a choice.
- `UnsubscribeModelTests`, `BrowserAgentDisclosureTests`, `BlockedSenderUnsubscribeListTests` (Kit, 2026-11-27):
  `Unsubscribe` decoded and written back as core has it (working without a way, page or words), every way and state
  and an unknown one kept, only an https page with a host offered to open (not http, `javascript:`, `mailto:`); a
  blocked sender carrying one only when asked; `unsubscribe.changed`; `AiSettings.browserAgent` and the patch's key or
  `null`, the key a secret; the route (`POST /v1/threads/:id/unsubscribe`, no body, the id escaped); the disclosure's
  title and four lines found word for word in core/src/unsubscribe.ts; the list keeping the higher version, and one
  seen before its row given to the row.
- `UnsubscribeStoreTests`, `BrowserAgentSetupTests` (Kit, 2026-11-27, against the stand-in server, which gained
  `GET /v1/senders`, the unsubscribe route and `block_sender` adding the sender to its blocked list):
  `unsubscribe(threadID:)` blocks first (the post done, the strip "Blocked. Asking them to stop.") then asks; the
  Blocked tab's row carries the answer and `unsubscribe.changed` moves it on, a late older copy not taking it back;
  Undo unblocks without taking the request back; the answer waiting for its row; an event during the load applied on
  top; a refused request said in `problem` with the block kept; a refused block asking nothing; the sample asking
  nothing. The Browser Use key: sent once, trimmed, the server's state kept, never in the copy on disk; a refused key
  is the server's state; a refusal said in the setting without the key and not in `problem`; removing sends `null`.
- `BlockedTabTests.howUnsubscribingGoes` and `SettingsTabsTests.theBrowserAgentsStateWords` (UI, 2026-11-27): the
  Blocked tab's line by state and way (a page that isn't https as good as none, a failure in the server's words, an
  unknown state saying nothing) and the AI tab's Unsubscribing words (the state's word, the server's detail or a
  line of its own, where a key is made).
- `TabNewsTests` (UI, 2026-11-27): the dot on a tab with mail not seen yet: mail from before lights nothing, new
  unread mail lights its tab and not the chosen one, looking or reading puts it out, new mail in a thread counts
  again, a profile sees its own, and what is kept survives a restart and forgets what the copy no longer holds.
- `PhoneTests` (UI) also holds, since 2026-11-25, `BarFit` measuring the row as `TopBar` draws it, beside Settings'
  tabs centred on the iPhone only.
- `SyncRetryTests` (UI, 2026-11-25, the review's): `SyncNoticeDispatch` opens the dashboard, moves the window or asks
  the server, and only Try again asks it, a refusal in words; `SyncRetry` busy while asking, "Asked your server to
  sync." until the inbox changes, it goes, or 30 seconds pass, a change while asking ending it once the server
  answers (and one changed back not), and a refusal's line, the button free again.
- `SyncWarningTests` (UI, 2026-11-25): only `needs_attention` warns; the notice on every list with the inbox's
  mail and not on Settings, search or an open mail; its words for one inbox (the server's, or a line of its own when
  there are none), two and three; Gmail's "Sign in again", another single inbox's "Reconnect on the dashboard"
  (which leaves the window where it is) and several inboxes' "Open Accounts"; `Navigation.accountsSignIn` set by the
  button and dropped by another tab, stack, search or profile; the iPhone menu's line under the name and the
  capsule's words. Each inbox is looked up by its id, not its place in the sample.
- `FirstSyncProgressTests` (Kit, 2026-11-23): `Inbox.firstSync` decoded, written back and brought by `inbox.changed`;
  core's words ("1,200 of 3,400"); fetching while `connecting` or a first sync still running, not while paused or
  needing the person; several inboxes add up those that have a count (one connecting without one, just resumed or
  signed in again, doesn't hide the others'; the review of 2026-11-23, seen failing first); the first run's lines. With
  `ActivityNoteTests.fetchingSaysHowFarAFirstSyncHasGot` and `SettingsTabsTests` (UI): the corner note and the
  Accounts row.
- `SampleDecodingTests`: the fourth revision's sample (connections, rules' versions and makers, `drf_2` sent with a
  note in `thr_7` only); connections from an older store and a newer server; a rule made by `system`.
- `RuleEventTests`: `rule.changed` by version, an agent's suggestion with its name, `rule.removed`, a rule made or
  removed by an event during a refresh (the watch), a refresh removing a rule gone elsewhere, a teach answer's maker.
- `InboxCredentialsTests`, `MailStoreCredentialsTests`: the credentials' exact JSON and whole-number ports; the
  patch sent whole; `connecting` after; a changed server back in the connection; the provider's words on a
  refusal; another mailbox; a secret taken out of the words; offline; a paused inbox staying paused, then
  `connecting` when resumed; the dashboard link with a path prefix.
- `PausedInboxTests`: sending and a file from a paused inbox say so in words; another `conflict` keeps the server's
  words; an action on its thread still applies.
- `AttentionTests`: the refresh asks `attentionOnly=true`; a failed record needs a look though Handled's default
  leaves it out; a later error or note; the person's own refused change, from an event and from a refresh, though
  never in Handled's list; never a silent one.
- `SentDraftTests`: `drf_2` only in its thread; a sent draft without a note goes at once; `draft.removed`; a refresh
  dropping a sent draft whose day is over.
- `ProviderChangeTests`: a thread moved to spam (trashed, no record) leaves every list and the next refresh; new mail
  filed outside the inbox arrives done, or in its pile.
- `LocalStoreTests`, `TrashedThreadTests`, `SilentRecordTests`, `MailStoreEventTests`, `MailStoreOpeningTests`,
  `MailStoreInboxTests`, `MailStoreDraftTests`, `MailStoreSearchTests`, `APIClientTests`, `PairingTests`: as before,
  updated for the revision.
- `HomeTests`: Home follows the list's rules on the sample (New thr_14, thr_1, thr_2, thr_12; Seen thr_16; no screened
  thread, one-time code, newsletter, invoice, stacked or snoozed one); read mail is Seen; one profile shows one inbox;
  "Sender - summary", the snippet without one, markup kept as text; the times on hover; initials and stable avatar
  colours; the design's columns and a narrow window.
- `ExplanationTests`: why there are no summaries in each AI state, with how many wait, and for an inbox not sent to
  the AI; "why it's here" for the AI, a person, the mailbox, a rule and an unsorted thread.
- `FifthRevisionModelTests`, `FifthRevisionStoreTests`: the fifth revision's sample decoded (categories, an unknown
  value kept, summaries, screened, icons and positions, the AI actor, counts, AI status and settings, brief counts);
  each list's membership and order; categorize and its undo on screen; letting in clears screened; counts and AI
  status from a refresh and from events, the higher version kept; the new routes' paths and queries.
- `AssetTests`, `FontTests`: every icon and the wallpaper are in the bundle; the fonts register.
- `LaunchOptionsTests`: the debug launch options (see "Launch options" above).
- `UnreachableWordsTests`: an unreachable server in words for the common `URLError`s, and no system error code for
  the rest.
- `HTMLMailTests`: the web view's settings and the page's policy, unchanged.
- `SenderPicturesTests` (2026-11-19; the memory stand-ins 2026-11-21): one request for two loads at once, the still
  then in memory (`KeptStills`), and with memory keeping nothing (`ForgottenStills`, an `NSCache` after a critical
  memory-pressure event) still one request and the next load from disk; a load started while the request is out and
  unanswered joins it (the only test that sees the load in flight forgotten too early); read back from disk by a new
  instance and then in memory, a damaged file fetched again, a gone picture not asked again until its id changes, a
  server error or no connection tried again, refused bytes (wrong or missing type, SVG, undecodable, truncated, over
  4096 px) as initials, only the route's own path asked for. A test that says what is in memory gives a stand-in: a
  real `NSCache` keeps what memory pressure on the whole Mac allows, the most likely reason
  `twoLoadsAtOnceMakeOneRequest` failed three runs of four on 2026-11-20 ([known-issues.md](known-issues.md), Fixed).
- `PhoneTests` (2026-11-20, run on the Mac): the iPhone switcher's words and ticks in each stack, under search and
  Settings; the compact row's items (the Mac's, without the title capsule); the Mac has a pointer and a 24-point
  page margin. `MailLine`'s two-line layout on the iPhone has no test: it was only seen in the simulator.
- `GoogleClientSetupModelTests`, `GoogleClientSetupLoadingTests`, `GoogleClientGivingTests`, `GoogleClientFileTests`
  (2026-11-21, the Google client's set-up; stand-in server `Support/GoogleSetupServer.swift`): the set-up and the saved
  answer decoded as core writes them (an unknown step id, unknown fields, `client.note`); the two routes' paths, token
  and query, and the file sent byte for byte; both paths, the agent's first, or only those the server sent words for;
  host-only words for no address and a client not changeable, with nothing sent; the note; a set-up that can't be had,
  an older server, a quiet re-ask that keeps what it had; the set-up asked again before sending; a file too large or
  unreadable refused before sending; each refusal in the server's words, a 401 and an unreachable server in the
  app's; a `conflict` asking to replace, Replace it sending the same bytes with `replace=true`, Cancel dropping them, a
  `conflict` that can't be replaced (demo mode since), one when the set-up can't be asked again, and one while
  replacing; a client given elsewhere used, not overwritten; a file kept but not usable; a second file while one is
  sent, and stopping it; the whole step to the button with nothing opened and `serverInfo` updated; `recheck`;
  reading a folder, symbolic links (to a file, a folder, nothing, a named pipe), a named pipe and `/dev/null`.
  `GoogleClientSetupViewTests` (UI): the set-up's words (no dashes, the agent's line not repeating the server's note),
  only https pages on `console.cloud.google.com` open, `CopyFeedback`'s moment and a later copy keeping it, the Gmail
  step's notes held while there is nothing to sign in with, and the set-up rendered offscreen in a card offered 560
  and 420 points and in a sheet on a small window. `GoogleSetupLayoutTests` (UI): the real Gmail step laid out in the
  app's fonts in an offscreen window (never shown; the step's tasks ask a stand-in serving core's set-up,
  `GoogleSetupFixture.swift`; sizes are the windows' content under their 32-point title strip), read through
  `LayoutMarks`: at 1512 × 982 the agent's path whole with room around (the card 560 to 660 high; 598 now, about 605
  on screen); at 1100 × 620 and 820 × 592 the margin kept, the part above scrolling with a useful height and its
  content as wide as without a bar, and the file section whole and clear of the scrolling part; at all three sizes
  the agent's row with "Copy the prompt" (`LayoutMark.promptActions`) inside the scrolling part and clear of its
  24-point bottom fade (it failed at the two short sizes before the row moved first); "Do it myself"
  scrolling above a whole file section; the sheet within its window's limit with the file section in view;
  `GuideLayout`'s plans (whole, file whole, compact, sliver, scrolling file); the limits from the window;
  `FittedLayout`'s heights and the edges' fades. `GoogleClientSetupViewTests` also checks the file note's words and
  that its colour reads at more than 3.5:1 on the card (the old one under 2.5). `GoogleSignInTests` and
  `AnotherGmailTests` expect `.needsClient` for a server without a client.

## Earlier check runs

**Checks run 2026-11-17 on this Mac, on the fifth revision:** `apps/scripts/check.sh` exited 0: lint clean,
`UsualMailKit` 252 tests in 46 suites (`FifthRevisionModelTests`, `FifthRevisionStoreTests` new; every test that used
piles, triage, `move` or `/v1/now` rewritten; the stand-in server split into `SampleServer` and
`SampleServer+Views`; `SenderTests` and the fresh-copy pairing test after the amendment: 256 in 47; with
`GoogleSignInModelTests` and `GoogleSignInFlowTests`, 266 in 49 on 2026-11-17 evening) and `UsualMailUI` 48 in 10
(`ExplanationTests`, `MotionTests`, `MailPageTests`, `TopBarTests`, `ScreeningTests` new) passed, the unsigned Mac
build succeeded with no warnings (`LocalStore.state` now asks for a `Sendable` value, which quietened the last one).
