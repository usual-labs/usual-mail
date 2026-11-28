# Overview

The README introduces the features and has a short deploy guide; its Home image (`docs/images/home.jpg`) is a still
from the Mac onboarding tour's sample mail. [docs/deploy.md](../deploy.md) is the entry point to the detailed hosting
and setup guides.

State on 2026-11-17. **Every part follows the contract's fifth revision** (as amended the same day): the mailbox is
the main database, the server runs its own AI on mail with the person's own key (categories and summaries) for every
inbox once the key is set (the owner removed the per-inbox switch later that day: below), categories replace piles, screening is a gate, Home replaces Now, and lists, counts
and inboxes changed with them. The server and the mail providers, then the command, the connector and the dashboard,
were rebuilt to it; the Mac app's data layer and Home moved to it in their own session. An independent review the same
day re-ran every check, played the new product's story on the built server beside a local test mail server, fixed two
server defects, and found the open issues. **The coordinator then decided them, and they were carried out the same
day** in `core/`, the contract, the server, the command, the connector and the dashboard (below); the Mac app
adopted them in its own session ([apps.md](apps.md)). **On 2026-11-18 the owner's own server runs with real mail and a
real model:** Gmail connected by signing in with Google, and a Vercel AI Gateway key set (the coordinator's report);
no test calls a real model or uses a real key. The same day the owner decided that the AI works through all synced
mail (archived mail still skipped), that a summary aims for one line, and that Settings show the AI's usage; core, the
contract, the server, the command, the connector and the dashboard follow (no history setting; `GET`/`PATCH
/v1/first-sync`; `GET /v1/ai/usage`; see [server-ai.md](server-ai.md)); the Mac app followed that evening (it reads
and saves the first sync's window and shows the usage in Settings; [known issues](known-issues.md)). Nothing was
committed, published or deployed then. **On 2026-11-21 the server gained a Cloudflare host:** a Worker and one
Durable Object, Gmail only, all seven build steps built and tested in local workerd; first deployed to a real
account on 2026-11-23 (below, "Implemented today").
**On 2026-11-23 it gained files for other hosts** (the owner's decision that day: Docker with a guide for any VPS,
Coolify, then Render and Railway buttons; home servers later): an entry point that runs the image on volumes owned by
root, `compose.caddy.yaml`, `compose.coolify.yaml`, `render.yaml`, a workflow that publishes the image to GHCR, and
[docs/deploy.md](../deploy.md); tried in Docker Desktop on this Mac only. The image is published to GHCR from 0.1.0
(2026-11-24), public there since that day and pulled without signing in; no host has run it yet
([decisions-deploy.md](decisions-deploy.md)).
**On 2026-11-24 the owner got a password** (the owner's decisions that day): the first visitor to an unclaimed server
sets it and owns the server, unless the host names `USUAL_MAIL_OWNER_EMAIL`, which Google must prove; the dashboard
and the Mac and iPhone apps sign in with it; a recovery code goes where the owner's code goes. Built in core, the
contract, the server (both hosts), the dashboard and the apps ([server-owner.md](server-owner.md)); tested, never
run against a real Google account or deploy. Reviewed for security the same day after it shipped; the fixes
(`owner-claim-fix`): a server once used can never be claimed again, wrong passwords and codes count per client address
(`USUAL_MAIL_TRUSTED_PROXIES` names a Node server's proxies), a claim ends the owner's code, the Google claim leaks no
email and is capped per address, a name refuses control characters. A re-review's follow-ups the same day: an IPv6 /48
counted too (thirty) under a ceiling of a thousand, prose (reasons, highlights, a rule's text) made one line rather
than refused, a /0 proxy range refused, and `cloudflare` in `USUAL_MAIL_TRUSTED_PROXIES` for hosts behind Cloudflare.

**Later on 2026-11-17, more changes in every part, the Mac app's in its own session (done by 2026-11-18, but for
the guided Google set-up of 2026-11-21):**

- **Sign in with Google for Gmail** (the owner's request: one Google client they own, the server on their Mac first).
  The host gives the server a web application client (environment, or `<data-dir>/google-client.json` as Google's
  console downloads it); a person starts a sign-in (`POST /v1/google/sign-ins`), opens Google's address, Google sends
  the browser back to `GET /v1/google/callback`, and the server exchanges the code (PKCE), learns the address from
  Gmail, and connects a new inbox or reconnects one in place; the device that started it reads the outcome
  (`GET /v1/google/sign-ins/:id`). Built in `core/` (`src/google.ts`), the contract
  ([sync and providers](../contract-sync.md#connecting-gmail-by-signing-in-with-google)), the server (`src/google/`,
  `--public-url`, `--dev-fake-google`), mail (`FakeGoogle`, `GoogleTokenError`), the command (`google`, `google set`,
  `inbox add` and `inbox reconnect` signing in, `doctor`) and the dashboard; the host's guide is
  [docs/google-setup.md](../google-setup.md), and [docs/self-hosting.md](../self-hosting.md) takes a person from
  nothing to a paired app. **It has run against Google once** (the owner's own Gmail, 2026-11-17: it worked); every
  check here uses a fake built from Google's documentation. **Since 2026-11-21** (the owner's decision) a person's own
  paired device may give the server that client (`PUT /v1/google/client`, saved as `google-client.json` through the
  host's seam), and the server serves the guided set-up in core's words (`GET /v1/google/setup`: the browser agent's
  prompt with the redirect address filled in, the manual steps, what is missing); `usual-mail google prompt` prints the
  prompt. The Mac app (and the iPhone app, which shares its screens; never seen there) shows that set-up where Sign in
  with Google would be and takes the downloaded file (built 2026-11-21; seen at rest four times on a separate preview
  copy against a scratch server, its layout fixed between the looks and seen fixed; nothing in it clicked, copied or
  given; [apps-onboarding.md](apps-onboarding.md), [apps-runs.md](apps-runs.md)); the dashboard offers neither yet.
- **No per-inbox AI switch** (the owner: "we dont have any feature to turn off ai"). `aiProcessing` is gone; once a
  key is set every inbox's mail is processed; saving the key is the consent, with core's words shown first (`ai set`
  asks, the dashboard's key form shows them), served by `GET /v1/ai/disclosure` so the command, the dashboard and the
  apps show the same words. See [decisions](decisions.md).
- **After the owner's first run against Gmail** (their own server; the sign-in worked): the client file's redirect
  warning became a hint; the first sync's days persist in `<data-dir>/settings.json` (`usual-mail init` asks,
  `usual-mail sync-days` changes them, `status` and `doctor` show them); a smaller window takes effect for a first
  sync in progress in both providers; the owner's code is printed once, when it is made. In `core/` (comments only),
  the contract, the server, mail, the command, the guides and `compose.yaml`; see [known issues](known-issues.md)
  ("Fixed") and [decisions](decisions.md).

## Implemented today

- **Unsubscribing from a sender** (2026-11-27, the owner's request and plan; [unsubscribing](../contract.md#unsubscribing),
  [server-unsubscribe.md](server-unsubscribe.md)): `POST /v1/threads/:id/unsubscribe` asks the sender to stop, in the
  background, the cheapest way their mail offers: its one-click link, an email to its unsubscribe address, or its page,
  opened by Browser Use when the person set a key in Settings' AI tab, else handed to the person. The Feed's left swipe
  unsubscribes and blocks the sender (apps). Tested with fake hosts and a fake Browser Use only.
- **How far a first sync has got** (2026-11-23, the owner's decision; [sync](../contract-sync.md#sync), "How far a
  first sync has got"; [decisions](decisions.md)): `Inbox.firstSync` (`fetched` of `total` messages), counted by the
  provider from its cursor on every first-sync batch (`SyncBatch.progress`: Gmail and IMAP) and, for Gmail, after each
  message (`SyncOptions.onProgress`); the server (`server/src/sync/progress.ts`, both hosts) shows it once the first
  sync has run two seconds, then at most every two, on the inbox's row (migration 0019) with `inbox.changed`, and drops
  it when the first sync is done. Shown in core's words, "Fetching your mail · 120 of 340", by `usual-mail inbox list`
  and `doctor`, the dashboard's inbox list and settings, and the Mac app (the corner note, Settings' Accounts rows and
  the first run's lines; the iPhone app shares the Accounts rows and the first run); the connector gives agents the
  numbers. Pausing (or removing) an inbox answers at once and stops its sync once the batch in hand is stored (in the
  background), and resuming goes on from the cursor; a count alone doesn't make the server recount (the review's
  fixes, 2026-11-23). Tested in every part and
  in workerd (the count kept across a reset of the object, a first sync paused and resumed); never seen on a real
  mailbox or on screen.
- **A search asked in a sentence** (2026-11-20, step 3; [asking in a sentence](../contract-search.md#asking-in-a-sentence),
  [server-search.md](server-search.md)): `POST /v1/search/ask`, person only, turns a sentence into the filters and
  text a search takes with the summarize job's model; only the sentence and today's date leave the server; every
  field checked; the worst case is the sentence as typed. Fake models in every test, no real model asked. The Mac
  app's search page asks it through an Ask capsule (⌘↩; [apps-search.md](apps-search.md)), tested through its model
  and its words only: never clicked or typed.
- **Search** (2026-11-20, steps 1 and 2 of the owner's plan; [search](../contract-search.md),
  [server-search.md](server-search.md)): full text over everything the server holds (FTS5, migration 0018) with
  filters, Gmail's operators, ranking, excerpts as runs and the people found; older mail in a Gmail mailbox found on a
  person's request and opened one conversation at a time. Server, mail (Gmail, `FakeGmail`, the contract suite), the
  connector's `search_threads` and the Mac app's search page (⌘K over any page: people, kind chips, older mail in
  Gmail; [apps-search.md](apps-search.md)). Waiting threads left the category lists the same day (the owner's decision).

- **`core/`**: the shared contract. Types for the vocabulary (`src/domain.ts`), the server's AI (`src/ai.ts`: jobs,
  settings, credentials, status), Google sign-in (`src/google.ts`: its info, input, start, outcome, failures, the
  scope and Google's rules in words), the service every interface calls (`src/service.ts`), the mail-provider interface
  (`src/provider.ts`), the REST routes and the one dashboard path others may link to (`src/api.ts`), events
  (`src/events.ts`), what leaves the server for each AI job in numbers and in the words every interface shows
  (`src/ai-words.ts`) and one made-up server state (`fixtures/sample.json`). `npm run check` type-checks it and checks
  the sample against the contract's rules.
- **The contract**, in four pages: [docs/contract.md](../contract.md) (the entry point: the mailbox as the main
  database, who may do what, trust, lists and counts, actions and undo, rules and learning, triage by an outside
  agent, inboxes, drafts, briefs, REST), [docs/contract-ai.md](../contract-ai.md) (the server's AI),
  [docs/contract-sync.md](../contract-sync.md) (sync and providers) and
  [docs/contract-pictures.md](../contract-pictures.md) (pictures from the web).
- **`server/`** (see [server.md](server.md)): a Node server that implements every `MailService` method over SQLite
  (Drizzle and libSQL) and serves every route with Hono: categories with who decided them, the screening gate, Home,
  category, stack, waiting and screening lists, counts and their event, rules and teach prompts, the triage queue,
  proposals and exact undo, write-back with labels or folders per category, drafts, briefs, pairing and the event
  stream. **The server's AI** (see [server-ai.md](server-ai.md)): settings with the key sealed, status with
  `pending`, testing, pausing, all synced mail that isn't done as history (no history setting since 2026-11-18; the
  first sync's window, `GET`/`PATCH /v1/first-sync`, is the one setting for old mail), its usage by the hour for a
  person's Settings (`GET /v1/ai/usage`), every inbox once a key is set, categorize and summarize jobs through the AI SDK 7 (Vercel's AI
  Gateway with a decision model, or OpenAI's or Anthropic's own key), mail passed inside a marked data block, answers
  checked, the AI's categorizing recorded silently; the kinds' words and a tie-break from the audits of 2026-11-19, a
  message's text cleaned before a model reads it (links cut to their site, noise out, a stub text part replaced by
  the HTML's text), and the AI's own filings asked again once per build that names them (migration 0011; this
  build's: receipts, notifications, and by a dated exception conversations the person never wrote in); a receipt's
  or an invoice's payment details (who, how much in ISO minor units, refund, paid/scheduled/due, date, what for) and a
  notification's event (status, about, when; migration 0016), each checked against
  the mail; migration 0012) in place of its summary; requests
  held to core's words (no address in a summary request,
  nothing of a blocked sender's), the key scrubbed in any form, its own check before a model's answer lifts the
  screening gate (since 2026-11-25 for one-time codes, sign-in links, email confirmations, security alerts, password
  resets and account changes, receipts and order updates, bookings and payment alerts: the provider's proof of the
  From domain, machine-sent mail, the kind's evidence, and one question to the AI; `Thread.skippedScreening`;
  [server-screening.md](server-screening.md)), senders let in without the AI (another inbox on the server, a
  colleague at the inbox's own domain, both proved), a model of the wrong kind for its job failing the test in words; every inbox's mail once a key is
  set. Google sign-in for Gmail (state, PKCE, exchange, connect or reconnect in place, the page, the outcome, tokens
  sealed with the host's secret added when opened, revocation on removal). Rules a person taught apply
  whatever the trust; a new server reads recent filed mail as not done; a blocked sender writing into a thread
  changes nothing a person sees; threads carry `sender` and `categorizedByActor`; one list for several categories. `--dev-fake-ai` (development only, loopback only) and demo mode
  use fake models; `--dev-fake-google` sends Google's addresses to a fake. The store upgrades from the fourth revision. **Sender pictures** (2026-11-19, [server-avatars.md](server-avatars.md), the contract's
  [page](../contract-avatars.md)): an organisation's own site icon on `Thread.avatar` and `Message.avatar` when Gmail's
  checker proved the From domain and the sender is let in, fetched one domain at a time within six hours of being
  wanted, served at `GET /v1/avatars/:id`, migration 0013, the Public Suffix List shipped and an independent security
  review's fixes in (2026-11-19). The Mac app shows them in place of initials (seen on the owner's server, 2026-11-19).
  **Pictures from the web** (2026-11-18): each message's HTML shows them through the server's picture route, with
  trackers taken out first (MailTrackerBlocker's list and tiny or hidden pictures) and screened or blocked senders'
  held back; a person's device loads one, fetched on the first ask from public addresses only and kept per inbox.
- **`mail/`** (see [mail.md](mail.md)): IMAP with SMTP (ImapFlow, Nodemailer) and Gmail over its REST API behind
  `MailProvider`: `Usual Mail/Newsletters`, `Invoices`, `Receipts`, `Notifications`, `One-Time Codes`, `Screening`
  and the stacks' labels or keywords; IMAP leaves a category out while a message sits in Screening (one folder per
  message). Shared MIME parsing, an allow-list HTML sanitizer, a contract suite every provider passes, a fake of
  Gmail's API and one of Google's sign-in. Joined into the server. No Gmail push.
- **`cli/`** (see [cli.md](cli.md)) and the root `Dockerfile`, `compose.yaml`, `.dockerignore`: the `usual-mail`
  command, one bundled file talking REST only: `init`, server control, pairing, agents, devices, inboxes (with icon and
  place; Gmail by signing in with Google), `google`, `google set` and `google prompt`, and `ai status|set|models|history|test|pause|
  resume|remove` (`ai set` prints what leaves the server and to whom, in core's words, and asks before saving a key);
  the key is read unseen or from standard input, never from the command line, and never stored or printed. Output cut short (`| head`) exits quietly. **The Docker image was built and run on this Mac on 2026-11-23** (arm64
  and amd64) after Docker Desktop was updated ([cli.md](cli.md)).
- **`mcp/`** (see [mcp.md](mcp.md)): the connector for a person's own agent over MCP (2026-07-28, TypeScript SDK
  2.4.0; no Google sign-in for agents): twenty tools, among them `get_ai_status` (never `detail` or the settings) and `take_triage_batch` (the
  undecided threads the server's AI won't process); summaries and everything else from the store inside one marked
  data block; agents' tokens only; two interface pieces for chat apps. No sign-in for chat apps (OAuth).
- **`dashboard/`** (see [dashboard.md](dashboard.md)): server-rendered pages that work without scripts: sign-in,
  "what needs you" (the AI among it when it needs a person), inboxes with icon and place, "Sign in with Google" to
  connect or reconnect Gmail, the AI page (core's words of what is sent and to whom above the key field, the consent
  carrying the service shown; models, history, test, pause, removing the key after asking; the key never shown), rules, devices and agents, Handled with the AI's silent records on
  asking. No page has been opened in a browser.
- **The server on Cloudflare** (2026-11-21, [server-cloudflare.md](server-cloudflare.md)): `server/src/cloudflare/`, a
  front Worker and one SQLite-backed Durable Object holding the whole `MailServer`, deployed from the repository's
  root (`package.json`, `wrangler.jsonc`; `npm ci`, `npx wrangler deploy`). Gmail only; the same migrations; timers in
  memory with the alarm as backstop; smaller memory limits, a stored message at most 1.9 MB, search's catch-up in the
  background ([server-cloudflare-limits.md](server-cloudflare-limits.md)); pictures and site icons over
  DNS-over-HTTPS; the owner's code read in Data Studio, the address from each request's own host, the Google client
  given by a paired device, a per-address pairing count, the time zone from the first pairing
  ([server-cloudflare-access.md](server-cloudflare-access.md)); every statement within 100 parameters on both hosts.
  Two independent reviews' findings fixed. The docs are `docs/self-hosting.md`'s "On Cloudflare" and the README's
  Deploy button, not tried yet (the repository is public since 2026-11-24). **Tested in local workerd and Miniflare,
  and deployed once to a real account on 2026-11-23 with `npx wrangler deploy`, where it answered over HTTPS; no Google
  sign-in, sync or AI has run there** (its "Checks still open" and "Seen on the first deploy").
- **`site/`** (see [site.md](site.md), 2026-11-19): the static website for `mail.usual.dev` that Google's console
  needs before the OAuth client leaves Testing: a landing page in the Mac app's look (the wallpaper, glass, the app
  drawn in HTML with made-up mail), a privacy policy and terms, served by the Cloudflare Worker `usual-mail-site` with
  no JavaScript. Checked locally (structure, Quick Look in light and dark), deployed on 2026-11-19 and checked with
  curl (pages, assets, headers); no browser has opened it.
- **`design/`** (see [design.md](design.md)): `tokens.json` generates the web styles, fonts, icon sprite (the six
  inbox icons included) and the Swift package `UsualMailDesign`; galleries on the fifth revision's sample. Nobody has
  looked at the result.
- **`apps/`** (see [apps.md](apps.md)): `UsualMailKit` (models, a client for every route, the event stream, an
  on-device copy in SQLite, `MailStore`, the sign-in, set-up and search models) and `UsualMailUI`, the screens of two
  app targets. **The Mac app**, rebuilt from 2026-11-17 to the owner's Figma design (Liquid Glass over a wallpaper): a
  rail (search, the profile switch with "Add a Gmail account", To reply, Pinned and Snoozed with the server's counts,
  the Inbox page with every inbox's mail as Gmail's inbox lists it, Settings) that opens on hover; tabs Home (New
  above Seen, "Sender - summary"), Feed (newsletters as posts), Receipts (money rows) and Notifications (events,
  groups, a seen tick); Screening by sender with let in and block; the mail page in the card with its actions, the
  row's right-click menu and the undo strip; a row dragged onto To reply, Pinned or Snoozed; sender pictures and
  pictures from the web through the server;
  search with Ask ([apps-search.md](apps-search.md)); Settings in five tabs (Accounts, AI with usage, Appearance with a
  background picture, Blocked with Unblock, About); the first run from welcome and pairing through old mail, Gmail
  (with the guided Google client set-up) and the AI key ([apps-onboarding.md](apps-onboarding.md)). Seen on screen,
  reached through launch options, on the sample and on the owner's own server with real mail
  ([apps-runs.md](apps-runs.md)); this Mac gives the sessions no pointer or keyboard, so they clicked, typed and
  hovered nothing. **The iPhone app** (2026-11-20, [apps-phone.md](apps-phone.md)) is a second target on the same
  packages: search, the switcher and settings above the card, the tabs at its foot. Tapped through in the simulator on
  the sample and on the owner's server; build 0.1.0 was uploaded to TestFlight on 2026-11-20 and seen installed on the
  owner's Mac on 2026-11-25, as an iPhone app; the Mac app's first TestFlight build was refused for its resource
  bundles' signatures on 2026-11-25, and build 202611251405, with the fix, processed as valid the same day.

## Sign in with Google, the live run (2026-11-17)

Requests only, no browser, nothing reaching Google: the built server (`dist/server.mjs`, before the AI switch was
removed) on 127.0.0.1:8787 with `--dev-fake-google http://127.0.0.1:9797 --dev-fake-ai`, scratch data directory,
`USUAL_MAIL_POLL_SECONDS=5`; mail's `FakeGoogle` behind a small HTTP server on 127.0.0.1:9797 with two accounts; the
built command with a scratch home; curl playing the browser (following the fake's redirect to the callback). All
stopped afterwards, ports free; the other sessions' servers untouched.

1. Started without a client: the start line and `/v1/info` said Google sign-in is off (missing `client`) with the
   redirect address `http://127.0.0.1:8787/v1/google/callback`; `doctor` warned with the steps.
2. `usual-mail google set --file <a client file in Google's downloaded shape> --data-dir <scratch>`: copied byte for
   byte, mode 0600; `/v1/info` said available at once, without a restart; the command printed the redirect address
   and Google's rules.
3. `usual-mail inbox add --provider gmail --name Ana --color green --no-browser`: printed Google's address (`scope`
   gmail.modify, `access_type=offline`, `prompt=consent select_account`, S256); the callback page said "Gmail is
   connected"; the command waited and said "Connected Ana (ana@gmail.example), Gmail by signing in with Google".
   The inbox was `signIn: "google"`, status `ok`, its mail synced from the fake Gmail. The page's headers: CSP
   `default-src 'none'`, `script-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `no-referrer`, `DENY`,
   `no-store`; no script.
4. Revoked at the fake: within a poll the inbox needed attention, "Google no longer accepts this inbox's sign-in …
   Sign in with Google again …". `usual-mail inbox reconnect Ana --no-browser` (`login_hint`, `prompt=consent`): the
   page said reconnected; one inbox, same id, status `ok`, its trust, guide, rule and thread kept.
5. Through REST: another account on a reconnect refused (400, `wrong_account`, both addresses named, the sealed
   credentials unchanged); declined (`declined`); Gmail left unticked (`scope_missing`); no refresh token
   (`no_refresh_token`); a used state again (400, "already used"); a made-up state (400, nothing reached the fake's
   token endpoint); another person's device asking about this device's sign-in (404); an agent starting one (403
   `needs_person`).
6. A new-inbox sign-in for Ana's address reconnected her inbox in place (name and colour kept); Bo connected as a new
   inbox; removing Bo revoked his grant at the fake (every refresh token of his, including one left by his refused
   sign-in earlier); Ana's untouched.
7. A sign-in started at 18:25 and finished at 18:35:11, after its expiry: 400 "This sign-in expired", outcome
   `expired`, its code never exchanged.
8. The client secret and the four refresh tokens Google issued were in no response, event, log line, command output,
   file of the command's home, or byte of the database and its journal; only in `google-client.json`, as meant.

**On the final build** (after the switch's removal and the disclosure route; the same fake, a fresh scratch data
directory, everything stopped afterwards): `GET /v1/ai/disclosure?gateway=vercel` answered with no key set; `ai set
--gateway vercel --key-stdin` without `--yes` printed the words and stopped (exit 2, no key saved); the dashboard's
`/ai?service=gateway:vercel` showed them; all seven sentences were the same in the three. The Google flow connected
Ana again (`inbox add --no-browser`); her new mail stayed `unknown` until `ai set … --yes`, then was categorized
(`conversation`, by the AI) and summarized; the inbox carried no `aiProcessing`, and a patch with it was 400; an
agent's token on the disclosure route was 403.

## The review's decisions carried out (2026-11-17)

The coordinator decided the review's findings (decisions 1 to 16; reasons in [decisions](decisions.md)); one engineer
carried them through every part but the Mac app, each fix test-first. The contract's second amendment of the day
says them: a summary request carries no address and nothing of a blocked sender's leaves, in core's one copy of the
words; the key never shows in any form; the server checks a model's `otp` before it lifts the screening gate; rules a
person taught always apply; recent filed history isn't done; a blocked sender writing into a thread changes nothing
a person sees; `Thread.sender`, `Thread.categorizedByActor` (migration `0005`), several categories in one list,
removing the key (`usual-mail ai remove`, the dashboard), model kinds on the gateway; the command exits quietly when
its output is cut short; the contract's and README's stale lines. Fixed issues are in [known issues](known-issues.md);
questions 41 to 43, 46 to 48 and 50 to 62 are answered, 63 to 65 new ([contract questions](contract-questions.md)).

**Joined, requests only:** the built server bundle with `--dev-fake-ai` beside hoodiecrow and an SMTP sink in another
process on 127.0.0.1 (scratch data directories, all stopped afterwards, ports free): a blocked sender's reply inside
a nameless sender's thread showed nowhere and the summary came from the other message with its address replaced; a
stranger's "sign-in code" without a code stayed screened in `otp` (under `Usual Mail/Screening`), a machine-sent one
with a code didn't; a person's rule filed a receipt in a `suggest` inbox (applied, undoable, no proposals); the merged
invoice and receipt list paged one at a time in the right order; a second bundle on a fresh store read recent filed
mail as not done and 20-day-old filed mail as done. The summarize request itself, seen by running the server from
source with the real IMAP provider, named the nameless sender "someone" and carried no address and nothing of the
blocked sender's.

## The joined run of the fifth revision (independent review, 2026-11-17)

With requests only: the built server bundle with `--dev-fake-ai` on a scratch data directory, beside hoodiecrow (IMAP)
and an SMTP sink in another process on 127.0.0.1, `USUAL_MAIL_POLL_SECONDS=5`, driven by the built command with a
scratch home; each step read through REST and at the mailbox with another IMAP client. For step 6 the same data
directory ran under the server from source with fake models a scratch control port could make fail (the development
switch can't fail on purpose). Everything was stopped afterwards and its ports checked free.

1. `init --server` paired through the owner's code file. `inbox add --ai` was refused without a key; a wrong password
   was refused with the provider's words; the inbox connected (AI off). `ai set --gateway vercel --key-stdin` with a
   made-up key: "turns nothing on", status `working`, the inbox still off; a key typed after `ai set` was refused
   without being repeated. `inbox ai on` printed what leaves the server, to Vercel's AI Gateway and its models, that
   its terms apply, and how far back history goes, then asked for `--yes`.
2. History: the six undecided threads from the last 7 days were categorized (conversation, newsletter, invoice,
   receipt, notification, one-time code) and summarized (not the code), each filed in its folder; an archived one was
   left alone; two older ones counted as `beyondHistory` 2. Paused, raised to 30 days ("adds 2 threads", asked
   first): `pending` 2; resumed: processed, `pending` 0.
3. New mail of each kind from let-in senders landed in its category and folder with a summary; from strangers, each
   was screened in its category in `Usual Mail/Screening` (only the server keeps the category there), except the code,
   which went to `otp`, unscreened, unsummarized, in `One-Time Codes`. Home held the conversations; each list and the
   counts matched, and `counts.changed` carried them.
4. A person's correction (newsletter to notification) moved the message to `Notifications` and came with a teach
   prompt naming the list; its undo moved it back; "yes" made an enabled `correction` rule. In the default `suggest`
   inbox the rule only proposed for the next issue (it stayed `unknown` in INBOX); approved, and in `act_with_undo` it
   filed the next one itself.
5. A person's reply (a draft sent through the server) changed nothing; the list member's answer moved an AI-filed
   newsletter to `conversation` and into INBOX. An automatic reply joining a conversation left it a conversation.
6. A refused key, a missing model (with its job), no credit and unavailable each showed in the status with the
   service's words scrubbed of the key, stopped processing (60 minutes; unavailable 1, then 2 minutes), left new mail
   `unknown` in Home and in the triage queue, showed on the dashboard's "what needs you" (not for unavailable), and
   recovered after a test or by itself. A refusal quoting the key in base64 kept the base64 (fixed since: the key is
   scrubbed in any form).
7. AI off for the inbox: new mail stayed `unknown` without a summary, nothing was sent. Another service (Anthropic)
   turned every inbox off and reset the models; a new key for the same service kept the switch; removing the key
   turned it off; turning it on without a key was 409; the key was put back.
8. The connector with an agent's token and the MCP SDK's client: 20 tools; Home with summaries inside the data block;
   a hostile mail imitating the block's end escaped inside it; `get_ai_status` without `detail`; with AI off, the
   triage batch gave the new thread and the agent's sort applied; a person's token 403.
9. The dashboard: signed in through its form; the AI page never held the key; cross-site and token-less posts were
   refused; the inbox's switch showed the words before the button and refused consent given for a service no longer
   set.
10. A second bundle on a fresh data directory, same mailbox: filed categories read back (decided by the mailbox),
    Screening as screened `unknown`, conversations as `unknown`, summaries gone, **and every filed thread done**
    ([contract question](contract-questions.md) 59).

Also: what the fake models were sent matched "What leaves the server" for each job, except that summarizing sends a
nameless sender's address and a blocked sender's message inside a thread (open issue); trashed, done, spam, a blocked
sender's new thread and an inbox with AI off sent nothing; HTML became text without links, pictures or comments;
attachments' names and other recipients were never sent. A fourth-revision store built from the migrations upgraded
on the built bundle as the contract says. The apps' models decoded 102 saved responses (every route the Mac app calls,
ten error kinds with `Retry-After`) and 311 events, and `MailStore.refresh()` against the live server gave the same
Home, category, stack, waiting and screening lists and counts as the server. The key was in no response, event, log
line or file but the sealed store.

**Fixed in the review:** the triage queue held only old threads while a key was set and no inbox was on; a summary was
dropped when the sender's name was part of a word ([known issues](known-issues.md)).

**The first milestone** (fourth revision) was reviewed end to end the same morning with the built command and server
beside a local test mail server: pairing, connecting, history, rules, screening, triage, an agent under each trust
level, stacks, come-back times, done, trash and undo, changes at the mailbox, drafts, pause, new credentials, refused
write-backs, the owner's code and the pairing limit all passed; its findings were fixed the same day.

## Proven, built but unproven, not built

- **Proven** on this Mac with fake models and a local test IMAP server, by requests and by each part's tests: the
  flows above; the key sealed and kept out of every answer, event, log and file (in any form, since this pass's fix); the
  consent rules; the sorting order and the screening gate; history and its limits; the failure states and their
  waits; the store upgrade; the Mac app's data layer against the real server. **Against real services, only on the
  owner's own server:** one real Gmail mailbox, the owner's, connected by signing in with Google (2026-11-17) and
  synced; and Vercel's AI Gateway with the owner's key (from 2026-11-18): categorizing through its Decisions API
  (`liquid/d1.2`), summaries (`anthropic/claude-haiku-5.5`), and a receipt's payment details and a notification's
  event as structured output through the gateway, audited on the owner's mail ([decisions-ai.md](decisions-ai.md);
  how accurate the AI is elsewhere is unmeasured). **On the owner's own server with real
  mail** (from 2026-11-18): the Mac app's screens, seen in captures reached through launch options, with pictures from
  the real web and sender pictures through the server ([apps-runs.md](apps-runs.md)); in the simulator, the iPhone
  app's screens tapped through and one pin with its undo ([apps-phone.md](apps-phone.md)).
- **Built, unproven:** OpenAI's and Anthropic's own keys (no key, no request: their default models, structured output
  and real error bodies); the gateway's real error bodies, and whether the cost it reports is right (its cost lookup
  answered for both jobs on the owner's server, [apps-runs.md](apps-runs.md)); Gmail beyond the owner's mailbox
  (every test uses `FakeGmail`; the full form for large messages has never met real Gmail); the server on Cloudflare
  itself (deployed once on 2026-11-23 and answering over HTTPS, but no sign-in, sync or AI there yet); a real IMAP server beyond hoodiecrow (GreenMail and Dovecot need
  Docker, which answers again since 2026-11-23 but they weren't run); the image on any host but this Mac's Docker
  Desktop; any page in a browser; a real agent or chat app. **In the apps, these have not been
  tried by hand in a recorded run** (tests and captures only; the owner's recorded use is clicking through the rebuilt
  app on 2026-11-17 and scrolling a mail on 2026-11-18, [apps.md](apps.md)): dragging onto the rail,
  hover (tooltips, the rail opening, a row's time), Ask, Unblock, the background picker, typing in search; the first
  run as built now with a real account (the owner typed the pairing and pressed Sign in with Google on its first
  version, 2026-11-17); the guided Google set-up beyond seeing it at rest. The iPhone app on a device: build 0.1.0 was
  uploaded to TestFlight on 2026-11-20 and not yet seen on an iPhone ([apps-phone.md](apps-phone.md)).
- **Not built:** in the apps, the screens for writing mail (reply, compose, drafts), proposals to approve, Handled,
  rules, and inbox settings and new credentials (only Gmail can be added); `UsualMailKit` already has all of these
  (`DraftInput+Compose.swift`, `MailStore+Drafts.swift`, approving, Handled's list, rules, credentials). Also not
  built: changing the AI key or models after the first run, offline and problem messages, keyboard shortcuts beyond
  ⌘K, Esc, Return on a step's or sheet's main button, search's keys (with ⌘↩ for Ask) and the first run's ←/→ through
  its slides, dark mode; on the iPhone also swipe actions, drag and drop and the corner note; and everything under
  "Not started".

## Next

1. **The apps by hand** (the owner's to try; the sessions here have no pointer or keyboard): dragging onto the rail,
   hover, Ask, Unblock, the background picker, the first run with a real account, the guided Google set-up's prompt
   and file; then TestFlight build 0.1.0 installed on an iPhone. What is left to build is under "Not built" above; no
   order for it is recorded.
2. **The owner's real run** (under way since 2026-11-17/18): Gmail connected by signing in, a real AI key on
   Vercel's AI Gateway; after the fixes of 2026-11-18 the server rebuilt and restarted, the summaries asked for again
   and the older synced mail processed; the cost watched.
3. **The server on Cloudflare with mail** (the owner's): first deployed on 2026-11-23 with `npx wrangler deploy`;
   Google sign-in, a sync, the AI and the Deploy button are still to try there, to settle what local workerd can't
   ([server-cloudflare.md](server-cloudflare.md), "Checks still open").
4. **Public since 2026-11-24** (`usual-labs/usual-mail`, "History" below), and 0.1.0 released the same day, which
   published the image. Next, the owner's: making the GHCR package public ([decisions-deploy.md](decisions-deploy.md),
   "What waits for the owner"), and what improvement-ideas.md lists under "Since the repository was published".
5. Still open: [contract questions](contract-questions.md) 1, 2, 20 to 22, 30 to 38, 40, 44, 45, 63 to 69, 71 and
   74 to 77.

## Not started

On Cloudflare: any mailbox but Gmail, a backup or export, a warning before the object's 10 GB fill, and moving a
server between hosts (the host itself is built: "Implemented today"). Also a hosted service (Google's verification and security assessment first), binding a
Google sign-in to the browser (question 66), waking agents when mail arrives, sign-in for chat apps (OAuth), Outlook, push
notifications, Gmail's push (Pub/Sub), signing in with an AI provider instead of a key, the AI jobs planned after
categorize and summarize (extracting fields, drafting replies), an iPad layout.

## History

Published on 2026-11-24 at `github.com/usual-labs/usual-mail`, branch `main`, as one fresh commit of the tree under
the maintainer's GitHub noreply address (the owner's decision); the notes were trimmed of details from the owner's own
mailbox and machine just before it. The local history before it (seven commits, 2026-11-21 to 2026-11-24) stays in
the maintainer's own checkout and is never pushed. Each commit is made at the maintainer's request. Later commits go
onto `main` by rebase or fast-forward, never a merge (`main` shares no history with the local one). `1881044` sets the
version to 0.1.0 everywhere it is written, and the release `v0.1.0` (that commit, 2026-11-24) published the image.
The iPhone tweaks and the owner's password (2026-11-24) were rebased onto `main` after it and pushed there at the
owner's request. The stop fixes after them (2026-11-24) say 0.1.1 wherever `1881044` wrote the version (every
`package.json` and lockfile, `server/src/version.ts`, `cli/src/version.ts`, `mcp/src/server.ts`,
`mcp/src/ui/view-script.ts`, and the deploy guide's tag example); notes about the first release still say 0.1.0.
0.1.2 (2026-11-25, released as `v0.1.2`) bumps the same places and the README's status line,
for the apps' warning on an inbox that stopped syncing and the server's side of it (`Inbox.statusReason`, a grace for
failures that may pass, a watch on syncs that never finish; [server.md](server.md)).
0.1.3 (2026-11-26, released as `v0.1.3` from `hotfix-0.1.3`, `2bf7595` on `main`) bumps the same places and the
README's status line, for crafted mail that froze the server while it was read. The server's readers of a message's text and of a
model's answers, mail's readers of message ids and of a forwarded message's transfer encoding, and the picture pass's
size and tracker reading run in time linear in what they read; HTML is cut to 2,000,000 characters and 256 open
elements before htmlparser2 reads it (`mail/src/message/html-depth.ts`); addresses are taken out of summary requests
by `server/src/ai/addresses.ts`; and a subject sent to the AI is cut to 1,000 characters. A few patterns are linear
only because their callers hand them short strings ([known-issues.md](known-issues.md), "Linear only where they run",
and "Reading a message could take minutes" under Fixed; [mail.md](mail.md), [server-ai.md](server-ai.md)).
0.1.4 (2026-11-26, released as `v0.1.4`, `502ceed` on `main`; the owner's Cloudflare server runs it) bumps the same places and the
README's status line, for mail from strangers that skips Screening (a code, a sign-in link, a security alert, an order
and the like, with the provider's checker and the server's own check behind the model's answer) and senders let in
without the AI (another inbox on the server, a colleague at a company domain); migration 0022
([server-screening.md](server-screening.md)). The apps show `Thread.skippedScreening` in the mail's "why it's here"
since after the release ([apps.md](apps.md)).
0.1.5 (2026-11-27, released as `v0.1.5`, `51ae4cd` on `main`; its image `sha256:428466f1…0087` for amd64 and arm64,
tagged `0.1.5`, `0.1` and `latest`, its provenance verified with `gh attestation verify`; the attestations of
0.1.1–0.1.5 name each commit by its hash from before the history was rewritten on 2026-11-27) bumps the same
places and the README's status line, for unsubscribing from a
sender ([unsubscribing](../contract.md#unsubscribing), [server-unsubscribe.md](server-unsubscribe.md)): the route,
its queue, the browser agent's key in the AI's settings (Browser Use, only with the person's own key), mail's reading
of which unsubscribe headers the sender's signature vouches for, and migration 0023; reviewed for security twice before
it shipped (known-issues.md, Fixed). The iPhone app's builds that came with it unsubscribe from the Feed, swipe on
Notifications and the Feed, dot the tabs with unseen mail and go back from a mail with a swipe from the left edge
([apps-phone.md](apps-phone.md)). The apps' builds of 2026-11-28 (iPhone 202611280805, Mac 202611280809, from
`96d5692`; no server release) build the lists lazily, so a long copy no longer lags on changing tabs, keep each list's
place by the row at its top, and swipe on Receipts.

## Layout

```
core/        shared contract (types, interfaces, routes, sample data)
server/      the server, with the server's AI
mail/        mail providers
design/      tokens, fonts, icons
apps/        Swift packages, the Mac app and the iPhone app
dashboard/   the web dashboard
mcp/         the connector for agents and chat apps
cli/         the usual-mail command
site/        the static website at mail.usual.dev (landing page, privacy policy, terms; live since 2026-11-19)
Dockerfile, docker-entrypoint.sh, .dockerignore   the server's image (starts as root, gives /data to node, runs as node)
compose.yaml            the image with Docker Compose on this machine (pulls it, or builds it from a checkout)
compose.caddy.yaml      a VPS of your own: the image behind Caddy with Let's Encrypt, one file plus .env
compose.coolify.yaml    Coolify v4 (no ports; the address and the key from Coolify's variables)
deploy/                 Azure portal template and Bicep source, AWS CloudFormation stack, Railway Compose import
render.yaml             a Render Blueprint (Dockerfile build, starter plan, 5 GB disk at /data)
.github/workflows/image.yml   publishes the image to ghcr.io/usual-labs/usual-mail (amd64, arm64) on a release
package.json, wrangler.jsonc   deploy the server to Cloudflare (`npm ci`, `npx wrangler deploy`) and test it in workerd
LICENSE      the GNU AGPL-3.0 (every package.json says AGPL-3.0-only); THIRD_PARTY_NOTICES.md: what comes from others
CONTRIBUTING.md, CLA.md   how to contribute, and the contributor agreement (a draft without a legal review)
docs/        contract.md (the entry point), contract-ai.md, contract-sync.md, self-hosting.md, deploy.md (a VPS,
             Coolify, Render, Railway), deploy-cloud-vms.md (Azure and AWS), google-setup.md and google-setup-agent.md (for people running a server), and
             agents/ (this knowledge base; the deploy files' reasons in decisions-deploy.md)
```

## Checks

Re-run on 2026-11-23 on this Mac after the review of first-sync progress and the licence (the pause fix, count-only
events, the apps' summed count, the sample's first-sync count, the licence wording). `design/` changed only by the
licence field in its `package.json` and lockfile; its `npm run check` was re-run, its Swift checks weren't.

| Part | Command | Last result |
|---|---|---|
| `core/` | `npm install && npm run check` | 2026-11-23 (the review's fixes): type check clean; sample.json consistent (3 inboxes, 28 threads, 37 messages, 2 drafts, 21 actions, 4 rules; AI working, 4 pending; Home 5), Personal now with a first sync's count (1,840 of 2,600), so the sample check's `firstSync` branch runs; the agent prompt matches its doc |
| root (Cloudflare) | `npm install && npm run check:cloudflare` (each part's own `npm install` first for development); `npx wrangler deploy --dry-run` builds without deploying | 2026-11-24 (the final review's fixes): both Cloudflare type checks clean; 82 workerd tests pass (`wrangler deploy --dry-run` not run) |
| `server/` | `npm install && npm run check` (`npm install` in `mail/` first) | 2026-11-24 (the final review's fixes and libSQL's local client): both type checks clean; `npm test` 1,018 tests (1,012 pass, 6 skipped), the 3 new ones seen failing first; two scratch builds byte-identical; a scratch bundle inside `server/` smoke-tested and moved to the Trash (`dist/` not rebuilt) ([server-checks.md](server-checks.md)) |
| `mail/` | `npm install && npm run check` (`USUAL_MAIL_SKIP_DOCKER=1` skips the Docker probe) | 2026-11-23 (the review's fixes, nothing in `mail/` changed): type check clean; 552 tests in 73 suites: 537 pass, 15 skipped (Docker skipped) ([mail-checks.md](mail-checks.md)) |
| `cli/` | `npm install && npm run check`; `npm run build` writes `dist/usual-mail.mjs` | 2026-11-23 (the review's fixes): type check clean; 169 tests in 19 suites pass (the bundle not rebuilt) |
| `mcp/` | `npm install && npm run check` | 2026-11-23 (the review's fixes): design file current; both type checks clean; 134 tests in 32 suites pass |
| `dashboard/` | `npm install && npm run check` | 2026-11-23 (the review's fixes): assets current; both type checks clean; 161 tests in 31 suites pass |
| `design/` | `npm install && npm run build && npm run check`, then `npm run check:swift` and `npm run check:ios` | 2026-11-23 (after the licence field): 120 generated files current (nothing to regenerate after the sample change), 38 tests pass; Swift 19 tests in 7 suites passed in the review of 2026-11-17 (not re-run: no Swift or generated file changed) |
| `apps/` | `apps/scripts/check.sh` (`--fast` skips the Mac and iPhone builds). Keep the Mac unlocked: one test uses the Keychain | 2026-11-23 (the review's fixes): exit 0, lint clean, `UsualMailKit` 502 tests in 80 suites and `UsualMailUI` 383 in 57 pass, the unsigned Mac build and the iPhone simulator build with no warnings (a first run failed `ActivityNoteTests` on the sample's new count: its helper now clears it) |

Docker didn't answer from 2026-11-16 until Docker Desktop was updated on 2026-11-23. That day the image, `compose.yaml`,
`init --mode docker`, `compose.caddy.yaml` and `compose.coolify.yaml` ran in Docker Desktop, and `image.yml`'s steps
against a local registry ([cli-checks.md](cli-checks.md)); the Docker-backed mail tests weren't re-run.
