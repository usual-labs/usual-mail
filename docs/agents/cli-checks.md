# The command and the Docker files: check runs

What each pass ran and saw on this Mac (Node 22.23.2, npm 10.9.8), newest first, split out of [cli.md](cli.md) on
2026-11-24. Commands are in cli.md, "Run and check".

- **The server review of 0.1.2 (2026-11-25):** `npm run check`: type check clean, 187 tests pass. `doctor`'s advice
  for a Gmail sign-in names `inbox reconnect` (which signs in with Google again), and for a server it doesn't run the
  host's own way. No test touches ports 8484 or 8585 any more: the Google tests' scratch config and the stand-in's
  default address say 18585, and the pid-file test takes a free port.

- **`doctor` by why an inbox needs attention, and 0.1.2 (2026-11-25):** `npm run check`: type check clean, 186 tests
  pass; new `test/doctor-attention.test.ts` (each `statusReason`'s fix, and the old advice without one).

- **0.1.1 merged onto the owner's password, and two of the final check's follow-ups (2026-11-24):** `npm run check`:
  type check clean, 185 tests in 19 suites pass. New, `test/pid-file.test.ts` (4): a removal finding another
  command's newer record puts it back with a hard link, and by a rename where `linkSync` fails (EPERM), and a record
  naming this command's own process, whose command line holds the same `--data-dir`, isn't the server (`status`
  "stopped", no signal, the record gone). The last two failed with the source lines undone. Every package's
  `npm install --package-lock-only` left its lockfile unchanged.
- **The final review's last findings, and 0.1.1 (2026-11-24):** `npm run check`: type check clean, 181 tests in 19
  suites pass (176 before). New in `test/node-stop.test.ts` (real processes), each seen failing on the code before
  its fix: a `stop` held still with SIGSTOP once the server has its SIGTERM, then `start` in "another terminal" (it
  must keep the new server's record when that `stop` goes on: before, the record was gone every time; and say
  "another `usual-mail` command is stopping it", not "interrupted": checked failing on its own with only that check
  undone); a stale `<pid>\nstopping` record naming another program of this user, run as if for `<data>-other`
  (`status` "stopped", `stop` "It wasn't running." with the record gone, `start` starting the server, the program
  never signalled; before: "running"); the same naming pid 1 (before: "running", then "kill EPERM"; skipped as
  root). Passing before and after, as a guard: a server whose record is 0.1.0's (its pid alone) is seen running and
  stopped. The interrupted-stop test now also checks the word "interrupted". Five more runs of the file: 5 of 5
  pass. `test/stop.test.ts`: Docker says "killed" for a stop that ran into the deadline with `137 false`, not for a
  quick stop leaving 137 with or without OOMKilled, nor for an out-of-memory kill after the deadline (the quick one
  failed on the old launcher); `waitForStop` keeps its three minutes by the clock when checks are slow (before: 540
  s). The Ctrl-C fake test waits for the stop's SIGTERM, since `stop()` now awaits the command-line check first.
  `FakeNode.commandLine`, `FakeDocker.oomKilled`/`stopUntil`. By hand: the real 0.1.0 command (`git archive 1881044`)
  started a stand-in server (pid file `<pid>\n`), and this one said it runs, "runs already", then "Stopped." with the
  stand-in exited; the identity check, run read-only against the owner's live server, recognised it. On Docker
  29.9.3: a container in an out-of-memory restart loop, stopped with `docker stop -t 180`, took 0.30 s and was left
  `137 true`. `npm run dev -- --version` prints 0.1.1.
- **The command's stop (2026-11-24):** `npm ci` first (this checkout had no `cli/node_modules`), then the type
  check clean and 173 tests in 19 suites pass (169 before). New, `test/stop.test.ts` (4): Docker makes the container
  with `--stop-timeout 180` and stops it with `docker stop` and 180 seconds, a slow stop saying once what it waits
  for; a running container made with other settings is stopped that way before `docker rm`; Node mode leaves a process
  that takes 15 s after SIGTERM alone (no SIGKILL), saying it once; `waitForStop` gives up after exactly 180 s, says it
  once, and says nothing for a quick stop. The first three failed on the old launchers. `init.test.ts` checks the
  new run arguments and the stop call. The fakes: `FakeDocker.stopTakesMs`, `FakeNode.lingers`, and `docker stop`
  read the container's name from the last argument.
- **The re-review's fixes (2026-11-24):** `npm run check`: type check clean, 176 tests in 19 suites pass. New, each
  seen failing on the code before its fix: `test/node-stop.test.ts` runs the command from source (`node src/cli.ts`,
  a scratch home, a system PATH only) with a stand-in server process that closes its port at SIGTERM, ignores a second
  one and exits 3 s later: `start`, then `stop` interrupted with SIGINT once the server has its SIGTERM, then
  `status --json` (state "running", detail "stopping") and `start`, which must let the first server exit before the
  second starts (before: a second server started beside the stopping one, and `status` said "stopped");
  `stop.test.ts` adds `init` after an interrupted stop (fakes; before, `FakeNode.overlapped`: a second server) and
  Docker saying it was killed when the container's exit code is 137 (and not when 0). `docker stop` takes `-t 180`,
  and `FakeDocker` now refuses any other form (it caught `--time` in 7 tests), answers `{{.State.ExitCode}}` and has
  `stopKills`; `FakeNode` closes the stand-in's port at a lingering SIGTERM, ignores a second SIGTERM, forgets an
  exited process and sets `overlapped`. Against Docker 29.9.3 here, on throwaway containers: `docker stop -t 2`
  printed no warning and `--time 2` printed the deprecation; a process ignoring SIGTERM ended with exit code 137, one
  exiting on it with 0 (removed afterwards). `npm run dev -- --version` prints the version (before, `node
  src/main.ts` printed nothing).
- **The final review's Docker fixes (2026-11-24, Docker Desktop, Engine 29.9.3):** the image built from the working
  tree. The entry point, each case run with the new script and with the old one mounted over it: a `:ro` volume at
  `/data`; a `:ro` volume above the folder (`USUAL_MAIL_DATA_DIR` beneath it), with the folder missing and with it
  there; `--read-only` with the folder on the container's own filesystem; a `:ro` volume and a `:ro` bind mount at
  `/my data`. The new one gave the read-only line in all six; the old one gave it only for the first, and for the
  others `mkdir`'s or `chown`'s failure with the capabilities line. Unchanged: root's volume with another file (left
  root's, its line), `--cap-drop ALL` as root (its line), `--cap-drop ALL --user 1000:1000` (healthy). The server ran
  with its data at `/my data` (files `node`'s, `/healthz` 200). `docker stop` at rest 0.10 to 0.12 s, exit 0;
  `compose.yaml` (the local image, another port) gave the container `StopTimeout` 180 and `docker compose stop` took
  0.19 s. After the libSQL change the same day: `/app/node_modules` holds `libsql`, `detect-libc`, `@neon-rs/load` and the two
  arm64 platform packages, the licence step passed with 6 stand-ins, and the server started healthy. Every test
  container, volume, network and image was removed afterwards.
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
