# Apps: runs on this Mac (2026-11-17)

What was seen when the Mac app ran on this Mac, against which server, and what was fixed while looking. The app
itself is described in [apps.md](apps.md); what was never seen is under "Not verified" at the end.

Run on this Mac (macOS 27, Xcode 27.1), Debug, ad hoc signed, sandboxed. Screens were captured with ScreenCaptureKit
from a small tool in the session's scratch area (Screen Recording was already allowed for it). Nothing could be
clicked or typed: `osascript` was refused assistive access (-1728), `AXIsProcessTrusted` and
`CGPreflightPostEventAccess` were false, and no permission was granted. Every screen was reached through the debug
launch options.

- **The first UI** (before the rebuild): it built and ran, paired with the coordinator's demo server through the
  launch options (plain http to 127.0.0.1 passed the system's transport rules and the sandbox; opening a thread marked
  it read on the server), and drew every screen on the sample and the server's data in light and dark. Its findings
  (a squeezed Approve button, Brief and Handled cramped in the middle column, HTML white in dark mode, a short inbox
  sheet) went with it.
- **The rebuilt UI, on the fourth revision's sample** (before the data layer moved): Home at 1512 × 982 matches the
  Figma frame: the wallpaper, the rail at 96 from
  the edge, the tabs at 100 from the top with Home selected, the screening count, the card at 700 with New and five
  items (thr_1, 2, 8, 12, 6). The Harbor & Pine profile shows its two; Reads shows its placeholder; reading thr_1
  (text and a plain HTML reply) and thr_8 (an HTML newsletter) sits on the card; a 900 × 620 window keeps the rail
  and a 668-point card. Hover times weren't seen (no pointer).
- **Fixed while looking:** template-tinting turned the person icon solid (its grey fill), so icons are drawn as
  designed; the HTML page was a white box at 15 points with an inner scroll bar (the paragraphs' margins escaped the
  measured height once the body had none: `display:flow-root` and no outer margins on the first and last child).
- **A Keychain prompt after each rebuild:** the paired app's token is in the login keychain under the ad hoc build's
  signature; a new build is another signature, so macOS asks for the login password before the app may read it
  ("Usual Mail wants to use your confidential information stored in "Usual Mail server" in your keychain"). Not
  answered here.

- **On the fifth revision, against a real server:** the coordinator's fifth-revision server in demo mode
  (`http://127.0.0.1:8484`, the 16-thread sample from memory, fake models; a fresh store). The old sign-in in the
  Keychain (for the previous server's store) was removed (`security delete-generic-password`, the app's own item, no
  prompt), and the app paired through the launch options with a new code: the new sign-in was saved without a prompt
  and the event stream stayed connected. Checked in the app's own copy (its SQLite file, read-only), since the screen
  was locked: inboxes in position order with building, shop and person, Personal with AI off and needing attention;
  all 16 threads with the sample's categories, `categorizedBy`, screened and summaries (the one-time code without);
  Home's rules give thr_14, thr_1, thr_2, thr_12 under New and thr_16 under Seen, and the server's counts say Home 5,
  unread 4, screened 1; the AI status says working, 1 waiting, 1 beyond history, and the settings 7 of 30 days. The
  only difference from the built-in sample is the times, which the demo server moves to the present.
- **Against the amended server (2026-11-17, a fresh store again):** paired through the launch options after removing
  the old sign-in; the copy was started anew (the fix above). Every list rebuilt from the copy by the contract's rules
  matched the server's own counts: Home 5 (4 unread: thr_14, thr_1, thr_2, thr_12; thr_16 read), conversation 4,
  newsletter 2, invoice 1, receipt 1, notification 1, otp 1, unknown 3, reply later 1, set aside 1, waiting 1,
  screened 1. All 16 threads carry `sender`, 12 `categorizedByActor`; the one-time code is let in and has no summary;
  the AI is working, 1 waiting and 1 beyond 7 of 30 days. The screen was locked, so nothing was seen on screen.
- **Against a real server with real Gmail (2026-11-17 to 2026-11-22).** At the owner's request a session set up a
  server on this Mac with the built command (`usual-mail init --mode node`, 127.0.0.1 only), and the owner paired the
  app by typing the address and a code into the onboarding card: the first pairing done by a person in the app. What
  was seen there, without the mailbox's own details (its counts, senders, amounts and dates were trimmed from these
  notes before the repository went public, 2026-11-24):
  - *Sign in with Google:* the server rebuilt with Google sign-in and given the owner's client file with
    `usual-mail google set --file` (written readable only by the owner, never printed); `/v1/info` said `googleSignIn`
    available and `doctor` showed `google` ok; the app showed "Connect your mail" and the button. The owner's first
    real sign-in worked (connection `gmail`, `signIn: google`, trust `suggest`).
  - *The first sync:* 30 days, all mail but drafts and chats; for minutes the inbox said only `connecting`, which led
    to the progress count of 2026-11-23 (decisions.md). A window lowered by `USUAL_MAIL_SYNC_DAYS` didn't shrink a
    first sync already under way, which led to `usual-mail sync-days` and a window saved in `settings.json` that
    also shrinks a running first sync (cli.md).
  - *The AI with a 7-day history and a 30-day inbox:* older inbox mail landed in Home unsorted with its opening words,
    and the status said nothing waited; fixed by "history is all synced mail" (decisions.md, 2026-11-18). Home's
    note named only one reason for missing summaries; `AIWords.note` now names each.
  - *Pictures through the server:* a newsletter drew its pictures through the server with "1 tracker removed"; a
    screened sender's mail said "Pictures show once you let this sender in."; the owner's own replies showed as "You".
  - *Feed, Receipts, Notifications and the rest:* Feed as posts, Home's filter, the Notifications tab, the money rows
    ("Paid: … to …", "To be paid: … to …", "Will be charged: … by … · on …", "Refunded: … by …"), sender pictures fading
    in over initials, notification events and groups ("{status} · today, {time}" rows with "2 updates"), the Inbox
    page, the rail, To reply, Pinned, Snoozed and Settings' five tabs were each seen on screen after their builds.
  - *What real mail showed that the sample hadn't:* a sender named like a domain ("Shop.de") got two initials (now
    one); receipts with a "Total 0" line read "Paid: €0.00" (an amount of 0 is now no amount); one marketplace's name
    came in several spellings across its addresses (one name per sender, then per registrable domain); a refund sent by
    a marketplace names the merchant beside the marketplace's logo (the money row's avatar now follows the party);
    past deliveries said "Out for delivery" with no day, and "Dispatched" carried the expected arrival day (the
    server's event rules, decisions-ai.md); one parcel's mails stood as separate rows (the groups); snippets carried
    raw link syntax, HTML and zero-width entities (plain snippets).
  - *Capturing the screen:* ScreenCaptureKit failed for hours at a time with -3811 ("Failed to start stream due to
    audio/video capture failure") although the user was active, then worked again; the cause wasn't found. Launched by
    `run.sh` straight from the session's shell, the app's web views drew nothing (the shell's sandbox is inherited);
    `run.sh` now launches through `open`. A relaunch right after a capture once hit LaunchServices error -600; a
    second `open` worked.
  - *Two writers for a while (2026-11-20):* a fork of the apps session resumed the same pages agent from its
    transcript, so two copies wrote the same files at once; the coordinator caught it and the fork stopped. The tree
    checked out consistent (check exit 0). The apps session is the one writer and launcher again.
- **A visual pass over everything built since the night before (2026-11-20):** captures at 1512 × 982 (and
  Notifications at 820 × 560) through the launch options, reading only. Found and fixed: the chosen state was
  invisible over the sky on the current rail button, Settings' chosen tab and the mail page's chosen bar buttons; now
  lit (white 80%, dark ink), pinned by pixel tests. The owner chose "Name (address)" with no spaces
  (`MailPage.senderLine`) and to keep the main tabs lit. Still not seen: hover, dragging, the picture picker, typing
  and Ask (no pointer or keyboard).
- **The Google client's guided set-up, on a separate preview copy (2026-11-21, four looks):** shown without touching
  the owner's app, its Keychain item or their server.
  - *Scratch server:* a bundle on a loopback port with a new scratch data directory each time, an emptied environment
    (no Google client, no key), `--dev-fake-ai`, and `--dev-fake-google` pointing at a stand-in on another port: a
    small wrapper in the session's scratch area serving mail's `FakeGoogle` over HTTP, one made-up `@gmail.example`
    account with five made-up messages. `/v1/info` said `missing: ["client"]`. Before each look a throwaway second
    pair ran the whole path with curl: a made-up Desktop app file refused ("That file holds a Desktop app client…"),
    a made-up Web application file saved, a sign-in through the stand-in `connected`, the inbox `ok`.
  - *A separate app:* a Debug build into a scratch DerivedData with `BUNDLE_ID_PREFIX=labs.usual.preview` on the
    `xcodebuild` command line (its own container, defaults and saved state), signed as `run-mac.sh` signs, copied to
    `UsualMailPreview.app` named "Usual Mail Preview". **Another bundle id doesn't separate the Keychain**
    (known-issues.md): the pairing is a generic password in the login keychain under a fixed service and account, so
    the copy would have looked up the real app's item at launch. Each build's binary therefore had that one service
    string replaced by a same-length name (one standalone occurrence, in `UsualMail.debug.dylib`) and was re-signed
    with the same identity and entitlements; the unpatched build product was deleted. No source, project file or
    setting changed.
  - *Reaching the steps:* paired through the launch options (it opens on "How much old mail?"); later launches passed
    the progress itself, `-UsualMailOnboardingSteps '{"<server hash>" = "gmail";}'` (the copy's container can't be
    written from the session's shell, "Operation not permitted"), through `open -n -g` so captures took no focus.
    `-AppleShowScrollBars Always` in the arguments shows the always-shown bar in this app only.
  - *What the looks found:* at 1512 × 982 the first build cut the set-up at about 380 points with the drop area cut
    through the middle and the always-shown bar inside the card; at the smallest window the file section and its note
    went out of sight and the note was about 2.1:1 against the card; then the agent's "Copy the prompt" and "See the
    prompt" were the last thing in the part that scrolls, so they went first. Each was fixed the same day
    (known-issues.md, Fixed). At the fourth look, at 820 × 592, 1100 × 620 and 1512 × 982, the agent's row shows in
    full right under the path choice, the file section stays whole at the bottom of the card, and the note reads at
    about 3.9:1; the measurements match the offscreen tests. Not reached: the "Add a Gmail account" sheet, which only
    a button opens.
  - *Not seen* (no pointer or keyboard): "Do it myself" and its steps, the prompt box, copying, dropping or choosing a
    file, a refusal in the app, Replace, the saved state and the Sign in with Google button after it, scrolling, the
    sheets, VoiceOver.
- **A real server brought up to the reviewed tree (2026-11-22):** stopped with SIGTERM after checking its command
  line, its data folder backed up while nothing ran (`cp -Rp`; names, sizes, modes and every file's sha256 identical),
  rebuilt (`npm run build`, `npm run smoke`), started again with `usual-mail start`; no migration was pending. Verified:
  `/healthz` and `/v1/info` 200, routes without a token 401, `doctor` "All good", searches answered in milliseconds;
  the Mac app (opened with `run-mac.sh`) and the iPhone simulator's app reconnected without a Keychain prompt.
  - *Died with the agent's session:* the agent that started it ended its session minutes later, and the server was
    gone, with nothing in its log (the server logs nothing when signalled). `start` spawns it detached (`detached:
    true`, `unref()`, `cli/src/runner.ts`), so this environment evidently ends a session's processes when the session
    ends, detached or not ([known-issues.md](known-issues.md)). The Mac app, opened through LaunchServices by the same
    session, survived.
  - *Restarted through Terminal:* a scratch `.command` file that runs the built command's `stop`, `start --wait 900`
    and `status`, opened with `open` so Terminal runs it in the owner's login shell. When Terminal wasn't running,
    `open` passed the agent's whole environment to the Terminal it launched, so the server carried the agent
    session's variables, tokens among them. Opened again under `env -i` with only the login basics (HOME, USER,
    LOGNAME, SHELL, TMPDIR, a system PATH, SSH_AUTH_SOCK, `__CF_USER_TEXT_ENCODING`, COMMAND_MODE), the server's
    environment held nothing from an agent, and the server, its own process group and session leader, passed to
    launchd once `start` exited.

## Not verified

- **Signing in with Google:** the owner's own sign-ins on their server (from 2026-11-17, above) are the only runs
  against Google; the rest of the flow is tested against a stand-in.

- **Nothing was clicked, typed or hovered:** opening an item by clicking, the hover time, Esc, the profile switch and
  the tabs by pointer, pairing by typing, Settings' disconnect. They were reached only through the launch options.
- The rebuilt UI against the demo server: it was paired before the rebuild, and the new build waits on the Keychain
  prompt above.
- The Feed and Receipts tabs, the right-click menu, the thinner icons and Settings' AI usage weren't seen on screen
  when written (2026-11-18); checked by tests and the build. See above for what was seen after.
- Pictures through the server, the tracker line and a failed picture's alt text (written 2026-11-18, not run against
  a server with the pictures build yet); live updates while the window is open.
- The data layer's behaviour against a server still comes from tests with a stand-in server and the final review's
  decoding of the joined server's real answers (102 responses, 140 events) and a refresh that matched its lists.
