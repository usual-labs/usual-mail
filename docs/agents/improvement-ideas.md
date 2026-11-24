# Improvement ideas

Things deliberately left for later. Each part adds its own ideas to its own note; this page holds the ones that
cross parts.

## Since the repository was published

The repository went public on 2026-11-24 as `usual-labs/usual-mail` (branch `main`, a fresh history of one commit).
Settled before that: the wallpaper (the Unsplash License, its photo page in `THIRD_PARTY_NOTICES.md`;
[decisions-licence.md](decisions-licence.md), check 2), the identity the history is published under, and notes
trimmed of details from the owner's own mailbox and machine. What is left from the coordinator's list of 2026-11-17
and the notes:

- **Link the wallpaper's photo page in the website's footers** (now "Wallpaper: Unsplash" alone; needs a site deploy
  the owner asks for). Unsplash's licence asks for no credit, so this is a courtesy.
- **Make the contributor agreement final** (`CLA.md` 0.1 is a draft): a legal review; the maker's full registered
  name and address; the governing law; the Media licences; an agreement for companies, which section 3(c) mentions;
  whether a sentence in a pull request is enough to agree. `CONTRIBUTING.md` says no pull request is merged until then.
- **Consider a line on the licence in the website's terms** (owner decides; the source only, then a deploy the owner
  asks for): the terms (`site/public/terms/`) apply to "Usual Mail … including its server, its apps" and set "Fair
  use" rules, while the AGPL lets anyone run, change and share the software without further restrictions. A sentence
  that the software's source is under the AGPL-3.0 and that the terms don't limit that licence would keep the two
  apart; the footers could link the source once it is public.
- **Notices in what is distributed as a program:** the apps carry the fonts' OFL texts and Hugeicons' MIT licence in
  their resources, but not GRDB.swift's MIT notice or the AGPL, and Settings → About shows no licence list. Add an
  acknowledgements list (or ship `THIRD_PARTY_NOTICES.md`) before the App Store or external TestFlight. The Docker
  image carries `LICENSE` and `THIRD_PARTY_NOTICES.md` in `/app` (since 2026-11-23), but not the licence texts the
  notices name beside each file or in `node_modules/` (not checked whether it must). The dashboard and the apps'
  About could also show the licence and the source link (the AGPL's "Appropriate Legal Notices") once the
  repository is public.
- **Carry the tracker list's upstream notices in the generated files:** `server/scripts/update-trackers.mjs` writes
  only MailTrackerBlocker's notice into `trackers.LICENSE` and `trackers.json`'s `licenseText`; it should add DHH's
  gist (MIT, by its author's comment of 2020-07-01) and Simplify Gmail's list (BSD-3-Clause), whose texts are in
  `THIRD_PARTY_NOTICES.md`. The list itself is kept (no switch to Trocker's).
- Turn on the Mac app's links: `ProjectLinks.isPublished` in UsualMailKit (`Store/ProjectLinks.swift`) is false, so
  Settings → About hides the source link (`ProjectLinks.repository`, github.com/usual-labs/usual-mail) and
  `Onboarding.publishedDocs` (`sourceCode` + `blob/main/docs`) stays nil, hiding the "Set one up" and Google guide
  links. Setting it true (one line) shows all three; check the docs path matches the published layout.
- Keep `THIRD_PARTY_NOTICES.md` current: anything taken from elsewhere, and the npm table when a part's production
  packages change (it was written from the lockfiles of 2026-11-23).
- **Make the package public** (the owner's decision): 0.1.0 published `ghcr.io/usual-labs/usual-mail` on
  2026-11-24, but the package is private, so `compose.caddy.yaml` and `compose.coolify.yaml` (which only pull) can't
  start for anyone else yet; then check it is linked to the repository and pulls without signing in.
- Now that 0.1.0 is out: make the Railway template and put its address in the README's button, and try a real VPS,
  Coolify, Render and Railway ([decisions-deploy.md](decisions-deploy.md)).
- Have the guides' wording checked against the Mac app once more when its onboarding is wired in (the self-hosting
  guide follows `apps-onboarding.md` as of 2026-11-17).

## Ideas

- **Ask for the current password before a new one replaces it** (`PUT /v1/owner/password`, from the owner password's
  security review, 2026-11-24): today any person's device sets a new password without the old one, by design (a
  person's device already has the owner's whole access, and it is how a forgotten one is replaced). Asking for the
  current one once a password is set would keep a stolen browser session from locking the owner out of their
  password; a forgotten one would then go through a recovery code. Not changed yet: the Mac and iPhone apps call the
  route as it is, so it needs a contract change and the apps together.
- **Cap recovery-code requests per address** (`POST /v1/owner/recovery-code`, no token): one waits at a time and
  asking again returns it, so it costs a write and a log line on Node at most every 30 minutes; a per-address cap like
  the Google claim's would make even that bounded per client.
- **Count IPv4 by a wider block too** (the re-review, 2026-11-24): an IPv6 /48 counts at thirty, but a hundred IPv4
  addresses from one provider's range each still get their own ten. A /24 limit would cap them, at the cost of
  households behind one carrier-grade NAT sharing it. And the Google claim's waiting sign-ins could count per /48 as
  wrong passwords do (known-issues.md).
- **Check `CLOUDFLARE_RANGES` against Cloudflare's list** (2026-11-24): the copy in `client-address.ts` is never
  fetched while the server runs; a release step (or a script like `update-trackers.mjs`) comparing it with
  `https://www.cloudflare.com/ips-v4` and `ips-v6` would catch a new range.
- **Let `usual-mail init` carry `USUAL_MAIL_TRUSTED_PROXIES`** (2026-11-24, decided against for now): the command
  passes the Docker container only its address, and Node mode the starting shell's environment, so behind a proxy the
  guide says to export it (Node) or use `compose.yaml` (Docker). Carrying it would take a saved setting, a flag, the
  container's settings hash (only when set, so existing containers aren't remade) and the server's parser's checks.
- **Turn on IPv6 in `compose.caddy.yaml`'s network** (2026-11-24) once Docker Engine 27 is the floor and a host
  without working `ip6tables` is rare enough: `networks: default: enable_ipv6: true` gives IPv6 clients their own
  addresses instead of the gateway's (deploy.md, step 1). Try it on a real Linux VPS first.
- **Make a teach prompt's rule before marking the prompt answered** (`answerTeach`, 2026-11-24): a rule refused today
  consumes the prompt (known-issues.md).

- **Let a pause cut the batch being fetched short** (2026-11-23, after the review's pause fix): a pause answers at
  once, but the batch in hand is still fetched in the background, up to about two and a half minutes of Gmail on Node,
  with the old provider open and its quota spent (known-issues.md). An `AbortSignal` in `SyncOptions` that the engine
  aborts in `#close`, with Gmail stopping between messages and the server storing nothing of an aborted batch (the
  cursor stays where it was), would stop it within a message or two. A contract change (`core/src/provider.ts`,
  contract-sync.md) for both providers.
- **Deploying** (2026-11-23): home servers (Unraid, CasaOS, Umbrel) once the owner wants them; `usual-mail init
  --mode docker` pulling `ghcr.io/usual-labs/usual-mail` when run outside a checkout (it only builds from one now);
  taking the public address from the host's own variable when `USUAL_MAIL_PUBLIC_URL` is unset (Render's
  `RENDER_EXTERNAL_URL`, Railway's `RAILWAY_PUBLIC_DOMAIN`), so the first deploy needs no typing; building the image
  in CI on pull requests as well as on releases; re-running the Docker-backed mail tests now that Docker answers;
  refusing to start when `USUAL_MAIL_SECRET_KEY` and `/data/secret.key` both exist and differ (a restore on a host
  that sets the variable now silently uses the wrong key; the guide warns instead, review of 2026-11-23).
- **Stopping, on hosts** (2026-11-24, with the Compose files' `stop_grace_period: 3m`): a log line when the server is
  signalled ("stopping: storing the mail in hand"), since it logs nothing and `docker compose down` may now wait
  minutes in a first sync. Render gives a service with a disk 30 seconds after SIGTERM and no way to raise it
  ([decisions-deploy.md](decisions-deploy.md), checked 2026-11-24), so only a stop that aborts the batch in hand
  (above) would keep a deploy there from wasting a first sync's batch.
  An init process as PID 1 (Compose's `init: true` in the three Compose files, `--init` in the command's `docker run`,
  or tini in the image) would close the moment before Node's own SIGTERM handler exists, in which a `docker stop` is
  still ignored, and the entry point's shell before it (known-issues.md, Open); it changes every host's file and the
  Docker mode's settings hash. A second Ctrl-C during the Node server's start-up could end it at once, since nothing
  is in hand then (today it waits for the step in hand).
- **Node mode's pid file** (the `usual-mail` command, final check of 2026-11-24; known-issues.md, Open): a lock file
  opened with `O_EXCL` around each change would close the windows between reading and renaming; matching the server's
  arguments exactly, not a text in its command line; saying the port is the server's own when a record marked
  `stopping` names a server that still listens.

- **Tell the apps which providers a server has** (2026-11-21, from the Cloudflare design,
  [server-cloudflare.md](server-cloudflare.md)): the planned Cloudflare server has Gmail only, but the apps would still
  offer IMAP and fail with the server's words. `ServerInfo` could list the provider kinds the server registered, so
  the apps hide what it can't connect. A core and contract change; accepted as it is for the first Cloudflare build.
- **The dashboard's Gmail page doesn't offer the upload yet** (2026-11-21): while the server has no client it shows
  only the form for a client id, secret and refresh token, with no way to give the server its Google client. It could
  take the downloaded file and show the prompt and steps from `GET /v1/google/setup`; both routes would then go onto
  `MailService` (today they are the server's own, `calls: "-"`) and into its test double.
- **The server's own Google words still name the command on Cloudflare** (2026-11-21, step 6 of the Cloudflare host,
  [server-cloudflare-access.md](server-cloudflare-access.md)): `src/google/words.ts`'s `notAvailable` (a sign-in
  started without a client), `clientRefused` and the inbox attention words (`clientRefused`, `clientMissing`) say
  "usual-mail google set", which a Cloudflare server's host can't run. Core's set-up words already take a host's part
  (`addressFix`); these could take one the same way (the app's Google set-up, or the Worker's secrets).
- **The front Worker could answer `/healthz` itself** (2026-11-21, the Cloudflare design's list, left out of step 6;
  refusing `/v1/*` without a token was built after the review): saves waking the object, but `/healthz` there would say
  healthy while the object can't start.
- **Label changes needn't share the sync batch's small limit** (2026-11-21, steps 4 and 5 of the Cloudflare host,
  [server-cloudflare-limits.md](server-cloudflare-limits.md)): Gmail's provider counts label changes against `limit`
  as it counts new messages, so on Cloudflare (25) a bulk change of 1,000 threads takes 40 rounds, each re-reading a
  history page of up to 500 records. A change is a few bytes, so a provider could take a separate, larger cap for
  them, or keep the page it read; it would be a `mail/` and contract (`SyncOptions.limit`) change.
- **The Gmail cursor's ids in a table of the host's own** (2026-11-21, the review of the Cloudflare host's steps 4 to
  6; known-issues.md): the first sync carries every id still to fetch in `inboxes.sync_cursor`, which passes a Durable
  Object row's 8 MB at about 330,000 ids. A table of pending ids (or the provider re-reading its listing by page) would
  keep the cursor small; a `mail/` and server change.
- **Keep the fit's notes out of search and the AI** (2026-11-21, the same review): the note a fitted message's text
  ends with could be a flag on the message instead (as `htmlTooLarge` is), shown by the apps and left out of the index
  and of what a model reads. A contract change.
- **The front Worker could answer more without waking the object** (2026-11-21, the same review): the dashboard's
  static assets, `/v1/info` from a cache, and a cheap per-address limit on what still reaches the object would keep
  strangers from spending a plan's requests (known-issues.md). workers.dev has no rate-limiting rules; a custom domain
  would.
- **Bounded reads for an old conversation and `refreshThread`** (2026-11-21, the same review): both read every message
  of one thread with its text and HTML at once; the index's rounds (`SearchIndex.#bodies`) show how to bound them.
- **Size search's rounds with `octet_length`** (2026-11-22, the final review): `BODY_SIZE_SQL`
  (`server/src/search/indexer.ts`) casts each text and HTML to a BLOB, so SQLite reads every body of a chunk's
  messages just to size them. `octet_length(x)` (SQLite 3.43 and later) gives the same byte count, U+0000 included
  (probed on libSQL 0.18, SQLite 3.45.1), from the record's header without reading the body. Not a regression (the
  old `length(text)` read them too); needs the workerd test run again, since a Durable Object's SQLite wasn't probed.
- **Word a Free plan's failures as needing Workers Paid** (2026-11-22; designed in [server-cloudflare.md](server-cloudflare.md),
  "Backup, moving and the Free plan", not built): on a Free account a sync fails with Cloudflare's own errors ("Too
  many subrequests" after 50 fetches, the CPU limit), which the inbox's attention words show as they are. The host
  could recognise them and say the server needs Workers Paid instead. Unverified what a Free account really gives.
- **A storage warning from 8 GB** (2026-11-22; designed in [server-cloudflare.md](server-cloudflare.md), "Storage",
  not built): a Durable Object holds 10 GB, and past it writes fail with `SQLITE_FULL`. The server could report the
  object's size (`ctx.storage.sql.databaseSize`) in its status and warn once it passes 8 GB, so a person can remove an
  inbox or shorten the first sync's window before mail stops arriving.
- **`usual-mail google set` replaces a client file without asking** (2026-11-21), while `PUT /v1/google/client`
  refuses to replace a client without `replace=true`, because another client stops the inboxes signed in with the old
  one. The command could ask in a terminal when the file holds another client id, and take `--replace` otherwise.
- **`usual-mail start` hands the server the whole environment of whoever runs it** (2026-11-22, seen restarting a
  server from an agent's session, [apps-runs.md](apps-runs.md)): Node mode's `startDetached` spawns with the command's own
  environment, so a long-lived server keeps the starter's variables, an agent session's tokens included, and its locale
  (`LANG`) and certificate store (`NODE_USE_SYSTEM_CA`) depend on which shell started it. The command could pass only
  what the server reads (`USUAL_MAIL_*`, `PATH`, `HOME`, `TMPDIR`, `NODE_*`, proxies, `TZ`) and say so in its help.
- **Asking search in a sentence, next** (2026-11-20; step 3 built,
  [asking in a sentence](../contract-search.md#asking-in-a-sentence)). **An amount filter** ("over 100 euros", "under
  20"): `amountOver` and `amountUnder` in minor units with a currency, matched against `Thread.payment.amount` (only
  receipts and invoices have one, so the filter implies those kinds; a thread without a checked amount can't match),
  filled by the model like the other fields and checked like a payment amount; today the words stay in the text,
  where they usually find nothing. **Periods by rule:** the server reading "last month", "this week", "since March"
  itself (in the seven languages the event dates know) and overruling the model's dates when the sentence holds such a
  phrase, so a model's arithmetic isn't trusted for the common cases. **Measuring it:** a list of sentences with the
  filters a person would expect, run against the owner's model with their yes (each a request), to see what it gets
  wrong before changing the words. **A sender the model can't know:** "from my landlord" needs the mailbox (who the
  landlord is), which is never sent; a later step could let the server look names up itself after the answer.
  **Asking for older mail in the same breath** ("... in 2023" beyond what the server holds: offer the mailbox search
  with the same filters).
- **Search, next** (2026-11-20; steps 1 and 2 built, [search](../contract-search.md)). **Searching by meaning** (embeddings of summaries or bodies: a model per message, a
  vector table or index the host has). **Inside attachments** (text of PDFs and documents: fetched from the provider,
  read, indexed; costly and a parser's attack surface). **IMAP reach-back** (`UID SEARCH` with `TEXT`, `FROM`,
  `SUBJECT`, `SINCE`, `BEFORE` over each folder, then `fetchThread` by Message-ID and References; servers differ in
  charset and folder handling). Smaller: matching inside words (a trigram index beside the words one), "ue" for "ü",
  spelling tolerance, the people a search finds with their sender picture, a count of all results.

- **Notifications, later** (2026-11-19; one row per parcel or appointment was built the same day, by one sender's
  reference or an appointment's subject and day): **joining a shop's and a carrier's mails** about one parcel (the
  audit found no shared number in their mails; a shop's mail sometimes prints the carrier's tracking number, which
  could join them across domains if the server trusted it); **an appointment moved to another day** (the "moved" mail
  states the old time: asking the model for the old date would join it to its old mail); **grouping receipts or
  newsletters** (an order's receipt with its parcel's notices, a newsletter series). The audit of the groups
  (2026-11-19) found: **a shop's mail printing the carrier's tracking number** would let some parcels join their
  carrier's mails safely; a shop that prints no number can't. **One order told by an order number in one mail and a
  tracking number in another, both printed in both**: needs several references per mail and groups as connected
  sets. **A package holding two orders** whose "Delivered" mail prints only the first order's number. **A reference
  that is really a subscription number** (seen once, likely; the 8-thread and 60-day guard caps it). **A window that spans two days**
  (an evening-to-morning slot, a maintenance window over midnight): `when` has one date, so the end is dropped
  (`time_order`, or `two_days` after a UTC conversion); it needs an end date. Also a "needs you" mark for alerts and
  deadlines, and adding an appointment to a calendar.
- **People's pictures, later** (2026-11-19, the coordinator's decision 5 on sender pictures): Google contacts' photos as
  an opt-in the owner switches on, which adds a second Google permission (`contacts.other.readonly` for "Other
  contacts", `contacts.readonly` for saved ones) to the sign-in; and Gravatar, never on by default, since it sends a
  SHA-256 of each person's address and the server's address to Automattic. Neither is built.
- **Sender pictures, later** (2026-11-19): a trusted checker for IMAP providers (each one's own authserv-id), so IMAP
  inboxes show pictures too; BIMI with a verified mark certificate, if the server ever rasterises SVG safely; a list of
  hosting companies' default favicons to refuse; the account's own picture for "You" (Google's `profile` permission).
- **Payment details, later** (2026-11-19, the coordinator's "not now"): reading amounts from PDF attachments; marking
  an invoice paid, by the person or by matching a later receipt; totals per month; "due soon" in Home.
- **Summaries written from noisy text aren't redone** (2026-11-19, left simple on purpose): mail joining a thread
  summarizes it again with the cleaned text; a migration like 0006 could ask for all of them again, at one summarize
  request per thread.
- **Keep the records of refused and failed pictures out of the cache's cap** (proposed 2026-11-18, not built). They
  are a few dozen bytes each, so a sender who fills the 256 MB with big pictures can't flush them and count later
  openings of a failing tracker again. A picture that was shown must be fetched again after it is pushed out
  either way, so such a record only helps for pictures never shown.
- **Pictures from the web, later** (2026-11-18, left out on purpose): fetching ahead of time for senders already let in
  (opens would tell those senders nothing; costs traffic for unread mail); a check that refreshes the tracker list
  for each release; catching tracking pictures hidden by a style block's classes; letting a person read a picture's
  original address; `srcset` for sharper pictures on Retina screens (the sanitizer drops it today).
- **A standing check that the Swift models decode what the server sends.** Done by hand twice: in the final review of
  the first milestone (102 responses, 140 events) and in the review of the fifth revision on 2026-11-17 (102
  responses of every route the Mac app calls and ten kinds of error, `Retry-After` included, through `APIClient`; 311
  events heard by a person and by an agent; then `MailStore.refresh()` against the live server, whose Home, seven
  category lists, two stacks, waiting, screening, counts and "needs a look" equalled the server's, in order). A test
  could do the same from responses the server's own tests save, so a change on either side fails at once.
- **A way to make the development switch's fake models fail** (from the review of 2026-11-17). `--dev-fake-ai` always
  answers, so the AI's failure states can't be tried on the built server; the review ran the server from source with
  a scratch control port instead. A made-up key that names the failure (for example one ending in `-refuse`,
  `-no-model`, `-no-credit`, `-down`), honoured only by the fake, would let the command, the dashboard and the Mac app
  be tried in every state.
- **Gmail joined by hand.** The Gmail provider runs only in the server's tests against `FakeGmail` (passed in as
  `fetch`). Serving `FakeGmail` over HTTP from a scratch process, with the server's Gmail `fetch` pointed at it, would
  let the built bundle, the command and a second server be tried on Gmail's labels as on IMAP's folders.
- **Decode an inbox's `connection` leniently in the apps.** `InboxConnection` is strict: a known kind with a missing
  field fails the whole inbox list, so the app couldn't refresh at all. The server sends every field today; falling
  back to `.unknown` for one inbox would keep the rest working.
- **Pass on the IMAP server's own reason for a refused move.** ImapFlow's `messageMove` answers `false` without the
  NO text, so a record says only "The server refused to move the message to …". Checked 2026-11-17 against ImapFlow
  2.12.1: the text reaches only the connection's logger, so it can't be had without relying on undocumented
  internals, and it was left (see mail's known limits). It needs ImapFlow to return or throw the server's response,
  or a move issued another way.
- Replaying missed events after a reconnect, so apps needn't reload their lists.
- **Inbox colours from the hat palette.** `design/specs/hat.md` proposes that `Inbox.color` holds one of the
  twelve hats' light fill colours, and that any other colour is shown as the nearest hat. To adopt it: say so
  in `docs/contract.md`, have the server accept only those twelve, and switch the three colours in
  `core/fixtures/sample.json` (which today land on blue, green and orange). Wait until no part is mid-build,
  because the sample is copied into other parts' tests.
- **A machine-readable hat list and a focus-ring token in `design/`.** The dashboard reads the twelve hats out
  of `tokens.css` and writes the focus ring as twice the line size, because neither exists as its own output.
- **What the design system lacks for the apps** (from the apps' second round, 2026-11-17):
  - Icons for read and unread, move, a generic stack, offline, a warning, refresh, disconnect, reply (apart from
    reply later), a draft and remote pictures. The apps use SF Symbols for these today.
  - Icons exist at one size only (24-point assets).
  - The Swift package's folder is named `swift`, so its package identity is `swift` and dependents write
    `package: "swift"`.
  - The brief-card spec's counts leave out the trash count; the apps show "Trash n" last.
  - No spec for Now's need line, compose, the "Load pictures" bar, draft cards or search.
  - From the apps' fourth round: no icon for a paused inbox, and no spec for the credentials form or Handled's
    "Needs a look".
- **One copy of Hono in the server's bundle.** The server and the dashboard each depend on it, so the bundle
  holds it twice.
- **Geist Serif as TTF in the apps.** The font's npm package ships it as WOFF2 only, which registers on the Mac
  but is untested on iPhone. The font's own repository has a TTF.
- **Keep write-backs held for a paused inbox in the store,** so a restart while paused still fails their records
  when the provider refuses them on resume, instead of a repair whose refusal is only logged.
- **A thread view in the dashboard** would let it show a sent draft's note (kept a day in the thread) and failed
  drafts in context; today only the apps and the connector show draft notes.
- **Let a person read a paused inbox's attachments from a cache,** if one is ever kept: a paused inbox reads nothing
  from the provider, so its attachments answer `conflict` today.
- **For the rebuilt Mac app (2026-11-17):**
  - The design's values (10 and 12 point text, 32 point controls, the card and control colours, the avatar pairs,
    a bold Geist) as design tokens, so the dashboard can share them.
  - A person picks each profile's icon and its order: the fifth revision added `Inbox.icon` and `Inbox.position`;
    the apps and a settings screen still need to use them.
  - The wallpaper's licence (settled 2026-11-24, above) and the icons (checked 2026-11-23: all in Hugeicons' free
    set) are in [decisions-licence.md](decisions-licence.md).
  - Dark mode for the glass, the card and the wallpaper.
  - A way to drive the app in tests (UI tests, or launch options that also act) on a Mac where the window can't be
    scripted.
- **From the fifth revision (2026-11-17), the server's AI:**
  - **Gmail push** through a Pub/Sub pull subscription ([contract-sync.md](../contract-sync.md) says what it
    needs), so new Gmail mail arrives in seconds instead of within the poll.
  - **OpenRouter as a second gateway.** Its OAuth flow (PKCE, with a localhost callback or a code to paste) ends with
    an API key on the person's own account, which fits "sign in with a provider" without a new kind of credential.
    Checked in OpenRouter's documentation on 2026-11-17; not built.
  - **Signing in with ChatGPT** for plan usage, reported from 2026-09 as an OAuth scope with one-hour access tokens and
    30-day refresh tokens, open to open-source and personal projects (secondary sources only; check OpenAI's own
    documentation first). It would be the third kind of `AiConnection`.
  - **Decision fallbacks:** Vercel's gateway can rerun an uncertain decision with a second model, which may lift
    categorizing's accuracy for a little more cost.
  - **The inbox's guide in categorizing,** so "clients come first" shapes the AI's choice. It would leave the server
    too, so "What leaves the server" in [contract-ai.md](../contract-ai.md) changes with it.
  - **The AI's records of one thread in `ThreadDetail`,** so "why it's here" needn't look through Handled (since
    2026-11-17 `Thread.categorizedByActor` names who decided; the record still holds when and what was before).
  - **The connector could show `Thread.sender`** (the address `allow_sender` and `block_sender` reach) and
    `categorizedByActor`; it shows neither yet.
  - **The AI setting `need`** (reply, decide, pay, read) as part of categorizing.
- **Land a Gmail first sync's mail sooner** (2026-11-23, found while building how far a first sync has got, the
  proposal of 2026-11-17 that stood here until the owner decided it: [decisions](decisions.md)). On Node a sync batch is 200 messages and
  Gmail's quota fetches about one a second, so a first sync's newest mail reaches the apps only after about two and a
  half minutes, when the first batch is stored; the count shows meanwhile. A smaller first batch (or smaller batches
  for a first sync on Gmail only, say 25, as Cloudflare's) would store the newest mail within seconds, at the cost of
  more cursor writes (a Gmail first sync's cursor carries every id still to fetch). A `server/` change, or `mail/`'s.
- **Pace the AI's history, and wait out a rate limit instead of failing** (2026-11-18, from the summary diagnosis).
  History now reaches all synced mail, so a new server or a new key can queue hundreds of threads (a real server did after
  the upgrade, two requests for most). The queue sends one thread at a time with no pause; a 429,
  after the AI SDK's two retries, makes the AI `unavailable` and stops everything, new mail too, for 1 to 15 minutes,
  and the status says it is failing. Better: a short pause between history threads (new mail never waits for it), and
  a rate limit treated as "slow down" (honour `Retry-After`, keep the state `working`) rather than a failure.
- **Done threads get due flags they never use** (2026-11-18). The first sync's `setDue` (`server/src/sync/sorting.ts`)
  sets `category_due` and `summary_due` on every thread, done (archived) ones too; `work()` leaves done threads out,
  so nothing is sent, but the flags read as work waiting. Harmless; setting them only on threads that aren't done (and
  when new mail brings one back, which already happens) would make the store say what it means.
- **The AI's usage in the command and the dashboard** (2026-11-18, left out on purpose). `GET /v1/ai/usage` is built
  for the Mac app's Settings. A `usual-mail ai usage [--tz <zone>]` table (job, model, requests, failed, tokens, cost,
  "not reported" and "at least" as the contract says) and a card on the dashboard's AI page would read the same route.
- **`usual-mail sync-days` could use `PATCH /v1/first-sync`** (2026-11-18). It writes settings.json and restarts a
  server `init` set up; with a person's token the route does the same at once, with no restart, and for a server on
  another machine too. The file stays the fallback when the server doesn't answer.
- **Name an IMAP inbox's Sent folder by hand** (2026-11-18, from the pictures' third review). Without a Sent folder
  the server can find, mail the person sent from other apps is never theirs (known-issues.md). Proposed: a
  `sentFolder` kept with the IMAP connection and passed to the provider, set by `usual-mail inbox sent-folder <inbox>
  <folder>` and offered in the apps when an IMAP inbox has none. Small: the provider already takes folder names.
- **Let in by a thread only people the person addressed in it** (2026-11-18, from the third and fourth reviews).
  Someone writing into a thread that isn't screened is let in; anyone who knows one of its Message-IDs can
  (known-issues.md). Letting in only addresses the person's own messages in the thread named (To, Cc) would keep
  "someone copied on a conversation" working.
- **Complete a held move by asking the provider** (2026-11-18). A copy held because its stored twin's ref was never
  reported removed (a restart between the provider's own move and another app's) stays held. A provider op
  asking whether a ref still exists would settle it at the next sync.
