# Sender pictures

Which picture an app shows for a sender instead of initials, where it comes from, and what fetching it reveals. Part
of [the contract](contract.md); the shapes are in `core/src/avatars.ts` (`Avatar`, `AvatarFit`, `avatarPath`,
`AVATAR_TYPES`), `Thread.avatar` and `Message.avatar`, `ProviderMessage.fromCheck`, `FromCheck`,
`ProviderOptions.authentication` and `MailProvider.fromChecks`; the route is `avatar` in `core/src/api.ts`.

The owner's request of 2026-11-19, "render the sender avatars properly for the emails everywhere", with the
coordinator's seven decisions the same day ([agents/decisions.md](agents/decisions.md)). **Only organisations' own site
icons are shown; people get initials.** Built and reviewed for security on 2026-11-19.

- **What an app is given.** `Thread.avatar` (for `sender`) and `Message.avatar` (for its `from`):
  `{ picture: "/v1/avatars/<32 hex>", fit: "fill" | "inset", size }`. Absent means initials, which the app draws
  itself. `fill`: a full square made to be cut to a circle (a maskable manifest icon, an apple-touch-icon): fill the
  circle. `inset`: a mark that may sit on transparency (any other icon, a favicon): fit it inside the circle on a white
  disc with some padding. `size` is the picture's longer side in pixels, at least 16. When a thread's picture appears,
  changes or goes, its version rises and it is sent (`thread.changed`); a message's picture comes with its thread, so a
  change to one also raises its thread's version.
- **The route.** `GET /v1/avatars/:id`, a person's device only (an agent gets `needs_person`). It serves only what the
  server keeps and never fetches for the asking; anything else, a gone picture included, is `not_found`. A caller
  limited to some inboxes would get a picture only when proved mail from its domain is in one of them (none that may
  load pictures is limited today: a person's device sees every inbox). The type is
  always `image/png`, `image/jpeg` or `image/webp` (`AVATAR_TYPES`): an icon file is served as the PNG the server wrote
  from it; never SVG, GIF or AVIF. `Cache-Control: private, max-age=31536000, immutable`: the id is a hash of the
  domain and the bytes, so a changed picture has a new id and an app may keep one for good. Sandboxed and `nosniff`.

## When a picture is shown

Every one of these must hold, for the thread's sender (the sender's own message, the oldest one from that address) or
for the message's From:

1. **The server carries the Public Suffix List** (below). Without it the server shows no picture and fetches nothing.
2. **The thread isn't screened**, and **the address is let in**: not unknown (a one-time code from a stranger isn't
   screened, but shows no picture), not blocked. Screened and blocked senders never get the field, and nothing is
   fetched for them, so a stranger learns nothing from being let in front of the person.
3. **The mailbox provider's own checker proved the From domain** of that message (`fromCheck` is `verified` for
   exactly the address's own domain): the topmost `Authentication-Results` header, and only when the provider's own
   checker wrote it (Gmail: `mx.google.com`), says `dmarc=pass` with `header.from` equal to the From address's domain;
   or, when that header has no DMARC result at all (Gmail writes one only when the domain publishes a DMARC record),
   `dkim=pass` with a signing domain whose registrable domain is the From domain's (DMARC's relaxed alignment). Any
   `dmarc=fail` loses. The From field must name exactly one mailbox. A header lower down, or another checker's on top,
   proves nothing, and neither does one inside an attached message. **When two or more headers name the provider's own
   checker** (mail forwarded through Gmail twice, or brought in some other way), nothing is proved (`fromCheck`
   `repeated`). The header is read strictly, since Gmail writes parts the sender chooses into it (the envelope sender in
   its SPF comment and `smtp.mailfrom`): **a quote anywhere inside a comment, a quoted value holding `;`, `(` or `)`, or
   a DKIM or DMARC result carrying an envelope (`smtp.*`) property makes it unreadable**, which proves nothing (the
   security review of 2026-11-19). The checker's name is compared whole. IMAP inboxes have no checker the server
   trusts yet: initials.
4. **The mail is an organisation's**: machine-sent (`automated`: list headers, bulk, no-reply) or in a filed category
   (newsletter, invoice, receipt, notification, one-time code). A person writing from their company's domain is a
   person: initials.
5. **The domain isn't a mailbox provider anyone can sign up to** (Gmail, Outlook, Hotmail and Live in every country,
   Yahoo, iCloud, Proton, GMX, Zoho, mail.com's whole published list of domains, and others:
   `core/src/mail-domains.ts`, one list with the screening gate's), **nor a platform whose customers send from its own domain** (a Microsoft 365
   tenant's `onmicrosoft.com`, a Google group, a newsletter platform's writers, a sending service's shared domain):
   none of those is a brand. Such a provider's own notices come from other domains.
6. **Its site gave a picture** the server keeps (below). Never the inbox's own mail.

## Where a picture comes from, and how it is fetched

- **Kept under the registrable domain** of the proved From domain (`news.mail.brand.example` is `brand.example`, by
  the Public Suffix List, its private section included, so `someone.github.io` is its own), once for every sender and
  every inbox on the server. Never anything unique to a recipient.
- **The Public Suffix List** ships with the server (`server/src/avatars/suffixes.json`, written by
  `server/scripts/update-suffixes.mjs` from a pinned commit of `publicsuffix/list`, under the Mozilla Public License
  2.0; shipped since 2026-11-19 at commit `09c1b150f33c6145a73afcf7db0fb872fc54b4d1`). A server built without it
  logs one line saying sender pictures are off, shows initials, asks no provider and fetches nothing: it never guesses
  a registrable domain.
- **The site's own icons only**, fetched by the server with every rule of [pictures from the web](contract-pictures.md)
  (public addresses only, DNS asked once and the connection pinned, every redirect checked, no cookies or referrer, a
  common user agent, no compression; on Cloudflare the connection isn't pinned, the server's own host names are never
  asked and gzip or br is taken, as that page says): the page at `https://<domain>/` (else `https://www.<domain>/`), only its first
  512 KB and only up to `</head>`; the web app manifest it names, at most 64 KB; then the icons they name, best first
  (a size of 64 to 512 pixels before others; a maskable icon, then a touch icon, then any other; an ICO after a PNG),
  then `/apple-touch-icon.png` and `/favicon.ico`. At most 6 requests and 45 seconds for a domain. Icons may be on
  another site (a CDN), still under every rule; an inline `data:` PNG, ICO, WebP or JPEG of at most 96 KB is read
  without a request. No logo service, favicon service, BIMI, Gravatar or Google contact is ever asked.
- **What is kept:** a still PNG, JPEG or WebP read from its bytes, or an icon file (ICO) whose largest image the server
  turns into a PNG it writes itself (an embedded PNG as it is; a BMP of 1, 4, 8, 24 or 32 bits, with its mask,
  converted), so no client decodes a sender's BMP. At least 16 pixels a side, at most 2048 and 4 million pixels, no more
  than twice as wide as tall, at most 1 MB. SVG, GIF, AVIF and anything that moves (an animated PNG, a WebP with frames)
  are refused.
- **When:** a domain is wanted when new mail that would show its picture is stored, when its sender is let in, or when
  the backfill proves a stored message; it is then fetched **at a random moment within six hours**, not when the mail
  arrives. **One domain at a time**, never two at once, at least 5 seconds apart, at most 500 a day. A site with no icon
  is remembered as such. A site that can't be reached is tried again after ten minutes and after a day, then left. A
  found picture, or a site found to have none, is **looked at again only when new mail that would show it arrives and
  the last look is more than 30 days old**: never on a timer of its own. A refresh that fails keeps the picture. A
  domain no mail has wanted for 180 days is forgotten, its picture with it.
- **Mail stored before the server asked** (or while it carried no list) has no `fromCheck`. At every start, in the
  background, the server asks Gmail again (`fromChecks`: its metadata form with only `Authentication-Results` and
  `From`, 20 quota units a message) for each thread that isn't done, trashed or gone and had mail in the last 90 days:
  its sender's oldest and newest message. One log line counts the outcomes, with no address or domain: proved, Gmail's
  own result on top proving nothing, another checker's on top, no result at all, no longer there. What has an answer is
  never asked again.

## What it reveals, and what it does not protect

- **To the domain's owner:** that a server at this address (for a server at home, the person's home address; on
  Cloudflare, a Cloudflare address and a `CF-Worker` header naming the Worker's zone, which for a workers.dev address
  may name the account's subdomain and so give away the server's own address: unverified) received mail from them and
  that the person let them in, at a random moment within six hours of it, and again at most once in
  30 days while their mail keeps coming; even if the mail is never opened. For a sender who writes rarely, that links
  the person's address to the server's. Nothing about opening or reading. Nothing to anyone else: no service learns the
  person's senders.
- **A lookalike domain** (`brand-support.example` for `brand.example`) passes its own checks and may copy the brand's
  icon. Letting a sender in is the only defence: a stranger's mail is screened and shows initials. Once let in, its
  logo shows.
- **Mail that reached Gmail without Gmail's own result on top** (mail fetched by Gmail's "Check mail from other
  accounts", or uploaded into the mailbox over IMAP) may carry a header the sender wrote, naming `mx.google.com`, on
  top. When it carries two or more such headers it proves nothing (`repeated`); with exactly one, the server can't tell
  and takes it as proved. The forged address must already be one the person let in, whom the app trusts by address
  anyway. The backfill's counts show how much mail came in with Gmail's result more than once or not at all. Not
  guarded further (the coordinator's decision of 2026-11-19: a guard on `Received` lines would be brittle).
- **Two things are assumed, not seen on real mail:** that Gmail writes its own `Authentication-Results` above every
  other one, and that Gmail's metadata form (the backfill) lists headers top first, as the message has them. The
  owner's first start shows both: many "another checker's result on top" or "no result at all" in the backfill's log
  line would say otherwise.
- **A part the sender chooses that closes Gmail's comment without a quote** (a HELO name holding a `)`, which SMTP
  doesn't allow) leaves an envelope property on the result it adds, which is refused, because Gmail writes the same part
  again as a property value. **What would still inject** (the reviewer's re-check of 2026-11-19): an unquoted `)` in a
  part Gmail writes only inside a comment and never again as a property value. Nothing Gmail echoes fits that today;
  whether Gmail ever writes such a part unescaped is unverified.
- **Wrong or missing pictures:** senders on a platform's domain show the platform (a newsletter sent from a hosting
  service's own domain); a sending domain with no site, or a parked one, shows nothing or the parking company's icon; a
  hosting company's default favicon may show; a company's brands may share its icon; small favicons look soft; mail
  forwarded to Gmail may fail DMARC and show initials.
