# Running your own Usual Mail server

Usual Mail's apps talk to a server you run yourself. It keeps a copy of your mailboxes, sorts them, and, if you
choose, runs AI on them with your own AI key. This page takes you from nothing to the Mac app paired with your
server and your Gmail connected: on a computer of your own (sections 1 to 8), or in your own Cloudflare account
([On Cloudflare](#on-cloudflare), below). On a VPS with Docker, Coolify, Render or Railway: [deploy.md](deploy.md).

**Usual Mail is early and not released.** Everything below is built, but much of it hasn't been proven outside this
project's own tests: the Docker image has run only on a Mac, the Cloudflare version has been deployed once and has
not yet connected a mailbox there, signing in with Google has worked once (the maintainer's own Gmail, 2026-11-17),
and real AI models have run only on the maintainer's own server, through Vercel's AI Gateway (never with an OpenAI or
Anthropic key of their own). Expect rough edges, and keep your mailbox's own app at hand.

## 1. What you need first

- **A computer that stays on** while you want your mail sorted: your Mac is fine to start with. The server only
  works while it runs.
- **Node.js 22.18 or newer** (`node --version` says which you have), or **Docker** if you prefer containers.
- **Outbound access to the web** (http and https, ports 80 and 443) for the server, beside your mail provider and AI
  service: it fetches the pictures in your mail for your apps (see "Pictures in your mail" below). Without it, mail
  still works and pictures from the web don't show.
- **A copy of Usual Mail's repository** on that computer. There is no installer yet: you build the `usual-mail`
  command and the server from it.

In the repository's folder, build the command:

```
cd cli && npm install && npm run build && cd ..
alias usual-mail="node $PWD/cli/dist/usual-mail.mjs"
```

(The alias lasts until you close the terminal; add it to your shell's settings to keep it.) `usual-mail --help`
lists every command, and `usual-mail <command> --help` explains one.

## 2. Get the server running

`usual-mail init` sets up a server on this computer, starts it, waits until it answers, and pairs the command with
it. In a terminal it asks how to run the server, where to keep its data, which port to use, and how many days of mail
a new inbox's first sync takes (below). Running it again with the same settings changes nothing.

**With Node** (the way this project has tried):

```
for part in core mail dashboard mcp server; do (cd $part && npm install); done
(cd server && npm run build)
usual-mail init --mode node
```

**With Docker** (tried with Docker Desktop on a Mac):

```
usual-mail init --mode docker
```

From a copy of the repository it builds the image the first time. `compose.yaml` is there for people who prefer
Docker Compose; its comments say how to pair with it.

Either way, by default:

- the **data** lives in `~/.local/share/usual-mail` (`--data-dir` chooses another folder). It holds your mail, the
  sealed passwords and keys, and the key that seals them, all readable only by you. Back it up: losing it means
  connecting every inbox and setting the AI key again. Its `pictures` folder holds copies of the pictures your mail
  showed (at most 256 MB; a copy goes after 30 days unseen, and an inbox's go when you remove it); it needn't be
  backed up.
- the server listens on **port 8484** (`--port` chooses another), at `http://127.0.0.1:8484`.
- a new inbox's **first sync takes the last 30 days** of its mail (`--sync-days` chooses another number). When you
  connect an inbox, the server first copies that much of its mail and sorts it; older mail stays in your mailbox, and
  new mail always arrives.

**The first sync's days are kept with the server's data,** in `settings.json` in its data directory, so every
`usual-mail start` uses them, with Node and with Docker alike. `usual-mail sync-days` says the number, and
`usual-mail sync-days 7` changes it and restarts the server so it takes effect:

- **Fewer days** take effect at once, also for an inbox whose first sync is still running: it stops fetching mail
  older than that, and what it fetched already stays.
- **More days** apply to inboxes you connect from then on. An inbox already connected keeps the mail it has: fetching
  more for it would be a new first sync, which only removing the inbox and connecting it again starts (and removing
  it deletes its rules and history on the server).

`USUAL_MAIL_SYNC_DAYS`, set where the server starts, wins over the saved number; with Docker Compose, set it in
`compose.yaml`. `usual-mail status` and `usual-mail doctor` show the number the server uses.

Afterwards:

| To | Run |
|---|---|
| Stop it | `usual-mail stop` |
| Start it again | `usual-mail start` |
| See whether it runs and answers | `usual-mail status` |
| Read its log | `usual-mail logs` (`--follow` keeps showing new lines) |
| Check everything and hear what to fix | `usual-mail doctor` |
| See or change how many days a first sync takes | `usual-mail sync-days`, `usual-mail sync-days <days>` |

With Node, the server doesn't start by itself when the computer restarts yet: run `usual-mail start`. With Docker it
starts with Docker until you stop it.

## 3. Who can reach it

**By default only this computer can reach the server:** it listens on `127.0.0.1`. That is the safe start, and it is
enough for the Mac app on the same Mac.

To use it from your phone or another computer, never open the port to every network. Instead:

- use a private network between your own devices, such as Tailscale or WireGuard, and make the server reachable on
  that network's address only; or
- put a reverse proxy that serves HTTPS (Caddy, nginx or Traefik) in front of it, and keep the server itself on
  `127.0.0.1` for the proxy to reach.

Pairing codes and tokens must never travel without HTTPS outside a private network. `usual-mail doctor` warns when
other devices can reach the port. Only Caddy has been tried, on one Mac ([deploy.md](deploy.md)).

### Pictures in your mail

Your apps never load a picture from the web themselves. The server fetches a picture the first time you open a
message, takes tracking pictures out before that (those on its list of known trackers, and invisible ones), and keeps
a copy, so opening it again tells the sender nothing. Mail from senders you haven't let in, and from senders you
blocked, shows no pictures from the web until you let them in.

What it doesn't hide: the first time you open a message, a picture made for you alone that isn't a known tracker still
tells its sender you opened it, and when. The site sees the server's address: if the server runs at home, that is your
home's address; if it runs on a rented server, it is that server's address, the same for every sender. Links in mail
still tell their sender when you click them.

The server fetches only pictures that appear in your mail, never from your own network or the computer it runs on,
and never more than 10 MB or 15 seconds for one. A picture it refuses shows blank and isn't asked for again; one
whose site keeps failing is tried at most three times. It looks names up with your DNS servers, not your hosts file.

## 4. Give the server its Google client (for Gmail)

To connect Gmail by signing in with Google, the server needs a Google OAuth client that you create once, in your own
Google Cloud project, and give to the server. [Setting up Sign in with Google](google-setup.md) says each step: what to
create at Google, which redirect address to register, which scope, who to add as a test user, and how to give the
client to the server (`usual-mail google set --file <the file Google downloads>`). `usual-mail google` says whether
your server has it. If it says the file doesn't list the server's address, that is a hint, not a fault: the file
may be older than a change you made at Google; check the address there only if Google refuses a sign-in.

To have an AI agent that controls your browser do the clicking at Google, give it the prompt in
[Setting up the Google client with a browser agent](google-setup-agent.md) (not yet run from start to finish).
`usual-mail google prompt` prints it with your server's redirect address filled in.

You can skip this and connect Gmail with a client id, secret and refresh token you made yourself, or connect any
other mailbox over IMAP.

## 5. Pair the Mac app

The app needs the server's address and a pairing code, or the server's password once it has one.

- **The address:** `http://127.0.0.1:8484` when the app runs on the server's Mac (with another port, that port).
- **A pairing code:** run `usual-mail pair`. It prints a code that works once, for 15 minutes.
- **The password:** `usual-mail init` paired the command with the server, so the server has an owner but no password
  yet. Once the app is paired, set one in the app's **Settings**, **Accounts** (or on the dashboard's **Account**
  page): from then on the app on another Mac, the iPhone app and the dashboard sign in with the address and it.

In the Mac app, press **Get started**, choose **Your own server** and press **Continue**. Under **Connect to your
server**, enter the address as **Server address**, press **Use a pairing code instead**, enter the code as **Pairing
code**, and press **Connect**. With a password set, enter it as **Password** instead.

**A server set up without `init`** (with Compose, or on a host in [deploy.md](deploy.md)) has no owner at first:
whoever opens its address and sets its password first owns it, in a browser or in the app (**Connect** with a new
password offers **Set up your server**: type it twice, and an email if you like). On a server others can reach, do
it at once, or set `USUAL_MAIL_OWNER_EMAIL` to your email before it first starts: then only signing in with Google
as that address sets it up ([deploy.md](deploy.md#claiming-your-server)).

**Forgot the password?** On a device that is still signed in, set a new one: the dashboard's **Account** page, or
Settings, Accounts, in the app. With none at hand, open the address in a browser and choose **Forgot your
password?**: the server writes a recovery code where it writes the owner's code (below), never on the page. Sign in
with it, then set a new password.

**The owner's code.** Whenever no app or browser is paired, the server makes an owner's pairing code and writes it to
`owner-pairing-code` in its data directory, readable only by you. A new one is made when it expires unused (after 24
hours) and whenever the last app or browser is removed, so you are never locked out. The server prints a code in its
log once, when it makes it; when it starts again while the code still waits, its log only says so and where the file
is. So read the code from the file, not from `usual-mail logs`. `usual-mail init` pairs the command with it, which is
why the app then needs a code from `usual-mail pair`. If you set the server up without `init` (with Compose, say),
set its password as above, or pair the app with the owner's code from the file (`compose.yaml` says how to read it).

You can also open the server's address in a browser on the same computer for its dashboard, and sign in there with the
password or a pairing code.

## 6. Connect Gmail

Right after pairing, the Mac app asks **How much old mail?**: the last 7 days (recommended) or the last 30 days of the
mail already there, brought in when an inbox is connected, and every bit of it sorted and summed up with your AI key.
Then it shows **Connect your Gmail**: press **Sign in with Google** (and **Add another Gmail** for more, then
**Continue**). Or run:

```
usual-mail inbox add --provider gmail
```

Your browser opens Google's sign-in. Choose the account; Google warns that it hasn't verified the app (your own client
in Testing isn't verified; continue past it); allow Usual Mail to read, compose and send your email. A page from
your own server then says "Gmail is connected"; go back to Usual Mail. The browser must be on the server's computer
when the server's address is `127.0.0.1`.

**Every week:** while your Google client's consent screen is in Testing, Google ends the sign-in after seven days.
The inbox then says it needs attention; sign in again in place: in the Mac app's **Settings**, under **Inboxes**,
press **Sign in with Google again…** on that inbox, or run `usual-mail inbox reconnect <inbox>`. Its rules and history
stay. (**Add Gmail…** there connects another Gmail later.)

Other mailboxes: `usual-mail inbox add --provider imap` asks for the IMAP and SMTP servers and the password.
**IMAP inboxes are not yet safe for real mail:** use them only to try Usual Mail out, with a mailbox that holds
nothing that matters, until the known issues for IMAP are fixed (Gmail inboxes aren't affected).
`usual-mail inbox list` shows each inbox and how its first sync goes: it says "connecting" until the first sync is
done, which can take a few minutes for a busy mailbox.

## 7. Your AI key

The server can sort each mail by what it is (a conversation, a newsletter, an invoice and so on) and sum it up in a
line, with an AI key of your own: Vercel's AI Gateway, OpenAI or Anthropic.

In the Mac app, the step after Gmail is **Add your AI key**: a Vercel AI Gateway key, then **Save and test**. The AI
sorts and sums up all the mail the server brings in that isn't archived. From the command line:

```
usual-mail ai set
```

asks which service, shows exactly what is sent and to whom, asks for your yes, and only then asks for the key
(unseen). **Saving the key is your yes for every inbox's mail, now and later:** there is no switch per inbox. In
short, for each thread: to sort it, the subject, the newest incoming message's sender and its text (up to 4,000
characters); to sum it up, the subject and the messages' text (up to 8,000 characters), with every email address
removed. Never attachments, pictures, other
recipients, your passwords, your rules, anything from a sender you blocked, spam, or threads that are done or in the
trash. One-time codes are never summed up. The whole list is in the contract's
[what leaves the server](contract-ai.md#what-leaves-the-server). `usual-mail ai status` says how the AI is doing;
`usual-mail ai pause` stops sending for a while; `usual-mail ai remove` removes the key, and nothing more is sent.

## 8. When something goes wrong

Start with:

```
usual-mail doctor
```

It checks the settings, the server, the pairing, the data directory's permissions, each inbox, the first sync's
days, the AI, Google sign-in and who can reach the port, and says what to fix. Then:

- `usual-mail status` and `usual-mail logs` when the server doesn't answer or stopped;
- `usual-mail inbox list` for an inbox that needs attention, with its reason; `usual-mail inbox reconnect <inbox>`
  gives it new credentials or signs it in with Google again;
- `usual-mail ai status` when there are no summaries.

## On Cloudflare

Instead of a computer of your own, the server can run in your own Cloudflare account: one Worker in front of one
Durable Object that holds the whole server, with your mail in the object's own storage. Your apps reach it from
anywhere, over HTTPS, at its Cloudflare address.

**Deployed once, and not yet used with mail there.** Everything in this section is built and tested in Cloudflare's
runtime on this project's own machine. On 2026-11-23 the maintainer deployed it to a real Cloudflare account with
`npx wrangler deploy`, where it answered over HTTPS; Google sign-in, a sync and the AI haven't run on Cloudflare yet,
and the Deploy button hasn't been tried ([what hasn't been tried](#what-hasnt-been-tried-on-cloudflare)). It connects
**Gmail only**.

### What you need for Cloudflare

- **A Cloudflare account on Workers Paid** ($5 a month at least). For one person with three Gmail inboxes and 150
  messages a day, Cloudflare's prices (read 2026-11-21) give that minimum until the server stores 5 GB, then $0.20 a
  GB a month; this is an estimate, not measured. The Free plan lets each wake-up use 10 ms of CPU and 50 requests to
  other sites, far less than a sync needs; deploying to it hasn't been tried.
- **Node.js 22.18 or newer and a copy of the repository** on any computer, to deploy with Cloudflare's `wrangler`
  command (below). Or the README's Deploy to Cloudflare button, which sets the Worker up from a copy of this
  repository in your own GitHub account and needs neither; it hasn't been tried yet.
- **A Google Cloud project of your own** for the Google client (below), and the Mac app.

Before deploying, in the Cloudflare dashboard: give your account a **workers.dev subdomain that isn't your name**
(it is part of the server's address, and may be shown to the sites pictures in your mail come from, below); and if
you want to watch the cost, use a usage alert, **not a Durable Objects spending limit**, which pauses the objects
when reached and so stops your mail server.

### Deploy it

In the repository's folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

`npm ci` installs the server's parts as well (each from its own lockfile, only where nothing is installed yet) and
prepares its database migrations. `npx wrangler deploy` (or `npm run deploy`) bundles the server, uploads it as the
Worker `usual-mail` with its Durable Object, and prints its address, `https://usual-mail.<your subdomain>.workers.dev`.
Nothing asks for a secret.

**Updating:** bring your copy up to date with this repository and run `npx wrangler deploy` again. The deploy
restarts the server, which upgrades its store when it starts. Variables you set in the Worker's settings survive each
deploy.

### Its settings

All optional, set in the Cloudflare dashboard in the Worker's settings, as variables or secrets (a secret also with
`npx wrangler secret put <name>`). The server reads them when it starts; saving one deploys the Worker again, which
restarts the server. A value it can't use is left out with a line in its log, and it still starts; except a
`USUAL_MAIL_SECRET_KEY` that isn't 32 bytes in base64: then the server doesn't start (it answers 503), and its log
says why.

| Name | Kind | What it does |
|---|---|---|
| `USUAL_MAIL_SECRET_KEY` | secret | 32 random bytes in base64 (`openssl rand -base64 32`) that seal your mailboxes' sign-ins, the AI key and the Google client. Recommended: see below |
| `USUAL_MAIL_PUBLIC_URL` | variable | A custom domain's address, as `https://` and the name only (`https://mail.example.org`, no path). Not needed for the workers.dev address |
| `USUAL_MAIL_TIME_ZONE` | variable | The server's time zone, a name like `Europe/Berlin`, instead of the one it takes when you pair (below) |
| `USUAL_MAIL_SYNC_DAYS` | variable | How many days of mail a new inbox's first sync takes, 1 to 36,500. It wins over the number chosen in the app; with neither, 30 |
| `USUAL_MAIL_GOOGLE_CLIENT_ID` and `USUAL_MAIL_GOOGLE_CLIENT_SECRET` | secrets | Your Google client, both or neither, instead of giving it from the app. While they're set, no app can give another |
| `USUAL_MAIL_OWNER_EMAIL` | variable or secret | Your email: the server is then set up only by signing in with Google as this address (it needs the Google client). Strongly suggested; set it before you first open the address. One that isn't an email address keeps the server from being set up at all (the owner's code still pairs) |

**The secret key.** Without `USUAL_MAIL_SECRET_KEY`, the server makes a key when it first starts and keeps it in its
own storage, beside what it seals. **Set the secret before you first open the server's address** (that first request
starts the server), or at least before you connect an inbox, set the AI key or give the Google client: set later,
the server can't open what it sealed before, so every inbox needs connecting again, the AI key setting again and the
Google client giving again. Keep a copy of the value somewhere safe: Cloudflare never shows a secret again. To switch
later without losing anything, the key the server made (`usual-mail-secret-key` in its `_cf_KV` table, in Data
Studio, below) can be copied into the secret; how Data Studio shows that value hasn't been seen.

### Its address

The server's address is its workers.dev address, `https://usual-mail.<your subdomain>.workers.dev`, or a custom
domain of yours. Only these: after you sign in, Google sends your browser back to the address your request came to,
and the server takes as its own only its workers.dev address and the one in `USUAL_MAIL_PUBLIC_URL`, so no other name
pointed at it can receive your Google sign-ins. At any other address it still answers, but Google sign-in is off
there and the app says so in the server's words. Plain `http://` is refused (403), so codes and tokens travel only
over HTTPS; the Worker's version and preview addresses are off.

**A custom domain** (one whose DNS is on your Cloudflare account): add it to the Worker as a custom domain, set
`USUAL_MAIL_PUBLIC_URL` to its address, and register its redirect address at Google as well. The workers.dev address
keeps working.

### The first pairing code

**The easier way:** set `USUAL_MAIL_OWNER_EMAIL` (below) to your email in the Worker's settings first, then open the
server's address and set its password, and sign in to the apps with it. Without that variable, whoever opens the
address first and sets a password owns the server, and new addresses are found within minutes
([deploy.md](deploy.md#claiming-your-server)). The Deploy form can't ask for it: Cloudflare makes every value it asks
for required. A recovery code ("Forgot your password?") waits in the same table as the owner's code, and is never
written to the log.

The owner's code still works:

1. Open the server's address in a browser. The first request starts the server, which makes an owner's pairing
   code. The page, the dashboard's sign-in, says where the code waits; the code is never written to the log.
2. In the Cloudflare dashboard, go to **Durable Objects**, this Worker's namespace for the class `UsualMailServer`,
   **Data Studio**, the object named `server`, and the table `owner_pairing_code`. `code` is the code; `expires_at`
   says until when it works (in UTC, 24 hours after it was made).
3. In the Mac app, press **Get started**, choose **Your own server** and press **Continue**. Under **Connect to your
   server**, enter `https://usual-mail.<your subdomain>.workers.dev` as **Server address** and the code as **Pairing
   code**, and press **Connect**.

The code works once. A new one is made when it expires unused and whenever the last app or browser is removed. An
expired code can stay in the table until the server next starts: open the address again and it is replaced (pairing
with the old one is refused in words, not counted as a wrong code).

**Another device** needs a code from one already paired: the dashboard's **Devices and agents** page (sign in at the
server's address with a code), or the command, paired with `usual-mail init --server <the address> --code <code>`,
then `usual-mail pair`. The Mac app can't make a code yet. After five wrong codes from one network address in ten
minutes, the server refuses pairing from it for a while; ten in ten minutes from anywhere stop all pairing for a while
(paired devices keep working).

**The time zone.** The pairing of your first device gives the server its time zone, from where Cloudflare sees that
request come from (behind a VPN, the VPN's); later pairings don't change it. Until then the server works in UTC.
`USUAL_MAIL_TIME_ZONE` sets one instead.

### Google sign-in on Cloudflare

The server needs your Google client as in section 4 and [Setting up Sign in with Google](google-setup.md), with two
differences:

- **The redirect address to register** at Google is `https://usual-mail.<your subdomain>.workers.dev/v1/google/callback`,
  and with a custom domain also `https://<your domain>/v1/google/callback`. Whether Google's console takes a
  workers.dev address hasn't been tried; a custom domain is the way round it if not.
- **Give the client from the app**, not with `usual-mail google set`, which writes a file on the server's own computer.
  While the server has none, the app's **Connect your Gmail** step shows a guided set-up where **Sign in with Google**
  would be: **Let my agent do it** (a prompt for your browser agent, the redirect address filled in) or **Do it
  myself** (the steps), then **Give the file to your server**: drop the file Google downloaded, or press **Choose
  file…**. The app then says "Your server has its Google client." and offers **Sign in with Google**. The server keeps
  the file sealed. Or set the two Google secrets above. Some of the server's own messages about Google still name
  `usual-mail google set`; on Cloudflare, use the app instead.

Then connect Gmail and set your AI key as in sections 6 and 7. The browser you sign in with can be anywhere: the
redirect address is public.

### How it differs on Cloudflare

- **Gmail only.** The command and the dashboard still offer IMAP inboxes; the server refuses them.
- **Large messages.** The server keeps each message's text, formatted (HTML) version and headers within 1.9 MB
  together (a row of its storage holds at most 8 MB). Over that, overlong headers are cut first, then the formatted
  version is left out and the text kept, ending "[This message is too large to keep here in full, so its formatted
  version was left out. Open it in the mailbox to see all of it.]"; text still too long is cut, ending "[This message
  is too large to keep here in full, so its text was cut here. Open it in the mailbox to read all of it.]". Gmail
  keeps the whole message. Search finds these notes' words, and the AI reads them with the message. Attachments are
  never kept, on any host: the server asks Gmail when you open one.
- **Smaller steps.** The server takes 25 messages or label changes from Gmail at a time (200 on a computer), so a
  first sync, or catching up after thousands of conversations changed in Gmail at once, takes more rounds. Keep the
  first sync's window modest: with more than about 330,000 messages still to fetch, the sync can't save its place and
  stops (a known issue).
- **Search catches up in the background** after the server starts (after a deploy, or after Cloudflare restarted
  it); a search meanwhile waits until it is done.
- **It stops when idle and comes back by itself.** Cloudflare stops an idle server after a minute or two and restarts
  it after a deploy. While an inbox is connected, an alarm wakes it at least every minute, so Gmail is still checked
  every minute. Before that it runs only while answering.
- **Pictures in your mail and sender pictures** follow the rules in [Pictures in your mail](#pictures-in-your-mail),
  except: names are looked up with Cloudflare's resolver over HTTPS, and the connection can't be held to the address
  checked; a picture at a bare IP address is refused (shown blank); the server never fetches from its own addresses.
  Sites see a Cloudflare address, never yours, but Cloudflare adds a `CF-Worker` header naming the Worker's zone to
  each request, which for a workers.dev address may be your account's subdomain (not yet seen). The copies live in the
  server's storage (at most 256 MB), two fetched at a time.
- **Storage:** at most 10 GB for everything (mail, search, pictures); at 150 messages a day, years. Nothing warns as
  it fills yet, and once it is full, saving fails.
- **Every request wakes the server** and counts against your plan (Workers Paid includes a million Durable Object
  requests a month; one person's use is estimated at about 120,000). The Worker turns away requests under `/v1/`
  without a token, and their bodies or the dashboard's without a length, before the server wakes; but anyone who
  knows the address can open the dashboard's pages, ask `/v1/info` or try codes, and workers.dev has no rate limits.
  A Free plan's daily quota would go quickly.
- **For scripts:** a request with a body under `/v1/`, or a `POST` to the dashboard, must give its length
  (`Content-Length`), as apps and browsers do, or it gets 411 (the connector at `/mcp` takes bodies without one); a
  request under `/v1/` without a `Bearer` token gets 401, even at a path that doesn't exist (404 on a computer).
- **The log** is the Worker's Workers Logs (its **Logs** in the dashboard, or `npx wrangler tail`): the server's own
  lines, kept 7 days on Workers Paid. Cloudflare's per-request logs, which would keep each address asked for with
  Google's codes and search words, are off. `usual-mail start`, `stop`, `status`, `logs` and `doctor` are for a
  server on your computer.

**Who can get at it.** On a computer the boundary is the machine; here it is your Cloudflare account. Anyone with
edit access to the Worker can read every table in Data Studio (the waiting owner's code and the sealed credentials
among them, and the server's own key unless you set `USUAL_MAIL_SECRET_KEY`) and can deploy other code. Use
two-factor sign-in at Cloudflare. If you later connect a Git repository to deploy from (Workers Builds), whoever can
push to it deploys code; keep its builds for other branches (preview builds) off, since each would be a separate,
empty server anyone can reach.

### Backing up and moving

- **No backup or export is built.** Cloudflare keeps 30 days of point-in-time recovery for the server's storage, but
  restoring needs code run against Cloudflare's API, and nothing here does it yet. Keep your own copies of the secret
  key, the Google client file and the AI key.
- **Moving** between Cloudflare and a computer, or to another account, has no tool: set up the new server and connect
  your inboxes again. Your mailbox keeps what the server wrote to it (categories, Screening and stacks, as labels),
  and the new server reads them back; rules, blocked senders, each inbox's trust, devices, summaries (asked for again,
  at a cost), history, the AI key and the Google client stay behind. Don't then remove the inbox from the old server
  while both use the same Google client: removing it ends that Google account's sign-in for both.

### What hasn't been tried on Cloudflare

Every check ran in Cloudflare's runtime (workerd) on this project's machine; `npx wrangler deploy --dry-run` builds
the Worker. One deploy to a real account (2026-11-23, `npx wrangler deploy` on Workers Paid, from a clean copy of the
repository) built, uploaded and answered over HTTPS, at a custom domain and at workers.dev. Not seen on Cloudflare
yet:

- a deploy by the Deploy button (whose builds prepare the server through `package.json`);
- a Free account;
- Google taking a workers.dev redirect address;
- that Cloudflare sends the Worker no request for another name, which the address rule relies on;
- how much memory (an object has 128 MB) and CPU real mail takes, and how Cloudflare counts the server's own
  background requests;
- the alarm bringing the server back after Cloudflare stops it or after a deploy;
- how Data Studio shows the owner's code and the key;
- the time zone and network address Cloudflare gives a real request; variables surviving a deploy, and a setting
  saved in the dashboard restarting the server;
- the `CF-Worker` header's value, and fetching pictures through Cloudflare's resolver and network;
- opening an attachment;
- what it really costs, and how fast the store grows.

## Not built yet

An installer, starting the server when the computer starts (Node), the iPhone app for everyone (it has only run in
the simulator so far), Gmail's push notifications (the server checks every minute instead), and Outlook. On
Cloudflare: any mailbox but Gmail, a backup or export, a warning before the storage fills, and moving a server
between hosts.
