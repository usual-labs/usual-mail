# Decisions: the server on Cloudflare

The Cloudflare host's own choices, by build step of [server-cloudflare.md](server-cloudflare.md). Its shared-code
steps stay in [decisions.md](decisions.md) (no statement over 100 bound parameters; Gmail's large messages); the
other cross-part decisions are there too.

## 2026-11-21: after the review of steps 4 to 6

Two independent reviews of steps 4 to 6 the same evening; their fixes are in [server-cloudflare-limits.md](server-cloudflare-limits.md)
and [server-cloudflare-access.md](server-cloudflare-access.md).

- **Search's index reads bodies whole but a bounded round at a time, never cut.** The reviewers suggested `substr()`
  caps; a cut can change the reading text (an unclosed style block, a tag or a markdown link across it changes what
  comes before), and the index must stay exactly what it was on Node. So heads and attachment names come without
  bodies, and the text and HTML of shown messages are read newest first in rounds of `HostLimits.searchReadChars`
  (Node 4,000,000 characters, Cloudflare 1,000,000; at least one message), each thread only as far as its body can
  still grow. Memory holds one round and the largest single message (1.9 MB stored on Cloudflare). A chunk also ends
  before its threads pass 2,000 messages, for their heads.
- **A first sync is done only when the provider says nothing is left**; when a sync's rounds run out first, the next
  is queued at once. `ServiceOptions.syncRounds` (10,000) exists so a test can reach it.
- **A start counts as done once search's first catch-up has finished** (`Started.settled`), so an object reset during
  that catch-up backs off like any start that fails.
- **The shared REST app checks a route's token before reading its body**, then reads up to the route's own limit:
  16 KiB for `POST /v1/pair` (what the door reads) and the Google client, 2 MB else; a path that is no route reads
  nothing. On both hosts.
- **The front Worker refuses two things before waking the object:** a body without Content-Length on `/v1/*` or in a
  dashboard POST (411; every app and browser sends the length for its bodies), and `/v1/*` without a `Bearer umt_`
  token except the routes that take none by design: `GET /v1/info`, `POST /v1/pair`, `GET /v1/google/callback` (and
  HEAD for the GETs), taken from core's ROUTES (`auth: "none"`). `/healthz` is outside `/v1`; `/mcp` keeps its own
  checks. The path is the one Hono routes by, so the door's pairing count and the Worker agree with the routes.
- **The server's own host names are a failure that may pass, not a refusal for good:** as Node's own networks, the
  address the server is reached at can change. Own: `USUAL_MAIL_PUBLIC_URL`'s host, each host whose address a request
  was taken at, and the host of the request being answered.
- **gzip and br are taken, any other encoding refused,** because Workers ask origins for them and their fetch decodes
  them (local workerd checked); the 10 MB limit applies to what is read, which is decoded. Node still asks for no
  compression.
- **Kept pictures are served as a stream of their parts,** one per pull; whether a picture is whole is checked by its
  parts' total in SQL before serving. The type a source answers is `ServedPicture` (bytes or a stream).

## 2026-11-21: the Cloudflare host's limits, start-up and pictures (its steps 4 and 5)

Built in `server/src/cloudflare/` and the shared code; details in [server-cloudflare-limits.md](server-cloudflare-limits.md).
Started by a session a usage limit stopped at 15:29 the same day, finished and tested afterwards.

- **Limits live on the host, Node's by default** (`HostLimits` in `server/src/host.ts`; `NODE_LIMITS`): a host that sets
  none behaves exactly as before, and the Cloudflare host gives its own (`CLOUDFLARE_LIMITS`).
- **Sync batches of 25 on Cloudflare, not the plan's 50:** a batch is held converted until it is stored, and Gmail's
  small-memory cap lets one message be about 2 MiB of text and HTML, so 25 is about 50 MB of one-byte characters at
  worst in a 128 MB isolate, and about 100 MB if every message is in a single-byte charset other than Latin-1 (whose
  bytes become two-byte characters in JavaScript): ordinary mail is far below.
  The batch counts label changes as well as new messages (the provider's `limit`), so catching up on many label
  changes takes more rounds; accepted (known-issues.md).
- **A stored message at most 1,900,000 bytes on Cloudflare, not the plan's 4 MB:** the documented row limit is 8 MB
  (Cloudflare's limits page, read 2026-11-21; local workerd refuses a row a few bytes over 8 MiB), so either fits; the
  smaller one is for memory, since rows are read whole (a thread, a search chunk of 20 threads, a message for the AI),
  and HTML over 1,000,000 characters is never shown on any host, so little that a person could see is lost. Over it,
  overlong headers are cut first (only when they take more than a quarter), then the HTML is left out and the text kept
  (made from the HTML when there is none), then the text is cut, each with a note in the text (`server/src/sync/fit.ts`);
  the same message always fits the same way, so a later sync doesn't rewrite it, and whether a copy is exactly what the
  server sent is decided before it is made to fit. Node keeps every message whole.
  `docs/contract-sync.md` says so.
- **Search's catch-up at start runs in the background on Cloudflare,** 20 threads a chunk with a turn of the event loop
  between chunks (Durable Object SQLite answers at once, so its awaits alone never yield), and a search waits for what
  is stale; on Node it stays inside `start()`, 100 threads a chunk. Each chunk commits, so a reset keeps what was done.
  How a chunk reads bodies: above, "after the review".
- **Served picture plans: 4,000,000 characters on Cloudflare** (the plan's value), its own `PicturePlans`; Node keeps
  the process's shared 24,000,000.
- **Migrations run inside the start, not inside `blockConcurrencyWhile`** (the plan had them alone inside it): requests
  and alarms already wait on the start's promise, `blockConcurrencyWhile` resets the object on a throw before anyone can
  answer or log why, and after 30 seconds of wall time; this way every start failure takes one path.
- **A failed start answers 503 and resets the object a second later,** so the next request or alarm starts a fresh
  instance; a start the runtime cuts off can't answer, so each start first writes itself down as a failure
  (`usual-mail-start` in the object's key-value storage) and clears it once it succeeds. After one failure the next
  start runs at once; after more, starts wait the backstop, doubling to an hour, and a request meanwhile gets 503 at
  once. With an inbox, the alarm is set for the next try, so the server comes back by itself. Never a reset loop.
- **Pictures from the web are kept in two tables of the object's own SQLite** (`host_pictures`, `host_picture_parts`),
  not R2 (its subscription can't be taken out by the Deploy button): addresses only as SHA-256, a picture's bytes in
  parts of at most 1 MB, Node's caps, retries and records. Two fetched at once, against Node's six.
- **The fetcher keeps Node's rules where a Worker lets it** (`server/src/cloudflare/web/fetch.ts`): names asked of
  Cloudflare's resolver over DNS-over-HTTPS (`cloudflare-dns.com`, A and AAAA, Node's time limit and tries), every
  address public by the same IANA ranges (`server/src/pictures/rules.ts`, shared), every redirect checked again
  (`redirect: "manual"`), the same headers, caps and times. It can't pin the connection to the address checked, and it
  refuses any IP address in a picture's address (a Worker can't fetch one), a public one as the rules' refusal (served
  blank). The rules, the kept-picture checks (`server/src/pictures/kept.ts`) and the site-icon discovery
  (`server/src/avatars/site-icons.ts`) moved out of `src/node/` so both hosts share them. `docs/contract-pictures.md`
  and `docs/contract-avatars.md` say what differs.

## 2026-11-21: the Cloudflare host's address, pairing count and time zone (its step 6)

Built in `server/src/cloudflare/`; details in [server-cloudflare-access.md](server-cloudflare-access.md).

- **The public address is each request's own host, on Cloudflare only** (the owner's decision): used while that
  request runs (an `AsyncLocalStorage`), never stored, always `https://`, and only for a host Cloudflare routes to the
  Worker on purpose: a workers.dev host of the shape `<name>.<subdomain>.workers.dev` (with version addresses off, the
  only one routed to it) or `USUAL_MAIL_PUBLIC_URL`'s origin. The Worker doesn't learn its workers.dev name; it relies
  on routing, unverified until a real deploy. Any other host, and start-up or an alarm, has no address. Node is
  unchanged: its address is its settings'. `docs/contract-sync.md` says so in its address bullet and its Safety bullet.
- **Wrong pairing codes are also counted per client address on Cloudflare,** five in ten minutes, then the host
  answers 429 itself without passing the request on, so one address never reaches the service's global ten. Counted:
  `POST /v1/pair` and the dashboard's `POST /sign-in` answering 401, attempts in flight included (a burst can't slip
  past). The address is `CF-Connecting-IP` as the front Worker copies it into a header only it sets; an IPv6 address
  counts by its /64. The service, and Node, are unchanged.
- **An owner's code that expired while the object was evicted** is removed at the next start (before a new one is
  made), and a pairing with it is refused by the host in plain words, counted by neither count: the owner read it in
  Data Studio and isn't guessing.
- **The time zone comes from the request that pairs the first person's device** (`request.cf.timezone`, copied by the
  front Worker), kept in the object's storage and logged; `USUAL_MAIL_TIME_ZONE` overrides it; UTC until then, and the
  log says so. A later pairing doesn't change it.
- **Core's set-up words take a host's part:** `googleSetup(…, { addressFix })` puts the host's own words after core's
  `noAddress` sentence (Node's are core's default), so the answer's shape is unchanged; the prompt's last line names the
  app first and `usual-mail google set --file` only "on the machine the server runs on".
