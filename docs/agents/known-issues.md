# Known issues

Record each as: what happens, why (from the code), the fix or the workaround, and whether it is still open.

## Open

- **Linear only where they run** (server, mail and core, 2026-11-26, the sweep behind 0.1.3's freeze fix; open by
  choice). These patterns take more than linear time on a crafted string of their own, but every caller hands them
  one that is short: the thousands separator `\B(?=(\d{3})+(?!\d))` (core's `ai-words.ts` and `first-sync.ts`, the
  server's `payment.ts` and `search/doc.ts`), always on a number written out; the IPv4 tail and zone of an address
  (`client-address.ts`, `cloudflare/web/addresses.ts`, `node/pictures/address.ts`), on one header line or an address
  `net` has read; `=+$` on base64 (`secrets.ts`, `util.ts`), the operator's key or `btoa`'s output; the owner's email
  pattern, after a 254-character limit that stops valibot's pipe first; `withoutSender` (`event-lines.ts`) on an
  event's "about" line, one line of at most its limit by then; the link pattern in `checkReference`, on 120
  characters; `shortenSummary`'s trim, on the limit; the sticky domain pattern in `ai/addresses.ts`, tried only right
  after an at sign and stopped by the next. The fake models' patterns run in tests only. A caller handing any of
  them a long string would bring the cost back; the sweep (a pumping test of every pattern literal) finds them again.
  Also bounded rather than linear: sanitize-html looks through every open element for each style block's text, at
  most 256 deep (about 0.6 s a megabyte for 2 MB of style blocks inside 256 open elements, most of it the CSS filter
  reading each block); and htmlparser2's own stack still costs each tag as much as the elements open around it, now
  at most 256 ([improvement-ideas.md](improvement-ideas.md) has the upstream fix). HTML past 2,000,000 characters is
  cut before it's read: a message with more HTML than that and a text part shows the text part whole, one without
  shows text made from the first 2,000,000, and if what was kept sanitizes under the 1,000,000 characters the server
  shows, that HTML is shown without saying it was cut (it takes over a megabyte of markup the sanitizer drops).
- **Mail that skips Screening: what the server's check doesn't stop** (server, 2026-11-25, by design; open as limits,
  [server-screening.md](server-screening.md)). (1) **A look-alike domain that authenticates well passes:** a phisher
  who owns `lumen-bank-security.example`, publishes DMARC and sends machine-looking mail with security words to the
  person passes as a "security alert" if the model agrees: the check proves the From domain is the sender's own, not
  that it is the brand it imitates. It shows no logo (its sender isn't let in), and "Skipped Screening: a security
  alert" says why it is there. A list of brands' own domains, or holding back mail whose links lead elsewhere, would
  narrow it; neither is built. (2) **Platform notices that carry a user's words.** Refused: everything at google.com
  and microsoft.com and their subdomains but Microsoft's account team, and every address at paypal.*, venmo.com,
  square.com, squareup.com, stripe.com and sharepointonline.com (their real alerts wait in Screening, the accepted
  cost); tenant subdomains of help desks and tools. Google's own account alerts wait too: a genuine, signed one from
  its accounts sender can carry an app name an attacker typed (Kaspersky's DKIM replay through Google OAuth), and no
  Google page names that sender. **Verified:** Microsoft's account team's sender,
  `account-security-noreply@accountprotection.microsoft.com` (https://support.microsoft.com/en-us/help/13967, by the
  final security review). **Assumed:** that Google's and Microsoft's other products' notices come from those two
  domains (Microsoft's Teams also sends from addresses under the `.microsoft` top-level domain, which isn't listed),
  and how other platforms' notices are headed. No real header samples were read: the tests build them. A platform not on the lists that writes a user's
  words in mail addressed to the person, with no List-Id and no Reply-To elsewhere, still passes when the model
  agrees (another file share or calendar, a marketplace's message, a code-hosting site's notice without a List-Id).
  (3) **Replays:** a copy sent on by Bcc, or with a To or Cc added on top, doesn't pass (the field naming the inbox must
  be given once and signed by the sender's aligned DKIM signature; checked against real parsing, with made-up
  signatures). The check is monotone (`mail/src/message/signed-recipients.ts` argues it, a test adds every hostile
  field alone and in pairs at every place): every signature of the From address's organisation bounds what counts,
  so none can be made not to count. Not every replay: a sender who signs a field naming someone else is beyond it, and
  the check relies on Gmail's own result being the topmost Authentication-Results. Mail authenticated by SPF alone
  (no DKIM) never passes, also with a forged signature copying another domain's. (4) **Once through, a thread is judged again** when anyone not let in writes into it, but mail from someone
  let in into it changes nothing. (5) **The evidence words are English only** ("sign in", "order", "booking"): a German
  "Bestellung" or a French "connexion" waits in Screening. (6) **Mail sent to an alias or a forwarding address** never
  skips Screening, codes included: To or Cc must name the inbox's own address (a `+tag` and Gmail's dots aside).
  (7) **Invoices never skip it,** also a renewal the AI calls an invoice. (8) **Mail that arrived while the AI was off,
  paused or failing stays in Screening** when the AI categorizes it later, codes included. (9) **The question's quality
  is untried:** no real model has answered it; the fake answers by words. (10) On IMAP only codes pass, as before
  2026-11-25; a server without the Public Suffix List lets nothing through on Gmail.
- **A summary request can still carry an unusual address** (server, older than 2026-11-25; open). `withoutAddresses`
  (`server/src/ai/addresses.ts`) takes out addresses of letters, digits, marks and `._%+'=-` before an at sign ("@" or
  "＠") and a domain of any number of labels of any length, dotted by ".", "。", "．" or "｡". A quoted local part
  (`"Ann Lee"@mail.example`) and a domain written as an address literal (`ann@[192.0.2.10]`) aren't taken out, nor the
  part before a second @ (`a@b@mail.example` leaves `a@`). Mail rarely writes them; the sender's own address never
  goes in a summary request either way. Widening the scan would take them out.
- **Text in Thai, Japanese or Chinese can lose up to 256 letters before an address** (server, 2026-11-25; a quality
  limit, by design). With no space before an address, the letters run into its local part; a run of up to 256 is taken
  out whole with the address (mail allows only 64, but a longer local part is still taken whole to that length), and
  past that only its last 64. So a summary request may miss the words right before an address in such text.
- **The sender rules match exactly, and may never fire for colleagues** (server, 2026-11-25; open). A colleague at a
  subdomain of the inbox's domain (`eu.work.example` for `me@work.example`), a second domain the company owns, or
  another inbox's alias (Gmail's dots and `+` tags, a "send mail as" address) isn't let in by them. A colleague must be
  a person: mail that looks machine-sent or carries a List-Id isn't let in by the domain, so a colleague writing
  through a list or a tool waits in Screening. **Unverified:** whether Gmail stamps its own `Authentication-Results`
  on mail between two people in the same Google Workspace. If it doesn't, `fromCheck` is `no_header` and the colleague
  rule never fires for them; check on a real Workspace mailbox (the stored `messages.from_check` of a colleague's mail
  says). The "own addresses" rule needs the receiving inbox to be Gmail, whatever the other inbox is.
- **Syncing can fall behind without a warning in three ways** (server, found 2026-11-25 by the review of the apps'
  warning; open). Fixed in 0.1.2 (the owner's "Yes, fix it", [contract](../contract-sync.md#when-an-inbox-needs-attention)):
  every failed sync used to set `needs_attention`, a brief network error too, so the apps' notice flashed and Gmail's
  "Sign in again" showed when signing in couldn't help (the host's client refused, a provider error); and a sync that
  never finished, or none at all while the server ran, warned of nothing. Now a refused sign-in and the host's setup
  warn at once with their reason (`statusReason`), a failure that may pass only after ten minutes across two attempts,
  and no finished sync for 15 minutes (or five polls) is `not_syncing` (`server/src/sync/health.ts`, `watch.ts`). The
  server review of 0.1.2 then found and got fixed: a `not_syncing` that stayed through a slow first sync's healthy
  batches (a batch stored now ends it); IMAP's temporary login refusals (`[UNAVAILABLE]` and the like) taken for a wrong
  password; a hang ending in a failure counted as a gap, so the warning went to `ok` and came back ten minutes later
  (the run now counts from the attempt's start, and a failure after `not_syncing` is `provider_error` at once); the
  watch writing over a status a finished sync or a reconnect had just set (it looks again under the lock); write-backs
  not counting as signs of life; a refused sign-in turning into "try again" past the grace (it now stays until a good
  sync or new credentials); words that said "no sync has finished" since the last good one, and advice naming
  `usual-mail google set` on Cloudflare. Still open, none of them a status:
  - **IMAP skips a folder that has gone missing** (`mail/src/imap/sync.ts`, `mailboxMissing`): were INBOX itself to go
    (renamed at the provider), new mail would stop arriving while the inbox stays `ok`.
  - **A write-back that fails is logged and fails its records, never the inbox** (`sync/engine.ts`, `#runWriteBack`):
    Handled shows each failed action, but nothing says the mailbox stopped taking changes.
  - **Gmail leaves out a single message it can't read** (`failsTheBatch` false: a 400 or 404 on one message, data it
    can't parse): skipped or kept as a note, with no warning on the inbox.
  - **On Cloudflare, a sync cut short each time the object restarts isn't `not_syncing`**: the watch is in memory and
    begins afresh at every start (so that a start or a wake never sets it off), so an object restarted before every sync
    finishes would never warn. Not seen; `lastAttemptAt` is stored, should it be needed.
  - **The command's Docker mode passes no `TZ`** (`cli/src/launch/docker.ts`): a server it starts in Docker works in
    UTC, so its words say times in UTC. Compose files have the line; the guides say so.
- **The Dovecot suite's logins are refused** (`mail/test/imap/docker.ts`, found 2026-11-25, the first run with Docker
  answering; open). The harness starts `dovecot/dovecot:2.4.5` with `USER_PASSWORD`, its probe user logs in, then most
  per-test users (`u<random>@mail.example`) are refused, so 23 of its 32 tests fail with "refused the user name or
  password". Not the code under test: the same failures with 0.1.2's change undone. Likely the image's default passdb
  or its auth penalty; not looked into. `USUAL_MAIL_SKIP_DOCKER=1` skips the Docker suites.
- **Whoever opens a new server first owns it, unless `USUAL_MAIL_OWNER_EMAIL` is set** (by design, the owner's choice
  of 2026-11-24; [server-owner.md](server-owner.md)). Scanners read Certificate Transparency logs and reach new
  hostnames (a custom domain, `onrender.com`, Coolify's `sslip.io`, `workers.dev`) within minutes. The deploy files ask
  for the email (Render, Coolify, Caddy); Cloudflare's Deploy form can't ask for an optional value, so there it is set
  by hand, and the window runs from the deploy until it is set, whoever opens the address (the default `usual-mail`
  name on the account's `workers.dev` subdomain is easy to guess); the docs say to set it first or claim at once. A
  hostile claimer can leave its own AI key, Google client, agents or rules behind, so the docs' safe default is to wipe
  the data and deploy again; otherwise "Forgot your password?" writes a recovery code where only the host can read it:
  sign in with it, remove the other devices, check the AI settings and the Google client, set a password. The server
  logs each claim with the claiming device's name (quoted). Only a server nobody has used can be claimed: since the
  review's fix (2026-11-24) a server with any device row (revoked ones count), an inbox or a password never can be
  again ([server-owner.md](server-owner.md)).
- **The owner's password is PBKDF2-SHA256 at 100,000 iterations** (2026-11-24), below OWASP's 600,000, because Workers
  refuse more. Online guessing is capped by the pairing limit (ten wrong passwords or codes in ten minutes per client
  address, five at Cloudflare's door, thirty per IPv6 /48, and a thousand from everyone: at most 144,000 tries a day);
  a stolen database
  could be attacked offline faster than with a stronger hash. The stored form names the count, so a later build can raise it on Node and re-hash at sign-in.
- **An owner email set without a Google client closes claiming** (2026-11-24, by design): the server can't prove the
  email, so the claim page says Google sign-in isn't set up and the owner's code is the way in. A fresh Cloudflare
  deploy has no Google client, so an owner email there means Data Studio once, then a password.
- **A thousand wrong passwords or codes from many addresses lock signing in for everyone for ten minutes**
  (2026-11-24; [server-owner.md](server-owner.md), `service/attempts.ts`). Failures count per client address (an IPv6
  address by its /64): ten from one address lock only that address, thirty from one IPv6 /48 lock that /48, and the
  ceiling of a thousand keeps guessing slow (144,000 tries a day; about one in 7.6 million against one 40-bit code
  waiting all day). So locking the owner out of new sign-ins takes a hundred IPv4 addresses or thirty-four /48s
  guessing at once, renewed every ten minutes; devices already signed in keep working. Before the re-review's fix a
  hundred did (ten IPv4 addresses or ten /64s, even in one /48), and before the first review's fix ten from anyone.
  IPv4 isn't counted by any wider block (improvement-ideas.md). Who the client is depends on the host: on Node behind
  a proxy every connection is the proxy's address, so one client could lock everyone out unless
  `USUAL_MAIL_TRUSTED_PROXIES` names the proxy (the Caddy and Coolify files set `private`, Render's
  `private,cloudflare`, Railway by hand; `usual-mail init` passes none of it on, self-hosting.md says how). Behind
  Cloudflare's proxy the server sees Cloudflare's edge unless the setting holds `cloudflare` and the proxy in between
  trusts Cloudflare too (Caddy's `trusted_proxies`, Traefik's `forwardedHeaders.trustedIPs`); then anything connecting
  from Cloudflare's addresses (another account's Worker) may write the address it counts under, under the same
  ceiling. Behind `compose.caddy.yaml` with an AAAA record, every IPv6 client is the Compose network's gateway (Docker's
  userland proxy), so they share one count; deploy.md gives the network's `enable_ipv6` as the fix, not in the file
  because it stops the server where IPv6 or `ip6tables` doesn't work. `CLOUDFLARE_RANGES` is a copy of 2026-11-24: a
  range Cloudflare adds later counts as its edge until the list is updated. How Render's proxy connects and fills
  `X-Forwarded-For` is unverified. In memory: a restart forgets the counts.
- **Thirty-four addresses can hold the Google claim closed for ten minutes** (2026-11-24, open; `google/owner-claim.ts`):
  at most three sign-ins wait per client address (an IPv6 /64) and a hundred in all, so thirty-four addresses starting
  three each fill it, renewably, until the server is claimed. Only before the owner claims a server with an owner
  email; the owner's code still gets in. Counting the waiting sign-ins per /48 too, as wrong passwords are, would
  raise it for IPv6.
- **A teach prompt stored before 2026-11-24 whose list id holds a control character can't be accepted** (open, an edge
  case): a rule's `listId` still refuses control characters, so answering yes is `invalid`, and `answerTeach` marks the
  prompt answered before it makes the rule, so the prompt is gone too. New prompts never offer such a list id; one
  with a control character only in the sender's name is accepted (its rule's text is made one line). Making the rule
  before marking the prompt would keep it to answer no.
- **A restart forgets where a recovery code waits** (2026-11-24): the host hears null and removes the file or the row,
  while the code itself stays valid in the store until its 30 minutes end. Ask for another.
- **The claim proof travels in the address once** (`/claim?proof=`, 2026-11-24): it can sit in the browser's history.
  It works once, for ten minutes, only while the server is unclaimed. The callback's redirect sends no referrer; the
  claim page sends a `same-origin` referrer (the dashboard's `securityHeaders` in `dashboard/src/http/headers.ts`
  overwrites the route's `no-referrer`), so its address reaches only the server itself, with its own assets.
- **`server/src/service/server.ts` is at 624 lines** (2026-11-24: from 574, six thin owner methods, `start`'s
  checks of a stop asked for during start-up, and the per-address client key) and `dashboard/test/fake-service.ts` at
  593 (the owner's fake is its own file, `fake-owner.ts`). Split both by responsibility when they are next changed.
- **A stop in the first moment of a container's life is still lost** (server image, found 2026-11-24 while checking the
  fix for SIGTERM during start-up; open). Node is PID 1 and ignores SIGTERM until `stop-signal.ts` runs, which is after
  the entry point's shell (also PID 1, no trap) has `exec`ed Node and Node has parsed the 7.6 MB bundle: about 0.1 s
  of a 0.27 s start-up at full speed (measured outside Docker), and about 2 s at a tenth of a CPU in Docker, where a
  `docker stop` sent then was ignored and the server killed at the deadline. Rare (only a stop within that moment),
  and nothing is in hand then. The entry point's shell (`docker-entrypoint.sh`, PID 1 until it `exec`s Node) has no
  handler either. Not done: an init process as PID 1 (Compose's `init: true`, `docker run --init`, or tini in the
  image) would let the default action end Node at once before the handler exists, and cover the shell
  ([improvement-ideas.md](improvement-ideas.md)).
- **Ctrl-C during the Node server's start-up waits for the step in hand** (server, final check of 2026-11-24; open).
  A signal during start-up is acted on between steps (`quitIfAsked` in `src/node/main.ts`), so it waits for the key
  file, the store's upgrade or `MailServer.create` to finish; an upgrade of a large store can take a while. A second
  Ctrl-C is ignored, like every second signal (`stop-signal.ts`). Nothing is in hand before syncing starts, so a
  second one during start-up could end the process at once.
- **Node mode's pid file and `stop` leave small gaps** (`usual-mail` command, final check of 2026-11-24; open unless
  marked fixed). Each needs two commands at once, a command killed at the wrong moment or an unusual set-up
  ([cli.md](cli.md), "Node mode"):
  - The mark (`replaceRecord` in `cli/src/launch/pid-file.ts`) reads the file, then renames its own version into
    place: a record another command writes between the two is overwritten. A lock file beside it, opened with
    `O_EXCL` around each change, would close this window and the next two.
  - Without hard links (FAT, some network shares), `removeRecord`'s `linkSync` failed when it put back another
    command's newer record, and its `finally` then deleted the record it had set aside: the next server ran
    unrecorded. Fixed 2026-11-24: it renames the record back once no file is there (`pid-file.test.ts`, which fails
    without it); a record written between that check and the rename is replaced.
  - A command killed between writing and renaming leaves `server.pid.<pid>.tmp` beside the file; one killed after
    taking the record aside and before deciding leaves `server.pid.<pid>.taken` and no record, so the server runs
    unrecorded (`status` says stopped, `start` finds the port in use). Nothing removes the leftovers.
  - Which process is the server is a text match: the command line must hold ` --data-dir <dataDir> ` somewhere.
    This command's own process never counts (fixed 2026-11-24, `pid-file.test.ts`: its id may be one a server had,
    and `usual-mail … --data-dir <dataDir>` holds the same words); another program given those words would still
    match. Matching the arguments exactly would close it.
  - `Runner.isAlive` counts EPERM as not running, so a server running as another user (started with `sudo`) is
    "stopped": `stop` removes its record without stopping it, and `start` finds the port in use.
  - After SIGKILL the record is removed even if the process is still there five seconds later (stuck in the
    kernel), so the next `start` finds the port in use.
  - Words: the launcher's `start` (`cli/src/launch/node.ts`) says "another `usual-mail` command is stopping it" when
    the stopping command's id now belongs to another process, and after finishing a stop it says "Started." for a
    server another command started meanwhile. `stop` says "Stopped." when another command finished the stop first
    and the next server runs.
  - A command that dies between marking the stop and sending SIGTERM leaves the server marked `stopping`, still
    listening: `start` skips its "runs already" answer for a stopping server, then fails with "Port … is in use by
    another program", which is the server itself. `usual-mail stop` finishes the stop.

- **A server an agent started dies when the agent's session ends, even detached** (operations, found 2026-11-22;
  open, in this project's T3 Code/Claude environment). Node mode's `usual-mail start` spawns the server with
  `detached: true` and `unref()` (`startDetached` in `cli/src/runner.ts`), so it leads its own session and process
  group and passes to launchd when `start` exits. Even so, a server an agent started was gone minutes later, after
  that agent's session ended, with nothing in `server.log` (the server logs nothing when signalled). Inferred: the
  environment ends every process a session spawned when the session ends. It isn't the environment variables: the
  Mac app, opened with `open` by the same session and still carrying its variables, survived. Workaround: start the
  server from the person's own Terminal, for example by `open` on a `.command` file that runs `usual-mail start`
  (apps-runs.md, 2026-11-22). If Terminal isn't running, `open` launches it with the caller's whole environment,
  which then reaches the server (an agent's tokens included; see improvement-ideas.md); run `open` under `env -i`
  with only the login basics (HOME, USER, LOGNAME, SHELL, TMPDIR, a system PATH, SSH_AUTH_SOCK,
  `__CF_USER_TEXT_ENCODING`, COMMAND_MODE), or have the person open the file. Node mode has no login service (no
  launchd or systemd unit, [cli.md](cli.md)), so after a reboot or a kill someone has to start it again.

- **A second copy of the Mac app finds the first one's pairing in the Keychain** (apps, found 2026-11-21 preparing a
  preview copy; open). `KeychainCredentialStore()` (`UsualMailKit/Pairing/Credentials.swift`, called by
  `App/UsualMailApp.swift`) keeps the pairing as one generic password under a fixed service and account, without
  `kSecUseDataProtectionKeychain` or an access group, so it lives in the login (file-based) keychain, which isn't
  divided by bundle id or sandbox: a Debug copy with another bundle identifier looks up the same item at launch,
  macOS asks for the login password (as after the ad hoc rebuilds), and allowing it hands the copy the owner's token;
  pairing the copy would overwrite it. Inferred from the code and those earlier prompts, not tried. Workaround used:
  patch the service string in the copy's binary to a same-length name and re-sign (apps-runs.md, 2026-11-21). A fix
  would name the service after the bundle identifier for any identifier but the app's own, or move to the data
  protection keychain with the app's access group.
- **A migration that rebuilds a table would delete rows on Cloudflare only** (found 2026-11-21 in the Cloudflare
  design's spike, [server-cloudflare.md](server-cloudflare.md); the Cloudflare host runs migrations so since step 2). libSQL's
  `migrate` turns foreign keys off before its transaction (`@libsql/client`'s `migrate`); Drizzle's durable-sqlite
  migrator runs every file inside `transactionSync` with them on, and a Durable Object ignores
  `PRAGMA foreign_keys = OFF` (it stayed 1, outside and inside a transaction). So the `DROP TABLE` in a drizzle-kit
  table rebuild (`__new_<table>`) cascades: in local workerd both child rows of a rebuilt parent were deleted, also
  with `PRAGMA defer_foreign_keys = ON`. None of migrations 0000 to 0018 rebuilds a table. Until the Cloudflare side
  handles it, a migration must not rebuild a table other tables reference with `ON DELETE CASCADE`.
  `server/test/migration-replay.test.ts` (2026-11-21) replays every migration that way, with foreign keys on over rows
  in every table, each file on its own and a store's pending files in one transaction, and fails on any row lost: 0000
  to 0018 lose none. Its control, a drizzle-kit rebuild of `threads`, deletes every message, attachment, held copy,
  search document (with its index row) and search person there, and nothing through libSQL's `migrate`.
- **Cloudflare gotchas found building step 2** (2026-11-21, [server-cloudflare.md](server-cloudflare.md); local
  workerd only). (a) A Worker's main module may export only handlers and classes: an exported constant made workerd
  refuse the script ("Incorrect type for map entry"), which neither `wrangler deploy --dry-run` nor `wrangler check
  startup` noticed; the workerd tests load the built script, so they do. (b) Setting the alarm while it is being
  delivered cancels its handler ("SQLite alarm handler canceled with requestScheduledAlarm"): the restarted object's
  start set it before `alarm()` ran. The host reads the alarm before the server sets any timer and never overwrites a
  set one. (c) `@cloudflare/workers-types` alone fails on shared code that runs fine (dashboard's `TextEncoder().encode`
  as `Uint8Array<ArrayBuffer>`, mail's `globalThis.crypto`), so `tsconfig.cloudflare.json` adds Node's types and the
  `webworker` lib and can't prove every web API exists in workerd. (d) Miniflare 5 (wrangler's own beta line) takes a new
  options shape: the tests use `convertV4MiniflareOptions`, which refuses `modulesRules`; a module outside the working
  folder needs `modulesRoot`, else workerd fails with a bare "internal error"; its proxy from Node straight to an object
  refuses an `Origin` header. (e) Drizzle's durable-sqlite `run()` returns nothing where libSQL gives `rowsAffected`; no
  shared code reads it today. (f) The root's install puts production dependencies only into a part folder that has no
  `node_modules` (a fresh clone): work in that part needs its own `npm install`; the root carries `@types/sanitize-html`
  so the Cloudflare type check passes there. (g) The 50-byte LIKE limit (fixed in shared code, below) is real in local
  workerd: 50 bytes pass, 51 fail with "LIKE or GLOB pattern too complex".
- **Cloudflare gotchas found finishing steps 4 and 5, and fixing their review** (2026-11-21,
  [server-cloudflare-limits.md](server-cloudflare-limits.md); local workerd only). (a) Local workerd's row limit is a
  few bytes over 8 MiB (8,388,636 bytes of one text value pass, one more fails with `SQLITE_TOOBIG`) and counts the
  whole row (two 4.5 MB values fail); Cloudflare's page says 8 MB. A test must not sit on the boundary. (b) Through
  Miniflare's outbound service a fetch with `redirect: "follow"` wasn't followed either (the redirect test still saw
  the fetcher's own second hop), so no local test can show that `redirect: "manual"` matters; the tests show each hop
  checked, and the platform's behaviour is unverified. (c) The sync batch counts label changes as well as new messages
  (mail's provider counts `limit` that way): with 25 on Cloudflare, 150 label changes take 6 rounds, each re-reading a
  history page of up to 500 records; correct, slower, and it starved the two-inbox gate test of its premise (fixed in
  the test). Changing it is a contract change (improvement-ideas.md). (d) The picture cache's byte cap and record count
  are the whole server's, as on Node, so a test of them sweeps every other test's rows (it runs last, on a later
  clock); each new `SqlPictureSource` sweeps at its first write. (e) Local workerd's fetch decodes a gzip or br answer
  itself and keeps its `Content-Encoding` header, so the fetcher can't tell from the header whether the body is
  decoded: it takes only those two and counts what it reads (decoded). Whether Cloudflare's own fetch does the same is
  unverified. (f) When workerd answers before reading a request's body (the front Worker's 411) and closes the
  connection, a client still writing that body gets EPIPE instead of the answer: tests send a few bytes, then hold.
  (g) Hono routes REST by the path decoded with `decodeURI` (`/v1/%70air` is `/v1/pair`), the dashboard by the path
  as written; anything that decides by path before the server (the door's pairing count, the Worker's token check)
  uses `routedPath` in `server/src/cloudflare/requests.ts`. (h) A Worker's main module may still export only handlers
  and classes (step 2's gotcha (a)): the Worker's table of tokenless routes stays unexported. (i) U+0000 (2026-11-22):
  SQLite's `length()` counts a text's characters only up to it (0 for one that starts with it), on both SQLites; a
  Durable Object's SQLite reads such a text back whole, libSQL only up to the U+0000. Count bytes
  (`length(CAST(x AS BLOB))`) to size anything, and keep U+0000 out of stored text (below, "Mail stored before …").
- **The Gmail sync cursor keeps every id still to fetch in the inbox's row** (found 2026-11-21 by the review of the
  Cloudflare host's steps 4 to 6; open, not fixed). The first sync lists the window's ids and carries those not yet
  sent in the cursor (`mail/src/gmail/sync.ts`, `p`), which the server stores in `inboxes.sync_cursor`. About 330,000
  ids pass a Durable Object row's limit (8,388,636 bytes locally), and from then every batch would fail to store its
  cursor, so the sync would never move. Node has no row limit. Fix later: the ids in a table of the host's own (or the
  provider's own pages of the listing), the cursor only naming where it is.
- **The fit's notes are indexed and sent to the AI** (2026-11-21, the same review; open, accepted for now). A message
  made to fit (`server/src/sync/fit.ts`) ends its `text` with "[This message is too large to keep here in full …]",
  which search indexes like any words and the AI reads as the message's own. Harmless words, but a search for "large"
  finds them and a summary may mention them.
- **Every request wakes the server's object** (2026-11-21, the same review; open). The front Worker refuses tokenless
  REST and bodies without a length, but anything else (the dashboard's pages, `/v1/info`, a pairing attempt) reaches
  the one Durable Object, so anyone who knows the address can spend a plan's requests (a Free plan's daily quota
  quickly; Workers Paid counts them against its millions). No rate limit is possible on workers.dev (improvement-ideas.md).
- **Opening an old conversation and `refreshThread` read one whole thread at a time** (2026-11-21, the same review;
  open). Search's index now reads bodies in bounded rounds, but these two read every message of the thread with its
  text and HTML at once; a very long thread of large mail could pass a Cloudflare isolate's memory there.
- **A reset during search's first catch-up counts as a failed start, whatever reset it** (2026-11-22, the re-check of
  the review's fixes; open, accepted). Since the fix that keeps the start's record until that catch-up has finished
  (`server/src/cloudflare/start.ts`), a deploy or an ordinary eviction in that window counts too, not only one the
  catch-up caused. Two such resets in a row, before a catch-up finishes, make the next start wait the backstop: a
  minute of 503s, doubling with each further one up to an hour. A long catch-up (a first start over a big store, or an
  index format change) is the window; with an inbox the alarm brings the server back when the wait is over.
- **Search's chunks are sized by shown messages, but heads are read for hidden ones too** (2026-11-22, the same
  re-check; open, bounded). A chunk ends before its threads' `message_count` passes 2,000, and that count is the
  thread's shown messages only (`server/src/sync/rows.ts`); the index reads the heads (no bodies) of every message in
  those threads, a blocked sender's in someone else's thread included. Bounded by the chunk's thread count (20 on
  Cloudflare, 100 on Node); bodies are read for shown messages only.
- **A kept picture's stream could in theory mix two copies** (2026-11-22, the same re-check; open, not seen). A kept
  picture is served one stored part per pull (`server/src/cloudflare/web/pictures.ts`, `#parts`), reading parts by
  number. If a slow client is between two pulls while the picture is swept and fetched again (a new copy written under
  the same keys), the stream could join parts of the old and the new copy, or end with an error when a part is gone.
  The new copy is the same address's, so normally the same bytes; a site that changed the picture meanwhile would give
  a broken image for that one view.
- **Mail stored before 2026-11-22 may still hold U+0000** (open). Since that day mail's parser takes U+0000 out of a
  message's text, HTML and subject (`mail/src/message/parse.ts`) and the server out of a draft's subject and body
  (`server/src/service/drafts.ts`), because libSQL reads a stored text back only up to its first U+0000: on Node
  whatever followed it was lost when read (the stored bytes may still hold it). Messages and drafts stored before that
  keep theirs; on Node they read back cut, on Cloudflare (whose SQLite reads them whole) they carry the character.
  An ordinary sync sends a known message's label changes only, so it rewrites none. A message the provider sends whole
  again (Gmail's recent mail after it lost the sync's place, `relistAfterLosingPlace` in `mail/src/gmail/sync.ts`) is
  rewritten by `ingest`'s same-ref branch, its subject, text and HTML as now parsed, without the U+0000, once: before
  this fix, a cut text never matched the copy again, so each such resend rewrote it. Nothing else changes for that
  message (no new mail, no screening). A draft loses its U+0000 only when it is saved again.
- **A few stored texts still keep U+0000** (2026-11-22, the final review; open, low). The parser strips it from a
  message's subject, text and HTML only; `messages.message_id`, `in_reply_to` and `list_unsubscribe`, an IMAP thread's
  `thread_key` (made from Message-ID and References) and text people or agents type (rules, an inbox's name and
  guide, an action's reason, a device's name) keep it, so libSQL reads them back cut. Lookups still match (a bound
  value is compared whole: probed), so no message is taken for another; what reads back cut is, for example, a reply's
  In-Reply-To to a sender who put U+0000 in their own Message-ID, or that sender's unsubscribe link. Covered already:
  attachment names (`cleanFilename` drops C0 controls), addresses and References (JSON columns escape it), snippets and
  search text (control characters cleaned), the AI's summaries (dropped as `control`).
- **A sync asked for during a sync whose rounds run out still goes before the held write-backs** (2026-11-22, the
  final review; open, low). `server/src/sync/engine.ts` queues the next sync after the held and repair write-backs,
  but the inbox's queue is first in, first out (`WorkQueues`): a sync requested while the long one runs (an IMAP
  watch, "sync now", a sent draft, the poll timer left by an earlier sync) is already queued ahead of them, and
  `requestSync` then adds nothing. The write-backs wait one more sync (up to `syncRounds` batches). Seen with a probe
  in a scratch copy (`sync-rounds`' order test with `syncInbox` called during the first sync). Running them inline
  in the same queue slot fixed the probe but changed `provider-inbox`'s "a later note replaces an earlier one"
  (a record's version 3, not 4), so it needs care. Reachable only past 10,000 batches (2 million messages on Node,
  250,000 on Cloudflare).
- **Cloudflare gotchas found building step 6** (2026-11-21, [server-cloudflare-access.md](server-cloudflare-access.md)).
  (a) `wrangler deploy` removes variables set in the Cloudflare dashboard unless `keep_vars` is true (docs), and each
  push to a person's copy deploys: `wrangler.jsonc` sets it. (b) Miniflare gives every dispatched request a `cf`
  object (a cached `cf.json`, else a fallback whose `timezone` is America/Chicago) unless the test passes its own, so a
  test that pairs without `cf` gives the server that zone. (c) An unpaired object has no alarm, so its owner's code
  can expire while it is evicted and stay in the table until a request starts it; the start now removes it and the
  host refuses it in words, uncounted (fixed; while evicted it still sits there, with its expiry beside it). (d) An `AsyncLocalStorage` context set for a request flows into timers that request starts; the address kept
  there is only ever an allowed origin, so a background job that read it would still get one of the server's own.
  (e) Miniflare marks `ctx.abort`'s error neither `retryable` nor `overloaded`, so the front Worker's 503 answers were
  never seen locally. (f) Workers Builds doesn't run a Wrangler file's custom `build.command` (docs: it doesn't honour
  custom builds); the root `package.json`'s `build` and `postinstall` run the same preparation, so a Deploy-button copy
  still gets it (unverified until a real deploy).
- **Gmail's full form is read on assumptions nobody checked against Gmail** (2026-11-21, the large-message path,
  [mail-gmail-large.md](mail-gmail-large.md); open). Only a host with `largeMessageBytes` set (the Cloudflare host)
  reads messages over it in the full form and rebuilds them for the raw form's parser. Assumed from Google's reference,
  which doesn't say: header values as written and in the message's order (`fromCheck` reads the topmost
  Authentication-Results); `body.data` the part's bytes after the transfer encoding, in its own charset; `body.size`
  their count (a different count is now only logged, but it is still what a marked attachment's stored size and each
  message's download budget use); `attachments.get`'s `data` base64url, perhaps with JSON escapes (read); an expanded message/rfc822 part has the
  forwarded message as its one child, and the fake's choice that it also carries an `attachmentId` is unverified; the
  minimal form's `sizeEstimate` is optional (handled: no size takes the full form). Decoded encoded words would matter
  less than feared: postal-mime reads `Müller, Ann <…>` as it reads the encoded form. What would confirm them: one real
  message over the limit read in both forms. Also open: a message whose own HTML is huge and that Gmail sends inline in
  the full form is held whole while it is converted (its stored row is made to fit since step 4); and a host that changes `largeMessageBytes` with mail stored could make an attachment's
  position be read by the other form (nothing compares the stored metadata, which `fetchAttachment` isn't given).
- **Temporary files with a predictable name** (found 2026-11-21, not changed): `server/src/node/owner-code.ts`,
  `server/src/node/settings.ts`, `cli/src/config.ts` and `cli/src/server-settings.ts` write `<file>.<pid>.tmp` with
  `writeFile` (which follows a link or reuses a file already there) and leave it behind if the write or rename fails.
  The data directory and the command's settings folder are made owner-only (0700), so normally only the owner's own
  processes could plant one. The Google client file's save (`saveGoogleClientFile`) and `google set`'s `writeOwnerOnly` now create theirs
  exclusively under a random name and remove it on failure; the others could do the same.

- **Asking search in a sentence is unproven against a real model** (2026-11-20): every test, demo mode and the
  development switch use fake models; no real model has read a sentence. Unknown: how well the summarize job's model
  fills the ten fields (kinds from loose words, periods worked out from today's date, other languages than English),
  whether each service's structured output takes the schema (arrays of strings that may be null) as the SDK's types
  say, and what one request costs (roughly 600 to 700 input tokens by the request's size). The server's checks bound what a
  wrong answer can do (nothing invented, the worst case a plain search), not how often an answer is wrong: a wrong
  but possible date or kind is kept, and shows as a chip the person can remove.
- **A sentence's period is the model's arithmetic** (2026-11-20): the server checks that `after` and `before` are real
  days in order and not ahead of today, not that "last month" came out as last month. A rule for the common phrases
  is in improvement-ideas.md.
- **An opened old conversation isn't checked again by a reset listing** (2026-11-20, search; what is left of the two
  fixed below): its messages are outside every listing, so a deletion or a move made at Gmail while the provider had
  lost its place (history expired: the server was stopped or the inbox paused for about a week) isn't noticed until
  Gmail next reports that message. Until then the server shows it as it was; an action on a message Gmail no longer
  has fails its write-back in words, as any refused write does. A fix would ask the provider for those conversations
  again when a listing ends (`fetchThread`, 60 quota units a message). Not built.
- **Gmail's side of search is unproven against Gmail** (2026-11-20): the label form `label:usual-mail-receipts`, `after:`
  and `before:` as Unix seconds in a search, `payload.mimeType` in the metadata form telling attachments, and the quota
  units of `threads.list` and `threads.get` are from Google's documentation as known, tested only against `FakeGmail`.

- **A sender's forged `mx.google.com` result can be on top of mail that didn't come to Gmail by SMTP** (2026-11-19):
  mail Gmail fetched from another account ("Check mail from other accounts") or that was uploaded over IMAP may carry
  no result of Gmail's own on top, so a result the sender wrote is read as Gmail's and its From domain taken as proved.
  The forged address must already be one the person let in. Not guarded, by the coordinator's decision (a guard on
  `Received` lines would be brittle); the backfill's log line counts messages with Gmail's own result on top against
  none, so the owner's first start shows whether the mailbox has such mail at all.
- **Two assumptions about Gmail behind sender pictures** (2026-11-19, unverified; no real message was read): (1) Gmail
  writes its own `Authentication-Results` above every other one, in the raw form; (2) Gmail's metadata form, which the
  backfill reads, lists headers top first, as the message has them. What would confirm them: the backfill's log line
  on the owner's first start (many "another checker's result on top" or "no result at all" would refute either; many
  "more than once" would show forwarded or imported mail), or one real message read in both forms. Mail with Gmail's
  own result more than once proves nothing either way (`repeated`, the review of 2026-11-19).
- **Reading Gmail's header strictly costs some real mail its picture** (2026-11-19, by design): a quote anywhere in a
  comment, a quoted value with `;`, `(` or `)`, or an `smtp.*` property on a DKIM or DMARC result makes the header
  unreadable, so an envelope sender with a quoted local part gets initials. This closes the injection the security
  review found (a quoted local part with `)` ending Gmail's SPF comment); a part Gmail writes unquoted that holds a
  `)` (a HELO name, which SMTP forbids) would leave an envelope property behind and is refused too. **Left open** (the
  reviewer's re-check): an unquoted `)` in a part Gmail writes only inside a comment and never again as a property value
  would still inject; nothing Gmail echoes fits that today.
- **A limited caller's picture check isn't one indexed lookup** (2026-11-19): the route answers a caller limited to
  some inboxes only when proved mail from the picture's domain is in one of them, by reading those inboxes' messages
  through the indexes that start with the inbox (nothing indexes a proved domain by inbox; 0013 is frozen). No device
  that may load pictures is limited today (a person's sees every inbox; agents are refused), so it never runs now; an
  index (a later migration) would be due before such devices exist.
- **Unblocking a sender brings nothing back** (2026-11-20, described for the Settings tab, not changed): `allow_sender`
  only lets the sender in and unscreens their threads; what the block marked done stays done (archived at the
  provider for conversations), and so does mail that arrived during the block. Only undoing the block's own record
  puts back the threads that block changed, and that undo is gone once the sender is allowed or blocked again.
  Proposed: an option on `POST /v1/senders/allow` to mark the sender's threads not done again.
- **The blocked senders' count is what the server holds** (2026-11-20): mail the mailbox put in spam or trash is never
  taken in, and mail deleted at the provider is no longer held, so neither is counted; a message is counted by its
  date, so one dated before the block but delivered after it isn't. `blockedAt` moves to the undo's time when an
  unblock is undone. A sender whose only threads are trashed or gone is unblocked without a record (nothing to undo).
  Deleting blocked mail at the provider lowers the count without a `sender.changed`.
- **`server/src/service/server.ts` is at 512 lines** (2026-11-19, sender pictures added nine): split it by
  responsibility when it is next changed.
**Must be fixed before any IMAP inbox is used with real mail** (the pictures' fourth review, 2026-11-18; the owner's
inbox is Gmail, IMAP comes later; `docs/self-hosting.md` says so). Each with the reviewer's evidence (probes run
against the test server with memory mailboxes) and the proposed fix; none is built:

- **(a) A forged exact copy can take over the real message on a later split or large move.** When a stored copy's
  ref is reported removed, the oldest held copy takes its place (`takeHeldCopy` in `server/src/sync/identity.ts`).
  Evidence: an exact copy, from someone copied on the message, filed as spam is held; another app copies the real
  message to Archive (held too) and expunges it from INBOX later; the stored message then takes the spam copy's ref,
  and the thread is trashed. Fix: on IMAP, identity includes INTERNALDATE (a delivered copy gets its own; a move or
  copy keeps it), and a copy in Junk or Trash never wins over another.
- **(b) Content drift across builds.** The fingerprint is worked out from the stored, sanitized HTML; a message stored
  by an earlier build whose sanitizer wrote it differently no longer matches its own moved copy, so a move by
  another app shows as a separate message. Evidence: a CSS comment the round-2 sanitizer kept and today's drops.
  Fix: store the fingerprint when the message is stored, or fingerprint the raw message.
- **(c) Matching on a shared Message-ID is quadratic.** Every candidate's fingerprint is worked out again from its
  row and attachments: 2.4 s for 200 copies, 73 s for 1,400. Fix: an indexed fingerprint column.
- **(d) Legitimate duplicates show twice:** a mailing list's copy with its footer and the direct copy have the same
  Message-ID and different content, so both show (before the third review they merged).
- **(e) Untested parts:** no test notices removing any one of the five fingerprint parts (From, To/Cc, date, HTML,
  attachments), which held copy wins (oldest or newest), or `OwnMoves.in()` ignoring UIDVALIDITY.
- **(f) Held copies grow by one per exact copy delivered** (500 copies, 500 rows); they go only when each copy's own
  ref goes. Fix with (a): a bound per message, or keeping only copies that could be a move.
- **Thread injection through References** (the reviewer's view): anyone who knows one of a thread's Message-IDs can
  write into it and be let in while it isn't screened (below). Minor for Gmail, in the reviewer's view; the idea is
  to let in by a thread only people the person addressed in it.

- **Mail the server stored before 2026-11-18 keeps its old "outgoing"** (open by nature). Until then a From naming
  the inbox counted as the inbox's own mail. What is stored per message can't tell a forgery from a copy the person
  sent to themselves: Gmail's labels aren't kept (only the placement read from them, which has no SENT), and an IMAP
  message seen in two folders is one row whose ref is the folder last reported. So stored values aren't re-derived;
  a forged message stored earlier stays shown as "You" in its thread. New mail follows the evidence rule. The one-off
  that could be done safely was: migration 0009 forgets each inbox's own address where it was let in (at most one row
  per inbox), so new forgeries are screened. Nothing records who let it in, so **an `allow_sender` a person gave
  their own address went too**; giving it again lets it in again, forgeries of it with it. A block of it stayed.
- **An IMAP inbox whose Sent folder the server can't find has no own mail from other apps** (by design of the
  evidence rule, 2026-11-18). The Sent folder is the one marked `\Sent`, or else one whose name ImapFlow knows as a
  Sent folder in many languages ("Sent", "Sent Items", "Gesendet", "Enviados", "Envoyés" and more). Without one: mail
  the person sent from other apps isn't on the server at all; a copy in INBOX (a note to self, a Cc to self) shows
  as from their own address and lands in Screening, its thread's sender their own address; in the first sync's
  history it lands in Home, from their own address; and the people they wrote to from other apps aren't let in, so
  their replies are screened. Mail sent from Usual Mail is unaffected (the server's own record). Proposed, not built:
  a per-inbox setting naming the Sent folder (`usual-mail inbox sent-folder <inbox> <folder>`, kept with the IMAP
  connection and passed to the provider), shown when an IMAP inbox has none. Open.
- **A move whose old ref is never reported removed stays held** (IMAP, by design of the third review's rule,
  2026-11-18). The server takes a copy with a known Message-ID and content as a move only once the old ref goes. The
  IMAP provider reports that for every ref it knows, and for refs its own moves gave until it restarts; a server
  restarted after its own move and before a sync saw the message, which another app moved on meanwhile, never learns
  that ref went. Then the message stays where Usual Mail had it (a write-back to it fails with "Sync again"), and the
  copy where it went stays held, invisible, while it is in the mailbox. Rare. Removing and connecting the inbox again resyncs it
  (and deletes its rules and history on the server). Open.
- **Anyone who knows one of a thread's Message-IDs can write into it** (by design, before 2026-11-18; noted in the
  pictures' third review). An IMAP thread is found from the References and In-Reply-To a sender writes, and someone
  writing into a thread that isn't screened is let in (someone copied on a conversation). Everyone the person wrote
  to learns those Message-IDs, and so does anyone they forward the mail to. Since the third review such mail is
  always a separate message from its real From, never a change to one stored; but its sender is let in and its
  pictures shown. The fourth review rates it minor for Gmail; narrowing it (letting in by a thread only people the
  person addressed in it) is an idea, not decided (improvement-ideas.md).
- **A person's own post that a mailing list sends back with a new Message-ID lands in Screening** (by design,
  2026-11-18). It carries their From but no evidence (it isn't in Sent, its Message-ID isn't one the server sent),
  so it is mail from the inbox's own address, which is never let in by itself. Most lists keep the Message-ID, and
  then the copy joins the sent message. Letting their own address in (`allow_sender`) would stop it, and would let
  forgeries of it through too.
- **What pictures through the server don't hide** (by design, 2026-11-18, after the security review's fixes; the
  contract's [pictures from the web](../contract-pictures.md)). In plain words:
  - A picture whose address is made for one person, isn't on the tracker list and isn't declared tiny still tells
    its sender that the message was opened, and when, the first time it is opened. Most newsletters make even their
    ordinary pictures this way.
  - A picture whose site keeps failing (an error, no answer) is asked for up to three times (when first opened,
    after ten minutes, after a day), so its sender can learn of up to three openings. A picture refused by the rules
    or for what it is is asked for once.
  - What the server keeps is at most 256 MB, about 26 pictures of 10 MB: a sender who fills it can push older
    pictures out, and opening a message whose picture was pushed out fetches it again. The records of refused and
    failed pictures stay outside that cap (at most 50,000, a year unserved), so those aren't asked again.
  - The site sees the server's address. For a server at home that is the person's home address, so it tells roughly
    where they live; for a server rented online it is one fixed address, the same for every sender, which lets
    senders that share a mailing service tell that their mail went to the same person.
  - The server never fetches from its own networks (a global IPv6 address's whole /64; IPv4 and IPv6 prefixes too
    short to be a network count only as the address's /24 or /64), but a router in front of it (a home's) has a
    public IPv4 address the server can't see from inside: a picture at that address goes to the router, which may hand
    it back to a service it forwards ("hairpin"). Forwarding no ports to the server, or a firewall rule, avoids it.
  - Tracked links aren't touched: clicking a link in a newsletter still tells its sender.
  - A tracking picture hidden by a style block or a class, not by its own attributes, isn't caught unless the list
    knows its address; it is fetched like any picture. Once fetched, a picture of at most 2×2 is only shown blank:
    the request has already gone.
  - The list knows only what it knew at its last update, and its broad patterns can take out an ordinary picture
    (for example any address with nine letters before `?id=`), which then counts as a tracker.
  - Some designed CSS is lost when served: any declaration with a string naming the web ("http:", "https:", "//"),
    any SVG picture (`data:` ones too), more than 100 addresses in one declaration, rules nested deeper than 16, and
    a declaration with an unusual name go. Escapes elsewhere (bullets, icon glyphs, escaped font names) stay.
  - HTML over 1,000,000 characters is shown as its text. The first view of a large mail costs about a tenth of a
    second per megabyte; later views reuse what was written (at most 200 messages and 24,000,000 characters kept,
    the served HTML and the addresses its plan holds counted: twenty of the largest fit, and beyond that the least
    recently served are written again when next viewed).
  - SVG is never shown. CSS `attr()` reading an attribute into `image-set()` or `url()` (the newest CSS) hasn't been
    checked in WebKit: the server doesn't rely on it, since every address it serves is its own path and the page's
    policy loads nothing else, and attributes are read again as a whole either way.
  - Other mail apps reading the same mailbox (Gmail's own, Apple Mail) follow their own rules.
  - A picture that changes after it is fetched (a countdown, a live price) stays as first fetched until the copy
    goes (30 days unserved, or the cap).
  - DNS: the server's DNS servers learn the names of the picture sites. Names are asked of DNS servers only, so a
    name only the hosts file or the local network knows doesn't resolve (on purpose).
  Open by nature; the owner chose this with these limits.
- **The Mac app's Home and pictures followed the server** (fixed 2026-11-18/19): the app's Home filter matches core's
  `HOME_CATEGORIES` again (conversation and unknown since 2026-11-19, when notifications left Home for their tab), and
  it loads pictures through the server's `/v1/messages/<id>/pictures/<id>` paths. An app built before either change
  shows a Home or pictures that disagree with a newer server; update both together.
- **The gateway's cost lookup has never run against the real gateway** (2026-11-18). Built from the gateway
  package's documentation and types only: when a lookup can first answer, its limits, whether a lookup is billed, and
  whether the Decisions API's answers carry a generation id where text calls do are not documented. What to look at
  on a server that runs it (no secret involved): `ai_usage` rows getting `cost_reported` above 0 for `summarize`
  (`sqlite3 "file:<db>?mode=ro" "select job, sum(requests), sum(cost_reported), sum(cost_usd) from ai_usage group by
  job"`), `ai_cost_lookups` emptying within minutes, and the log's `AI cost lookup given up after 5 tries` lines
  (`usual-mail logs`), which mean the gateway didn't answer for those ids. Open until seen.
- **The Mac app expected the AI history setting and the per-inbox AI switch** (2026-11-17/18): fixed in the app on
  2026-11-18. It no longer decodes `historyDays`, `maxHistoryDays`, `beyondHistory` or `aiProcessing`, reads and saves
  the first sync's window (`/v1/first-sync`) and shows AI usage (`/v1/ai/usage`). A Mac app built before that
  evening fails to decode a newer server's AI settings, status and their events, so update the app with the server.
- **The `ai_processing` column stays in the store, unused** (by design, 2026-11-17): dropping it would need a
  migration for nothing. New inboxes write `false`; nothing reads it.

- **Sign in with Google has run against Google once** (2026-11-17): the owner signed in on their own server and it
  worked (the coordinator's report; not seen in this project's own checks, which still use a fake of Google's
  endpoints). By that report Google took PKCE with the web client's secret, the scope and the redirect address.
  Still unverified: the seven-day expiry's error (assumed `invalid_grant`, as the documentation says) and Google's
  other error codes. The run's four findings are fixed below. Open for the expiry.
- **A Gmail first sync begun by a build from before 2026-11-17's fix isn't narrowed by a smaller window** (mail, by
  design). Narrowing needs to know that the ids still to send are the first sync's own listing; cursors written since
  the fix say so (`f`), older ones don't, and an older cursor's carried history batch (new mail, which must be taken
  whatever its date) looks the same. So such a first sync finishes with the window it began with. What a person can
  do: let it finish (the extra mail does no harm), or remove the inbox and connect it again, which starts a new first
  sync with the new window and deletes its rules and history on the server. IMAP's cursors always said which backlog
  is the first sync's, so an IMAP first sync from before the fix is narrowed. Open.
- **A first sync's count can go back after a restart in the middle of a batch** (server, by design, 2026-11-23). A
  count heard while a batch runs (`SyncOptions.onProgress`, Gmail after each message) is shown before that batch is
  stored; after a restart, or a Durable Object's eviction, the provider counts on from its stored cursor, so the inbox
  may show, say, 26 after 37, at most one batch back (`server/test/cloudflare/first-sync.test.ts` checks it never goes
  below the stored cursor's count). Showing only stored counts would leave a Gmail first sync on Node at "connecting"
  for its first two and a half minutes. Open, accepted.
- **A paused inbox's sync still fetches the batch in hand** (server, by design, 2026-11-23). The PATCH that pauses an
  inbox (or gives it new credentials) and the removal answer at once; the sync engine closes the inbox in the
  background (`SyncEngine.#closeInBackground`, Fixed below), and a running sync stops once its batch in hand is
  stored (dropped for a removed inbox); one still opening its provider starts no batch. That batch isn't cut short: on Node up to 200 messages, which a Gmail first
  sync takes about two and a half minutes to fetch (about 1.3 a second); on Cloudflare 25, about 20 seconds.
  Meanwhile the old provider stays open, its fetches go on, and `whenIdle`/`stop` wait for it. Cutting it short would
  need a way to abort a provider's `sync` (a contract change; improvement-ideas.md). Open, accepted.
- **A first sync begun by a build from before 2026-11-23 shows its count from where the new build took over** (mail, by
  design). Its cursor has no count (`n` for Gmail, `fs` for IMAP), so the count starts at 0 of what was still to
  fetch. Open, accepted: it ends with the first sync.
- **`npm run check` in `server/` rebuilds the bundle a server started from the checkout runs** (2026-11-23). In Node
  mode `usual-mail start` runs `server/dist/server.mjs` from the checkout, and `npm run check` ends with `npm run
  build`, which writes that file: the running process keeps its code in memory, but its next restart would load
  whatever was built, uncommitted changes and new migrations included. While such a server is in real use, check
  with the type checks, `npm test` and a scratch bundle built elsewhere, smoke-tested with `USUAL_MAIL_BUNDLE=<file>
  node scripts/smoke-bundle.mjs` (the bundle needs `node_modules` and `migrations/` one folder up, so build it inside
  `server/` and move it away afterwards). Open, a working rule.
- **Changing the first sync's days restarts the server** (by design, 2026-11-17). The server reads the number at its
  start, and `usual-mail sync-days` restarts a server `init` set up so a smaller window applies at once. A restart ends
  Google sign-ins still waiting and the write-backs held for a paused inbox (both kept in memory; see below).
- **The Mac app's pairing step says the server prints a pairing code when it starts** (apps, seen 2026-11-17 in
  `PairingView.swift`; another session's). Since the owner's-code fix the server prints a code once, when it makes
  it, and a restart only says one waits. The same sentence names the file, which is right. Open for the apps session.
- **With a loopback redirect, Google sign-in works only from a browser on the server's own machine** (by design of
  the first run, 2026-11-17). Google sends the browser to `http://127.0.0.1:<port>/v1/google/callback`, which only
  that machine reaches. Signing in from another device needs `USUAL_MAIL_PUBLIC_URL` and an HTTPS address registered
  at Google (not tried).
- **A sign-in isn't bound to the browser that started it** (2026-11-17, contract question 66). The `state` is in
  Google's address; whoever holds that address in its ten minutes could finish the sign-in with their own account.
  On a loopback redirect only a browser on the server's machine can; a hosted server needs the binding first.
- **Sign-ins waiting when the server restarts are lost** (by design: they live in memory so the PKCE verifier never
  reaches the disk). The person's page then says the sign-in isn't one the server waits for; they start again.
- **A sign-in that fails after Google issued tokens leaves that grant at Google** (by design, 2026-11-17): another
  account on a reconnect, a scope left out. The server drops the tokens without revoking them, since revoking ends
  the account's whole grant and could end a working inbox of that account. The person can remove it in their Google
  Account. Seen in the live run: Bo's refused sign-in left a second refresh token, which removing Bo's inbox later
  revoked with the rest.
- **Each Google sign-in of an account leaves its earlier refresh tokens live** (Google keeps up to 100 per account and
  client, then retires the oldest). Reconnecting can't revoke the old one without ending the new one.
- **`server/test/inboxes-pairing.test.ts`'s owner-code test is timing-sensitive** (seen 2026-11-17, before and apart
  from the Google work). It waits 10 ms of real time for a timer's callback after advancing the manual clock; under the
  full suite's load it once saw 1 code instead of 2. Passed alone three times and in the next full run. Open.

- **A blocked sender's mail in someone else's thread reappears only when that thread next changes** (server, by
  design of this pass, 2026-11-17). What a person sees of a thread is worked out from the sender's standing when the
  thread is refreshed (`shownIn` in `server/src/service/store.ts`). Letting such a sender in again (`allow_sender`, or
  undoing the block) doesn't refresh the other threads they wrote into, so their messages there show only at that
  thread's next sync change. Nothing is lost: the messages are in the store and at the provider. Open.
- **The coordinator's demo server ran the bundle from before this pass** (2026-11-17). `npm run check` in `server/`
  rebuilds `dist/server.mjs`; a process started earlier keeps the old code in memory until it is restarted. Note, not
  a defect.

- **Each rebuild of the Mac app asked for the login keychain password** (apps, seen 2026-11-17, fixed 2026-11-18):
  ad hoc builds changed signature each time. Fixed by signing Debug with this Mac's development certificate; see
  "The Keychain asked for the login password after every rebuild" below.
- **Launches through `open -n` sometimes showed no window** (apps, seen 2026-11-17, not understood). The process ran,
  idle, with no window until a reopen event; starting the binary directly always showed one. Part of what looked
  like this was a script passing the launch options as one argument in zsh. Not reproduced on purpose since. Open.

- **A migration in `server/migrations` is live at once** (by design of drizzle's migrator, noted 2026-11-18 when
  0010 reached the folder earlier than planned through a scratch folder that was a symlink to it). A running server
  applies every migration the journal lists at its next start, whatever bundle it runs, and an applied one can't be
  changed. Develop a new one in a copy of `server/`, move it in last, and never sync into a folder before checking it
  isn't a link to the real one. 0010 (an empty table) stays and is frozen.
- **The payment state is only as good as the model's reading** (2026-11-19, after the owner added "Will be charged"):
  the title now follows `state`; while it is null, the category decides (an invoice "To be paid", a receipt "Paid"),
  so a null state on an automatically charged invoice still reads "To be paid". A refund on an invoice is still
  dropped (`refund_on_invoice`), so a credit note filed as an invoice reads without its amount.
- **A due date before its message is dropped, an overdue one too** (2026-11-19): a reminder whose due date lies more
  than two days before it loses that date unless day and month read the other way round fit. Payment services are known
  by a label of the sender's domain, so all of apple.com's and google.com's mail counts as theirs: it only means their
  receipts aren't unified by name.
- **A notification's relative date is one of two days** (2026-11-19): "today" in a message is checked against the two
  dates its UTC time has from UTC−12 to UTC+14, so a model that says tomorrow for "today" can pass. "Next week", a
  past weekday ("on Monday" for last Monday), short weekday names, "in two weeks" and numbers of days in words ("within
  fourteen days") aren't read; such dates are dropped unless also written. A year-less date is read day first only
  ("05/12" is 5 December), so a US "12/05" for 5 December is dropped; and "24/7" reads as 24 July if a model gave it. An amount like "12.00" counts as a written time 12:00, and since the server dates a time said "today"
  itself, a model that read such an amount as a time beside "today" would get it kept.
- **The day a message was sent is the server's day, not the sender's** (2026-11-19): requests state it in the server's
  own time zone (`Host.timeZone`; UTC in a container that sets no `TZ`), and the date the server gives a time said
  "today" follows that zone, so mail sent late in the evening elsewhere can read as the day before or after. A date
  the model gives is still checked against both possible days. Weekday names never give the server's date.
- **An asking-again's flag rules the next answer** (2026-11-19, `threads.payment_again`, on receipts, invoices and
  notifications alike): if mail joins a marked thread before it is asked, that answer is still applied by the
  asking-again's rule (a receipt's only fills; a notification's revises the pair but keeps the summary). The flag
  clears at the first answer. Its column name says payment; it also marks the notifications' asking-again (no
  migration to rename it), and a notification flagged by an older event asking-again is applied by the newest rule.
- **A snippet keeps quoted replies and signatures, and loses links** (2026-11-19, `snippetText`): a reply's quote
  ("On Monday, Dana wrote: …") and a signature stay as the mail writes them; a link standing in the text is taken out,
  so "See https://… for details" reads "See for details". A text part that starts with an HTML tag is read as HTML,
  also for the models (one reading). The start's pass shares the payment rules' marker (`ai/passes.ts`), so a store's
  `payment_rules_applied` now holds `2026-11-19 plain snippets`.
- **Moment groups join by minute and day, one key per thread** (2026-11-19): two different things from one sender
  without references at the same upcoming minute (two parcels in one delivery window with no tracking number read)
  join, up to the 8-thread guard; a time is "upcoming" by comparing the mail's local reading with the server's clock,
  so a reminder sent from far away the same day may read as past and stay apart. A thread has one key: when a later
  mail would bridge two sets, it joins the larger and the sets stay apart.
- **The reset rule reads a reset word up to 30 characters before the time, in one sentence** (English, German and
  French words only), and only for a status about a limit; "Nov." in between ends the sentence early.
- **Groups join only what one sender's mail says the same way** (2026-11-19, notification groups): a shop's and a
  carrier's mails about one parcel stay two rows (different domains, usually different numbers); an appointment moved
  to another day doesn't join its old mail; an appointment joins only when the model words its `about` the same in
  both mails (case and punctuation aside). A model that gives a customer number as the reference joins that sender's
  mails until more than 8 threads share it or they lie 60 days apart; up to then two different parcels from one shop
  could share a row. Without real calls nobody has measured how often models give a reference, or the right one.
- **A group's over-grouping check runs when a thread takes or leaves a key** (2026-11-19): a group cut for too many
  threads comes back only when another thread next takes that key and the count is low again; a thread leaving
  `notification` doesn't re-check the group it left. The rule counts done and trashed threads too (not removed ones).
- **Mail joining takes a status with its moment** (2026-11-19, the coordinator's decision with groups): a "Delivered"
  with no date leaves no `when` (clients show the mail's own day), so a delivery window no longer stays under it.
- **The status rules are English and literal** (2026-11-19): relative words are taken out of a status in English only
  (the status is asked in English), and only the dispatch words themselves ("Dispatched", "Shipped", "On its way", "In
  transit", maybe after "Order" or "Parcel") become "Arriving"; "Dispatched to the pickup point" stays as it is. The
  dispatch rule compares with the newest message's day, not the day of the message that gave the date. `about` keeps
  the sender's name before up to three capitalised words, so a title-case phrase ("Parcelway: Order Update") stays
  whole too.
- **A time marked UTC is converted on the event's date** (2026-11-19): when the date came from a relative word, the
  date is the server's day, not necessarily the UTC one, so a late-evening time can land a day off. Other zone names
  ("CET", "PST") are kept as written, and a UTC offset other than zero drops the time.
- **No test can say how well a model sorts or reads a receipt** (2026-11-19): fake models only; audits on real mail
  measure it. The details' checks drop rather than guess, and `currencies.ts` is the server's copy of ISO 4217.
- **Any asking-again can make a right label wrong** (2026-11-19). The model answers identical templates differently,
  so re-asking a thread it got right can flip it: 5 of the first round's 29 changes did. Ask again only where the
  words changed for that kind, and audit after; each change can be undone in Handled (show silent).
- **The command's bundle carries an unused copy of core's AI words** (`cli/dist/usual-mail.mjs`, 2026-11-19): core
  declares no `sideEffects`, so esbuild keeps `AI_SENT_WORDS`, which the command never shows (it shows the server's).
  It still holds the words from before links were cut and before messages carried their day sent. Rebuilding the
  command updates them.
- **Write-backs held while an inbox is paused are kept in memory** (server, by design of the fourth revision). If
  the server restarts while an inbox is paused, they are gone; when the inbox is resumed the repair pass sends the
  differences instead, but a refusal then is only logged instead of failing the records.

## Fixed

- **Reading a message could take minutes under the server's lock** (server and mail, found 2026-11-25 by security
  reviews of the screening work and of the first 0.1.3 build; fixed in 0.1.3, `hotfix-0.1.3`). A message is read
  under `ctx.lock`, and one that fails or stalls isn't stored, so it is read again on every sync and after a restart:
  a crafted mail stalled sync and the API for minutes to hours. What 0.1.3 fixes, each with what it cost before:
  - *The server's readers of text and answers* (`server/src/ai/`): taking addresses out of every summary,
    payment-details and event request (128 KB without an "@" took 55 s; now each at sign is read once,
    `ai/addresses.ts`, after the text and subject are cut without splitting an address); the snippet's markdown link
    (`[](mailto:` over 1 MB, 68 s); the tag strips of `readableHtml`, `plainText` and the snippet (80,000 "<", 2.4 s)
    and the style or script block strip; punctuation after a link (a link and 40,000 ")", 0.7 s); the snippet's
    angle links; the checks of a model's answers (an unclosed tag); a party's name (a run of commas); the status
    line's trim; a List-Id; the tracker list on a long picture address; the one-time code check (each code against
    every word); and a model's amount answer with separators between its digits (`parseAmount`; bounded in practice
    by the 4,000 tokens a model may answer). A subject sent to any AI job is at most 1,000 characters (core's
    `SUBJECT_LIMIT`, in the words shown before saving a key).
  - *Mail's readers of headers* (`mail/src/`): `stripBrackets` for Message-ID, In-Reply-To, References and each
    attachment's Content-ID, on Gmail and IMAP (256 KB of ">" in a Message-ID took 25.6 s in `parseMessage`); the
    large-message rebuild reading a forwarded message's Content-Transfer-Encoding (`withoutComments`, a run of "(").
  - *Mail HTML in htmlparser2 12.0.0*, which puts each open element at the front of an array (`Parser.js:299`) and
    searches it at each closing tag (`:346`), inside the sanitizer and `htmlToText` at `parseMessage`, `remotePictures`
    and `presentPictures` (each time a message is opened): 1 MB of `<b>` took 42.6 s, about an hour at 10 MB. Now
    `boundedHtml` (`mail/src/message/html-depth.ts`) cuts the HTML to 2,000,000 characters and drops opening tags past
    256 open elements before any parser reads it ([mail.md](mail.md), "Safe HTML"); 1 MB of `<b>` takes about 50 ms.
  - *The picture pass*: `pixels`, reading an `<img>`'s width or height, took time cubic in a run of spaces (2,000 took
    1.3 s); removing a tracker copied everything written so far once per picture (sanitize-html's `exclusiveFilter`,
    1.3 s at most for 2 MB of tracking pixels, 0.3 s at the 1,000,000 characters the pass reads).

  How it was found: a pumping test of every regular expression literal in `mail/src`, `core/src` and `server/src`
  (399 patterns, each on a prefix, a run of 2,000 and of 8,000 of one character or pair, and a suffix, flagged when
  the time grows faster than the length), and each reader of mail HTML on crafted shapes at 1 MB, 2 MB and 6 MB.
  What changed in output: nothing for HTML within the bounds (the 12,407 comparisons in [mail.md](mail.md)); deeper
  HTML loses the tags past 256 open elements, not their content; HTML past 2,000,000 characters is cut there; in what
  a model reads and in snippets a tag starts where HTML starts one and runs to its nearest ">", comments end where
  htmlparser2 ends them ("<!-->", "<!--->", "-->", "--!>"), so a lone "<" in text no longer swallows the text up to
  the next tag and a "<" inside an attribute leaves no piece of one ([server-ai.md](server-ai.md), "In linear time");
  the screening gate's `plainText` reads tags as before. Stored snippets aren't made again: on stored HTML, which is
  sanitized, they read as before; only a message with no HTML part whose text part is HTML source keeps 0.1.2's until
  its thread changes. Tests: the server's `ai-linear` (27 bodies of 1 MB through the requests and snippets, a model's
  answers, names, List-Ids and pictures, and the code check) and mail's `linear.test.ts` (17 HTML shapes at the cap,
  5 of them at 1 MB too, each reader timed apart; message ids of 1 MB of ">"; the rebuild), each in a worker stopped
  at its limit; `html-depth.test.ts`; each fix's test failing with that fix undone, but the tracker removal's (its old
  cost stays under the tests' 3 s). Still open: the patterns below in "Linear only where they run", and the address
  leaks in [server-ai.md](server-ai.md) (a quoted local part, an address literal, the part before a second @).
  Since 0.1.4 the screening gate's own patterns are linear too: its card and reference patterns ("card " and 80,000
  "*" took 7.6 s; "order " and 80,000 "-", 2.6 s) are bounded, the gate reads only what the model read (the subject's
  first 1,000 characters and 4,000 of the model's text), and `plainText`, which 0.1.3's gate read, is gone. Tests in
  `screening-gate` and `ai-linear`'s gate work; the sweep's list is in [server-screening.md](server-screening.md).
- **The owner password's re-review follow-ups** (server, 2026-11-24, `owner-claim-fix`; each with a test that fails on
  the code before). (1) A hundred wrong passwords or codes from everyone locked signing in for everyone: ten IPv4
  addresses or ten /64s (even in one /48) were enough; now a /48 counts at thirty and the ceiling is a thousand (Open,
  above). (2) The stricter one-line check refused whole batches: one decision's reason with a line break made a
  200-thread `decide` invalid, and a teach prompt stored with a control character in a sender's name couldn't be
  accepted; prose (reasons, highlights, a rule's text) is now made one line instead, while names and a rule's match
  fields still refuse them. (3) `USUAL_MAIL_TRUSTED_PROXIES` took `0.0.0.0/0` and `::/0`, believing anyone's
  `X-Forwarded-For`; any /0 now stops the Node server at start. (4) Behind a proxy that adds Cloudflare's hop the
  server counted Cloudflare's edge; `cloudflare` in the setting walks past it.
- **Closing an inbox left three gaps** (server, found by the final review of 2026-11-24, fixed the same day, each with
  a test that failed on the code before). (1) New credentials store `connecting`, but the old provider's batch in hand
  could then fail (the old credentials being why new ones came) and `#sync`'s catch stored `needs_attention` with the
  old row's words, shown until the new provider's whole sync ended, hours for a large first sync. A sync that fails
  while its inbox is being closed (paused, new credentials, the server stopping) now stores no status and logs one
  info line; the next sync once the inbox is open again says how it goes (`first-sync-reconnect.test.ts`, third
  test). (2) A write-back refused because its inbox was removed meanwhile (Gmail's sign-in is revoked at once) was
  logged as an error; a removed inbox's refusal is now nothing to tell (`sync.test.ts`, "inbox lifecycle"). (3) A
  close that began while a sync was still opening its provider didn't stop it: the first batch was fetched for a
  paused inbox. `#closing` is now checked at the top of each round (`first-sync-pause.test.ts`, fifth test).
- **The image shipped libSQL's clients for remote databases** (found by the coordinator on 2026-11-24, fixed the same
  day). `@libsql/client` was external, so the image installed it with every dependency it declares, whichever entry
  the code imports: `@libsql/hrana-client`, `@libsql/isomorphic-ws`, `ws`, `@types/ws`, `@types/node`,
  `undici-types`, `js-base64` and `promise-limit` (ISC, no licence file anywhere), beside `libsql`; and the server
  loaded the main entry (through `drizzle-orm/libsql` too), which loads the HTTP and WebSocket clients. The server only
  opens `file:` and `:memory:`: `src/node/db.ts` now imports `@libsql/client/sqlite3` and `drizzle-orm/libsql/sqlite3`
  (the same `expandConfig` and local client the main entry uses for those), the bundle takes in `@libsql/client`,
  `@libsql/core` and `js-base64` (esbuild's metafile, 58 packages), and only `libsql` stays outside. The arm64 image's
  `node_modules` went from 15 packages to 5 (`libsql`, its two platform packages, `detect-libc`, `@neon-rs/load`), and
  its licence file needs 6 stand-ins, not 8. The tests still import the main entry (development only).
- **`THIRD_PARTY_LICENSES.txt` named two of the project's own source files** (found by the final review of 2026-11-24,
  fixed the same day). `server/scripts/licenses.mjs` matched every bundled file of the repository to a `<name>.LICENSE`
  beside it, so `suffixes.ts` and `trackers.ts`, Usual Mail's own code, were listed with `suffixes.json` under MPL-2.0
  and with `trackers.json` under BSD-3-Clause. The repository's own code (`.ts`, `.js`, `.mjs` and the like) is now
  skipped; only the two data files are listed. Two builds into scratch folders gave byte-identical files.

- **Clients gave up while a pause waited for the batch in hand** (server, found by the re-review of 2026-11-23, fixed
  the same day). After the fix below, `updateInbox` and `removeInbox` still awaited the sync engine's close, which
  waits for the running batch: up to about two and a half minutes for a Gmail first sync on Node, while the command
  allows 30 s (`cli/src/client.ts`), the Mac app's `URLSession.shared` 60 s and `inbox reconnect` 120 s. So
  `usual-mail inbox pause` said the server was unreachable and the Mac app showed an error although the pause had
  been stored and announced. Now `Hooks.inboxClosed` is synchronous: the engine closes in the background, tracked (so
  `whenIdle` and `stop` wait), the closes of one inbox in the order asked (a quick pause and resume can't open it
  while the pause's close still drops its provider), and with `reopen` opens it again afterwards unless it is paused
  or gone. A removal deletes the inbox's rows before answering (gone from lists and events at once, its address free
  to connect again as a new inbox, nothing half-removed after a restart or an eviction) and the close follows; the
  batch in hand then finds no inbox and stores nothing, and a sync that fails because the inbox is gone (its Google
  sign-in is still revoked at once) logs nothing. `first-sync-pause.test.ts` (4), `first-sync-reconnect.test.ts` (2)
  and the workerd pause test (the PATCH took 9.2 s with Gmail slowed before the fix; answers within a second now),
  each seen failing first. On Cloudflare nothing extra keeps the object up: the close waits on the batch's fetches,
  which (like the server's timers and its alarm) keep a Durable Object from eviction, and every change is stored
  before the answer, so an eviction mid-close loses nothing.
- **Pausing didn't stop a running first sync** (server, found by the review of 2026-11-23, fixed the same day). The
  round loop in `src/sync/engine.ts` never read `paused`, and `#close` waits for the inbox's queue, so a pause (or a
  removal) waited for every round of the sync: with 20 messages in batches of 2 and a pause during the second call,
  all ten calls ran, the PATCH answered only at the end and more counts went out while the inbox said `paused`; a
  10,000-message Gmail first sync on Node would have held the PATCH about two hours. Now the loop stops after the
  batch in hand when the row it ingests is paused or the inbox is closing, without marking the first sync done, and
  a count is never shown while paused (`first-sync-pause.test.ts`, the second test of
  `server/test/cloudflare/first-sync.test.ts`; both failed before).
- **A first sync's count made the server work out every count again** (server, the same review, fixed). Its
  `inbox.changed` went through `Ctx.emit`, which touches the change notifier, so every count shown (every two seconds
  per syncing inbox) cost a scan of all threads, the AI's status and the triage queues under the lock; on Cloudflare
  that is rows read billed to the plan (server-cloudflare-limits.md, "What a count costs"). It now goes out with
  `countsUnchanged` (`first-sync-counts.test.ts`).
- **The apps' combined count vanished while any inbox was connecting without one** (apps, the same review, fixed).
  `FirstSyncProgress.sum` gave nil unless every fetching inbox had a count, and an inbox just connected, resumed or
  signed in again is fetching without one, so "Fetching mail from 2 inboxes · …" lost its count. It now adds up the
  inboxes that have one, "…" only when none has (`FirstSyncProgressTests`, `ActivityNoteTests`; failed first).
- **Docker on this Mac didn't answer** (fixed 2026-11-23). From 2026-11-16 `docker version` hung with no output
  (over 18 minutes once) while Docker Desktop 4.36.0's processes ran on macOS 27, so the Docker-backed mail tests
  skipped and the image was never built. Replacing it with Docker Desktop 4.100.1 from Docker's DMG fixed it: the
  daemon answered at once ([cli.md](cli.md)). `docker version` ignores SIGALRM, so a `perl -e alarm` wrapper doesn't
  bound it; kill it from another process instead. `USUAL_MAIL_SKIP_DOCKER=1` still skips mail's probe.
- **The image stopped at start on a volume owned by root** (fixed 2026-11-23). Run as `node`, the server's first
  write (`/data/usual-mail.db`) failed with `EACCES` and the container exited 1, as it would on Railway's volumes.
  The entry point now starts as root, gives the folder to `node` and drops to it
  ([decisions-deploy.md](decisions-deploy.md)).
  Testing it: an *empty* named volume doesn't reproduce it, because Docker copies the image's `/data` (owner and
  mode) into a new empty volume; put a file in it first (a real disk has `lost+found`).

- **The review of the Cloudflare host's steps 4 to 6 found nine problems** (2026-11-21; fixed the same day, each with a
  test that fails on the code before: [server-cloudflare-limits.md](server-cloudflare-limits.md)). (1) Search's index
  read every message of a chunk whole, text and HTML, while an entry keeps 20,000 characters a message and 100,000 a
  thread: 20 threads of 70 messages of 81 KB ran a 128 MB heap out of memory, at a start and whenever a long thread
  changed. It now reads heads and attachment names without bodies, then bodies newest first in rounds of
  `HostLimits.searchReadChars`, only as far as each thread's body can still grow; read whole, never cut, so every
  entry is the same (`search-bodies.test.ts`). (2) A first sync was marked done when a sync's 10,000 rounds ran out,
  so the rest of it (past 250,000 messages in batches of 25) was screened as new mail; now it is done only when the
  provider has sent all of it, and the next sync is queued at once (`sync-rounds.test.ts`). (3) The start's failure
  record was cleared when `start()` returned, before search's catch-up, so a catch-up that reset the object never
  backed off; now it is cleared once that catch-up has finished. (4) Bodies were read before the token (above). (5)
  `POST /v1/%70air` reached pairing without the host's per-address count, so one address could trip the service's
  global lock; the door now decides by the path Hono routes. (6) The fetcher didn't refuse the server's own host
  names. (7) It refused gzip and br, which Workers ask for, so real pictures and site pages could fail once deployed;
  now taken, the 10 MB counted decoded (a decompression bomb stops at the limit). (8) A kept picture was assembled
  whole (up to 10 MB) and copied again for each read; now streamed one stored part per pull. (9) Making a message fit
  dropped the first References entry (the thread's root) and ran before the check against what the server itself
  sent, so a large sent message's copy wasn't the inbox's own; now the root and the last 49 are kept and the check
  sees the message as it came.
- **Every REST route but `PUT /v1/google/client` read a body before checking the token** (found 2026-11-21 by the
  review of that route; predated it; fixed 2026-11-21 after the review of the Cloudflare host's steps 4 to 6, on both
  hosts). `server/src/rest/app.ts` applied the general `bodyLimit` (2 MB) to every `/v1/*` path as middleware, ahead
  of routes and tokens; without Content-Length (a chunked body) Hono's `bodyLimit` buffers the body as it arrives, up
  to the limit, so anyone could make the server hold 2 MB per request, even at a path that is no route (40 tokenless
  2 MB POSTs added 182 MB to workerd). Now every route checks its token, then reads its body up to its own limit (16
  KiB for pairing and the Google client, 2 MB else), and a path that is no route reads nothing
  (`server/test/rest-bodies.test.ts`, which fails on the old app). On Cloudflare the front Worker also refuses a body
  without Content-Length (411) and REST without a token (server-cloudflare-access.md).
- **The workerd suite failed 4 of 32 after a usage limit stopped steps 4 and 5 mid-change** (2026-11-21, 15:29; found
  and fixed the same day, in the tests only: [server-cloudflare-limits.md](server-cloudflare-limits.md)). (1) The row
  limit's control inserted 8 MiB + 1 byte, which local workerd takes (its limit is a few bytes over 8 MiB). (2) The
  large-message test asserted its 8.8 MiB HTML was over 9 MiB. (3) The search catch-up test ran on the mail (2) never
  delivered. (4) The two-inbox gate test assumed the first inbox's new mail came first, but its history still held the
  previous test's 150 label changes, read 25 a round under step 4's sync batch, so the second inbox synced alone; it now
  catches the first inbox up first and compares turns, not times. Each fixed test was also seen failing against
  deliberately broken code (the note lists the mutations).
- **A failed start on Cloudflare stayed broken, and unused demo code was said to be in the Worker** (found by step 2's
  review, 2026-11-21; not recorded then). The start is now `server/src/cloudflare/start.ts`: a failure answers 503,
  resets the object a second later and backs off, and the alarm brings a server with an inbox back
  (`start.test.ts`, 3 tests; all three fail with the reset removed). The deployable bundle's source map names none of
  the demo, fake-model, testing, Node-only or test files, and `bundle.test.ts` now fails if one is bundled (seen
  failing with the Worker importing `src/demo/seed.ts`); what the review saw can't be told from the snapshot.
- **`SenderPicturesTests.twoLoadsAtOnceMakeOneRequest` failed some runs and stopped `check.sh`** (apps, seen
  2026-11-20 in three runs of four of `UsualMailKit`'s 464 tests; fixed 2026-11-21, in the test). The day's record
  names one failing line, `pictures.cached(picture) != nil` (line 56), which comes right after the checks that both
  loads returned a picture and that one request was made. **Most likely cause, not proven for that day: the test
  asserted what an `NSCache` holds, which memory pressure on the whole Mac decides**, not the code. The code and the
  test were unchanged since 2026-11-19, that day's Mac was busy (the simulator, builds, several sessions), and the
  unified log no longer reaches back to it. `SenderPictures` keeps stills in an `NSCache` (Foundation's, on libcache).
  In small programs here, with libcache's own `cache_simulate_memory_warning_event`: a critical event emptied every
  cache that existed, and none kept a new entry until the "normal" event (still none 3 s later); a cache made after
  an event was unaffected; a warning dropped nothing a cache held, but a cache still empty at the warning kept no new
  entry either (2 runs of 2; caches holding 1, 10 or 50 kept every new one). **Evidence:** today, with the Mac's
  pressure level normal when read, 0 failures in 50 solo runs and 6 whole-suite runs; the old test with the event
  fired once its cache existed (still empty) failed 20 runs of 20 after a critical event and 20 of 20 after a
  warning, at that line only. **Fix:** `SenderPictures` has an internal `init(directory:stills:loader:)` (the public
  ones unchanged: the app still uses an `NSCache` of 400). The test gives a store that keeps every still
  (`KeptStills`) and starts both loads as main-actor tasks, so both are waiting inside `SenderPictures` before the load
  starts (no 50 ms wait). New tests: one gives a store that keeps nothing (`ForgottenStills`, the cache after a
  critical event): still one request, `cached` nil, the next load from disk; one starts a third load after the request
  went out and before it is answered, and expects one request. `aNewInstanceReadsItBackFromDisk` now also expects the
  still read from disk in memory. Taking the de-duplication out fails the first two (2 requests); forgetting the load
  in flight at the start of `load` instead of its end fails only the third (20 runs of 20; the review's breakage); not
  putting a fetched still in memory fails the first, a still read from disk the read-back test. Results:
  `SenderPicturesTests` passed 120 solo runs in a row; `check.sh` exit 0. Under pressure the app behaves as designed:
  a row shows initials and fades the picture in from disk, with no request. Never assert what an `NSCache` keeps in a
  test; give the code a stand-in.
- **Gmail's large-message path could stop an inbox, serve the wrong attachment and download too much** (found
  2026-11-21 by the review of that path, before any host used it; fixed the same day, `mail/`). (1) Every error on the
  full form's way but the parser's refusals was rethrown, so a deterministic one (an unreadable `attachments.get`
  answer, the rebuild failing) failed the batch, and the server's sync engine retries the same cursor forever: the
  inbox would stop. Now only `failsTheBatch` errors are thrown; the rest leave the part out or make the message the
  usual note. (2) Every attachment was served through the rebuilt full form while Node's were numbered by the raw
  parse, unchecked: a UTF-16 calendar invite's marker was decoded by its charset and the garbled bytes served (1 byte
  instead of 42), and a boundary with an escaped quote (`"in\"ner"`), cut short by the rebuild's own regular
  expression, made image "0" serve the PDF. Now an attachment is served by the form its message was stored from, every
  multipart gets the rebuild's own boundary, a marked invite is declared UTF-8, and a part written empty is never
  served. (3) Each left-out part was checked against the limit alone: eight 1.6 MiB text logs in a 17 MiB mail were all
  downloaded and held. Now one budget of `largeMessageBytes` per message. Also: JSON's Unicode escapes (of `=`, say) in
  `attachments.get` were refused (now read). A download whose length didn't match `body.size` was refused too, which
  the re-review found turned a size counted one byte off into "too large to keep here" for a short text and a failed
  open: now `body.size` only sizes the buffer, a mismatch is logged, and only missing or empty data is refused; a part
  left out for its data says "Gmail didn't give this message's text", never the words for a size. The token refresh's
  unnamed refusals (`GoogleRefreshError`) now fail the batch instead of leaving a part out for good. The reviews'
  probes are tests (`mail/test/gmail/large-faults.test.ts`, `test/unit/payload.test.ts`, `test/unit/download.test.ts`).
- **Gmail's `threads.get` was counted at 20 quota units, Google charges 40** (2026-11-20 to 2026-11-21; fixed in
  `mail/src/gmail/limits.ts` once Google's page was read). Search and opening an old conversation spent their budget
  faster than the provider counted, risking rate limits.
- **A LIKE pattern over 50 bytes would have failed on Cloudflare** (found 2026-11-21 in Cloudflare's limits while
  keeping statements within 100 parameters; fixed the same day, on Node, before any Cloudflare host). A Durable
  Object's SQLite, like D1, refuses a LIKE or GLOB pattern over 50 bytes when it compares a row; Node's has no such
  limit, and a pattern around an ordinary CJK word of 16 characters is over it. Patterns came from input or stored data: search's
  `from:`/`to:` (`server/src/search/local.ts`, `whoWhere`: `%@domain`, `%.domain`, `% words%`), the people a search
  finds (`search/excerpt.ts`, `peopleOf`), a domain's sender pictures (`avatars/settle.ts`, `settleDomain`;
  `avatars/sites.ts`, `pictureShownIn`). Now `contains` and `endsWith` (`server/src/db/match.ts`: `instr` and `substr`
  over `lower`) match exactly as the escaped LIKE did, wildcards literal and ASCII-only case folding, with the same
  plans (decisions.md). `test/parameters.ts` fails any LIKE or GLOB pattern over 50 bytes in every test;
  `test/statement-patterns.test.ts` compares the two forms over ASCII, non-ASCII, wildcard and NULL cases and searches
  with a 60-byte CJK name and a 57-character domain (those failed with the old code). Constant patterns stay LIKE.
- **The guided Google set-up was cut at the default window, and the first-run card met the edge at the smallest**
  (apps, seen 2026-11-21 on the preview copy; fixed the same day, seen fixed on screen the same day). It stopped at a fixed
  380 points with about 390 spare at 1512 × 982, cutting the drop area and hiding its note; the system's scroll bar
  sat a few points from the rows' right edges; `OnboardingView` centred the card with no margin, so at 820 × 560 its
  bottom edge sat on the window's. Now: the set-up's scroll (`Pieces/FittedScroll.swift`, a `Layout` that takes the
  scroll view's own ideal height, which is its content's) is as tall as its content wherever the card has room and
  shrinks only when it hasn't; there is no bar while it fits, and the bar has its own gutter in the card's right
  margin, following the person's scroll bar setting; an edge with more beyond it fades; every first-run step is
  offered the window less 24 points on each side (`OnboardingFrame`); the sheets stop at their window's height less
  48, and the set-up in a sheet or Settings at the window's height less 240. Laid out in an offscreen window
  (`GoogleSetupLayoutTests`; its first numbers, a card 540 high, came from a stand-in face, see the entry on the file
  part above). Seen on screen on the preview
  copy (apps-runs.md): whole with no bar at 1512 × 982 (the card about 605 high there, not 540, with about 172
  points above and below); 24 points below the title bar and above the bottom edge at the smallest window, the bar
  (shown always for the app) in the card's margin beside the content, the cut edge fading.
- **At the smallest window the Google set-up's file part was out of sight, and its note was faint** (apps, seen
  2026-11-21 on the preview copy's fixed build; fixed the same day, seen fixed on screen the same day). At 820 × 592 (the
  window with its title strip) what showed ended with "Give the file to your server" and the drop box's top edge
  fading out; at 1100 × 620 the fade cut through "Choose file…". The note under the drop area was about 2.1:1 against
  the card. Now: when the set-up can't show whole, the file section (heading, the server's note, the drop area with
  "Choose file…", the note on the file, any refusal or question about replacing) stays whole below and only the part
  above it scrolls (`GuideLayout`); where the part above would keep less than 120 points the drop area becomes one
  row; where even that can't fit, the file section scrolls in the room it has (`ClientFileDrop`). Sheets and Settings
  follow the same rule. The note is in the card's secondary colour (black at 50%, about 3.9:1 on the card by the
  test's sums; the window is always light) and reads "It's the JSON file Google downloaded. Its name starts with
  client_secret_." Laid out offscreen in the app's fonts (`GoogleSetupLayoutTests`): at 820 × 592 the part above
  scrolls in 186 points and the file section (129) shows whole below it; at 1100 × 620 the same with 214. The offscreen
  test had read the card at 540 high where the screen showed about 605: it had laid the words out in a stand-in face
  (the app registers its fonts at launch; the test now does too) and taken the window's full height for its content
  (the sizes are now the content under the 32-point title strip). It now reads 598 with 176 above, against the
  screen's about 605 and 172 (the last build on screen: about 597 with 176). Seen on the preview copy's third build
  (apps-runs.md): at 820 × 592 and 1100 × 620 the file section whole at the bottom of the card with the note in full,
  about 3.9:1, the part above scrolling (about 179 points of it at 820 × 592) and fading above the heading, the
  always-shown bar beside that part only.
- **When the Google set-up couldn't show whole, the agent's "Copy the prompt" went out of sight first** (apps, seen
  2026-11-21 on the preview copy's third build; moved the same day at the owner's word, "move it above the
  explanation"; seen fixed on screen the same day). With the file section kept in view below, the part that
  scrolls ended with the server's note, the app's line, then "Copy the prompt" and "See the prompt", so a short window
  hid them first: at 1100 × 660 the fade left a ghost of the button's top edge; at 1100 × 620 and 820 × 592 the line
  and both actions were below the visible part. Now `AgentPath` (`GoogleClientPaths.swift`) starts with that row, the
  prompt's box opening right under it, and the note and the line follow. `GoogleSetupLayoutTests` marks the row
  (`LayoutMark.promptActions`) and checks it inside the scrolling part and clear of its 24-point bottom fade: before
  the move it failed at 1100 × 620 (82 points past the fade's start) and 820 × 592 (110); now its bottom sits 50
  and 22 points above the fade's start there (the row 108 points below the part's top, under the lead and the path
  choice), and at 1512 × 982 everything shows. The sheet at 820 × 592, not asserted, clears the fade by 2 points
  (offscreen only: no launch option opens it). Seen on the preview copy's fourth build (apps-runs.md): the row whole
  and unfaded right under the path choice at 820 × 592, 1100 × 620 and 1512 × 982, its pill's bottom 22 and 50
  points above the fade's start at the two short sizes (the scrolling part read from the always-shown bar's track),
  the file section still whole below.
- **A chosen control was invisible over light wallpaper** (Mac app, 2026-11-20, found in captures; fixed the same day).
  A tinted glass (`.regular.tint(white 30%)`, or the mail page's white 70% "chosen") over the light sky differed from
  clear glass by 2–9 RGB levels, so the current rail button, Settings' chosen tab and the mail page's chosen bar
  buttons couldn't be told apart (over the dark hills the same tint read clearly). Inside a `GlassEffectContainer`,
  tinting one glass can also lighten the whole container. Fix: one lit look, a white fill at 80% under clear glass
  with dark ink (`GlassControl`'s `lit`, `RailLook.lit`), pinned by pixel tests (`RailChosenTests`, `TabChosenTests`,
  `BarChosenTests`). The offscreen renderer draws glass lighter than the screen, so the tests' backdrops are set to
  match captured values. Measure chosen states in a capture, not by eye, over both the sky and the hills.
- **The rail's count badge was drawn behind its glass button** (Mac app, 2026-11-20, the owner's screenshot: "the
  number is beneath button"; fixed the same day). A `GlassEffectContainer` draws all the glass inside it above any
  ordinary content inside it, so the badge, an `.overlay` in each button's label, sat under its own button's glass
  with its lower-left half and digit cut. Fix: each button reports its badge's place through an anchor preference
  (`railBadge`, `Shell/RailLabel.swift`) and the rail draws every badge in one overlay outside the container
  (`railBadges()`, `Shell/Rail.swift`). Pinned by a pixel test on the real `Rail` (`RailBadgeTests`; `ImageRenderer`
  draws glass only once an `NSHostingView` has been created in the process); it fails on the old code. Anything else
  meant to sit on glass inside a container (a dot, a count) must be drawn outside it the same way.
- **A reset listing dropped old conversations opened from the mailbox, and opening one during a listing dropped
  mail** (2026-11-20, found before the search build's first bundle, fixed test-first the same night; `IMPORTED` in
  `server/src/sync/ingest.ts`). Two faults in how an opened conversation met a listing (the provider lost its place,
  on Gmail when its history expired, and lists the first sync's window again; what the listing leaves out is dropped
  when it ends). (1) The opened conversation is older than that window, so the next listing left it out and its
  thread was removed (opening it again from the mailbox's search brought it back; nothing changed at Gmail, but its
  stack, come-back time and summary here were lost). (2) Worse: the opening's own batch said `more: false`, so
  opening a conversation while a listing was between two batches ended the listing early and dropped every message it
  hadn't reached yet, and the listing's later `changed` entries for them were ignored, so that mail was gone from the
  server (not from Gmail) until the inbox was connected again. Now an opened conversation's messages carry the mark
  `listed = -1`, which no listing drops and no listing's own mark (a time) can equal, and an opening takes no part in
  a running listing. Tests: `sync-provider` ("a later reset listing leaves an old conversation ... alone", "opening an
  old conversation while a reset listing runs ends no listing and drops nothing"; both failed first). No migration:
  `messages.listed` is the existing column. What is left is under Open.
- **A resend of the person's sent words with HTML of the sender's own was stored as "You"** (the pictures' fourth
  review, 2026-11-18, fixed the same night, test-first, with the IMAP and Gmail kinds of test mailbox). The server's
  sent key hashed From, To, Cc, subject and text, and it sends text only, so a recipient could add HTML (say, new
  bank details) or an attachment and the copy still counted as the person's own. The key now hashes everything the
  content fingerprint does but the date (`sentKey` in `server/src/sync/identity.ts`): a copy of a text-only send
  must have no HTML and no attachments. Tests also cover the key without its text, and the Sent copy joining a thread
  whose first incoming sender is blocked or which the mailbox filed under Screening (gaps the reviewer's mutation
  run found).
- **The pictures' third security review** (2026-11-18, fixed the same day, test-first). On IMAP a message was
  matched by its Message-ID alone when its ref was new, so a copy with a known Message-ID (anyone the person wrote
  to knows theirs) rewrote the stored message's text and sender, turned it into "You" or out of it, and moved or
  trashed its thread; a Sent copy then let its recipients in. Now only the ref, or on IMAP the same Message-ID and the
  same content, is the same message (`server/src/sync/identity.ts`); anything else is a separate message from its own
  From. Since anyone who received a message knows its content too, an exact copy filed as spam still trashed the
  thread and took the stored message's ref (found in the fix's own probe): a copy of the same kind now counts as a
  move only once the stored copy's ref is reported removed, and is held (`held_copies`, migration 0010) until then.
  The IMAP provider now reports a ref its own move gave as removed when another app moved the message on before a
  sync saw it (it never did, and the end-to-end test showed such a move would otherwise stay held). The server's record of what it sent kept Message-IDs only, so a copy with other recipients or words counted
  as the inbox's own: it now keeps a hash of the From, To, Cc, subject, text, HTML and attachments with each (the
  last two since the fourth review, after a resend with HTML of the recipient's own was stored as "You"), in the same
  column (no migration), and forgets them after 90 days. A note to self or a Cc to self whose inbox copy synced before its Sent
  copy stayed a stranger's mail in Screening: the Sent copy now makes it the inbox's own and works its thread's
  sender and screening out again. The kept served HTML counted its HTML but not its plans' addresses (now counted;
  bound 24,000,000 so twenty of the largest fit). Mutation runs weakened 58 defences, then 27 for the held copies and
  the provider's removals: every one failed a test but five second layers (three from the second round; a removed
  inbox's held copies, which the foreign key removes anyway; and forgetting an own move once reported, which the
  cursor never reports again) ([server-checks.md](server-checks.md)).
- **The pictures' second security review** (2026-11-18, fixed the same day, test-first). A string in a style
  declaration's name ran past a newline for postcss but not for a browser, hiding a declaration that loaded from the
  web (for shown and blocked senders alike) and carried `javascript:` and `expression()` into stored HTML: names are
  now checked, and whole attributes and blocks read again, stored and served. Rewriting one declaration with many
  addresses was quadratic (2.4 s a serve): one pass now, at most 100 addresses a declaration, and the served HTML
  kept. A forged "From: <the inbox's own address>" counted as the inbox's own mail everywhere (it let its recipients
  in, let a spammer in through a reply, arrived done, and was summarized as "you"): "outgoing" now comes only from
  the provider's evidence or a Message-ID the server sent, and the own address is never let in by itself. Also:
  refusal records outlive the cache's cap; DNS-dependent refusals are retried; a /128 left LAN neighbours allowed;
  a null prefix was skipped; a VPN's /0 made everything local; and the loopback's ::1/128, widened to a /64, made
  every IPv4 address look local on this Mac. AVIF sequences are refused, trailerless GIFs accepted, nested style
  rules capped (they overflowed the stack), and a failing rewrite is served as text. A mutation run weakened 40
  defences: 37 failed a test; the 3 left are second layers no input separates from the first.
- **Pictures from the web: the security review's findings** (2026-11-18, fixed the same day, each with a test that
  failed first). Web addresses survived the rewrite inside nested CSS functions, behind a `)` in a string or behind
  comment markers inside strings, because CSS was read with regular expressions (`[^)]*`) and comments were stripped
  inside strings; the sanitizer that stores mail had the same flaw, which let other schemes (`javascript:` behind
  comment markers, `file:` nested) into stored HTML. Now a CSS reader that reads as a browser does
  (`mail/src/message/css-tokens.ts`) finds every address, and the served pass drops any declaration still naming
  the web. A picture request re-ran the sanitizer and the tracker list over the whole HTML (0.5 s each on a 5 MB
  mail); plans are now kept per message, at most 300 addresses are looked at, and HTML over 1,000,000 characters
  isn't shown. A forged "From: me" message got pictures in a screened thread. A picture that always failed was
  asked for at every opening after ten minutes. Name lookups had no time limit. Global IPv6 and public addresses of
  the server's own networks counted as public. The pixel cap read a GIF's screen and the first "ispe" anywhere,
  sizes decoders don't use. Removing an inbox while a picture was fetched left it on disk, and half-written files
  were never swept. 32 weakened defences were each checked to fail a test (a scratch mutation run).
Fixed on 2026-11-18 after the owner asked why Home showed no summaries (the coordinator's diagnosis on the owner's
server, read only, counts only; each fix with a test that failed first; `core/` and the contract changed with them):

- **Most summaries were silently dropped, and never asked for again** (server). On the owner's server about four in
  five of the recent threads the AI had processed had no summary, though `summary_due` was cleared for all of them and no failure
  was recorded. `acceptSummary` dropped any answer over 200 characters and any naming the thread's first sender; the
  prompt asked for "one or two sentences, at most 200 characters", which a model often overshoots (the few kept were
  125 to 197 characters, most of them two sentences), and machine-sent mail's sender is often the brand a summary
  names. A drop cleared the due flag and logged nothing, so which rule hit which thread can't be told now. Fixed:
  the safety checks run on the whole answer; an over-long one is shortened, not dropped; naming the sender keeps it;
  the prompt aims for one line under about 100 characters; a drop logs the thread id and a reason code; migration
  0006 asks again for every missing summary on a thread that isn't `otp`, done, trashed or removed (see
  [server-ai.md](server-ai.md)). Reproduced first with fake models (a 214-character answer dropped, due cleared,
  `pending` 0, not asked again); `server/test/ai-summaries.test.ts` failed first.
- **The status said nothing waited beyond the history while hundreds of older threads sat in Home unprocessed** (server).
  `maxHistoryDays` is the server's current `syncDays`; the owner had set it to 7 after the inbox's first sync had
  taken 30 days, so `beyondHistory` counted only up to 7 days and said none, and the Mac app's Home note explained
  nothing. Fixed by the owner's decision that history is all synced mail: `pending` counts every synced thread with
  work that isn't done, and `beyondHistory` is 0. `server/test/ai-pipeline.test.ts` failed first.

Fixed on 2026-11-17 after the owner's first run against Gmail on their own server (the coordinator's decisions; each
with a test that failed first; `core/` and the contract changed with them):

- **A false warning at start about the Google client file** (server, command). With a client file downloaded before
  its redirect address was changed at Google, the server logged that the file "doesn't list" its callback address "or
  sign-ins will fail"; Google accepted the sign-in, because Google's own list counts and the file is frozen at
  download. Now it is a hint, in one wording (since 2026-11-21 core's `googleRedirectHint`, used by the server's log,
  `PUT /v1/google/client` and the command): the file doesn't list the address, it may simply be older than a change made at
  Google, and if Google refuses a sign-in, check the address there. `usual-mail google`, `google set` and `doctor` say
  the same; in `doctor` it is a note on an `ok` check, never a failure. Tests that failed first:
  `server/test/google-config.test.ts` and `cli/test/google.test.ts`.
- **The first sync's window didn't persist** (server, command). It came only from `USUAL_MAIL_SYNC_DAYS` at start, so
  `USUAL_MAIL_SYNC_DAYS=7 usual-mail start` worked once and a plain `start` went back to 30. Now it is `syncDays` in
  `<data-dir>/settings.json`, which the server reads at every start (`server/src/node/settings.ts`), in Node mode and
  in Docker (the data directory is the volume); the variable still wins. `usual-mail init` asks for it (`--sync-days`;
  without a terminal it saves the variable's value or 30), `usual-mail sync-days` shows and changes it and restarts the
  server, `status` and `doctor` show what the server uses (from `AiSettings.maxHistoryDays`). Tests that failed first:
  the server's config and settings tests in `server/test/unit.test.ts` and the bundle's smoke test; `cli/test/
  sync-days.test.ts` and the question in `cli/test/init.test.ts`.
- **A first sync in progress kept its old window** (mail). Both providers' cursors remembered the window and what was
  still to send. Now a provider opened with a later `since` while its first sync is still being sent takes nothing
  older than it from then on, and keeps what it sent; an earlier `since` never widens it. Gmail lists the new window
  once and drops the older ids still to send (`narrowFirstSync`, cursor fields `f` and `w`); IMAP searches the first
  sync's backlog with the narrower window (`narrowedWindow`, cursor field `w`). Both keep the window the first sync
  began with for a listing after losing their place, so nothing fetched is dropped later. Tests that failed first:
  `mail/test/gmail/gmail.test.ts` and the IMAP scenario in `mail/test/imap/scenarios.ts` (both hoodiecrow shapes); the
  server's `test/e2e-first-sync-window.test.ts` runs it end to end against the fake Gmail and an IMAP server in
  process, and fails without the providers' change. Left: a Gmail first sync begun by an older build (Open, above).
- **The owner's pairing code was printed at every start** (server). Every start made a new code and printed it, so
  the log held a code each time. Now the Node host hands the service the code still in `owner-pairing-code`; while it
  is valid and unused it is kept, and the log says one waits, until when and where the file is, without the code
  (`keepOwnerCode(listener, { kept })` in `server/src/service/devices.ts`, `ownerCodeLines` in
  `server/src/node/owner-code.ts`). A code is printed once, when it is made. The guide and the command point to the
  file, never to `usual-mail logs`. Tests that failed first: `server/test/inboxes-pairing.test.ts`,
  `server/test/unit.test.ts`; the smoke test starts the bundle twice.

- **Pairing again with the same address kept the old copy** (apps, found 2026-11-17 against the reset demo server).
  The copy is one file per server address, and pairing opened it as it was, so after the server's store was reset
  (versions starting over) the old copy's higher versions would have won over the new store's. A new pairing now
  deletes that copy first, as signing out does (`AppSession.removeCopy`). `pairingAgainStartsAFreshCopy` failed first.

Fixed on 2026-11-17 after the coordinator's decisions on the review of the fifth revision (each with a test that
failed first; every part's check passes, and the built server confirmed them with requests beside a local test mail
server):

- **What left the server for summarizing went beyond the words a person is shown** (server). `planSummarize` labelled
  a nameless sender with their address and sent every message, a blocked sender's included; categorizing could send a
  blocked sender's message when it was the newest. Now a summary request names a nameless sender "someone" (a name
  holding an address counts as none) and replaces every address in the subject and text with `[address]`
  (`summarizeSender`, `withoutAddresses` in `server/src/ai/prompt.ts`), and both jobs leave out everything a sender
  blocked now wrote, their subject included (`sendableMessages`, `subjectToSend` in `server/src/ai/process.ts`). The
  words are core's one copy (`core/src/ai-words.ts`), which the command and the dashboard show, and
  `server/test/ai-sent.test.ts` fails if a request carries a field those words don't name or an address.
- **The key could reach the AI's status written another way** (server). `scrubKey` (`server/src/ai/models.ts`) now
  also removes any eight letters and digits in a row of the key in base64 (every alignment; standard and URL-safe,
  padded or not, being the same once separators are ignored) or hexadecimal (either case), with spaces and separators
  between characters ignored, so a spaced-out or broken key goes too. `server/test/key-scrub.test.ts`.
- **Mail could talk the AI into a one-time code, which lifted the screening gate** (server). The AI's `otp` lifts the
  gate only when the message the model read is machine-sent and holds a code near the word "code" (then `looksLikeCode`
  in `server/src/ai/gate.ts`); otherwise the thread stays screened in `otp` (then `PerformInput.holdGate`). A person's
  `otp` lifts it as before. Tests in `server/test/ai-sorting.test.ts`. Since 2026-11-25 the From domain must be proved
  too, and other kinds pass the same way ([server-screening.md](server-screening.md)).
- **A rule a person taught only proposed in a `suggest` inbox** (server). Rules of source `person` or `correction` now
  apply whatever the trust, `trash` and `block_sender` included (`gate` in `server/src/service/actions.ts`, `taught`
  from `applyRule`), so they fill Handled with no proposals. Agents' rules stay under trust. Tests in
  `server/test/service-trust.test.ts`. The Mac app still shows no proposals, which agents' rules and agents make.
- **On a new server, every thread in a filed category was done** (server). The first sync reads a thread under a
  filed category's label or folder whose newest message is within the history days as not done (`classify` in
  `server/src/sync/sorting.ts`). `server/test/sync-decisions.test.ts`.
- **A blocked sender writing into an existing thread moved it, changed its snippet and its unread state** (server,
  decided with the review's findings). The thread's shown fields, its state for actions, `thread(id)` and the triage
  queue now leave out what a blocked sender wrote into someone else's thread, and such mail ends no
  come-back-if-no-reply wait (`shownIn` in `server/src/service/store.ts`, `refreshThread`, `newMailInThread`).
  `server/test/sync-decisions.test.ts`.
- **`usual-mail` crashed with `EPIPE` when its output was cut short** (cli). `exitQuietlyOnClosedPipe`
  (`cli/src/pipes.ts`, wired in `src/cli.ts`) exits with 0 and prints nothing once the reader has gone.
  `cli/test/pipes.test.ts` reproduced the stack trace first.

Earlier:

- **The triage queue held almost nothing while a key was set and no inbox had AI processing on** (server, found
  joined in the independent review of 2026-11-17, fixed the same day). With the AI working and every inbox's AI off
  (the state right after `usual-mail ai set`), `GET /v1/triage` and `triage.pending` gave only the threads older than
  the history window (2 of 8 seen joined), so an outside agent had nothing to sort. `aiWontDecide` in
  `server/src/ai/work.ts` passed `undefined` for "inbox off" when no inbox was on, which dropped that condition from
  the `or`. It now returns no condition then, so every undecided thread waits. The new test in
  `server/test/lists-counts.test.ts` failed first; the server's check passes (341 tests) and the rebuilt bundle gave
  the new thread in the queue joined.
- **A summary was dropped when the sender's name was only part of a word** (server, found in the review of
  2026-11-17, fixed the same day). `acceptSummary` in `server/src/ai/prompt.ts` dropped any summary containing the
  first sender's name as a substring, so a sender called "Tom" lost "Asks to meet tomorrow", "Ann" lost "annual". It now
  matches the name as whole words, any case. The new test in `server/test/ai-pipeline.test.ts` failed first. Since
  2026-11-18 naming the sender doesn't drop a summary at all (above).
- **No part followed the fifth revision** (2026-11-17, by the order of work). Every part adopted it the same day:
  server and mail, then the command, the connector and the dashboard, then the Mac app's data layer and Home. Closed.
- **`design/`'s build stopped on the fifth revision's sample** (2026-11-17). The design part added words for the
  categories and `categorize`; `npm run check` passes (104 generated files current, 38 tests; Swift 19 tests). Closed.

- **`docs/contract.md` grew to 662 lines** with the fifth revision, over the 500-line guide (2026-11-17). Split the
  same day by subject: `docs/contract.md` is the entry point (456 lines), with `docs/contract-ai.md` (the server's AI)
  and `docs/contract-sync.md` (sync and providers); `AGENTS.md`'s index and the docs' links point to them. Code
  comments in the parts that cite `docs/contract.md, "Providers"` or `"Sync"` still name the old page; the entry
  point says where those sections went, and each part updates its comments when it adopts the revision. Closed.
- **The first Mac UI's findings** (apps, seen at the first launch, 2026-11-17): a proposal's Approve button squeezed
  into a one-letter column, a 900 × 450 first window, Brief and Handled cramped in the middle column, HTML mail white
  in dark mode, an inbox sheet too short to show its rules. Two were fixed, then the whole UI was replaced the same
  day by the rebuild to the owner's Figma design. Closed.
- **The offline strip showed a system error code** (apps, seen 2026-11-17): "Can't reach your server. The operation
  couldn't be completed. (NSURLErrorDomain error -1009.)". `APIClient.transportError` passed `URLError`'s own
  description, which is that text when the error carries none. Common cases are now words (`APIError.reason(for:)`),
  others none. `UnreachableWordsTests` failed first. (The rebuilt UI doesn't show offline yet.)
- **Gmail: mail delivered to spam and then marked "not spam" never arrived** (mail and server, found in the final
  review, fixed 2026-11-17 after the coordinator's decision on contract question 23). The server ignores new mail
  delivered to spam and drops a `changed` entry for a ref it doesn't hold, and Gmail reported "Not spam" as a label
  change. The contract's provider section now says a message that leaves spam is sent whole in `upserted`, never as
  `changed`, and the server treats it as new mail where it now sits. Gmail turns a history entry that removes `SPAM`
  into a whole message (`src/gmail/sync.ts`); IMAP never remembers a move out of the junk folder as its own
  (`src/imap/apply.ts`; another app's move was already new mail); the server's `MemoryMailbox.update` sends a message
  taken out of spam whole. The server itself needed no change. Tests that failed first: the provider contract suite's
  new case (Gmail, and both `MemoryMailbox` shapes; IMAP passed already), Gmail's and IMAP's own-`place` cases, the
  server's `fourth-revision` spam case and the Gmail end-to-end "Not spam" case. Left: a message that left spam during
  a Gmail history gap and is older than the reset's two days still comes as `changed` (mail's known limits).
- **Lists ordered records made in the same second differently on the server and in the apps** (server, found in the
  final review, fixed 2026-11-17 after the decision on question 24). The server now orders every list by the whole
  second it publishes, then id, descending (the triage queue oldest first, so ids ascending), and its cursors hold
  that second (`publishedSecond` in `src/service/rows.ts`, used in `views.ts` and `drafts.ts`). The apps' order is
  unchanged. Tests in `server/test/final-review-fixes.test.ts` failed first (Handled, Now and drafts came back in
  millisecond order); on the built server, three approvals in one call whose stored milliseconds ran against their
  ids came back by id, descending, whole and a page at a time.
- **A draft left `sending` by a stop stayed `sending` for good** (server, from the code in the final review, fixed
  2026-11-17). At start (`MailServer.start`, before the engine), such a draft becomes `failed` with "The server
  stopped while sending this draft, so it may have gone out. Check the Sent folder before sending it again." and
  `draft.changed`; it can then be changed, deleted or sent again. Tests in `final-review-fixes.test.ts` failed first;
  on the built server, a draft set `sending` in the stopped server's store was `failed` after the restart and then
  sent.
- **A person's own refused write-back showed in no list** (contract question 25, decided 2026-11-17). `attentionOnly`
  now returns records that failed or carry an error or a note whoever made them, so the dashboard's "what needs you",
  the connector's `list_handled` and the apps' "Needs a look" show it; Handled's ordinary list stays rules' and
  agents'. Tests failed first in the server, the dashboard and the connector (against fakes that followed the old
  rule) and in the apps' `AttentionTests`.

- **Mail a server-side rule filed outside INBOX waited for the next INBOX change** (server, fixed in the final
  review, 2026-11-17). IMAP's `watch` sees only INBOX, and the engine stopped polling an inbox once its watch was up
  (`#schedulePoll` returned while `loop.stopWatch` was set), although the server's and mail's notes both said other
  folders were polled. So mail filed straight into Archive or a pile's folder, and changes made only there, arrived
  only with the next INBOX change, a manual sync or a restart (seen in the joined run: nothing within 15 seconds
  with a 5-second poll). Every inbox is now polled as well (`src/sync/engine.ts`). The new test in
  `test/sync.test.ts` (a watch that hears nothing) failed before and passes after; on the rebuilt bundle, mail
  filed into Archive and into `Usual Mail/Reads` each arrived within 5 seconds.
- **Undoing an allow again, after the provider refused the first undo, overwrote a thread changed in between**
  (server, fixed in the final review, 2026-11-17). `failUndo` gave every thread a fresh revision, also one a person
  had moved or stacked after the refused undo, so the next undo of the allow found it "unchanged" and put it back.
  Now only a thread that is again where the action left it takes a fresh revision (`src/service/actions.ts`). The
  new test in `test/fourth-revision.test.ts` failed before (the moved thread went back to Screening) and passes
  after; the server's 204 tests pass.

- **A refused write-back overwrote a later action's change to the same thread** (server, fixed 2026-11-17, fourth
  revision). Two write-backs for one thread were queued; the first carried the thread as the second left it, the
  provider refused, and `failRecords` put the thread back to the first action's before-state, losing the second
  action's change (and a refused undo did the same through `failUndo`). Now each record stores every thread as it
  left it, only parts still as it left them are put back, and later records are rebased to the state before the
  failed one. Tests in `server/test/fourth-revision.test.ts` and `server/test/e2e-imap-filing.test.ts` (an IMAP
  `UID MOVE` refused while a person's later move comes in) failed against the old rule and pass now.
- **The Docker image carried build tools** (fixed 2026-11-17, fourth revision). `npm prune --omit=dev` in the
  build stage left esbuild's binary, TypeScript and drizzle-kit's helpers in `node_modules` (36 MB), because npm
  keeps what the linked sibling packages pull in. The image now installs only `dist/runtime.package.json` (libSQL,
  written by the server's build) with the server's lockfile: 12 MB then; since 2026-11-24 only `libsql`, the native
  part, and its own dependencies (17 MB on arm64, two platform packages). Replayed outside Docker; the server's smoke
  test checks the runtime file.
- **"What needs you" missed older notes** (dashboard, fixed 2026-11-17, fourth revision). Home looked for notes in
  the newest 50 applied records only. It now asks `handled` with `attentionOnly`.
- **`usual-mail ... --secrets-stdin` failed with `EAGAIN`** when standard input was a non-blocking pipe whose
  writer hadn't written yet, for example a program that feeds the password a moment later (cli, fixed 2026-11-17).
  `readFileSync(0)` can't wait on such a pipe; `src/cli.ts` now reads standard input as a stream. Found driving the
  built command against the built server.
- **The command's stand-in left a resumed inbox `ok`** (cli tests, fixed 2026-11-17): the contract makes it
  `connecting` until its next good sync, and the stand-in now does.
- **Undoing `allow_sender` or `block_sender` overwrote later changes to the sender's other threads** (server, fixed
  2026-11-17 in the third round). Undo now puts back only threads whose `revision` is still the one the action left;
  since the fourth revision the revision rises only when where a thread is changes, so reading it doesn't count.
- **After the last person's device was removed, nobody could make pairing codes until a restart** (server, fixed
  2026-11-17 in the third round). `keepOwnerCode` makes a new owner's code at once whenever no person's device is
  paired, prints it and writes `owner-pairing-code`.
- **`rate_limited` came without `Retry-After`** (server, fixed 2026-11-17 in the third round). REST sends the whole
  seconds from `ServiceError.retryAfter`; the command and the dashboard say how long to wait from it.
- **`usual-mail status` named the saved device, not the token's** (cli, fixed 2026-11-17 in the third round). It
  asks `GET /v1/me`.
- **The apps forgot trashed threads at their next refresh, so a trash record left their Handled** (apps, fixed
  2026-11-17 in the third round, by the apps' builder). `LocalWriter.reconcile` keeps a trashed thread while the copy
  holds a record for it (`TrashedThreadTests`). Read in the code for this record, not run here.
- **Providers' notes were only logged** (server, fixed 2026-11-17 in the third round). A note goes on the record that
  caused the write-back, or on the sent draft; only a note on a tidy-up no record caused is still logged.
- **The bundled server stopped at start** with `Dynamic require of "path" is not supported` (server, fixed
  2026-11-17 in the third round). The build gives the ES module bundle a `require`, and `npm run check` starts the
  built bundle (`npm run smoke`), so it can't come back unnoticed.
- **The dashboard could send a person to another site after signing in** (fixed 2026-11-17). `safePath`
  (`dashboard/src/http/context.ts`) checked the raw `next` value for `//` but returned the path after URL
  resolution, so `/.//evil.example` became `//evil.example` in the `Location` header. It now refuses a resolved
  path that starts with `//`. Tests in `dashboard/test/auth.test.ts` failed before and pass after.

## A web view inside a SwiftUI scroll view keeps the wheel (Mac app, 2026-11-18)

On the Mac a `WKWebView` takes scroll-wheel and trackpad events even when it has nothing to scroll, so a scroll view
around it doesn't move while the pointer is over it. The mail page's web view is sized to its page and passes
vertical scrolling on to its next responder (`MailWebView.scrollWheel` in `apps/`); keep that when changing it.

## Mail bodies blank when the Mac app is started from an agent's shell (2026-11-19)

Started directly from a sandboxed shell (the binary inside the bundle), the app inherits the sandbox and its
`WKWebView`s draw nothing: every HTML mail, sample mail included, shows an empty body. Launched through
LaunchServices (`open -n UsualMail.app --args …`) the same build draws them. Launch the app with `open` for captures.

## The Keychain asked for the login password after every rebuild (Mac app, fixed 2026-11-18)

Ad hoc builds (`CODE_SIGN_IDENTITY=-`) get a new signature each time, and the login keychain grants its item to one
signature, so macOS asked for the login password on every launch of a new build. `apps/scripts/run-mac.sh` builds
Debug signed with this Mac's "Apple Development" certificate instead: the designated requirement (bundle id plus
that certificate) stays the same across builds, so one "Always Allow" lasts. `check.sh` still builds unsigned, which
is fine as it launches nothing.

## The Mac app's TestFlight upload was refused for its resource bundles (ITMS-90284, fixed 2026-11-25)

App Store Connect failed Mac build 202611251025 in processing: "Invalid Code Signing … must be signed with the
certificate that is contained in the provisioning profile" for each Swift package's resource bundle
(`GRDB_GRDB.bundle`, `UsualMailDesign_UsualMailDesign.bundle`, `UsualMailKit_UsualMailKit.bundle`,
`UsualMailUI_UsualMailUI.bundle`). Xcode signs those bundles in their own package targets with the archive's
identity, Apple Development. On the Mac they sit in `Contents/Resources`, which the app's seal treats as plain files
(its `rules2`), and the App Store export re-signs only the app and nested code in the usual places (`Frameworks`,
`PlugIns` and the like) with the cloud-managed Apple Distribution certificate. So the exported package had the app
signed Apple Distribution and the four bundles still Apple Development. `codesign --verify --deep --strict` and
`xcrun altool --validate-app` both pass that package; only processing after the upload catches it. The
distribution certificate is cloud-managed, so nothing on this Mac can sign the bundles with it.

`apps/scripts/testflight.sh --mac` now removes each bundle's `Contents/_CodeSignature` in the archive before the
export. They hold no code (the script stops if one has `Contents/MacOS`, a `CFBundleExecutable` or, since the review
of 2026-11-25, any Mach-O file), so the export's signature of the app seals them as resources, privacy manifests
included. `--mac --check` then expands the package and fails if anything in the app, a sealed bundle or a Mach-O
file, is signed by anyone but the app's signer. Build 202611251405, made this way,
processed as valid. The iPhone's exported `.ipa` has the same development-signed bundles (at the app's root), and
App Store Connect accepts them for iOS, so the script leaves the iPhone alone; if iOS processing ever refuses them,
the same step applies there ([apps-phone.md](apps-phone.md), "Sending it to TestFlight").

## A `where` on a list of case patterns binds only the last one (Swift, 2026-11-20)

`case .toReply, .pinned, .snoozed, .inbox where compact && !reading:` matches the first three always and applies the
condition only to `.inbox`. Written that way in `TopBar.items` it would have emptied the Mac's row on To reply, Pinned
and Snoozed; caught before any build was kept. Test the condition before the `switch`, or repeat `where` per pattern.

## zsh skips its EXIT trap when `set -e` stops a function, and `status` is read-only (2026-11-25)

Found by the review of the tour script (`apps/scripts/make-tour.sh phone`, which sets the simulator's status bar to
9:41 and must give it back). Under zsh 5.9, `set -eu; trap 'echo CLEARED' EXIT; f(){ false; }; f` prints nothing: a
failure that `set -e` stops inside a function leaves without the EXIT trap (at the top level the trap runs). INT, TERM
and HUP with no trap of their own skip it too. And `status` is zsh's read-only `$?`: `cmd || status=$?` aborts the
script, again without the trap. `make-tour.sh` therefore runs the captures in their own zsh
(`scripts/tour/capture-phone.zsh`, `zsh -eu … || captured=$?`), sets the EXIT trap before the override, turns
INT, TERM and HUP into `exit 130`, and clears the bar itself after a good capture. Don't write `capture … || exit`
instead: `||` turns `set -e` off inside the function. Tried against the booted simulator the same day: a forced
failure (a screenshot refused) exited 1 and a Ctrl-C mid-capture 130, and after each the bar had no override.

## Hosting platforms (2026-11-23, from their documentation and local runs; none tried on the platform itself)

- **A plain HTTP public address stops the server.** `USUAL_MAIL_PUBLIC_URL` must be HTTPS unless it is loopback; an
  `http://` address makes the server exit 2 at every start (seen in Docker: a restart loop). Coolify's made-up
  address (`sslip.io`) is plain HTTP, so a domain with HTTPS has to be set in Coolify before the first deploy.
- **Railway** mounts volumes owned by root (its docs suggest `RAILWAY_RUN_UID=0` for images that run as another
  user; the image no longer needs it), allows no replicas with a volume, is briefly down at each redeploy, and allows
  SMTP only on Pro and above: IMAP inboxes can't send on Hobby. Its free plan sleeps. Templates are made in its
  dashboard only.
- **Render's** free instances sleep and can't have a disk; a service with a disk runs as one instance and is down
  for a moment at each deploy. Its Blueprint plan IDs are now like `0.5c-512mb`; `starter` stays valid. `sync: false`
  values are asked only when the Blueprint is first created. Disk snapshots are daily and kept seven days.
- **SMTP blocks on VPS providers:** Hetzner Cloud blocks ports 25 and 465; DigitalOcean blocks 25, 465 and 587 on
  every Droplet. Only IMAP inboxes' sending is affected; Gmail sends through Google's API.
- **YAML 1.1 reads a bare `off` as false:** `render.yaml` quotes `autoDeployTrigger: "off"`.
- **Compose with both `image:` and `build:`** tries the pull first and builds when it fails; it prints "error from
  registry: denied" for an unpublished or private GHCR image and carries on.
- **Coolify's `SERVICE_URL_<NAME>_<PORT>` keeps the port in its value** (fixed in `compose.coolify.yaml`, review of
  2026-11-23). Taking the public address from it gave `https://…:8484`, so Google would get
  `…:8484/v1/google/callback` (`redirect_uri_mismatch`). `SERVICE_URL_<NAME>` is the same address without the port;
  read in Coolify v4.7.6's source ([decisions-deploy.md](decisions-deploy.md)).
- **`docker cp` into a container keeps the files' own uid and group** (Engine 29.9.3, 2026-11-23: a backup made on a
  Mac, 501:0 there, arrived as 501:0), not root's as Docker's docs say; an earlier note here said the copying user's,
  which a re-review corrected. A restore copied in that way keeps the owner it had; the entry point takes everything
  in a folder of `node`'s for that reason. Files also keep their modes, and the server turns Google sign-in off while
  `google-client.json` is readable by others. Copying a folder's contents (`backup/.`) leaves `/data`'s own owner as
  it was.
- **Without capabilities (`--cap-drop ALL`) the image can't start as root:** root can't read `node`'s 0700 `/data`
  (`find: '/data': Permission denied`), change an owner or change user. The entry point prints one line and exits 1
  (a restart loop under a restart policy). On `node`'s folder the line points to `--user 1000:1000`, with which it
  runs. On a folder of root's it used to say the same, which then failed (`EACCES` on `/data/usual-mail.db`); it now
  says to give the folder to 1000:1000 first (one start without `--cap-drop`, or `chown -R` on the host) (fixed
  2026-11-23, re-review). A `:ro` mount used to get the capabilities line too (`chmod` fails on a read-only
  filesystem); it now gets its own, from `findmnt -T` on the folder or the nearest folder above it that exists. The
  first fix read `/proc/mounts` for a mount at the folder itself and compared its escaped path (`\040` for a space),
  so a read-only mount above the folder, a `--read-only` container with the folder on it and a `:ro` mount at a path
  with a space still got the capabilities line, or for a missing folder `mkdir`'s (fixed 2026-11-24, final review;
  each tried in Docker Desktop with the old and the new entry point).
- **The entry point took any folder of root's whole** (fixed 2026-11-23, re-review): a mistaken `-v /srv:/data`
  would have re-owned another service's files to uid 1000. It now takes one only when it is empty but for
  `lost+found` or already holds `usual-mail.db` or `secret.key`, and otherwise stops with a line saying so (tried:
  an empty volume, one with `lost+found`, a restore, and one holding other files, left as root's).
- **Docker kills a container ten seconds after `docker stop`** (its default), while the server's stop waits for each
  inbox's batch in hand: a moment at rest (0.12 s for `docker stop`, 0.19 s for `docker compose stop`, 2026-11-24),
  up to about two and a half minutes in a Gmail first sync on Node. The three Compose files set
  `stop_grace_period: 3m` (final review, 2026-11-24), which Compose gives the container as its `StopTimeout` (180,
  seen), so a plain `docker stop` waits as long; `docker run` needs `--stop-timeout 180`. Killed sooner, nothing
  stored is lost: `ingest` writes the cursor last, so the next start fetches that batch again. Render gives 30 s and
  can't give a service with a disk more; Railway gives 0 s unless `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is set (from
  their docs, 2026-11-24; [decisions-deploy.md](decisions-deploy.md)).
- **Coolify's Stop and Restart ignore `stop_grace_period`** (Coolify v4.7.6 and `main`, read 2026-11-24): a Service's
  stop is `docker stop --time=30` (10 with more than five containers), then `docker rm -f`
  (`app/Actions/Service/StopService.php`); Restart runs the same first (`RestartService.php` → `StartService.php`,
  unless it pulls the latest images). Only a deploy goes through `docker compose up`, which honours the file. Issue
  #5620; PR #9746 (v4.1.0) added a stop grace setting for Applications only. Pressed during a first sync, Stop or
  Restart can cut off the batch in hand, which is fetched again; `compose.coolify.yaml` and the guide say to redeploy
  instead. Not tried on Coolify itself.
- **The server's stop closed its inboxes one after another** (fixed 2026-11-24): an inbox whose close hadn't begun
  went on starting batches while another's batch in hand was stored, so a stop took the sum of the batches and more
  (in a unit test, the second inbox started four more batches; in the image, a second IMAP inbox fetched a whole
  extra batch). `SyncEngine.stop` now marks every inbox closing at once and waits for the longest batch.
- **The `usual-mail` command gave the server ten seconds to stop** (fixed 2026-11-24): Docker mode ran the container
  without `--stop-timeout` and stopped it with a plain `docker stop`; Node mode sent SIGTERM, waited 10 s, then
  SIGKILL; and remaking a running container with other settings ran `docker rm --force` on it. Now 180 s in both
  modes, the container stopped before it is removed, and a line after two seconds says what it waits for.
- **A Node-mode stop interrupted with Ctrl-C let a second server start on the same data folder** (found by the
  re-review, fixed 2026-11-24): `stop` removed the pid file before SIGTERM and the wait, and the server closes its
  port at SIGTERM, so after Ctrl-C `start` (or `init`) saw nothing running and a free port, and started another
  server beside the one still storing its batch (reproduced with the real launcher and a stand-in server). The pid
  file now stays, marked `stopping <pid of the stopping command>`, until the process has exited or been killed; such a
  process counts as running, and starting finishes the stop first ([cli.md](cli.md), "Node mode";
  `cli/test/node-stop.test.ts`).
- **`docker stop --time` is deprecated** (Docker 29.9.3 prints "Flag --time has been deprecated, use --timeout
  instead", seen 2026-11-24); `--timeout` is too new for older Docker. The command uses `-t 180`, which both take
  (no warning, seen), and `FakeDocker` refuses any other form of `docker stop`.
- **Docker mode said "Stopped." also when Docker had killed the server** (fixed 2026-11-24): `docker stop` exits 0
  either way. The launcher reads the container's exit code afterwards (137 for a process that ignores SIGTERM, 0 for
  one that exits, seen) and says so as Node mode does. **The exit code alone wasn't proof** (the final review, fixed
  the same day): a container stopped while it restarts keeps the code of whatever ended it last, and an out-of-memory
  kill ends 137 too (seen on Docker 29.9.3: a `docker stop -t 180` of a container in an out-of-memory restart loop took
  0.30 s and left `137 true`), so a quick stop was reported as a three-minute kill. Now "killed" needs the stop to have
  run past `waitForStop`'s deadline (by the clock, before Docker's) and `{{.State.ExitCode}} {{.State.OOMKilled}}` to
  be `137 false` (`cli/test/stop.test.ts`).
- **A `stop` and a `start` run at the same time could lose the new server's pid file** (Node mode; found by the final
  review, which reproduced it in 3 of 8 runs; fixed 2026-11-24). Both waited on the same stopping server; when `start`
  saw it exit first, it recorded the next server, and `stop` then deleted that file without looking: the new server
  ran unrecorded, and `status` said "stopped". `start`'s line also said the stop was "interrupted" while it still ran
  in another terminal. Now each change compares first (the mark is renamed into place right after the comparison; the
  removal renames the file aside, deletes it only if it still names the stopped server, and otherwise links it back),
  and the file names the stopping command, so `start` says "another `usual-mail` command is stopping it" while that
  process lives ([cli.md](cli.md), "Node mode"; `node-stop.test.ts` holds the `stop` still with SIGSTOP, so the race
  happens every time).
- **A stale `stopping` record naming a reused pid made `start` signal another process** (Node mode; found by the final
  review, fixed 2026-11-24). Only "alive" was checked, and EPERM counted as alive: a record naming another process of
  the same user had `start` send it SIGTERM, and SIGKILL three minutes later; one naming pid 1 showed "running
  (stopping)" and made `start` and `stop` fail with "kill EPERM" until the file was deleted by hand. Now the process
  must be this user's (EPERM counts as not running) and run with this data folder's `--data-dir`, read from its command
  line (`/proc` on Linux, `ps` elsewhere), before it is signalled, and again before SIGKILL; 0.1.0's records (the pid
  alone) still work, as the server's command line hasn't changed.
- **SIGTERM during start-up was ignored in the container** (server; found by the final review, fixed 2026-11-24). Node
  runs as PID 1 there, which ignores a signal it has no handler for, and `main.ts` installed its handler only after
  start-up: a `docker stop` then was ignored, the server went on to listen, and Docker killed it at the deadline (seen:
  10.1 s with `--stop-timeout 10`, exit 137; 180 s with the Compose files). Now `src/node/stop-signal.ts`, imported
  first, holds the handler from about 100 ms in; start-up acts on it between steps and exits 0, and a start whose stop
  was asked for starts no sync ([server.md](server.md); `server/test/stop-at-start.test.ts`; seen in Docker: exit 0
  without listening). The part before the handler is still open (above).
- **A sync asked for once its inbox's close was done still ran during the stop** (since v0.1.0; found by the
  re-review, fixed 2026-11-24): `#sync` didn't check that the engine was started, so "sync now", a watch or a sent
  draft for an inbox whose close had finished, while the stop waited for another inbox, opened its provider again and
  ran its rounds, which the stop waited for. `#sync` now returns when the engine isn't started ([server.md](server.md)).
- **A test harness whose fake mailboxes run in its own process must never block it** (2026-11-24): a synchronous
  `execFileSync("docker", ["stop", …])` froze the in-process IMAP servers, so the server's batches in hand waited
  for data until ImapFlow's 120 s socket timeout and the stop looked like a 136 s hang. Run such commands with an
  async `execFile` or `spawn`. The IMAP provider takes plain IMAP and SMTP only on loopback (elsewhere it wants
  STARTTLS), so a container reaches test mailboxes on the host through a relay started with
  `--network container:<name>`, at `127.0.0.1`.
- **A shell in the container is root's** (`docker exec`, Coolify's terminal, Render's Shell, `railway ssh`): files it
  writes in `/data` stay root's until the next start gives them back to `node`. The guide says `exec -u node` or
  `su node -c` for anything that writes.
- **A host's own secret key wins over a restored `secret.key`** (`server/src/node/config.ts`, `host.ts`): restoring a
  backup on Coolify or Render, which set `USUAL_MAIL_SECRET_KEY`, silently uses the new key and no inbox or AI key
  opens. The guide says to set the variable to the old file's text (base64url, which `parseKey` takes). A mistyped
  key exits with Node's bare `DOMException [InvalidCharacterError]: Invalid character`, not the server's own
  "must be 32 bytes" message.
- **A volume owned by root, for testing:** `--mount type=volume,src=<name>,dst=/data,volume-nocopy=true` keeps Docker
  from copying the image's `/data` into it, so its top folder stays root's (0755), as a host's new disk would be.
- **Testing ownership with an empty named volume misleads:** Docker copies the image's `/data` (owner `node`, 0700)
  into a volume that is still empty at each mount, so `chown 1001` in one container is gone in the next. Put a file in
  the volume first.

- **bash turns `-e` off inside `$(…)`** (`image.yml`, fixed 2026-11-23, re-review): in
  `releases="$({ gh api …; echo "$TAG"; } | sed … | sort -V)"` a failed `gh api` was ignored (the braces return
  `echo`'s 0, so `pipefail` never sees it), and with an HTTP 502 the release named itself the newest: 1.1.5 after
  1.2.0 took `latest`. Fetch into a variable on a line of its own (`list="$(gh api …)"`), where `set -e` applies, or
  `shopt -s inherit_errexit`.
- **Some npm packages ship no licence file** (2026-11-23): `@ai-sdk/provider-utils` and `drizzle-orm` (Apache-2.0),
  and `@libsql/client`, `@libsql/core` and libSQL's per-platform packages (MIT; their repositories have one).
  `server/scripts/licenses.mjs` names each with what stands in and fails the build for any other package without one.
  `@libsql/isomorphic-ws` (MIT, its repository's text) and `promise-limit` (ISC, with no licence file or copyright line
  anywhere, so only the standard text) needed one too until 2026-11-24, when the server took only libSQL's local
  client and the image stopped installing `@libsql/client` with its remote clients' packages (Fixed, below).
  `THIRD_PARTY_NOTICES.md` used to say every package's text was in its `node_modules/` folder, which wasn't true in the
  image (no `node_modules` for the bundle) nor for these.