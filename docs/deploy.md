# Deploying Usual Mail's server

Usual Mail's server is one program in one container image, so it runs anywhere that runs containers and keeps a
folder for it. This page covers four ways to run it on a machine that is always on: **Docker on a server of your own
(a VPS)**, **Coolify**, **Render** and **Railway**. To run it on your own computer, or in your own Cloudflare account,
read [Running your own Usual Mail server](self-hosting.md); its sections on the Google client, pairing the Mac app,
Gmail and the AI key apply wherever the server runs.

**Early.** The image is `ghcr.io/usual-labs/usual-mail` (amd64 and arm64), published from each release as its
version (`0.1.4`), its minor line (`0.1`) and `latest`. To run code that isn't released yet, build the image from a
copy of this repository (`git clone https://github.com/usual-labs/usual-mail.git`) with
`docker build -t ghcr.io/usual-labs/usual-mail:latest .` on the machine that runs it: only Docker Compose on that same
machine finds an image built there. (Render builds from the repository itself, and Railway can.) What has been tried
(2026-11-23 and 2026-11-24, Docker Desktop on a Mac): building the image for arm64 and amd64, running it with
`compose.yaml`, with `compose.caddy.yaml` (Caddy's own local certificate rather than Let's Encrypt) and with
`compose.coolify.yaml` (plain Compose, given the values Coolify would give it), pairing over HTTPS, data surviving a
restart and a new container, a backup and its restore, a volume owned by root (empty, with `lost+found`, a restore,
and one holding other files, which it leaves alone), a read-only mount (the folder's own `:ro`, also at a path with
a space, a read-only mount above it, and a container started with `--read-only`), a container without capabilities
(`--cap-drop ALL --user 1000:1000`), and stopping it while two IMAP inboxes' first syncs ran. Not tried
yet: a real VPS, Let's Encrypt, Coolify, Render and Railway themselves.

## What any host must give it

- **One copy, always on.** The server syncs mail, runs timers and keeps its database open. It must not sleep, scale
  to zero or run as two copies at once, not even for a moment during an update. Hosts that stop the old copy before
  starting the new one (as Render and Railway do for a service with a disk) are right for it.
- **A folder that persists, at `/data`.** It holds the database (`usual-mail.db` with its `-wal` and `-shm` files),
  `secret.key` (the key that seals mailbox passwords and the AI key, unless `USUAL_MAIL_SECRET_KEY` gives it),
  `google-client.json`, `settings.json`, `owner-pairing-code` while an owner's or recovery code waits, and `pictures/`.
  The server makes the folder `0700` and its files `0600`, owned by the image's `node` user (uid 1000); files copied in
  keep the modes they came with. The image starts as root only long enough to give `node` a folder that belongs to root
  (as some hosts mount it) and anything in `node`'s folder that isn't `node`'s yet, then runs the server as `node`. It
  takes a folder of root's only when it is new (empty, or holding only `lost+found`) or already holds the server's data
  (`usual-mail.db` or `secret.key`); a folder of root's with other files in it (`-v /srv:/data` by mistake) is left as
  it is, and the container stops with a line saying so. A folder that belongs to another user (a folder of yours mounted
  from the host) is left as it is: run the container as its owner with `--user`. A folder on a read-only mount (its own
  `:ro`, one above it, or a container started with `--read-only` and the folder not a volume) stops it too: the server
  must write there. **A hardened container** without the capabilities to change owners and users (`--cap-drop ALL`)
  can't do that step and stops with a line saying so; run it as `node` from the start: `--cap-drop ALL --user
  1000:1000` (in Compose, `cap_drop: [ALL]` and `user: "1000:1000"`), on a folder that is already uid 1000's. A named
  volume is, from its first start; a folder of root's isn't: start the container once without `--cap-drop`, or run
  `chown -R 1000:1000` on the folder on the host, first.
- **Outbound HTTPS, IMAP and SMTP.** HTTPS for Gmail, Google sign-in, the AI service and pictures in mail; IMAP (993
  or 143) and SMTP (465 or 587) for mailboxes connected over IMAP. Some hosts block SMTP (below); Gmail doesn't need
  it.
- **Inbound HTTPS at an address that doesn't change.** `USUAL_MAIL_PUBLIC_URL` is that address, as an origin like
  `https://mail.example.org`. It must be HTTPS unless it is this machine (`http://127.0.0.1:…`): **the server refuses
  a plain HTTP address and doesn't start.** Google sends people back to that address followed by
  `/v1/google/callback`, so register exactly that at Google ([google-setup.md](google-setup.md)). The server listens
  on port 8484 inside the container and answers `GET /healthz` when it is up.
- **`TZ` for a time zone other than UTC.** The server works in its process's time zone, so in a container UTC unless
  `TZ` names one (`Europe/Berlin`): the day each message was sent, as the AI reads it, and the times in its words, as
  an inbox that "hasn't synced since 25 Nov, 14:02 UTC". The Compose files have the line; elsewhere set it with the
  other variables.
- **Memory:** about 100 MB measured at rest; 512 MB is the minimum to give it, 1 GB is comfortable.
- **Backups** by the host's snapshots, or by stopping the server and copying `/data` (below).
- **Updates go forward only.** The server updates its database to the version's form at every start, and an older
  version may not read it afterwards. Take a backup before updating; to go back, restore it.
- **Time to stop.** Stopping waits for the mail in hand to be stored: usually a moment, but up to about two and a half
  minutes during a Gmail inbox's first sync. Docker kills a container ten seconds after asking it to stop, so the
  Compose files here give it three minutes (`stop_grace_period: 3m`); with `docker run`, add `--stop-timeout 180`.
  Stopped sooner, it loses nothing it stored: its next start fetches that mail again. Asked to stop while it is still
  starting, it ends once the start-up step in hand is done, before it fetches any mail. Not every host waits that long:
  **Coolify's Stop and Restart** give it 30 seconds ([Coolify](#coolify)); **Render** gives 30 seconds, and a
  service with a disk can't be given more ([Render](#render)); **Railway** kills it at once unless told to wait
  ([Railway](#railway)).

The Google client can come from `/data/google-client.json` (given from the Mac app) or from the variables
`USUAL_MAIL_GOOGLE_CLIENT_ID` and `USUAL_MAIL_GOOGLE_CLIENT_SECRET`, both or neither. While they are set, no app can
give another.

**A shell in the container is root's.** `docker compose exec`, Coolify's terminal, Render's Shell and `railway ssh`
run commands as root, so a file root writes in `/data` stays root's until the next start, when the image gives it
back to `node`. Reading (`cat /data/owner-pairing-code`) is fine; run anything that writes there as `node`:
`docker compose exec -u node usual-mail …`, or in a platform's shell `su node -c '…'`.

## Claiming your server

A new server has no owner. **Whoever opens its address first and sets a password owns it**, and scanners that read
new HTTPS certificates find new addresses within minutes. So either:

- **set `USUAL_MAIL_OWNER_EMAIL`** to your email before the server first starts (Render and Coolify ask for it; with
  Compose, in `.env`): the exact address your Google account shows, since it is compared as written (only upper and
  lower case don't matter; dots and a `+` part are not removed). Then the server is set up only by signing in with
  Google as that address, which needs the Google client (`USUAL_MAIL_GOOGLE_CLIENT_ID` and `_SECRET`, or the file); or
- **open the address and set the password at once**, as soon as the server is up.

Then sign in to the dashboard and the apps with that password. Claiming ends the owner's code that waited (each
host's steps below say where it is): before anyone claims the server, that code gets you in without a password; after,
the server makes a new one only when no device is paired, once the last one signs out or is removed. To pair the
`usual-mail` command after claiming, make a pairing code on the dashboard's **Devices and agents** page and run
`usual-mail init --server <the address> --code <that code>`. A server once used (a password set, a device paired, even
one since signed out, or an inbox) can never be claimed again.

**If someone else got there first,** the dashboard's sign-in says the server already has an owner. Whoever claimed it
could have set things up for later: their own AI key (the server would then send your mail's text to their AI
account), their own Google client (your Gmail sign-in would go through a client they control), agents or rules. So
**wipe the server's data and deploy it again** (the safe default): delete its volume or disk, and its secret key if the
host keeps one, then start again with `USUAL_MAIL_OWNER_EMAIL` set. **On Cloudflare** the data lives in the Worker's
Durable Object, and Cloudflare's documentation doesn't say whether deleting a Worker deletes that too, so deploy a new
Worker under a new name, which always starts with nothing stored: from your copy of the repository,
`npx wrangler deploy --name <a new name> --var USUAL_MAIL_OWNER_EMAIL:<your email>` sets the owner email in the deploy
itself; with the Deploy button, give it the new name and set `USUAL_MAIL_OWNER_EMAIL` in the new Worker's settings
before opening its address ([self-hosting.md](self-hosting.md#its-settings)). Give the new Worker its own
`USUAL_MAIL_SECRET_KEY` and Google client, register its address at Google (or move your custom domain to it), then
delete the old Worker in the Cloudflare dashboard (Workers & Pages, the Worker, Settings, Delete) and check under
Durable Objects that its `UsualMailServer` namespace went with it. If you keep it instead, choose **Forgot your
password?**: the server writes a recovery code where only its host can read it (`/data/owner-pairing-code`, read as
each host's steps below say, and its log), never on the page. Sign in with it, remove every device and agent you don't
know on the Devices and agents page, set your own password on the Account page, and before connecting an inbox check
the AI settings (set your own key or none) and the Google client (`usual-mail google`; give your own, replacing
theirs).

### Behind a proxy

Wrong passwords and pairing codes are counted per client address: ten from one address in ten minutes, and that
address waits; thirty from one IPv6 /48 (a site's whole range), and that /48 waits; a thousand from everyone, and
everyone waits. Behind a reverse proxy every connection comes from the proxy, so set **`USUAL_MAIL_TRUSTED_PROXIES`**
to the proxy's addresses (addresses and ranges separated by commas, such as `172.16.0.0/12`, or `private` for loopback
and private networks). The server then takes the client from the `X-Forwarded-For` the proxy writes (the right-most
address in it that isn't one of those proxies), and ignores that header from anyone else. Set it only when every
connection comes through those proxies. A `/0` range (`0.0.0.0/0`, `::/0`) would believe anyone's header, so the
server refuses it and doesn't start. Without the setting, every client counts as the proxy, and one client's wrong
passwords could make everyone wait for ten minutes (signed-in devices keep working). The Caddy and Coolify files set
`private`, and the Render file `private,cloudflare`; on Railway, set it yourself. Caddy and Traefik (Coolify's proxy)
write the address that reached them as the last entry, the one the server takes; Railway's edge is reported to connect
from `100.64.0.0/10`, which `private` covers. None of this has been tried on Coolify, Render or Railway.

**Behind Cloudflare's proxy** (a proxied, orange-cloud DNS record in front of Caddy or Coolify): the proxy in front
of the server is then reached from Cloudflare's edge, so the address it writes is the edge's, and every client coming
through the same edge shares one count. Set `USUAL_MAIL_TRUSTED_PROXIES=private,cloudflare`: `cloudflare` stands for
the ranges Cloudflare publishes at [cloudflare.com/ips](https://www.cloudflare.com/ips/), written into the server
(copied 2026-11-24, never fetched while it runs), so the server walks past the edge to the client Cloudflare wrote.
The proxy in between must keep Cloudflare's header too, or it writes the edge alone: Caddy ignores an incoming
`X-Forwarded-For` unless the connection comes from one of its `trusted_proxies`, so list Cloudflare's ranges there (a
`servers { trusted_proxies static … }` block in the Caddyfile's global options; only the `static` source comes with
Caddy); Traefik takes them as its entry points' `forwardedHeaders.trustedIPs` (in Coolify, the proxy's configuration).
Neither has been tried here. Trusting Cloudflare's ranges means that anything connecting from them, such as another
account's Cloudflare Worker, may be able to write the address it counts under; the ceiling of a thousand still holds.
**Render** is reported to put Cloudflare in front of every service in the same way, which is why `render.yaml` sets
`private,cloudflare`; where Cloudflare isn't in the way, `cloudflare` changes nothing. **On Railway**, `private` also
covers its private network (reported to use `fd12::/16`, inside `fc00::/7`), so another service in the same project
could connect to the server directly and write any `X-Forwarded-For`; keep services you don't trust out of the
project.

## Which to choose

| | Docker on a VPS | Coolify | Render | Railway |
|---|---|---|---|---|
| File | [`compose.caddy.yaml`](../compose.caddy.yaml) | [`compose.coolify.yaml`](../compose.coolify.yaml) | [`render.yaml`](../render.yaml) | a template made in Railway (none yet) |
| Data | the volume `usual-mail_usual-mail-data` at `/data` | a Coolify volume at `/data` | a 5 GB disk at `/data` | a volume at `/data` |
| Public address | `https://` and your domain, from `.env` | your HTTPS domain, set in Coolify before the first deploy | the `onrender.com` address or your domain, typed in once | `https://${{RAILWAY_PUBLIC_DOMAIN}}` or your domain |
| Volume's owner | `node` (a new Docker volume takes it from the image) | `node`, the same way | not known; the image handles root or `node` | root; the image gives it to `node` |
| Secret key | `/data/secret.key` | a Coolify variable | a Render variable | `/data/secret.key` |
| SMTP for IMAP inboxes | Hetzner Cloud blocks 25 and 465; DigitalOcean blocks 25, 465 and 587 | your server's provider decides | not checked | Pro plan and above only |
| Backups | stop, copy the volume, start | Coolify's volume backup, stopping containers | Render's daily disk snapshots, kept 7 days | not checked |
| Time to stop | 3 minutes (the file's) | 3 minutes for a deploy; 30 seconds for Stop and Restart | 30 seconds, not changeable with a disk | none unless `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is set (step 4) |
| Cost (2026-11) | the server: DigitalOcean from $4 a month (512 MB), Hetzner Cloud from €5.49 | Coolify is free on your own server; Coolify Cloud from $5 a month, plus the server | the smallest paid instance (`starter`) and the disk, [render.com/pricing](https://render.com/pricing) | Hobby $5 a month including $5 of use; a volume $0.15 per GB a month |

Free plans don't fit: Render's free instances sleep and have no disk, and Railway's free plan sleeps.

## Docker on a server of your own

A VPS (or any Linux machine that is always on) with Docker Engine and Docker Compose 2.23.1 or newer, 1 GB of memory,
and a domain whose DNS you control. [`compose.caddy.yaml`](../compose.caddy.yaml) runs the server behind
[Caddy](https://caddyserver.com), which gets a certificate from Let's Encrypt and renews it. It pulls the published
image and stands alone: you don't need a copy of the repository on the server.

1. **DNS:** an A record for the name you choose (say `mail.example.org`) to the server's IPv4 address, and an AAAA
   record if it has IPv6. **Firewall:** let in ports 80 and 443 (TCP, and UDP 443 for HTTP/3). Caddy needs port 80
   to get the certificate. Nothing else needs to be open; the server's own port stays inside Docker.

   **With an AAAA record, every IPv6 client counts as one.** The network Compose makes for the file is IPv4 only, so
   Docker's userland proxy takes each IPv6 connection and hands it to Caddy from the network's gateway address: Caddy,
   and so the server, sees that one address for every IPv6 client, and wrong passwords from one of them make every
   IPv6 client wait ([Behind a proxy](#behind-a-proxy)); IPv4 clients aren't affected. The fix is an IPv6 network:
   on Docker Engine 27 or newer, which gives a network an IPv6 subnet of its own when asked, add this to the end of
   the file:

   ```
   networks:
     default:
       enable_ipv6: true
   ```

   The file doesn't do this itself because creating the network then fails on a host where IPv6 is turned off or
   `ip6tables` doesn't work (Docker's own words), and on Docker older than 27 without a subnet given, so the server
   wouldn't start at all. Not tried here (only Docker Desktop on a Mac, whose networking differs); leaving out the AAAA
   record avoids it too.
2. **Files:** in a folder of its own on the server, save `compose.caddy.yaml` as `compose.yaml`
   (`curl -fsSLo compose.yaml https://raw.githubusercontent.com/usual-labs/usual-mail/main/compose.caddy.yaml`), and
   beside it a file `.env` (readable only by you: `chmod 600 .env`):

   ```
   USUAL_MAIL_DOMAIN=mail.example.org
   # Strongly suggested: only signing in with Google as this address sets the server up (it needs the client below).
   # Leave it out to set the password at once instead (Claiming your server, above).
   USUAL_MAIL_OWNER_EMAIL=you@example.org
   # Optional, for Gmail by signing in with Google (docs/google-setup.md); or give the client from the Mac app.
   # USUAL_MAIL_GOOGLE_CLIENT_ID=…
   # USUAL_MAIL_GOOGLE_CLIENT_SECRET=…
   ```

3. **Start it:** `docker compose up -d`. `docker compose logs caddy` shows the certificate being issued;
   `curl https://mail.example.org/healthz` answers `{"ok":true}`.
4. **Claim it:** open `https://mail.example.org` and set the server's password (after signing in with Google as the
   owner email, when `.env` names one). Sign in to the dashboard and the apps with it
   ([self-hosting.md](self-hosting.md#5-pair-the-mac-app)). To pair the `usual-mail` command on your own computer
   afterwards, make a pairing code on the dashboard's **Devices and agents** page and run
   `usual-mail init --server https://mail.example.org --code <that code>`. Claiming ends the owner's code. Before
   anyone claims the server, it gets you in without a password instead:

   ```
   docker compose exec usual-mail cat /data/owner-pairing-code
   usual-mail init --server https://mail.example.org --code <that code>
   ```

   The server writes the file a few seconds after it starts; if `cat` finds no such file yet, wait a moment and run
   it again. The code is in `docker compose logs usual-mail` too, once, when the server makes it.
5. **Google:** register `https://mail.example.org/v1/google/callback` as the client's redirect address at Google.
   `usual-mail google` says whether the server has its client and which address it expects.

**Update:** back up first, then `docker compose pull && docker compose up -d`. To stay on one version, write it in
place of `latest` in the image's tag (`ghcr.io/usual-labs/usual-mail:1.2.3`) and change it when you choose.

**Back up** by stopping the server for a moment and copying its folder:

```
docker compose stop usual-mail
docker compose cp usual-mail:/data ./usual-mail-backup-$(date +%F)
docker compose start usual-mail
```

Copy that folder off the server. It holds `secret.key` with the sealed passwords, so keep it as safe as a password.
Copying the files while the server runs can catch the database half-written; a snapshot of the whole VPS from its
provider is the other safe way. **Restore** into a fresh volume:

```
docker compose down
docker volume rm usual-mail_usual-mail-data
docker compose create
docker compose cp ./usual-mail-backup-<date>/. usual-mail:/data
docker compose up -d
```

`docker compose cp` keeps the copied files' own user and group (a backup made on a Mac arrives as `501:0`, its owner
there); the image gives them back to `node` when it starts. They keep the modes they had in the backup: if something
on the way made them readable by others, the server makes `secret.key` private again itself, but leaves Google
sign-in off while others can read `google-client.json` (`docker compose logs usual-mail` says so); fix it with
`docker compose exec -u node usual-mail chmod 600 /data/google-client.json`.

**Moving to another host:** the server uses `/data/secret.key` only when `USUAL_MAIL_SECRET_KEY` isn't set, and the
data can't be read without the key it was sealed with, so the key moves with the data, before the first start with
the restored data:

- **To a host that sets the variable** (Coolify and Render make one): set it to the text of the backup's
  `secret.key`; the server takes that text as it is. On Coolify the variable to change is
  `SERVICE_REALBASE64_32_SECRETKEY` (the file passes it on as `USUAL_MAIL_SECRET_KEY`); on Render,
  `USUAL_MAIL_SECRET_KEY`. Otherwise the host's new key wins, and no inbox and no AI key can be opened.
- **From a host that sets the variable** (a backup from Coolify or Render has no `secret.key`) to one that keeps the
  key in `/data` (Docker on a VPS, Railway, your own computer): write the old host's key into the backup folder as
  `secret.key` before copying the folder in, readable only by you:
  `printf '%s\n' '<the old key>' > ./usual-mail-backup-<date>/secret.key` and
  `chmod 600 ./usual-mail-backup-<date>/secret.key`. Otherwise the server makes a new key at its first start.
- **Between two hosts that set the variable:** copy the old host's value into the new host's variable.

**Mail providers that block sending.** Some VPS providers block outgoing SMTP to stop spam: Hetzner Cloud blocks ports
25 and 465 (it may lift that on request for an established account), and DigitalOcean blocks 25, 465 and 587 on
every Droplet. That only affects inboxes connected over IMAP, which send through their SMTP server; Gmail sends
through Google's API over HTTPS and isn't affected. On such a host, use port 587 where it is open, or choose another
provider for IMAP inboxes.

**Another proxy instead of Caddy** (nginx, Traefik, or one you already run): use [`compose.yaml`](../compose.yaml),
which publishes the server on `127.0.0.1:8484` for the proxy, and set `USUAL_MAIL_PUBLIC_URL` there. The proxy must
pass the `Host` header through (the web dashboard marks its sign-in cookie `Secure` only when it sees the public name,
not `127.0.0.1`; nginx sends its upstream's address unless told `proxy_set_header Host $host`), set
`X-Forwarded-Proto: https` (or the dashboard's sign-in page warns that it isn't on HTTPS), and not buffer
`GET /v1/events`, a stream of server-sent events (the server sends `X-Accel-Buffering: no` for nginx, and a comment
every 25 seconds; keep the proxy's read timeout above that). Caddy does all three by itself. Have the proxy set
`X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $remote_addr`) and set `USUAL_MAIL_TRUSTED_PROXIES:
private` in `compose.yaml`'s `environment` ([Behind a proxy](#behind-a-proxy)): with the port published on
`127.0.0.1`, only this machine's proxy reaches the server.

## Coolify

[Coolify](https://coolify.io) runs containers on your own server and gives each one a domain and HTTPS.
[`compose.coolify.yaml`](../compose.coolify.yaml) is written for Coolify v4 and checked with plain Docker Compose; it
hasn't run on Coolify itself yet. It pulls the published image.

1. Point a domain's DNS at the Coolify server, as for a VPS.
2. In Coolify: **New Resource**, then **Docker Compose Empty**, and paste the file.
3. **Before the first deploy**, open **Domains** for the `usualmail` service and enter your domain with HTTPS and the
   server's port: `https://mail.example.org:8484` (the port tells Coolify where to send requests; the address people
   use stays `https://mail.example.org`). **Don't keep the address Coolify makes up** (an `sslip.io` name): it is plain
   HTTP, which the server refuses, so the container would stop at every start.
4. Under Environment Variables, set `USUAL_MAIL_OWNER_EMAIL` to your email (strongly suggested: [Claiming your
   server](#claiming-your-server)), and optionally `USUAL_MAIL_GOOGLE_CLIENT_ID` and `USUAL_MAIL_GOOGLE_CLIENT_SECRET`.
5. **Deploy,** then open `https://mail.example.org` and set the server's password. Before anyone claims it, the
   owner's code also gets you in: in the service's log, or in its terminal with `cat /data/owner-pairing-code`, for
   `usual-mail init --server https://mail.example.org --code <that code>`. After claiming, pair the command with a
   code from the dashboard's **Devices and agents** page instead.

Coolify fills `USUAL_MAIL_PUBLIC_URL` from the domain without the port (`SERVICE_URL_USUALMAIL`). The file also
names `SERVICE_URL_USUALMAIL_8484`, which tells Coolify's proxy the port, but that variable's value keeps the port
(`https://mail.example.org:8484`, in Coolify v4.7.6's source and tests), where nobody reaches the server, and Google
would refuse it as the sign-in's return address. Coolify also makes the secret key once
(`SERVICE_REALBASE64_32_SECRETKEY`, 32 random bytes in base64). **Copy that key somewhere safe** from Environment
Variables, and never change it: a backup of the volume doesn't hold it, and the data can't be read without it.
There is no `ports:` in the file: Coolify's proxy reaches the server inside Docker and serves HTTPS. The image's own
health check tells Coolify when it is up.

**Backups:** under the service's persistent storage, schedule a backup of the volume with **Stop containers during
archive**, so the database isn't copied half-written (Coolify's documentation describes this for volume mounts; not
tried here with a Compose resource). Or stop the service and copy the volume by hand. **Updates:** take a backup,
then redeploy so Coolify pulls the image again, or pin a version in the image's tag and change it.

**Stop and Restart cut a first sync short.** A deploy goes through Docker Compose and gives the server the file's
three minutes to stop, but Coolify's own **Stop** and **Restart** don't use it: they give it 30 seconds (10 for a
resource of more than five containers), then remove the container (Coolify v4.7.6, its latest v4 release when this
was checked: `app/Actions/Service/StopService.php`, which `RestartService.php` reaches through `StartService.php`'s
stop before starting; a restart that pulls the latest images skips that stop and goes through Docker Compose, as a
deploy does). Pressed while an inbox's first sync runs, they can cut off the batch of mail being fetched. Nothing
stored is lost, but that batch is fetched again at the next start. To restart then, redeploy instead.

## Render

[`render.yaml`](../render.yaml) is a Render Blueprint: one web service built from this repository's Dockerfile, on
the `starter` instance (0.5 CPU, 512 MB), with a 5 GB disk at `/data`, its health check on `/healthz`, and no
deploy at every change to the repository (`autoDeployTrigger: "off"`). Render's own checker accepted it
(2026-11-23); it hasn't been deployed.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/usual-labs/usual-mail)

The button makes a Blueprint from this repository. To deploy your own copy (a fork) instead: in Render, **New**,
then **Blueprint**, and choose it.

1. Render asks for the variables marked `sync: false`. **`USUAL_MAIL_PUBLIC_URL`:** the service's address,
   `https://<your service>.onrender.com`, from the name you give it; if Render gives the service another address
   (the name is taken), change the variable under **Environment** once it exists (the service restarts). The two
   Google variables are optional.
2. Render makes `USUAL_MAIL_SECRET_KEY` once (256 random bits in base64). **Copy it somewhere safe** and never
   change it: the disk's snapshots don't hold it.
3. Once it is live, open `https://<your service>.onrender.com` and set the server's password (after signing in
   with Google, when you gave `USUAL_MAIL_OWNER_EMAIL`: Render asks for it, strongly suggested). Before anyone claims
   it, the owner's code also gets you in: in the log, or in the service's **Shell** with
   `cat /data/owner-pairing-code`, for `usual-mail init --server https://<your service>.onrender.com --code <that code>`.
   After claiming, pair the command with a code from the dashboard's **Devices and agents** page instead.
4. For a domain of your own, add it under **Custom Domains**, then set `USUAL_MAIL_PUBLIC_URL` to it and register
   the new redirect address at Google.

A service with a disk runs as one instance and is down for a moment at each deploy, which the server needs. Render
snapshots the disk every day and keeps each snapshot for seven days; restore one from the disk's page. **Updates:**
take a backup, then **Manual Deploy** with the latest commit; Render builds the image from the repository.

**A deploy or restart during a first sync can cut it short.** Render sends the server SIGTERM and kills it 30
seconds later, and a service with a disk can't be given longer: Render's `maxShutdownDelaySeconds` (up to 300
seconds) doesn't apply to one ([Render: deploys](https://render.com/docs/deploys),
[Render: disks](https://render.com/docs/disks), [Blueprint reference](https://render.com/docs/blueprint-spec)), so
`render.yaml` doesn't set it. Nothing stored is lost, but the batch of mail being fetched is fetched again at the
next start. To be safe, deploy when no inbox's first sync runs (`usual-mail inbox list` shows one in progress).

## Railway

Railway's templates are made in its dashboard, not from a file in the repository. **There is no Usual Mail template
yet**, and nothing here has been tried on Railway; Railway's buttons open a template, so the README has none until
it exists. To run it now, or to
make the template, set up one service:

1. **New Project**, then **Deploy a Docker Image**: `ghcr.io/usual-labs/usual-mail:latest` (or a GitHub repository,
   which Railway builds from the Dockerfile).
2. **Volume:** add one to the service, mounted at `/data`. Railway's volumes belong to root; the image gives the
   folder to `node` when it starts, so `RAILWAY_RUN_UID` isn't needed. (Railway's documentation suggests
   `RAILWAY_RUN_UID=0` for images that run as another user; this image starts as root and drops to `node` itself.
   Tested with a volume owned by root; not on Railway.)
3. **Networking:** generate a domain for the service with target port **8484**, or add your own.
4. **Variables:** `USUAL_MAIL_PUBLIC_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}` (or your domain with `https://`);
   `USUAL_MAIL_OWNER_EMAIL`, your email (strongly suggested: [Claiming your server](#claiming-your-server));
   `USUAL_MAIL_TRUSTED_PROXIES` = `private` ([Behind a proxy](#behind-a-proxy));
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` = `180`, the time to stop; optionally the two Google variables. Railway's
   default for the time between SIGTERM and SIGKILL is 0 seconds
   ([Railway: variables](https://docs.railway.com/reference/variables),
   [Railway: deployment teardown](https://docs.railway.com/guides/deployment-teardown), which says it can also be
   set in the service's Settings), so without it a redeploy during a first sync cuts off the batch being fetched
   (fetched again at the next start). Railway's pages give no maximum. The secret key stays in the volume
   (`/data/secret.key`); to keep it apart from the data instead, set `USUAL_MAIL_SECRET_KEY` to 32 random bytes in
   base64 (`openssl rand -base64 32`) before the first start, and never change it.
5. **Settings:** health check path `/healthz`; one replica (Railway allows no more with a volume).
6. Deploy, then open the address and set the server's password. Before anyone claims it, the owner's code also gets
   you in: in the deploy log, or `railway ssh`, then `cat /data/owner-pairing-code`. After claiming, pair the command
   with a code from the dashboard's **Devices and agents** page instead.

It needs the Hobby plan or above: the free plan sleeps. **Railway allows SMTP only on Pro and above**, so on Hobby
inboxes connected over IMAP can't send; Gmail can. A service with a volume is down for a moment at each redeploy.

**Making the template** (the maintainer): set up the service as above with
`USUAL_MAIL_PUBLIC_URL` referring to `RAILWAY_PUBLIC_DOMAIN`, publish it as a template, and put its address in the
README's Railway button.
