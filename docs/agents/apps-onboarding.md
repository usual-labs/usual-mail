# The Mac app's first run (`apps/`, onboarding)

The steps from first launch to Home, built on 2026-11-17 to the owner's agreed flow and approved words (the sessions'
shared notes, `onboarding-copy.md`; manifesto option D). The rest of the Mac app is in [apps.md](apps.md). What was seen
on screen is in [apps-runs.md](apps-runs.md) (the AI key step on 2026-11-17; the history step and the Gmail step with
the guided Google set-up on 2026-11-21, on a separate preview copy, before and after its layout fix); otherwise the checks are tests, the build, and the
Kit run against a scratch server (below).

## Who owns what

This part's files (the rest of `apps/` is the Mac app's, in [apps.md](apps.md)):
- `Packages/UsualMailUI/Sources/UsualMailUI/Onboarding/`: `PairingView.swift` (before pairing, the wordmark, the
  server step), `WelcomeStep.swift` (welcome, where to run), `OnboardingView.swift` (after pairing),
  `ConnectGmail.swift` (`GmailStep`, and `GoogleSignInStep`, which Settings uses too: keep its parameters),
  `AiKeyStep.swift`, `HistoryStep.swift`, `WhileWaitingStep.swift`, `OnboardingPieces.swift` (card, title, field,
  choice row, footer), and since 2026-11-21 the Google client's guided set-up: `GoogleClientSetupView.swift` (states,
  the path choice, `FittedScroll`), `GoogleClientPaths.swift` (`AgentPath`, `StepsPath`, `CopyButton`),
  `GoogleClientFileDrop.swift` (`ClientFileDrop`, `DroppedClientFile`).
- The one imageset `onboarding-screenshot` in `UsualMailUI/Resources/Assets.xcassets` (agreed with the Mac app
  session; nothing else in that catalog).
- In `UsualMailKit`: `Store/Onboarding.swift` (steps, resume, `isNeeded`, words), `Store/OnboardingProgress.swift`,
  `Store/OnboardingAiKey.swift` (with an internal `MailStore.keep(aiStatus:)`, which writes the status read after
  saving a key through the same versioned path as `ai.status.changed`, as the Mac app session confirmed),
  `Store/GoogleSignInFlow.swift`, `Models/GoogleSignIn.swift`, and since 2026-11-21 `Store/GoogleClientSetup.swift`
  (the set-up's model, `GoogleClientFile`, `MailStore.googleClientGiven`) and `Store/OnboardingGoogleClient.swift`
  (its words, `Onboarding.GoogleClient`).
- Tests: `UsualMailKitTests/Onboarding{,Gate,AiKey}Tests.swift`, `GoogleSignInTests.swift`,
  `GoogleClientSetupTests.swift`, `UsualMailUITests/OnboardingViewTests.swift`, `GoogleClientSetupViewTests.swift`.
- The disclosure's model and route (`AiDisclosure`, `APIClient.aiDisclosure(for:)`) are the Mac app session's.

## The flow

Before pairing, `RootView` shows `PairingView(session:)` over the wallpaper, with "Usual Mail" in Prociono at the top
left ("Mail" lighter, as usual.dev writes "Usual" and "dev"); margins as usual.dev's, 6% of the width between 24 and
80 points, at least 52 from the top.
1. **Welcome:** the manifesto at the bottom left, white over the hills with a soft shadow and, since 2026-11-24 (the
   owner's "a bit of shadow behind text"), a tight one close behind the letters, 15 points, at most 440 wide,
   and "Get started" under it at that column's right (owner's words of 2026-11-24, on the Mac and the iPhone; it was
   at the left). Left-aligned: SwiftUI's `Text` can't justify, so the lines are even by width only.
2. **Where should Usual Mail run?** "Your own server" (chosen) and "Usual hosted · Coming soon" (faded, can't be
   chosen); Back, Continue. Choosing their own server is remembered, so pairing again starts at step 3.
3. **Connect to your server:** server address, then the server's password by default (2026-11-24, the owner's
   password: `AppSession+Owner.swift` in the Kit), the help line, "Use a pairing code instead", Back, "Connect". Before
   signing in, the app asks the server what it needs (`passwordStep`): with a password it signs in; a server nobody
   owns turns the card into **Set up your server** (email optional, the new password twice, "Set up": `claim`); one
   whose host named the owner's email says to set it up in a browser; one without a password switches to the code
   with words saying so. The code mode is as before (`AppSession.pair`), its help unchanged; it links back to the
   password. On the iPhone the card sits at the screen's foot and rises above the keyboard (apps-phone.md).
   `session.pairingProblem` shows in red, in the approved words, which `AppSession` owns. "Don't have a server yet?
   Set one up" is hidden until the guides have a public address (below). A Mac signed out with a reason starts here.

After pairing, `OnboardingView(session:)` takes the whole window while `Onboarding.isNeeded(store)`: `MailWindow`
picks a `Stage` (`.waiting` until `store.counts` is set, showing only the wallpaper; then `.onboarding` or `.mail`) and
keeps the store running under it (wired by the Mac app session, 2026-11-17 evening). Each step is a frosted card with
"Use another server…" at its foot (it asks, then `session.disconnect()`), since Settings can't be reached meanwhile.
The order after pairing is the owner's of 2026-11-18: how much old mail first, since the server's first-sync window
applies only to inboxes connected after it is set.
4. **How much old mail?** The body ("New mail comes in as it arrives. Usual Mail also brings in some of the mail you
   already have, and the AI sorts and summarizes all of it; each message costs a little on your Vercel account."),
   then "The last 7 days (recommended)" and "The last 30 days", plus the server's own days when they are neither
   ("The last day" for 1), so a window set elsewhere isn't changed silently; the server's days are picked. The window is
   `store.firstSyncWindow` (`GET /v1/first-sync`, filled by the refresh; the step asks again with
   `loadFirstSyncWindow()` if it is missing). Continue sends `updateFirstSync(days:)` only when the choice differs and
   the window can change; a refusal shows the store's words, else "Your server didn't keep the choice. Try again."
   Not changeable: the rows can't be picked, with "Your server is set to bring in the last {n} days, and that can't be
   changed from here." Not read: "Your server didn't say how much old mail it brings in. Continue to use its own
   setting." and Continue moves on without saving. The AI's own `historyDays` is gone from the contract.
5. **Connect your Gmail:** the body, `GoogleSignInStep`, the two notes on Google's warning and the weekly sign-in. Once
   an inbox exists: a row per inbox ("{address} · Connected, fetching mail", with "· 120 of 340" once the server says
   how far its first sync has got, 2026-11-23; "Needs you" or the server's words when it
   needs attention; "Paused"), "Add another Gmail" as a light button with the test-user note, and Continue enabled
   (it shows from the start, greyed out until the first inbox; seen 2026-11-21). The step
   is rebuilt for each inbox (`.id(count)`), so the button comes back. Without a Google client: the guided set-up
   (below), and the two notes wait until it is done.
6. **Add your AI key:** the body; a secure field "Vercel AI Gateway key"; "Get a key from Vercel" (the dashboard's AI
   Gateway API keys page, the address Vercel's docs give); then the server's words: destination and terms always
   shown, the lead, the three sent items and the history under "What the AI sees" (scrolls past 240 points);
   "Save and test" is disabled until those words loaded, and a plain error with "Try again" shows if they can't be had.
   Saving: `MailStore.updateAiSettings` with only the credentials; the field is emptied the moment it is sent; then
   `GET /v1/ai/status` (the server answered after its test) is kept in the store and said: working or paused moves on
   by itself; key refused, out of credit, unavailable in the approved words; model not found in the server's
   `detail`. A refusal shows the store's words (key masked) and is taken off `store.problem`. With a key already on
   the server that failed, an empty field offers "Test again" (`testAi`).
7. **While your mail comes in:** nine slides (`Onboarding.slides`, title and line): Home is what needs you, A line on
   every message, Feed, Receipts, Notifications, Reply later / pin / snooze, Screening, Your whole inbox, Your inboxes
   (Notifications and Your whole inbox added by the owner on 2026-11-20). One screenshot for all for now
   (`built-home-sample.png`), arrows (also the left and right keys), a dot per slide; at the foot the progress line and
   "Go to Home" (always enabled, Return), which ends the first run on this Mac.

## The Google client's guided set-up (2026-11-21)

Built at the owner's request on the server's routes of the same day (`GET /v1/google/setup`, `PUT /v1/google/client`;
[contract-sync.md](../contract-sync.md#connecting-gmail-by-signing-in-with-google)), then corrected after an
independent review the same day. `GoogleSignInStep` shows it where it showed the words for a server without a Google
client, so it appears in four places without changes there: the Gmail step, "Add a Gmail account" (the rail's plus
and Settings' sheet, `AddGmailSheet`), Settings' "Sign in with Google again" (inline in the inbox's row), and search's
sheet for signing an inbox in again (`SignInAgainSheet`, `Search/SearchRemote.swift`). The iPhone app shares all of
it but the drop area.

- **When:** `GoogleSignInFlow.readiness` answers `.needsClient` when `/v1/info`'s `missing` holds `client` (also when
  the address is missing too: the set-up then shows the server's `noAddress`). Missing only the address keeps the old
  words. The step loads the set-up (`GoogleClientSetup.load`); while loading a small spinner, on failure "Your server
  couldn't say how to set up its Google client." with the reason (the server's words) and "Try again". A server older
  than the route (`not_found`) gets the approved words "Your server can't sign in to Google yet. Give it a Google
  client first; the setup guide shows how." and the hidden guide link. The Gmail step's two notes on signing in wait
  (hidden from the start) while the step is asking the server or showing the set-up (`GoogleSignInStep.holdsNotes`).
- **Asked again:** whenever the app comes back to the front (`onAppBecomesActive`: the Mac app activated, the iPhone
  app back from the background) the step re-asks `/v1/info` (`flow.recheck`) and the set-up re-asks its route
  quietly (`refresh`, keeping what it had if the server can't be asked); and before each file is sent. A client that
  came from elsewhere (the command, another device) hands back `.alreadyThere` and the step becomes the button
  instead of offering to overwrite it; a server that no longer takes a client from a device shows its words.
- **Only the host can:** with `noAddress`, or `client.changeable` false, the server's words (`noAddress`, then
  `client.reason`), the hidden guide link, nothing to give.
- **Otherwise:** a lead, two `ChoiceRow`s side by side where they fit (one above the other where not, through
  `ViewThatFits`): "Let my agent do it" (chosen first) and "Do it myself" (a path the server sent nothing for isn't
  offered), the chosen path, then the file. **The set-up is as tall as all of it wherever there is room** (`GoogleClientGuide`, `GuideLayout`;
  `Pieces/FittedScroll.swift`; reworked twice after looks on screen, 2026-11-21). The part above the file (the lead,
  the path choice, the chosen path) sits in `FittedScroll`, whose `Layout` takes the scroll view's own ideal height
  (its content's); the file section ("Give the file to your server", the server's `client.note`, the drop area with
  "Choose file…", the note on the file, any refusal or question about replacing) is `ClientFileDrop`. `GuideLayout`
  shows both whole when they fit; otherwise **the file section stays whole and in view below** and only the part above
  scrolls in what is left, while that keeps at least 120 points; below that the drop area becomes one row (its words
  beside "Choose file…"), the part above keeping what is left down to 48; and where even that can't fit, the part
  above keeps 48 and the file section scrolls in the rest, so nothing runs past the room (no Mac window gets there:
  the smallest leaves the set-up about 330). Offered no height, the room is the window's height less 240
  (`GoogleClientGuide.cap(window:)`, from the `windowSize` the mail window shares and the sheets' presenters pass on),
  so sheets and Settings follow the same rule; with no window known (the first run) the card's room decides. The
  sheets (`AddGmailSheet`, `SignInAgainSheet`) stop at their window's height less 48. No scroll bar while the part
  above fits; while it scrolls the bar has its own gutter in the card's right margin, as wide as an always-shown bar
  (17 points), so the content keeps its width either way (`FittedScrollMetrics`, following the person's scroll bar
  setting as it changes), and its edge with more beyond fades over 24 points. Every first-run step is offered the
  window less 24 points on each side (`OnboardingFrame` in `OnboardingView.swift`; 16 above and below on the iPhone),
  centred. Laid out offscreen in the app's fonts (`GoogleSetupLayoutTests`, the step's own tasks against a stand-in
  serving core's real set-up; sizes are the windows' content under their 32-point title strip): at 1512 × 982 the
  agent's path shows whole, the card 440 × 598 with 176 points above and below (on screen about 597 and 176); at
  1100 × 620 the card keeps its margins, the part above scrolls in 214 points and the file section (129) shows whole
  below it; at 820 × 592 the same with 186; "Do it myself" at 1512 × 982 scrolls its seven steps in 576 points above
  the whole file section, the card 902 high; the sheet shows whole at 1512 × 982 and, at 820 × 592, keeps the file
  section whole under 166 points of scrolling. The first numbers of that test (a card 540 high) came from a stand-in
  face: the app registers its fonts at launch and the test hadn't; it does now. Seen on screen after this last
  change too (2026-11-21, a preview copy, [apps-runs.md](apps-runs.md)): whole with no bar at 1512 × 982; at 820 × 592
  and 1100 × 620 the file section whole below with the note in full, the part above scrolling and fading, the bar
  beside it only; there "Copy the prompt" and "See the prompt", then last in the agent's path, went out of sight, so
  that row now comes first ([known-issues.md](known-issues.md), Fixed). Seen on screen in that order in the fourth
  preview look (2026-11-21, [apps-runs.md](apps-runs.md)): 22 points clear of the fade at 820 × 592, 50 at
  1100 × 620, whole at 1512 × 982, as offscreen (the row 108 points below the part's top, under the lead and the path
  choice); in the sheet at 820 × 592 it clears the fade by 2, offscreen only.
  - the agent's (this order since 2026-11-21, the owner's "move it above the explanation"): first the row with "Copy
    the prompt" (`LightButtonLabel`; `CopyFeedback` puts the prompt on the pasteboard and says "Copied" for two
    seconds, a later copy keeping it for its own two) and "See the prompt", a toggle like "What the AI sees" that
    opens the prompt right under the row in a 180-point box of 10-point monospaced, selectable text, scrolling
    inside; then the server's `promptNote` (how to sign in, fill it in and hand it over, what stays with the person)
    and the app's one line on what it doesn't say. So the actions are near the top of the part that scrolls, where a
    short window still shows them;
  - the steps: a number in a small circle, the title, its lines, "Open" (`LinkWords` through `Links.open`, only for
    an https address on `console.cloud.google.com` with no port or user; any other address shows the step without
    it; VoiceOver: "Open {title} at Google Cloud") and each `copy` value in a white row with its label, the value
    (monospaced, selectable) and a copy icon (`doc.on.doc`, a tick for two seconds; VoiceOver: "Copy {label}", then
    "Copied").
- **Both end with "Give the file to your server":** the server's `client.note` when it sent one, then on the Mac a
  dashed drop area ("Drop the file here, or choose it.") around "Choose file…", on the iPhone the button alone, and
  the note on the file's name. `fileImporter` takes `.json` and the file is read off the main actor; a drop takes a
  JSON file through `DroppedClientFile` (`FileRepresentation`, read inside the import). `GoogleClientFile.read`
  (its own file) opens without waiting (`O_NONBLOCK`) and follows a symbolic link, takes only a regular file (a
  folder, a named pipe, a device or a dangling link is "couldn't be read", at once), and reads at most 16,385 bytes:
  over 16,384 is refused in the app's words before sending. The model takes one file at a time (a second, dropped or
  chosen while one is read, checked or sent, is ignored), and the bytes go as they are. While sending, the button
  says "Sending…". A refusal shows the server's message as it is (`invalid`, `needs_person`, `internal`,
  `rate_limited`); a device the server no longer knows (401) and an unreachable server get the app's words. Leaving
  the screen stops an upload still on its way (`stop()`; nothing is handed back).
- **Replacing:** a `conflict` to the first upload makes the set-up ask the server again. Only while a device may
  still give a client (a client file already saved, used or not, or inboxes signed in under another client) does it
  show the server's words with "Replace it" (the same bytes again with `?replace=true`) and "Cancel" (the bytes are
  dropped). If the host has since set the client in the environment or restarted in demo mode, the server's words
  for that show instead and nothing can be sent; if the server has a usable client now, the step becomes the button;
  if it can't be asked, the conflict's words show as a refusal. A `conflict` to the replacing upload is a refusal.
- **Once saved:** `flow.clientSettled` sets the step from the answer's `googleSignIn`, so it is the normal "Sign in
  with Google" button by itself (nothing opened, even in the sheets that start at once), with the notes "Your server
  has its Google client." and the server's `redirectHint` when it sent one; `store.googleSignInChanged` updates
  `serverInfo` (About) the same way. A save the server answers while still listing the client as missing (it kept the
  file but can't use it) shows "Your server kept the file, but it still has no Google client it can use." and asks
  the set-up again, so the server's `client.note` says why when it does.
- **Words** (`Onboarding.GoogleClient`, for the owner's review; none approved yet): the lead "Your server can't sign
  in to Google yet. It needs a Google client of its own: you make it once at Google Cloud, then give your server the
  file Google downloads."; the agent's line "Your agent creates the Google client and downloads its file. Then give
  that file to your server below." (the three lines of the first build repeated the server's note and are gone);
  "Copy the prompt", "Copied", "See the prompt", "Open", "Give the file to your server", "Drop the file here, or
  choose it.", "Choose file…", "It's the JSON file Google downloaded. Its name starts with client_secret_." (in the card's secondary colour since
  the second look on screen; it was "…named like client_secret_….json." in the faint time colour), "Sending…",
  "That file is too large to be a Google client file, so it wasn't sent. Choose the JSON file Google downloaded.",
  "That file couldn't be read, so it wasn't sent. Choose it again.", "The file wasn't sent." (before the reason),
  "Replace it", "Cancel", "Your server has its Google client.", "Your server kept the file, but it still has no Google
  client it can use.", "Your server couldn't say how to set up its Google client." (before the reason), "Your server
  sent no steps for setting up its Google client." (neither prompt nor steps nor reason), and for VoiceOver "Copy
  {label}" and "Open {title} at Google Cloud". The prompt, its note, the steps, `noAddress`, `reason`, `note`,
  `redirectHint` and every refusal are the server's (core's) words.
- **Sandbox:** the Mac's existing `com.apple.security.files.user-selected.read-only` covers the file chooser and a
  dropped file; no entitlement changed (its comment in `Config/UsualMail-macOS.entitlements` now names both uses).

### Changed in the Mac app session's files for it

`APIClient.swift` (`Method.put`), `APIClient+Routes.swift` (`googleSetup()`, `setGoogleClient(file:replace:)`, raw
body, `Content-Type: application/json`), new `Models/GoogleClient.swift` (core's `GoogleSetup`, `GoogleClientState`
with `note`, `GoogleClientSource`, `GoogleSetupStep`, `GoogleSetupStepId`, `GoogleSetupValue`, `GoogleClientSaved`),
new `Pieces/Pasteboard.swift` (with `CopyFeedback`) and `Pieces/AppActive.swift` (`onAppBecomesActive`), the
entitlements file's comment, and `AnotherGmailTests.swift` (a server without a client now shows the set-up). In this
session's files: `ConnectGmail.swift` (`.needsClient`, the notes after saving, the re-check on coming to the front,
the optional `holdsNotes` binding the Gmail step uses to hold back its notes; the existing parameters unchanged) and
`GoogleSignInFlow.swift` (`.needsClient`, `notes`, `clientSettled`, `recheck`). `GoogleSignInTests` now expects
`.needsClient` for a missing client.

## Pointer and hover (owner's request, 2026-11-18)

Everything clickable shows the pointing hand and answers the pointer. Buttons on `PlainControlStyle` (the Mac app
session's, `Pieces/Glass.swift`) get the hand while enabled and tell their label (`isControlHovered`): the dark button
lightens (`DarkButtonLabel`), "Add another Gmail" (`LightButtonLabel`), the run and history rows (`ChoiceRowLabel`) and
the carousel's arrows brighten, the dots darken, and the "What the AI sees" toggle (a button with a turning chevron, no
longer a `DisclosureGroup`) takes `rowHover()`. Link-style buttons (`QuietButton`: Back, "Use another server…",
"Try again", "Stop waiting") and web links (`WebLink`: "Get a key from Vercel", and the hidden guide links) take
`.pointer()` and underline under the pointer (`LinkWords`). The disabled "Usual hosted" row gets no hand.

## When it shows, and where it resumes

- `Onboarding.isNeeded(store)`: false until `store.counts` is set (the refresh writes counts and AI settings together);
  then true while the server has no inbox, while `aiSettings.credentialsSet == false`, or while this Mac's progress
  for this server is unfinished. Settings not heard (a refusal) decide nothing. A second Mac on a set-up server goes
  straight to Home.
- `OnboardingProgress.shared`: per server (a 12-byte SHA-256 of the address, as `AppSession` names its copy), the
  step reached, in `UserDefaults` (`UsualMailOnboardingSteps`), set when the steps after pairing begin, updated at
  each step, removed by "Go to Home". Observable, so the window leaves the first run as soon as it ends. Also
  `UsualMailOnboardingOwnServer`.
- `Onboarding.resume`: no inbox → how much old mail, when nothing or that step is saved, else Gmail; with an inbox,
  never the history step (at least Gmail); no key → at most the key step; otherwise the step reached; a key that
  already works moves on from the key step to the carousel. `step(after:in:)` uses the same rule, so Gmail's Continue
  skips the key step when another device already set a working key, and waits while there is no inbox.

## Words changed from the approved copy, and why

- Server address placeholder: "127.0.0.1:8484 or mail.example.com" (the approved copy named another port). The
  server's and the command's default port, and `docs/self-hosting.md`, say 8484.
- The pairing help (the coordinator's words, 2026-11-17): "Get a code with usual-mail pair on your server, or from the
  file owner-pairing-code in its data folder. A code works once." The approved "Your server prints a pairing code when
  it starts" stopped being true: the fixed server prints a code only when it makes one. Since 2026-11-24 (the
  coordinator's suggestion, the owner's yes) it goes on: "On Cloudflare, the first code is in the Worker's Data
  Studio, table owner_pairing_code; later ones come from the dashboard's Devices and agents page.", since the
  Cloudflare server has neither the command nor the file ([self-hosting.md](../self-hosting.md), "On Cloudflare").
- The progress line: the server gives only `pending`, no total, and counts 0 until a first sync has listed mail. So:
  "Sorting your mail · {pending} left"; "Fetching your mail" while an inbox is fetching (`connecting`, or a first sync
  still running) and nothing is pending, with core's count once a fetching inbox has one ("Fetching your mail · 120
  of 340", added up over the inboxes that have one; 2026-11-23); "All sorted" only when every inbox is `ok`, none is fetching, and
  nothing is pending; "Sorting your mail" otherwise. A stuck AI says the
  key step's words; paused: "Sorting is paused on your server."; no key: "Sorting starts once your AI key is saved."
- Words with no approved version: "Use another server…" (the coordinator's), the disclosure error ("Your server
  couldn't say what the AI would be sent, so the key can't be saved yet." plus the reason; "Your server sent no words
  on what the AI would be sent."), "Test again", the fallbacks for a model not found without `detail`, an unknown
  state, a status that couldn't be read after saving, "Back", "Needs you"/"Paused" in an inbox row. The words of
  "How much old mail?" are the coordinator's copy notes of 2026-11-18.
- The Google heads-up uses the corrected sentence (no "Advanced" step). `GoogleSignInStep` now says "choose your
  account" (approved) in Settings too.

## Waiting on others

- **Publishing:** the guides' address comes from the Mac app session's `ProjectLinks` (`Store/ProjectLinks.swift`):
  `Onboarding.publishedDocs` is `ProjectLinks.sourceCode` + `blob/main/docs`, and the guides are `self-hosting.md` and
  `google-setup.md` under it. `sourceCode` is nil while `ProjectLinks.isPublished` is false, so the "Set one up" link
  and the Google guide link stay hidden until that one switch is turned on.
- **Guides:** `docs/self-hosting.md` says "choose **I have my own server**" and "choose Connect Gmail"; the app says
  "Your own server", Continue, and "Connect your Gmail" with "Sign in with Google".
- **Screenshots:** one per slide later; the image is a capture of the sample's Home with the window's buttons.

## Checks

- 2026-11-17: `apps/scripts/check.sh` exit 0 (lint, `UsualMailKit` 300 tests in 53 suites, `UsualMailUI` 52 in 11, the
  unsigned Mac build). Onboarding's own: 42 in the Kit (steps and resume, words, history, slides, progress, the gate,
  progress kept per server without the address, the key step against the sample server with the disclosure route
  stubbed, Google sign-in's 1-second asking, 15-second grace and http pages), 5 in the UI (copy, bundle, margins).
- A scratch server from `server/` (port 8797, `--dev-fake-ai`, scratch data, stopped and deleted afterwards): the real
  disclosure has the six fields and the three labels; no service is 400; the Kit's gate said Gmail for a new server;
  the words loaded before saving was allowed; a stand-in key saved, tested `working` and moved on (2026-11-17, before
  the first-sync window replaced the AI's history setting).
- 2026-11-18: the Kit's onboarding tests (33 in 3 suites) pass with the new order, resume, choices, preselection,
  the not-changeable words, and no request when unchanged. `HistoryStep` uses the Mac app session's
  `store.firstSyncWindow`, `loadFirstSyncWindow()` and `updateFirstSync(days:)`.
- 2026-11-20, with the first-sync window and the nine slides: `apps/scripts/check.sh` exit 0 (lint, `UsualMailKit` 371
  tests in 63 suites, `UsualMailUI` 214 in 32, the unsigned Mac build).
- 2026-11-21, with the Google client's set-up after the review's fixes and both layout fixes: `apps/scripts/check.sh`
  exit 0 (lint, `UsualMailKit` 495 tests in 79 suites, `UsualMailUI` 382 in 57, the unsigned Mac build and the iPhone
  simulator build, no warnings); the set-up's own: 31 in the Kit (`GoogleClientSetupModelTests`,
  `GoogleClientSetupLoadingTests`, `GoogleClientGivingTests` with one test run four times, `GoogleClientFileTests`),
  14 in the UI (`GoogleClientSetupViewTests`, and `GoogleSetupLayoutTests`, one of them run at two window sizes,
  which lays the Gmail step out in the app's fonts in an offscreen window that is never shown and reads the card, the
  scroll view, the file section, its drop area and its note from layout marks, `LayoutMarks`, that nothing in the app
  reads). (Earlier runs that day: 484 and 373, then 495 and 380.)
- 2026-11-21, with "Copy the prompt" moved first in the agent's path: `apps/scripts/check.sh` exit 0 (lint,
  `UsualMailKit` 495 tests in 79 suites, `UsualMailUI` 382 in 57, the unsigned Mac and iPhone simulator builds, no
  warnings). `GoogleSetupLayoutTests` now also checks that row (`LayoutMark.promptActions`) inside the scrolling
  part and clear of its bottom fade at 1512 × 982, 1100 × 620 and 820 × 592; on the old order it failed at the two
  short sizes.

## Changed for the iPhone app (2026-11-20, by the session that started it)

Small edits in this session's files so `UsualMailUI` builds for iOS and the first run fits a phone
([apps-phone.md](apps-phone.md)); the Mac's behaviour is unchanged: `ConnectGmail.swift` opens Google's page through
`Links.open` (no AppKit import); `OnboardingPieces.swift`: `onboardingCard` is at most its width on the iPhone, 16
from the screen's edges, `StepField` doesn't capitalise there, and the link button uses `linkStyle()`;
`PairingLayout.margin` keeps the wordmark below the iPhone's status bar. None of it has been seen on a phone.

## Not verified

- Not shown on screen: the layout of the steps other than history, Gmail and the AI key (apps-runs.md), the welcome
  over the hills, motion, the "What the AI sees" toggle, the pointer and every hover reaction, the keyboard arrows,
  focus, Return on each step, the confirmation dialog.
- Signing in with Google and the Gmail step with a real inbox; a real Vercel key.
- The Google client's set-up beyond its first look: seen only at rest, in the first run's Gmail step with "Let my agent
  do it" chosen, against a running scratch server (2026-11-21, apps-runs.md). Never clicked or typed into: "Do it
  myself" and its steps, "See the prompt", no file dropped or chosen (the drop through `FileRepresentation` from
  Finder in the sandbox is untested), the pasteboard, the app-activation notifications, the scroll to a message,
  Replace, the saved state; the path rows' fit at the sheets' 332 points, and VoiceOver. Of the layout fixes, the
  first (whole at 1512 × 982, margins, gutter, fade) and the second (the file section kept in view at 820 × 592 and
  1100 × 620, the note's colour and words) were seen on screen at rest, and the agent's row moved first was seen on
  screen in the fourth preview look (2026-11-21: 22 points clear of the fade at 820 × 592, 50 at 1100 × 620, whole at
  1512 × 982); the compact drop row and the scrolling fallback (no Mac window gets there), "Do it myself" at full size
  and the sheets are laid out offscreen only. The offscreen layout can't show glass, materials, the shadow, the
  fade or the scroll bar as drawn, nor hover; it does use the app's fonts and real layout.
- `OnboardingView` inside `MailWindow`'s `.onboarding` stage, and the hand-over to `.mail` on "Go to Home".
