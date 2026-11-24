# The command and the Docker files

`cli/` is the package `usual-mail`: the `usual-mail` command a person uses to set up and run their own server,
then pair apps, give agents access and connect inboxes. It talks to the server over the REST routes in
`core/src/api.ts` and nothing else. It ships as one bundled file with no runtime dependencies. The repository
root holds the `Dockerfile`, `compose.yaml` and `.dockerignore` for the server's image. It follows the contract's
fifth revision (2026-11-17, as amended the same day): the server's own AI (`usual-mail ai ...`), each inbox's AI
switch, icon and place.

**The Docker image is built and tried (2026-11-23), on this Mac only.** Docker Desktop here was 4.36.0, installed
from Docker's DMG (not Homebrew), and its daemon never answered on macOS 27 (`docker version` hung from 2026-11-16 on).
On 2026-11-23 it was replaced with **Docker Desktop 4.100.1** (Engine 29.9.3, Compose v5.7.1, buildx 0.38.1) from
Docker's notarized DMG: quit, old app moved to the Trash, new app copied in. No password, licence or helper prompt
came up, and the owner's other images and volumes were kept. To update it again, the same way or from its own
updater. The image, `compose.yaml`, `init --mode docker` and the files for other hosts were then run (see Checks);
those files are described in [deploy notes](decisions-deploy.md) and [the public guide](../deploy.md).

## Run and check

All commands run in `cli/` after `npm install`.

| Command | What it does |
|---|---|
| `npm run check` | Type-checks `src/` and `test/`, then runs every test |
| `npm test` | The tests only |
| `npm run build` | Bundles `src/cli.ts` into `dist/usual-mail.mjs` (`scripts/build.mjs`, esbuild), executable |
| `npm run dev -- <args>` | Runs the command from source |

`node dist/usual-mail.mjs --help` lists the commands. `usual-mail <command> --help` explains one.

## Commands

| Command | What it does |
|---|---|
| `init` | Sets up a server on this machine (Docker or Node), starts it, waits until it answers, pairs this command with the owner's pairing code, and says what to do next. Also keeps how many days of mail a new inbox's first sync takes (`--sync-days`, or asked) in the data directory's `settings.json`. Safe to run again |
| `start` | Starts the server `init` set up, and waits until it answers |
| `stop` | Stops it |
| `status` | Says how it runs, whether it answers, its version, which device the token in use belongs to (`GET /v1/me`), and how many days a new inbox's first sync takes (the server's `GET /v1/first-sync`, else the saved number; `syncDays` in `--json`). Exit 1 when it doesn't answer |
| `logs` | Shows the server's log (`--follow`, `--lines N`). Its help says to read the owner's code from its file, not the log |
| `doctor` | Checks the settings file, the server, its version, the pairing (`GET /v1/me`), the process, the data directory's permissions, the owner's code file, each inbox, the first sync's days (warn when the server's differ from the saved ones), the server's AI, Google sign-in, and whether other devices can reach the port. Exit 1 when a check fails |
| `sync-days [<days>]` | Says how many days of mail a new inbox's first sync takes; with a number (1 to 36500) saves it in `<data-dir>/settings.json` (keeping the file's other fields) and restarts the server `init` set up so it takes effect (`--data-dir` for another server, which it then says to restart). Says what happens: fewer days stop a first sync in progress from fetching older mail and keep what it fetched; more days apply to inboxes connected afterwards, since fetching more for one would be a new first sync (only removing it and connecting it again starts one). Warns when `USUAL_MAIL_SYNC_DAYS` is set where it runs, which wins. `--json` |
| `pair` | Makes a pairing code for a new app and shows it with the server's address and expiry |
| `agent add` | Gives an agent chosen inboxes, turns their agent access on, and shows once the connector's address (`<server>/mcp`) and the agent's token |
| `agent list` | Lists agents and their inboxes, marking inboxes whose agent access is off |
| `agent remove` | Revokes an agent, and offers to turn agent access off for its inboxes that no other agent uses (`--access-off`, `--keep-access`) |
| `devices` | Lists paired apps and agents, marking the device the token in use belongs to (`GET /v1/me`) |
| `devices revoke` | Revokes a device; asks first when it is the one in use. Revoking the last person's device says the server made a new owner's code |
| `inbox add` | Asks for the provider (IMAP or Gmail), a name, one of the twelve hat colours, then the connection details. Secrets are read unseen. `--icon` sets the icon. **Gmail when the server has Google sign-in** (and no `--client-id` or `--secrets-stdin`): starts a sign-in (`POST /v1/google/sign-ins` with name, colour and icon), prints Google's address on standard error and opens it in the browser (`open`, or `xdg-open`; `--no-browser` only prints it), asks the server every second how it ended (`GET /v1/google/sign-ins/:id`) until it isn't waiting, then says what happened (or the server's words, exit 1) and sets `--trust` afterwards. In a terminal the list offers "Gmail: sign in with Google" first. Says that with an AI key the new inbox's mail goes to the AI like every inbox's. No `--ai` or `--no-ai` since the per-inbox switch was removed |
| `inbox list` | Lists inboxes in their order with place (`#`, from 1), name, icon, hat, address, provider, connection (IMAP server and login, the Google client id, or "Google sign-in", from `Inbox.connection`), status (with the reason when something is wrong; while a first sync runs and nothing is wrong, how far it has got in core's words lower-cased, "fetching your mail · 120 of 340", since 2026-11-23; `doctor`'s inbox line says the same), last sync and id |
| `inbox reconnect` | Gives a connected inbox new credentials in place. A Gmail inbox, when the server has Google sign-in and no `--client-id` or `--secrets-stdin` is given, is signed in again with Google (`POST /v1/google/sign-ins` with `inboxId`; in a terminal it asks first; `--no-browser`), and another account is refused by the server. Otherwise (`PATCH /v1/inboxes/:id` with `credentials`), in the shape used to connect, starting from the stored connection so only the secrets are asked. Secrets are read unseen |
| `inbox icon <inbox> <icon>` | Sets the icon: one of core's `INBOX_ICONS` (person, building, briefcase, house, shop, globe, and since 2026-11-20 plane, wallet, family, rocket, school, heart, star, leaf); the help and the check list them from core |
| `inbox move <inbox> <place>` | Moves an inbox to a place in the profile switch and the list, counting from 1 (the server's `position` counts from 0); the server renumbers the others |
| `ai status` | The AI's state in words, why there are no summaries when it isn't working and what to fix, the service and each job's model, the last run, what waits (`pending`), and what it works on: "all synced mail that isn't done, newest first; a new inbox's first sync takes the last N days" with who changes that (`GET /v1/first-sync`; the line is left out for an agent's token or a server from before the route). An agent's token sees the status without the settings. `usual-mail ai` alone is the same |
| `ai set` | Sets the key for a gateway (`--gateway vercel`) or one provider (`--provider openai\|anthropic`). **Saving a key is the consent for every inbox's mail:** it first shows what is sent and to whom (core's words, for that service), then asks (`--yes` without a terminal; with `--json` the words go to standard error), and only then reads the key unseen or with `--key-stdin`. Then says from now on every inbox's mail goes there, and shows the status the server's test left |
| `ai models` | Shows each job's model and the server's default; `--categorize` / `--summarize` set one, `default` goes back to the default. Shows the status afterwards (the server tests a new model at once) |
| `ai history` | **Gone** (2026-11-18): not listed; typed anyway, it says in one line that the AI works through all synced mail and that `usual-mail sync-days` sets how far back that goes, on standard error, and exits 2, sending nothing |
| `ai test` | `POST /v1/ai/test`, then the status |
| `ai pause` / `ai resume` | Stops all processing for every inbox; carries on |
| `ai remove` | Removes the AI key (`PATCH /v1/ai` with `credentials: null`), which stops all processing. Says first what it does, then asks (`--yes` without a terminal; with `--json` the words go to standard error). Nothing to remove without a key |
| `inbox sync` / `pause` / `resume` | Asks for a sync now; pauses or resumes syncing |
| `inbox remove` | Removes an inbox after asking (`--yes` without a terminal) |
| `google` | What the server says about Google sign-in (`GET /v1/info`'s `googleSignIn`): available with the redirect address to register at Google, or exactly what the host must still give it (the client: what to create at Google and `google set`; the address: `USUAL_MAIL_PUBLIC_URL`), then Google's rules in core's words. When `init`'s data directory holds a client file that doesn't list the redirect address, the hint (core's `googleRedirectHint`): the file may be older than a change made at Google; check the address there if Google refuses a sign-in. `--json` prints the info |
| `google set` | Gives the server its Google OAuth client: `--file <the JSON Google's console downloads>` is copied as it is (checked as the server checks it, with core's `readGoogleClientFile`: a Desktop app client's file is refused, and since 2026-11-21 a client id or secret of spaces too) to `<data-dir>/google-client.json`, mode 0600, through a temporary file (`writeOwnerOnly`: created exclusively under a random name, mode 0600 from creation, removed if the write or rename fails, since 2026-11-21), replacing a file already there without asking (the server's `PUT /v1/google/client` asks for `replace=true` instead); without a file it asks the client id and the secret unseen (or `--client-id` and `--secret-stdin`) and writes the same shape. The data directory is `init`'s, or `--data-dir`. Never prints the secret or the file. Then reads `/v1/info` and says whether sign-in is available, the redirect address, and Google's rules |
| `google prompt` | (2026-11-21) Prints the browser agent's prompt of docs/google-setup-agent.md with the server's redirect address filled in, from `GET /v1/google/setup` (person only): the prompt alone on standard output (so `\| pbcopy` copies it), core's `promptNote` on standard error. Without an address, the server's `noAddress` words, exit 1; a server older than the route (`not_found`), words saying so. `--json` prints the whole `GoogleSetup` (the steps by hand too) |

`usual-mail inbox`, `usual-mail agent` and `usual-mail devices` alone list; `usual-mail ai` alone is `ai status`.
Inboxes are named by id, name or address; devices and agents by id or name. A name that matches two is refused with
their ids.

### Everywhere

- **`--json`** on `init`, `status`, `doctor`, `pair`, `agent add`, `agent list`, `agent remove`, `devices`, `inbox
  add`, `inbox list`, `inbox reconnect`, `inbox icon`, `inbox move`, `inbox pause`, `inbox resume`, and
  every `ai` command. Output is the server's own shapes where there is one: `ai status` prints `{ status, settings }`
  (`settings` null for an agent's token), `ai set`, `models`, `history`, `pause`, `resume` and `remove` print
  `{ settings, status }`, `ai test` the status, the inbox commands the inbox. Words that must be shown before a yes
  (what leaves the server, what raising history adds, what removing the key does) go to standard error with `--json`. **With `--json` nothing is asked,** even in a terminal: an answer that would need a question fails
  with exit 2, code `not_a_terminal` and a message that starts "With --json nothing is asked" and names every flag
  needed. So standard output holds only JSON.
- **Errors** go to standard error as one or two sentences that say what to do next, one per contract error code
  (`src/errors.ts`). With `--json` they are `{ "error": { "code", "message" } }`, plus `retryAfter` (seconds) on
  `rate_limited` when the server sent `Retry-After`. `code` is the contract's code or one of the command's own:
  `usage`, `not_set_up`, `unreachable`, `not_a_terminal` (an answer is missing and nothing can be asked), `failed`.
- **`rate_limited`** says how long to wait from `Retry-After`: whole seconds as the contract sends it, or an HTTP
  date. Under a minute in seconds, otherwise minutes rounded up ("Try again in 10 minutes."); "now" for 0;
  "up to ten minutes" when there is no header.
- **Exit codes:** 0 on success, 1 on failure, 2 for a mistake in the arguments or a question that can't be asked.
- **Output cut short** (`usual-mail … | head`): at the first write whose reader has gone, the command exits with 0
  and prints nothing more, no stack trace (`src/pipes.ts`). What it had sent to the server before stays sent.
- **No questions without a terminal.** A question is asked only when standard input and output are both a
  terminal and `--json` isn't given. Otherwise a command takes flags, or fails with exit 2 naming every flag it
  needs.
- **Environment:** `USUAL_MAIL_SERVER` and `USUAL_MAIL_TOKEN` are used instead of the saved address and token. The
  saved token is only ever sent to the address it was saved for. `USUAL_MAIL_DOCKER` names the docker binary,
  `USUAL_MAIL_SOURCE` a checkout of Usual Mail, `USUAL_MAIL_DEBUG` prints stacks of unexpected errors, and
  `NO_COLOR` turns off the hat swatches.
- **Which device is in use** always comes from `GET /v1/me`, never from the name saved in the settings file. With
  `USUAL_MAIL_TOKEN`, `status`, `doctor`, `devices` and `devices revoke` name that token's device and say it came
  from the variable; an agent's token is named as an agent.
- Only IMAP and Gmail are providers. `--provider` takes nothing else.

## Where files go

| What | Where | Mode |
|---|---|---|
| Settings: server address, this command's token and device, how `init` runs the server | `$XDG_CONFIG_HOME/usual-mail/config.json` (default `~/.config/usual-mail/`) | file 0600, folder 0700, written whole through a temporary file |
| The server's data (default) | `$XDG_DATA_HOME/usual-mail` (default `~/.local/share/usual-mail`) | created 0700 |
| The server's own settings that persist: the first sync's days | `<data-dir>/settings.json` (`{ "syncDays": N }`), read by the server at every start, Node or Docker | file 0600, written whole through a temporary file |
| Node mode: the process id and the server's log | `$XDG_STATE_HOME/usual-mail/server.pid` and `server.log` (default `~/.local/state/usual-mail/`) | files 0600, folder 0700 |

The command never prints its own token. It never stores or prints mailbox passwords, Gmail secrets or the AI key:
they go into the one `POST /v1/inboxes`, `PATCH /v1/inboxes/:id` or `PATCH /v1/ai` request and nowhere else, and a
server message that repeats one has it replaced by `•••` before it is shown (`ai set` replaces the key in everything
it prints, the status the server's test left included). Secrets are read unseen in a terminal, or from standard
input with `--secrets-stdin` (one per line) or `--key-stdin` (the first line), never from flags or words on the
command line, which other users can see in the process list: `ai set` refuses words after it without repeating them,
and an unknown command line repeats only words that look like command names. The server prints an owner's pairing
code in its log once, when it makes it; the command's words point to the file, never to the log.

## The server's AI

- **Setting the key** (`ai set`): saving a key is the person's yes to every inbox's mail, now and later, going to that
  service (no per-inbox switch since the owner's decision of 2026-11-17). In a terminal it says the key goes to the
  server once, asks which service (Enter keeps the current one), shows the words, asks "Save a key for … and send
  every inbox's mail there?" (default no; no changes nothing and asks no key), then the key, unseen. The words are
  the server's (`GET /v1/ai/disclosure` for that service), laid out by `disclosureLines` and otherwise unchanged. Without a
  terminal it needs `--gateway vercel` or `--provider openai|anthropic`, `--key-stdin` and `--yes`; without `--yes`
  it prints the words and stops with exit 2 before reading the key. It sends `PATCH /v1/ai` with `{ credentials }`,
  reads the status, and says the key is saved and sealed, that another service put each job back on the default model
  or that the same service keeps the chosen models, and that from now on every inbox's mail goes there.
- **The words** are the server's answer to `GET /v1/ai/disclosure` (built by core's `aiDisclosure` from
  `AI_SENT_WORDS`, the one copy the server's requests are held to), laid out for a terminal by `disclosureLines` in
  `src/ai-words.ts`: every
  inbox connected to the server, now and later; the service (for a gateway, that it passes mail on to the company that
  runs each model; the models only for the service already set); that its terms apply; what is sent to categorize
  and to summarize; what is never sent; how far back history goes.
- **Words for states** (`explainStatus` in `src/ai-words.ts`): not set up, paused, working, key refused, model not found (naming the job and its model), out of credit, unavailable; each with what to
  do. The service's `detail` is shown as "It said: …", with control characters taken out so it can't move the
  terminal's cursor.
- **No history setting** (since 2026-11-18): `ai history` is retired in `main.ts`'s `RETIRED` list (one line pointing
  to `sync-days`, exit 2, before any command is looked up), chosen over letting it fall to "Unknown command" so a
  person or script that used it learns what replaced it. `ai set` says "new mail as it arrives, then all the synced
  mail that isn't done, newest first". `sync-days`, `status` and `doctor` read what the server takes from
  `GET /v1/first-sync` (`serverSyncDays`), null without a person's token or against a server from before the route.
- **`doctor`'s `ai` check:** fail for key refused, model not found and out of credit; warn for not set up, paused and
  unavailable; ok otherwise ("working (service), for every inbox; …" with what waits).
- **`doctor`'s `google` check:** ok when the server has Google sign-in (with its redirect address and the seven-day
  note, and the client file's redirect hint as a `note` when the file doesn't list the address: never a warning); warn with exact steps when it lacks the client (what to create at Google, the redirect address, `google set
  --file`) or its address (`USUAL_MAIL_PUBLIC_URL`); fail when `init`'s data directory holds a `google-client.json`
  other users can read (`chmod 600`). With an
  agent's token it reads the status only.

## The owner's pairing code

The server makes an owner's code (kind `person`) whenever no person's device is paired: at a start, after the
last one is removed, and when the old code expires unused. It writes the code and a newline to
`<data-dir>/owner-pairing-code` (owner-only), writes it again with each new code, and removes it once the code is
used. It prints a code once, when it makes it: a later start keeps a code still waiting and only says so (since
2026-11-17). Demo mode writes no file.

- `init` reads the code from that file (plain text, or JSON with `code`), or takes `--code`. If pairing with the
  file's code answers `unauthorized` (it expired in between), it reads the file once more and pairs with a new code
  if there is one.
- Without a file and without a working token, `init` says an app or browser is paired already and to make a code
  there and pass `--code`.
- `init` refuses a code made for an agent: it revokes the agent device it just made, with that device's own token,
  and saves nothing.
- `doctor` (when `init` set the server up on this machine) reports the file: `fail` when other users can read it,
  `warn` when no app or browser is paired and the code waits (fix: `usual-mail init`). When the server refuses this
  command's token, its fix depends on the file: run `init` when the file is there; otherwise make a code on a
  paired device and run `init --code`.
- `devices revoke` of the last person's device says the server made a new owner's code and that `init` pairs with
  it. After that, `init` with the same settings pairs this command again ("The saved token no longer works here").

## How `init` works

1. Settings come from flags, then from what an earlier `init` saved, then from questions (only in a terminal,
   without `--json`, and only the first time), then from defaults. Without a terminal the first `init` needs
   `--mode`.
2. It checks what the mode needs. Docker: that Docker answers within 10 seconds, and that the image exists; run
   from a checkout of Usual Mail (the Dockerfile, `server/` and `core/` around the command's own file) it builds
   a missing image with `docker build`, unless `--no-build`. Node: that the server's built file exists (default
   `server/dist/server.mjs` in that checkout; `--server-file` otherwise).
3. If an earlier `init` used other settings, it stops that server. It creates the data directory (0700) and
   refuses a port that another program holds, naming `--server` when a Usual Mail server already answers there.
4. It writes the settings, starts the server, and waits for `GET /healthz` (`--wait`, default 60 seconds). If the
   server stops or never answers, it fails with the end of the server's log. It checks `GET /v1/info`.
5. If the saved token works (`GET /v1/me`), it is done. Otherwise it pairs as `usual-mail on <host>` (`--name`)
   with the owner's code (above).
6. A second run with the same settings and a working token writes nothing, starts nothing, pairs nothing, and
   says "Nothing changed". A new port keeps the token (same data); a new data directory pairs again.
7. **The first sync's days** (since 2026-11-17): `--sync-days`, else what the data directory's `settings.json` holds,
   else a question (in a terminal, after a sentence on what it means), whose default is `USUAL_MAIL_SYNC_DAYS` when set,
   else 30; that default without a terminal. Saved there before the server starts; a changed number stops a running
   server first so it starts with it. `--json` prints `syncDays`.

`init --server <url>` runs nothing: it pairs with a server that runs elsewhere (compose, another machine) using
`--code`, the owner's file in `--data-dir`, or a question. `start`, `stop` and `logs` then say to manage the
server where it runs.

### Docker mode

`docker run --detach --name usual-mail --restart unless-stopped --publish 127.0.0.1:<port>:8484 --volume
<data-dir>:/data --label dev.usual.mail.settings=<hash> --user <uid>:<gid> usual-mail`. The data directory is a
folder on this machine, so the command can read the owner's code and `doctor` can check its permissions; the
container runs as this machine's user so the files stay the person's own. The label holds a hash of the image,
port, data directory and user, so a changed setting makes the container again (the data stays on disk). A
container with that name but without the label is refused, never removed. `start`, `stop` and `logs` are `docker
start`, `docker stop` and `docker logs`; a stopped container stays stopped after Docker restarts. The first sync's
days are in the mounted data directory (`settings.json`), so they aren't part of the hash: `sync-days` stops and
starts the container, which reads them at its start, without making it again.

### Node mode

`node <server-file> --data-dir <dir> --port <port> --host 127.0.0.1`, started in the background with its output
appended to the log. `stop` sends SIGTERM, waits up to 10 seconds, then SIGKILL.

## `inbox reconnect`

- Finds the inbox by id, name or address and uses its provider, and starts from what the server stored of the
  connection (`Inbox.connection`, `imapDetails`/`gmailDetails` in `src/commands/credentials.ts`). IMAP: each
  server's host, port and TLS, the IMAP and SMTP logins (each its own), and whether sent mail is saved are kept
  unless a flag changes them (`--user` sets the login for both; `--imap-host`, `--imap-port`, `--imap-starttls`,
  `--smtp-*`; `--no-save-sent` or `--save-sent`, not both). Then the password (and optionally a different SMTP
  password). The address is always the inbox's own; it is sent as `address` when the login differs. Gmail: the
  stored client id unless `--client-id`, then the client secret and refresh token. The details are sent whole,
  since they replace the stored ones whole.
- In a terminal it prints the stored details and asks once whether to keep them ("Keep these details and give only
  the password?", default yes); then only the secrets, unseen. On no, it asks for each detail, suggesting what was
  stored. Without a terminal or with `--json` it needs only `--secrets-stdin`, plus `--imap-host` and
  `--smtp-host` (IMAP) or `--client-id` (Gmail) when the stored details lack them (an inbox from an older server).
- The server checks the details with the provider first. `provider_error` shows the provider's words;
  `invalid` (another address) the server's; nothing changes either way. On success it says the inbox keeps its
  rules and history and syncs again, or stays paused.

## `agent remove`

- Finds the agent's inboxes whose agent access is on and that no other agent was given. In a terminal it asks
  whether to turn agent access off for them too (default yes), before revoking anything. `--access-off` and
  `--keep-access` decide without asking; both at once is a usage error.
- Without a terminal or with `--json`, when there are such inboxes and neither flag is given, it fails with exit 2
  naming both flags, and revokes nothing.
- Then it revokes the agent and turns access off where chosen. `--json` prints `{ agent: { id, name },
  agentAccessTurnedOff: [ids] }`.

## The Docker files

- **`Dockerfile`:** two stages on `node:22.23.5-trixie-slim`, pinned by digest (an index for amd64, arm64 and
  more). The build stage copies the context, runs `npm ci --omit=dev` in every package the server names as
  `file:../<folder>` (today `core`, `dashboard`, `mail` and `mcp`, so the bundler finds each one's dependencies),
  then `npm ci` and `npm run build` in `server/`. A second step installs only the bundle's run-time dependencies
  in `/runtime`: `server/dist/runtime.package.json` (written by the build: `@libsql/client` at the server's pinned
  version) with the server's `package-lock.json`, `npm install --omit=dev`, so libSQL comes at the lockfile's
  versions and nothing else does. (Pruning the build's `node_modules` instead, as before, left esbuild's binary,
  TypeScript and drizzle-kit's helpers in it: npm keeps what the linked sibling packages pull in.) The image holds
  that `package.json` and `node_modules` (12 MB, libSQL only; the rest is bundled), `dist/server.mjs` and
  `migrations/`. It keeps data in the volume `/data` (owned by `node`, 0700), listens on 8484 on all of the
  container's addresses, and checks `GET /healthz` with Node's `fetch` every 30 seconds. The bundle is 7.5 MB and
  the image 392 MB unpacked; it builds in about 10 seconds here (30 for amd64 under emulation).
- **The entry point, `docker-entrypoint.sh`** (since 2026-11-23; installed as `/usr/local/bin/usual-mail-entrypoint`):
  the image has no `USER`, so it starts as root. The folder's owner decides: root's becomes `node`'s; in `node`'s
  folder, anything not `node`'s becomes `node`'s (`find … -exec chown`) and the folder is made 0700; anyone else's
  is left alone with a line naming `--user <uid:gid>`. Then a trial `setpriv … true`, `HOME=/home/node`, and the
  command as `node` with `setpriv` (util-linux, in the base image). When a step fails for lack of capabilities
  (`--cap-drop ALL`), it prints one line pointing to `--user 1000:1000` and exits 1. Started as another user
  (`--user`, as `init` does), it changes nothing and runs the command as that user. Why: hosts such as Railway mount
  volumes owned by root, where the server as `node` failed at start (`EACCES` on `/data/usual-mail.db`); why the
  folder's owner and not each file's: [decisions-deploy.md](decisions-deploy.md).
- **`.dockerignore`:** lets in only `core/`, `server/`, `mail/`, `dashboard/` and `mcp/` (plus the entry point,
  `LICENSE` and `THIRD_PARTY_NOTICES.md`, which the image copies to `/app`), without `node_modules`,
  `dist/`, tests, Markdown, `core/scripts`, `dashboard/scripts`, `dashboard/assets`, `mcp/scripts`, local data,
  databases, keys and `.env` files. `design/` stays out: the dashboard and the connector carry the design output
  in their generated sources (`src/generated/assets.ts`, `src/ui/design.generated.ts`), which are checked in.
  `apps/`, `cli/` and `docs/` stay out too.
- **`compose.yaml`:** one service, `image: ghcr.io/usual-labs/usual-mail:latest` with `build: .` (since 2026-11-23:
  Compose pulls the image, and when the pull fails, as now with nothing published, builds it from the checkout;
  `--build` always builds), a named volume at `/data`, the port published on 127.0.0.1 only, `restart: unless-stopped`, and comments on the owner's code (in the volume whenever no person's
  device is paired) and on reaching it from other devices: a private network such as Tailscale or WireGuard, or a
  reverse proxy with HTTPS, never the bare port on every network. Its volume comment says the database holds the
  mailbox passwords and the AI key sealed, and the volume the key that seals them.

## Decisions

- **One file, no runtime dependencies.** Node's `fetch`, `parseArgs`, `readline` and `child_process` cover
  everything. esbuild bundles core's route table into the file, so the command can't drift from the routes.
- **Routes from core.** Paths and methods come from `ROUTES`; nothing is written by hand.
- **Agents through pairing.** There is no route that makes an agent's token directly, so `agent add` makes an
  agent pairing code with the chosen inboxes (`POST /v1/pairing-codes`) and pairs it at once (`POST /v1/pair`).
  It turns on `agentAccess` for those inboxes first, because an agent sees an inbox only when both hold.
- **`agent remove` asks before it changes anything,** and needs a flag without a terminal, as `inbox remove` needs
  `--yes`: removing an agent shouldn't leave inboxes open to agents by accident, and a script should say which.
- **Who the command is comes from the server.** `GET /v1/me` names the device of the token in use, so a token
  from `USUAL_MAIL_TOKEN` or a renamed device is shown as it is.
- **`--json` turns questions off centrally** (`src/main.ts` runs the command with `interactive: false`), so no
  command can mix a question into JSON.
- **Plain `docker run`, not Compose, for `init`.** Compose is a plugin that isn't always there, and everything
  `init` needs to make the container again is in its settings. `compose.yaml` is for people who prefer Compose.
- **A bind-mounted data folder in Docker mode,** run as the host user, so the owner's code file is readable from
  the host and the files are the person's own. `compose.yaml` uses a named volume instead, which is simpler there.
- **`init` builds a missing image only from a checkout,** since no image is published. Node mode never builds the
  server, because that would write into `server/`; it says how instead.
- **Hats:** the twelve light fills are copied into `src/hats.ts` and a test compares them with
  `design/tokens.json`. `inbox add` stores the hat's light fill as `Inbox.color` (design/specs/hat.md) and
  suggests the first hat no inbox wears yet. Listings show the nearest hat by OKLab distance, as the design
  package does.
- **The AI key, like a password, never touches a flag, a file or the screen.** `ai set` wraps its output in a
  redactor for the key, because a service's refusal can repeat the key and the server may pass its words on.
- **Saving a key asks, after showing the words,** because the contract makes it the person's consent for every inbox;
  `--yes` is the explicit choice without a terminal, and the words are printed anyway. The key is read only after the
  yes, so a "no" never touches it.
- **Google sign-in polls the outcome route every second** (the contract has no event for a sign-in's end) and gives up
  15 seconds after its expiry, when the server has said it expired. Google's address is printed on standard error so
  `--json` stays clean; it holds the sign-in's state, which works once, for ten minutes.
- **`init --mode docker` gives the container `USUAL_MAIL_PUBLIC_URL=http://127.0.0.1:<port>`:** it publishes the port
  there, and inside the container the server listens on every address and can't know its name, so without it Google
  sign-in would be off in Docker. In the settings hash, so a container made before is made again (data kept).
- **Places count from 1** in `inbox list` and `inbox move`, as people count; `--json` keeps the server's `position`
  from 0.
- **After `ai set` or `ai models`, the command reads `GET /v1/ai/status`.** `PATCH /v1/ai` answers with the settings,
  not the status of the test it runs (see "For the coordinator").
- **IMAP security from flags:** TLS from the start by default (993 and 465); `--imap-starttls` and
  `--smtp-starttls` switch to STARTTLS (default ports 143 and 587). Port 143, 587 or 25 also means STARTTLS.
- **Progress on standard error** ("Started the server…", "Paired…"), results on standard output, so `--json`
  output stays clean.
- **Tests run against a stand-in** (`test/stand-in.ts`, with the AI's part in `test/stand-in-ai.ts`) written from
  core's route table and types (fifth revision: inboxes with icon, position and `aiProcessing`, on only with AI
  credentials; the AI's settings without the key, credentials replaced whole and tested at once, another service
  turning every inbox's AI off and the jobs back to their defaults, pause, test, a status counted from threads a test
  describes, and the first sync's window from settings.json; keys that make the made-up service refuse, run dry, fail, or repeat the key),
  with the
  contract's sign-in, pairing limit and `Retry-After`, `GET /v1/me`, inbox versions, credentials checked before
  they are kept, the owner's code (written whenever no person's device is paired, again on expiry, removed once
  used), statuses and error bodies, so they don't depend on the server compiling. Docker and the server process
  are fakes (`test/fakes.ts`) that start the stand-in. Tests use a scratch home directory under the system's
  temporary folder, a virtual clock for waits, and never the real `~/.config`.

## Checks (2026-11-17, this Mac: Node 22.23.2, npm 10.9.8)

- **First-sync progress (2026-11-23):** `npm run check`: type check clean; 169 tests in 19 suites pass. Changed:
  `inbox list` with an inbox fetching "fetching your mail · 1,200 of 3,400" and one that needs attention with a count
  (its reason shown, not the count) in `commands.test.ts`, and `doctor`'s line for an inbox in its first sync in
  `init.test.ts` (both failed first). The bundle wasn't rebuilt.
- **`google prompt` and the shared reading of the client file (2026-11-21):** `npm run check`: type check clean; 168
  tests in 19 suites pass (165 before). New in `test/google.test.ts`: `google prompt` prints exactly core's prompt for
  the server's address with two blanks left and the note on standard error, `--json`; no address (exit 1, the server's
  words, nothing on standard output) and an older server (`not_found`); `google set` refusing a client id of spaces as
  the server does. The stand-in serves `googleSetup` with core's `googleSetup`. `node src/cli.ts google prompt` ran
  against the built server on a scratch directory (server-checks.md). `cli/dist` not rebuilt. After the review the
  same day: 169 (`writeOwnerOnly` refuses a link at its temporary name and leaves it, and `google set` onto a
  directory fails in words with no temporary file left; seen failing with the old write).

- **After the owner's first run against Gmail (2026-11-17):** `npm run check`: type check clean; 167 tests in 19
  suites pass (160 in 18 before). New, each failing first: `test/sync-days.test.ts` (6: `init` keeps the days in the
  data directory and a later plain `start` honours them in Node mode; the question and its default from the variable;
  `sync-days` shows, changes, restarts, says what happens to inboxes, warns about the variable; `--data-dir` and other
  fields kept; Docker restarts the container without making it again; `doctor` warns when the server's days differ);
  the redirect hint in `google`, `google set` and `doctor` (`test/google.test.ts`); the fourth `init` question. The
  stand-in reads `settings.json` when it starts. `npm run build` wrote the bundle. Joined against the built server:
  see [server.md](server.md) ("Checks").

- **Sign in with Google, then the removal of the per-inbox AI switch, then the disclosure route (2026-11-17):** `npm
  run check`: type check clean; 160 tests in 18 suites pass (the route's test: what `ai set` prints is the stand-in's
  answer for each service, word for word; 159 before it) (168 after Sign in with Google; the switch's own tests went with it). New
  `test/google.test.ts` (9): `google set --file` copies the downloaded file as it is, mode 0600, the secret printed
  nowhere; asked unseen or `--secret-stdin`, never from the command line; a Desktop app client, a file that isn't one
  and an unknown data directory refused with nothing written; `google` in each state; `inbox add` signing in (the
  browser opened with Google's address, the outcome waited for, `--trust` set after, nothing pasted), `--no-browser`
  and a declined sign-in (exit 1, the server's words); pasting still works; `inbox reconnect` in place, another
  account refused, asking first in a terminal; `doctor`'s `google` check (warn with steps, fail for a file others can
  read, ok). `init --mode docker` passes `USUAL_MAIL_PUBLIC_URL` (the init test failed first). Rewritten for the
  switch's removal: `ai set` shows the words and asks before reading the key (`--yes`), a "no" changes nothing,
  another service shows its words again and no longer turns anything off; `inbox ai`, `inbox add --ai/--no-ai`, the
  AI column and doctor's "off for every inbox" are gone. `npm run build` wrote the bundle. The stand-in serves
  `startGoogleSignIn` and `googleSignIn` and has no `aiProcessing`.
- **Joined:** the built command against the built server with `--dev-fake-google` (the live run in the
  [overview](01-overview.md)): `init --server`, `doctor`'s `google` warning, `google set --file` (the file copied
  byte for byte, 0600, sign-in available at once), `inbox add --provider gmail --no-browser` (connected, synced),
  `inbox reconnect --no-browser` after Google refused the token (reconnected in place). That run predates the switch's
  removal; the command's AI part was checked against the stand-in only after it.

- **Fifth revision:** `npm run check`: type check clean; 154 tests in 18 suites pass (116 in 11 before). New:
  `test/ai.test.ts` (22: status in every state and with an agent's token, the service's words without control
  characters; `ai set` sending the key once and never printing or storing it, in a terminal and from standard input,
  refusing it on the command line, a refusal that repeats the key shown as `•••`, another service turning AI off,
  `--json` asking nothing; models, history with what it adds and its question, pause, resume, test) and
  `test/inbox-ai.test.ts` (16: the switch with the words shown first and the question, `--yes`, `--json` with the
  words on standard error, OpenAI's words without "passes it on", off, no key, the server's `conflict`; `inbox add`
  offering AI only with a key; icon and place; `doctor`'s AI check). Changed: `inbox list`'s columns, and an agent's
  token stopping `inbox add` at `GET /v1/ai` before connecting. `npm run build` writes `dist/usual-mail.mjs` (142 kB).
- **The built command against the stand-in** (a scratch home, no real config): `ai status` (not set up), `ai set
  --gateway vercel --key-stdin`, `inbox ai on Acme` without a terminal (the words, then exit 2 naming `--yes`), with
  `--yes`, `inbox list` and `ai test` printed as the tests expect; the key was in no file under the scratch home.
- **Earlier rounds** (first milestone, fourth revision): 116 tests in 11 suites; the built command drove the joined
  story against the built server (init through the owner's file, inbox add and reconnect with a wrong password
  refused unprinted, agent add, pair, pause and resume, rate limits with `Retry-After`, doctor, agent remove, inbox
  remove); the Dockerfile's build steps were replayed outside Docker and the runtime layout passed the server's smoke
  test. Those runs used the fourth revision's server and haven't been repeated against the fifth.
- **Independent review (2026-11-17):** `npm run check` again: 154 tests in 18 suites pass; `npm run build` wrote the
  bundle. **Joined** against the fifth revision's built server (`--dev-fake-ai`, a scratch home, requests only):
  `init --server` paired through the owner's code file (removed once used); `inbox add` refused `--ai` without a key,
  refused a wrong password with the provider's words, then connected; `ai set` refused a key typed after it without
  repeating it, took a made-up key from `--key-stdin`, said it turns nothing on and showed the status the server's
  test left (`working`, AI off for every inbox); `inbox ai on` without a terminal printed the words, then exit 2
  naming `--yes`; with `--yes` turned it on; `ai pause`, `ai history 30` (asked first without `--yes`, "adds 2
  threads"), `ai resume`, `ai models`, `ai test`; `ai status` and `doctor` in key refused (the scrubbed `detail` shown);
  another service turned AI off and reset the models, a new key for the same one kept it. The key was in no file under
  the scratch home and in nothing printed. Found: piping the output into a program that stops reading early (`| head`)
  ends the command with an unhandled `EPIPE` and a stack trace (the change it made had already been sent).
- **After the review's decisions (2026-11-17):** `npm run check`: type check clean; 159 tests in 19 suites pass;
  `npm run build` wrote the bundle (147 KB). New: `ai remove` (asks first; `--yes`, `--json`; nothing to remove
  without a key), the words from core (`test/inbox-ai.test.ts` checks core's sentences whole), and output cut short
  exits quietly (`exitQuietlyOnClosedPipe` in `src/pipes.ts`: at the first write whose reader has gone, exit 0 with
  nothing printed; `test/pipes.test.ts` runs the entry point with its output closed, which printed the `EPIPE` stack
  trace before). The stand-in's AI now remembers the service when the key is removed and keeps the chosen models, as
  the server does.
- **Docker image and deploy files (2026-11-23, Docker Desktop 4.100.1, arm64):** `docker build` (native) and
  `docker buildx build --platform linux/amd64` both built; the amd64 image ran under emulation with libSQL's
  `linux-x64-gnu` binary, healthy, uid 1000. `docker compose up -d` (project `usual-mail-test`, port 8484) pulled,
  got "denied" from GHCR, built and started; `/healthz` answered; the server ran as uid 1000 with `/data` 0700 and
  its files 0600. The owner's code from the volume paired the command (`init --server`, separate
  `XDG_CONFIG_HOME`), and the code file went; `PUT /v1/google/client` wrote `google-client.json` (0600, `node`).
  `restart` and `down` then `up` kept the pairing, `secret.key` and the Google client. A non-empty volume owned by
  root (with `lost+found`, as a real disk has) made the old image exit 1 (`EACCES`); `--user 0` ran it as root;
  the new entry point gave it to `node`, including files root had written, with `secret.key` unchanged, and with
  `--user 0` still ran the server as uid 1000. `init --mode docker --port 8484` (scratch data folder and config)
  built the image `usual-mail`, ran it as 501:20 with the bind mount, paired, `stop`/`start` worked and a second
  `init` said "Nothing changed". `compose.caddy.yaml` from an empty folder with `localhost` and spare ports: HTTPS
  through Caddy's local CA, port 80 redirected (308), the command paired over HTTPS, `/v1/events` streamed through
  Caddy, and the guide's stop-copy backup restored into a fresh volume with the old token working.
  `compose.coolify.yaml` under plain Compose with Coolify-like values: healthy, key from the environment (no
  `secret.key`); with an `http://…sslip.io` address the server exits 2 and restarts forever. Idle memory: 91 MiB
  (Caddy 21 MiB). Every test container, volume, network, builder and image was removed afterwards.
- **After the review of the deploy files (2026-11-23, same Docker):** the image built with the workflow's pinned
  BuildKit v0.35.1 and SBOM scanner 1.12.1 (provenance and SBOM on), with `LICENSE` and `THIRD_PARTY_NOTICES.md` in
  `/app`; `shellcheck -s sh` clean on the entry point. Healthy as uid 1000, with no entry-point line: a fresh named
  volume; a root-owned volume with `lost+found` and a root file (given to `node`, the file's 0644 kept); the guide's
  `docker cp` restore of a backup owned 501:20 (given to `node`, `secret.key` unchanged); `--user 1000:1000`;
  `--cap-drop ALL --user 1000:1000`. `--user 1001` on a 1001-owned volume ran as 1001:0. Started as root on that
  volume, the entry point left it 1001's, printed the `--user 1001:1001` line, and the server exited 1 (`EACCES`);
  with that flag it ran. `--cap-drop ALL` as root (on `node`'s and on root's volume) and dropping only SETUID and
  SETGID each printed the `--user 1000:1000` line and exited 1; under `unless-stopped` it looped with one line per
  try. `exec -u node` and `su node -c` wrote files as `node`; a file root wrote was `node`'s after a restart.
  `USUAL_MAIL_SECRET_KEY` set to a backup's `secret.key` text was accepted. `compose.coolify.yaml` under plain
  Compose with `SERVICE_URL_USUALMAIL` and `SERVICE_URL_USUALMAIL_8484` set as Coolify sets them: `/v1/info` gave
  the redirect address `https://mail.example.org/v1/google/callback`, without the port. `docker stop` took under a
  second, exit 0. Every test container, volume, builder and image was removed afterwards.

## Not done or not verified

- **The AI commands were checked against the stand-in and, in the review of 2026-11-17, against the built server with
  fake models.** No real AI key, no request to a model. The server answers `PATCH /v1/ai` after its test, so the
  status read straight after reflects it (seen joined).
- `ai remove` was checked against the stand-in only. No question in a pseudo-terminal was tried in the last rounds
  (the prompter's hiding is tested with streams).

- **The image has run only in Docker Desktop on this Mac** (2026-11-23). Unverified: a Linux host (bind mounts with
  `--user` there, and SELinux, which needs `:Z`), Let's Encrypt through Caddy, Coolify, Render and Railway themselves,
  and the publishing workflow on GitHub. `init --mode docker` doesn't pull a published image (none exists yet).
- The bundle that stopped at start in the third round is fixed (the server's build gives it a `require`, and its
  `npm run check` starts the bundle).
- Accepted new credentials were only checked against the stand-in; no real mailbox was used.
- Interactive questions were checked in a pseudo-terminal on this Mac in the second round only; no other terminal
  or Windows.
- Node mode doesn't start the server at login (no launchd or systemd service). A stale process id could, in
  theory, name another process.
- `doctor` checks the owner's code file only when `init` set the server up on this machine; for a server elsewhere
  it can't see the data directory.
- No way to change an inbox's trust after it is added, its name or colour, agent access on its own, or anything else
  the dashboard and apps own. No question asks about saving sent mail; `--no-save-sent` and `--save-sent` set it.
- No install script, Homebrew formula, npm package or published image. The command is run from a checkout.

## For the coordinator

Nothing open: saving AI settings answers after its test (in the contract since 2026-11-17), and the words of what
leaves the server are core's.
