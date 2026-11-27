# Usual Mail

One app for all your inboxes, each sorted the way that inbox needs, on a server you run yourself.

**Status: early.** 0.1.5 is the latest release (0.1.0 was the first); much of it hasn't been tried outside this project's own tests.

## Deploy your own

Your Usual Mail server runs in your own account or on your own machine, and the apps pair with it. Wherever it runs,
connecting Gmail needs a Google client of your own ([docs/google-setup.md](docs/google-setup.md)), and sorting and
summaries need your own AI key.

**Then claim it.** A new server has no owner: open its address in a browser and set its password, and you own it.
Whoever does that first owns it, and scanners find new addresses within minutes, so either claim it at once or set
`USUAL_MAIL_OWNER_EMAIL` to your email before it first starts (the exact address your Google account shows): then only
signing in with Google as that address sets it up ([docs/deploy.md, Claiming your server](docs/deploy.md#claiming-your-server)).
If someone else claimed it first, wipe its data and deploy again. Sign in to the dashboard and the
Mac app with the address and that password ([docs/self-hosting.md](docs/self-hosting.md#5-pair-the-mac-app)); the Mac
app you build from this repository for now.

### Cloudflare (Gmail only)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/usual-labs/usual-mail)

The server runs in your own Cloudflare account, as one Worker and one Durable Object, and needs **Workers Paid** ($5
a month at least). The maintainer has deployed it to a real account with `npx wrangler deploy` (2026-11-23), where it
answered over HTTPS. **The button itself hasn't been tried yet**, and neither Google sign-in nor a sync has run on Cloudflare.
From the deploy until the variable `USUAL_MAIL_OWNER_EMAIL` is set, whoever opens the server's address first, not only
you, can claim it, and the default address (`usual-mail` on your `workers.dev` subdomain) is easy to guess. The Deploy
form can't ask for an optional value, so set `USUAL_MAIL_OWNER_EMAIL` and the secret `USUAL_MAIL_SECRET_KEY` in the
Worker's settings right after deploying. The steps, the settings and the `wrangler` way:
[docs/self-hosting.md, On Cloudflare](docs/self-hosting.md#on-cloudflare).

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/usual-labs/usual-mail)

The button reads [`render.yaml`](render.yaml): one service built from this repository's Dockerfile, on a paid
instance with a 5 GB disk at `/data` (Render's free instances sleep and have no disk). Render asks for the server's
address (`https://<your service>.onrender.com`), your email as the owner's (`USUAL_MAIL_OWNER_EMAIL`, strongly
suggested) and, optionally, your Google client, and makes the secret key itself: keep a copy of it. Render's
checker accepts the file; it hasn't been deployed on Render yet. Steps: [docs/deploy.md, Render](docs/deploy.md#render).

### Railway

No button yet: Railway's buttons open a template made in Railway's own dashboard, and none has been published for
Usual Mail. You can still set it up as one service from this repository, with a volume at `/data`:
[docs/deploy.md, Railway](docs/deploy.md#railway).

### Docker on a server of your own

On a VPS with Docker and a domain whose DNS points at it, [`compose.caddy.yaml`](compose.caddy.yaml) runs the server
behind Caddy, which gets the HTTPS certificate:

```
mkdir usual-mail && cd usual-mail
curl -fsSLo compose.yaml https://raw.githubusercontent.com/usual-labs/usual-mail/main/compose.caddy.yaml
printf 'USUAL_MAIL_DOMAIN=mail.example.org\nUSUAL_MAIL_OWNER_EMAIL=you@example.org\n' > .env && chmod 600 .env
docker compose up -d
```

Then open `https://mail.example.org` and set the server's password (with `USUAL_MAIL_OWNER_EMAIL`, after signing in
with Google as that address, which needs your Google client in `.env` too; leave the line out to claim it with a
password alone, at once). To pair the `usual-mail` command afterwards, make a pairing code on the dashboard's
**Devices and agents** page: claiming ends the owner's code.

The owner's code works too, until the server is claimed. Give the server a few seconds to start (it writes the code
once it has), then read it:

```
docker compose exec usual-mail cat /data/owner-pairing-code
```

If `cat` says there is no such file yet, wait a moment and run it again. On the first start the code is also in
`docker compose logs usual-mail`, printed once.

The file pulls the published image, `ghcr.io/usual-labs/usual-mail:latest` (amd64 and arm64), and stands alone: the
server needs no copy of the repository. DNS, the firewall, pairing, backups and updates:
[docs/deploy.md, Docker on a server of your own](docs/deploy.md#docker-on-a-server-of-your-own).

### Coolify

Paste [`compose.coolify.yaml`](compose.coolify.yaml) into a new Docker Compose resource, set an HTTPS domain and,
strongly suggested, `USUAL_MAIL_OWNER_EMAIL` before the first deploy, then open the domain and set the password.
The file pulls the published image:
[docs/deploy.md, Coolify](docs/deploy.md#coolify).

### On your own computer

`usual-mail init` sets the server up with Node or Docker and pairs the command with it. Pair the Mac app with a code
from `usual-mail pair`, then set a password in its Settings (or on the dashboard's Account page) to sign in with it
elsewhere: [docs/self-hosting.md](docs/self-hosting.md).

## What it is

- **Your existing inboxes.** Gmail first, and any mailbox over IMAP. No new address. Your mailbox stays the main
  copy of your mail; your server keeps in step with it and writes what it works out back as labels.
- **Each mail sorted by what it is.** Your server's AI, using your own AI key, tells conversations from
  newsletters, invoices, receipts, notifications and one-time codes, and sums each up in a line or two (never
  your one-time codes), so every device shows the same. Home holds the conversations that need you; your
  notifications have their own list. Before you save your AI key you see exactly what is sent and to whom; from then
  on every inbox's mail goes to it.
- **First-time senders wait for you.** Mail from someone you haven't let in waits in screening. Codes, sign-in links,
  security alerts, receipts and the like sent to you from a service whose domain your mailbox provider (Gmail)
  verified go straight to their lists (the sender still isn't let in), and mail from your other inboxes and
  colleagues at your own domain is let in.
- **Nothing happens behind your back.** Every action is recorded with who did it and can be undone. Correcting
  a category teaches that inbox a rule.
- **Your server, your data.** You run the server, you hold the AI key. Your own agent can connect too, within the
  trust you give each inbox.

## Parts

| Folder | What it is |
|---|---|
| `core/` | The shared contract: types, interfaces, routes and sample data |
| `server/` | The server |
| `mail/` | Mail providers: IMAP with SMTP, and Gmail |
| `design/` | Design tokens, fonts and icons for every interface |
| `apps/` | The Mac app and the iPhone app (the iPhone app has only run in the simulator so far) |
| `dashboard/` | The web dashboard, served by the server |
| `mcp/` | The connector for your own agent and chat apps, served by the server |
| `cli/` | The `usual-mail` command, with the Docker files at the root |
| `site/` | The website at mail.usual.dev: what Usual Mail is, its privacy policy and terms |

To run your own server and pair the Mac app with it, read [docs/self-hosting.md](docs/self-hosting.md); to run it on
a server of your own with Docker, on Coolify, Render or Railway, [docs/deploy.md](docs/deploy.md); for connecting
Gmail by signing in with Google, [docs/google-setup.md](docs/google-setup.md).

[docs/contract.md](docs/contract.md) explains how they fit together, with the server's AI in
[docs/contract-ai.md](docs/contract-ai.md) and sync and providers in [docs/contract-sync.md](docs/contract-sync.md).

## Licence

Usual Mail is free software under the [GNU Affero General Public License, version 3](LICENSE) only
(`AGPL-3.0-only`): you may use, study, change and share it under that licence. If you change it and let others use
your changed version over a network, the licence asks you to offer them its source code.

Some files come from others and keep their own licences: the fonts (SIL Open Font License), the icons (MIT), the
Public Suffix List (MPL-2.0), the list of email trackers (BSD-3-Clause and MIT) and the wallpaper (a photo from
Unsplash, under the Unsplash License).
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists them, with the packages the built parts include.

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). Contributors agree to the contributor agreement in
[CLA.md](CLA.md), which lets Usual Mail's maker also publish it under other terms, for example in the App Store. The
agreement is a draft that hasn't had a legal review yet.
