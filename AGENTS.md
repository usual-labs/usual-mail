`docs/agents/` is this project's maintained knowledge base. Code is the source of truth; when code and a note
disagree, fix the note.

Usual Mail is a self-hosted mail app for people with many inboxes, built on the mailboxes they already have (Gmail
first). The person's own server keeps a synced copy of each mailbox, runs its own AI on the mail with the person's
own AI key (categories and summaries) for every inbox once the person sets the key, sorts with rules, and writes what it
works out back to the mailbox; every app talks to that server. The person's own outside agent can still connect.
This repository is public (`usual-labs/usual-mail` on GitHub, since 2026-11-24), so it holds only documentation about
the software. Private planning stays in the parent workspace.

## Knowledge index

- [docs/contract.md](docs/contract.md): how the parts fit together and how the service behaves. Read it first. It is
  the entry point to the contract's pages:
  - [docs/contract-ai.md](docs/contract-ai.md): the server's AI (jobs, settings, status, what it processes, what
    leaves the server, mail as untrusted input, records).
  - [docs/contract-sync.md](docs/contract-sync.md): sync and providers (what is written to the mailbox, labels, what
    a provider must do).
  - [docs/contract-pictures.md](docs/contract-pictures.md): pictures from the web (shown through the server,
    trackers taken out, held back for screened and blocked senders, the picture route, what is fetched and how).
  - [docs/contract-search.md](docs/contract-search.md): search (what a search takes, Gmail's operators, what is
    searched, ranking, excerpts, keeping the index right, who may search, older mail in the mailbox and opening it).
  - [docs/contract-avatars.md](docs/contract-avatars.md): sender pictures (an organisation's own site icon when the
    provider's checker proved the From domain and the sender is let in; the route; what is fetched and when; what it
    reveals and doesn't protect).
- [docs/self-hosting.md](docs/self-hosting.md): the public guide from nothing to a paired app (running the server,
  reaching it, the Google client, pairing, Gmail, the AI key, `usual-mail doctor`; and "On Cloudflare": deploying,
  the Worker's settings, the address, the owner's code in Data Studio, how it differs, backup, what is unverified).
  The Mac app links to it.
- [docs/deploy.md](docs/deploy.md): the public guide to running the server on an always-on host: what any host must
  give it, a table to choose by, Docker on a VPS behind Caddy (`compose.caddy.yaml`), Coolify (`compose.coolify.yaml`),
  Render (`render.yaml`) and Railway (no template yet); tried in Docker Desktop on a Mac only. The README's "Deploy
  your own" leads with the Cloudflare and Render buttons and points here.
- [docs/google-setup.md](docs/google-setup.md): the host's guide to setting up Sign in with Google for Gmail (the
  Google Cloud client, its redirect address, the scope, test users, Google's rules).
- [docs/google-setup-agent.md](docs/google-setup-agent.md): the same client set up by the host's own browser agent (a
  prompt to fill in and copy, what stays with the host, checking the agent's work); not yet run as written.
- [docs/agents/01-overview.md](docs/agents/01-overview.md): what exists today, the history, the folder layout and how to
  check each part.
- [docs/agents/decisions.md](docs/agents/decisions.md): choices that shape the code, with their reasons; those about
  pictures from the web, the inbox's own mail and which stored message new mail is in
  [docs/agents/decisions-pictures.md](docs/agents/decisions-pictures.md); those about how the server's AI sorts (its
  words, what a model reads, asking it again, payment details) in [docs/agents/decisions-ai.md](docs/agents/decisions-ai.md);
  the Cloudflare host's own (its address, pairing count and time zone; its limits, start-up and pictures) in
  [docs/agents/decisions-cloudflare.md](docs/agents/decisions-cloudflare.md); the licence (AGPL-3.0-only), the
  contributor agreement, the third-party notices and the checks before going public in
  [docs/agents/decisions-licence.md](docs/agents/decisions-licence.md); deploying beyond Cloudflare (the owner's order
  of 2026-11-23, the image's entry point, each host's file, publishing the image to GHCR) in
  [docs/agents/decisions-deploy.md](docs/agents/decisions-deploy.md).
- [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
  [CLA.md](CLA.md) (a draft): the licence, what comes from others, how to contribute, the contributor agreement.
- [docs/agents/known-issues.md](docs/agents/known-issues.md): bugs and gotchas found while building.
- [docs/agents/improvement-ideas.md](docs/agents/improvement-ideas.md): things deliberately left for later.
- [docs/agents/contract-questions.md](docs/agents/contract-questions.md): questions the parts raised about the contract, not settled yet.
- One file per part in `docs/agents/`, written by whoever builds it: `server.md` (with `server-ai.md`, the server's
  AI, `server-avatars.md`, sender pictures, `server-search.md`, search, `server-checks.md`, its check runs, `server-owner.md`, the owner's
  password (claiming, signing in, recovery codes, the owner email through Google), and `server-cloudflare.md`, the
  Cloudflare side: all seven build steps built and tested in local workerd, deployed once to a real account (the Worker, its Durable Object, the root
  `wrangler.jsonc` and `package.json`, the workerd tests; `server-cloudflare-limits.md`: the host's limits, start-up,
  pictures and site icons; `server-cloudflare-access.md`: the front Worker, the address, the Google client, the owner's
  code, the per-address pairing count, the variables, the time zone); its public docs are `docs/self-hosting.md`'s
  "On Cloudflare" and the README's Deploy button, not tried yet), `mail.md` (with `mail-checks.md`, its check runs, `mail-imap.md`, the IMAP
  provider's folders, cursor, sync, sending, watching and connections, and `mail-gmail-large.md`, Gmail's
  large messages and bounded memory: the size check, the full form, attachments, the shared gate), `design.md`,
  `apps.md` (with `apps-kit.md`, the data layer, `apps-phone.md`, the iPhone app, `apps-runs.md`, what was seen when the Mac app ran, `apps-search.md`, the search page, and `apps-tests.md`), `dashboard.md`, `mcp.md`, `cli.md` (with `cli-checks.md`, its check runs),
  `site.md` (the static website for mail.usual.dev: landing page, privacy policy, terms). The overview says which
  parts exist.

## Rules

- Read the contract and the part's own note before changing a part. Update the note in the same change.
- `core/` is the shared contract. Change it only together with `docs/contract.md` and its pages, and only when
  coordinating across parts.
- Each TypeScript folder is its own package. Dependency versions are exact. Imports use `.ts` extensions. Run
  with Node 22 or newer. Tests use Node's own test runner unless a part's note says otherwise.
- Keep files under about 500 lines and split by responsibility. Build what the current milestone needs.
- Say what is implemented and what is not. Don't describe a plan as if it were built.
- No real mailboxes, accounts or credentials in tests, fixtures or notes. Sample addresses end in `.example`.
- Anything taken from elsewhere (code, data, fonts, icons, pictures) needs a licence that allows it in an AGPL-3.0
  project, its licence text beside it and a line in `THIRD_PARTY_NOTICES.md`. Icons only from Hugeicons' free set;
  SF Symbols only in the Apple apps.
- Don't run the apps in a browser, simulator or device unless asked. Type checks, tests and builds are the
  checks.
- Nothing here is committed, pushed, published or deployed without the maintainer asking.
