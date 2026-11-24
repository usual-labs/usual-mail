# Server on Cloudflare: access, address and settings (build step 6)

**Built 2026-11-21 and tested in local workerd; deployed once to a real account on 2026-11-23** (its first deploy,
[server-cloudflare.md](server-cloudflare.md), "Seen on the first deploy": the address from each request's own host,
the token check and the refusal of plain HTTP answered as built), **with no request to Google from there yet**, so
"Not verified" below still stands. Step 6 of
[server-cloudflare.md](server-cloudflare.md)'s build plan: the front Worker's remaining work, the server's public address,
the Google client seam, the owner's code's last pieces, the per-address pairing count, the Worker's variables and the
time zone. The decisions are in [decisions-cloudflare.md](decisions-cloudflare.md) ("the Cloudflare host's address, pairing
count and time zone"); the contract change is `docs/contract-sync.md`'s address and Safety bullets.

## Files

`server/src/cloudflare/`: `worker.ts` (the front Worker), `requests.ts` (the object's request wrapper, `RequestDoor`,
and the two header names), `address.ts`, `google.ts`, `pairing.ts`, `settings.ts`, `owner-code.ts` (grown), `env.ts`
(the variables), `parts.ts` and `object.ts` (wiring only). Tests: `server/test/cloudflare/google.test.ts`,
`pairing.test.ts`, `front.test.ts`; the harness's `startServer({ bindings, google })` and the test entry's
`GET /__test/kv` and `POST /__test/throw`. Elsewhere: core's `googleSetup(…, { addressFix })` and prompt, the server's
`GoogleOptions.addressFix` (`src/google/config.ts`, passed on in `src/google/setup.ts`), the dashboard's
`DashboardOptions.ownerCodeWhere`, `wrangler.jsonc`'s `keep_vars`, the root `.gitignore`.

## What runs

- **The front Worker** refuses `http:` first (403, core's shape), before anything reads `Authorization`. It drops
  `X-Forwarded-Host` and every client header named `x-usual-mail-…`, then sets `x-usual-mail-client-address` from
  `CF-Connecting-IP` and `x-usual-mail-time-zone` from `request.cf.timezone`. A failed `stub.fetch` becomes core's
  error shape with no internals: 503 with `Retry-After` when the error is marked `overloaded` (5 s) or `retryable`
  (1 s), else 500 "Something went wrong on the server"; the log gets the method, the path (never the query) and the
  error's name and message. Every answer gets, where the server set none: `Strict-Transport-Security: max-age=31536000`
  (no `includeSubDomains`, for a custom domain's other hosts), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and `Cache-Control: no-store`.
  The dashboard keeps its own CSP and `same-origin` referrer, the Google page and the file routes theirs, an event
  stream its `no-cache` and its streaming. **Before waking the object** (since the review of 2026-11-21) it refuses a
  request carrying a body without Content-Length on `/v1/*` (411, core's shape, `invalid`) or in a dashboard POST (any
  POST outside `/v1` and `/mcp`; 411, a line of text), since REST and the dashboard's forms read a body whole; and a
  `/v1/*` request whose `Authorization` isn't `Bearer umt_…` (401 `unauthorized`, the object's own words), except the
  routes that take no token by design, taken from core's ROUTES (`auth: "none"` under `/v1`): `GET /v1/info`,
  `POST /v1/pair`, `GET /v1/google/callback`, and HEAD for the two GETs. Both decide by the path Hono routes
  (`routedPath`: `/v1/%70air` is the pairing route). The object still checks every token; `/mcp` keeps its own checks.
  **Not built:** `/healthz` answered by the Worker (it would say healthy while the object can't start).
- **The address** (`address.ts`): for each request, `https://<host>` when the URL is `https:` and its origin is
  `USUAL_MAIL_PUBLIC_URL`'s, or its host is `<label>.<label>.workers.dev` on the default port; kept in an
  `AsyncLocalStorage` (`nodejs_compat`) for that request and what it starts, never stored. `GoogleOptions.redirectUri`
  reads it, so `/v1/info`, the set-up, a sign-in's start and its callback (the code exchange) each use the address the
  request came to. The Worker doesn't learn its workers.dev name: it relies on Cloudflare routing only
  `<worker>.<subdomain>.workers.dev` to it with version addresses off. `USUAL_MAIL_PUBLIC_URL` must be an https origin;
  anything else is logged ("isn't used") and left out, and the server still starts. A request to another host, and the
  start or an alarm, has no address; the set-up's `noAddress` then ends with the host's words (`ADDRESS_FIX`: connect at
  the workers.dev address, or set the variable in the Worker's settings). Timers started inside a request inherit its
  address; harmless, since only an allowed origin is ever kept.
- **The Google client** (`google.ts`, all of `GoogleOptions`): `saveClient` seals the file's text with the server's
  `Secrets` (context `google-client-file`) into the object's KV as `usual-mail-google-client`; `client()` and
  `savedClient()` open it each time (none, usable with its id, or refused when the key can't open it: "the server can't
  open it with its secret key (USUAL_MAIL_SECRET_KEY was set or changed after it was saved)…", said once in the log).
  The Worker secrets `USUAL_MAIL_GOOGLE_CLIENT_ID` and `USUAL_MAIL_GOOGLE_CLIENT_SECRET` (Node's names) win, both or
  neither (one alone is logged and ignored); then `clientFromEnvironment` is true and a device can't give one. The
  replace guard in `src/google/setup.ts` works unchanged. The start logs where the client comes from and that Google
  sends people back to the address a request comes to, for which hosts; never the secret.
- **The owner's code** (`owner-code.ts`): a start that finds the table's code expired (it can expire while an unpaired,
  alarm-less object is evicted) removes it, logs so, and lets the service make a new one; the old code is remembered by
  hash in memory (`SpentOwnerCodes`, the last four; a code replaced by the expiry timer too, cleared once a person
  pairs). A pairing with it, REST or the dashboard, is refused by the host before the service sees it: 401
  `unauthorized` (a small page for the dashboard) "That owner's pairing code expired at …, so nothing was paired. A new
  one is waiting. Read it in the Cloudflare dashboard: …", counted by neither count. The dashboard's sign-in page and
  its last-device warning say the code waits in Data Studio (the path as the log gives it), through
  `ownerCodeWhere`; Node's words stay its own.
- **The owner's password** (2026-11-24, [server-owner.md](server-owner.md)): `USUAL_MAIL_OWNER_EMAIL` from the
  Worker's variables or secrets (one that isn't an address is logged and keeps claiming closed); a recovery code goes
  into `owner_pairing_code` like the owner's code and is never logged (only "A recovery code is waiting, until …").
- **The per-address count** (`pairing.ts`, `requests.ts`): `POST /v1/pair`, `/v1/owner/sign-in` and
  `/v1/owner/claim` (by the path Hono routes, so any percent-encoded spelling too) and the dashboard's `POST /sign-in`
  and `POST /claim` (by the path as written, as the dashboard routes) are counted under the client address (IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64, none as one key); a 401
  answer is a failure; an attempt in flight holds a place, so a burst can't pass the limit; after five in ten minutes
  the host answers 429 `rate_limited` with `Retry-After` (REST: "Too many wrong pairing codes or passwords from this
  address. Try again in N seconds."; the dashboard: a small page) without passing the request on. At most 10,000 addresses are
  remembered, in memory; an eviction forgets them, as it forgets the service's own count. Behind the door the service
  counts per address too (since the owner password's security review, 2026-11-24): ten per address and a hundred
  from everyone (`service/attempts.ts`), keyed the same way (`client-address.ts`). The door keeps the client's
  address in its request place (`address.ts`, `requestClient`), which is the object's `Host.clientAddress`, so the
  service's counts and the Google claim's cap per address (three waiting) read `CF-Connecting-IP` as the front Worker
  passed it on. Before, the service's ten were global: five from an IPv4 address and five from an IPv6 /64 passed the
  door and locked pairing and signing in for everyone.
- **Settings** (`settings.ts`): `USUAL_MAIL_SYNC_DAYS` (1 to 36,500) wins; else a person's window kept in KV as
  `usual-mail-sync-days` (`saveSyncWindowDays`); else 30; the start logs which. **The time zone:** `Host.timeZone` is a
  getter, so a pairing sets it at once. The request that pairs a person's device while none is paired (checked in the
  store before and after) gives its `x-usual-mail-time-zone`, kept in KV as `usual-mail-time-zone` (only when none is
  kept, and only a zone `Intl` knows) and logged; `USUAL_MAIL_TIME_ZONE` overrides it (both are logged); UTC until
  then, and the start says so. A later pairing changes nothing.
- **Variables:** none in `wrangler.jsonc`; set in the Worker's settings. `keep_vars: true`, because a deploy (each push
  to the person's copy) otherwise removes variables set in the dashboard (docs); secrets are always kept.

## Checked locally (2026-11-21)

`npm run check:cloudflare` at the root: both type checks, then 26 workerd tests, 25 passing. The one failure,
`gmail.test.ts`'s shared-gate timing test, came from steps 4–5's smaller sync batch, built at the same time, and was
fixed in the test the same day ([server-cloudflare-limits.md](server-cloudflare-limits.md)). The step's tests:
- `google.test.ts` (a server with `USUAL_MAIL_PUBLIC_URL=https://mail.example` and a `FakeGoogle` behind the outbound
  service): the address only at `mail.example` and `usual-mail.someone.workers.dev`, none at another host, another
  port, a deeper or shallower workers.dev host; http refused. A paired device's `PUT /v1/google/client` (401 without a
  token), read back without the secret, the prompt with the address; no table and no KV value holds the secret or the
  client id in plain, the KV value is `v1.<iv>.<data>`; the same and another client refused without `?replace=true`
  (the server's words, ending "Confirm to replace it.", no `replace=`); a sign-in refused at another host, started at
  workers.dev with that redirect, started at `mail.example`, the fake's consent followed back to the callback there,
  the code exchanged with the same redirect, the inbox connected with `signIn: "google"`; replacing the client then
  answers `replaced: true` and the set-up's note names the stranded inbox's client. A second server whose secrets give
  the client and whose `USUAL_MAIL_PUBLIC_URL` is `http://`: the variable logged and unused, the address missing at
  `mail.example` and present at workers.dev, `source: "environment"`, `noAddress` with the Cloudflare words, a device's
  client refused. The secrets are in no answer and no log line.
- `pairing.test.ts`: the sign-in page's Data Studio hint; an expired code (both tables set back, then a reset) removed
  at start, refused in words over REST and the dashboard, fourteen tries counted by neither; three REST and two
  dashboard failures from one address, then 429 for REST, the dashboard and a good code, whatever
  `x-usual-mail-client-address`, `X-Forwarded-For`, `True-Client-IP` or `X-Real-IP` the client sends, while another
  address pairs; that pairing's `cf.timezone` kept and logged, a later pairing's ignored, kept across a reset; five
  failures from one /64 (written three ways) then 429, another /64's five passed on to the service, and a third address
  still answered 401, not locked (it asserted the global lock before the review's fix); a person's first-sync window
  kept across a reset.
- `owner.test.ts` (2026-11-24, the review's fixes): a server whose only device row is revoked isn't claimable (409); a
  claim removes the owner's code's row and the code no longer pairs; pair, then `DELETE` the device itself: not
  claimable, 409, a new owner's code; five wrong passwords from an IPv4 address and five from a /64, then the owner
  signs in from a third; with an owner email and a Google client, the claim's start holds no `login_hint` or email,
  the fourth start from one `CF-Connecting-IP` answers 429 "from your address" whatever forwarding headers the client
  sends, and another address still starts.
- `front.test.ts`: `USUAL_MAIL_TIME_ZONE` and `USUAL_MAIL_SYNC_DAYS` win and are logged, the pairing's zone still
  kept; an object that throws answers 500, and so does a reset one (Miniflare marks `ctx.abort`'s error neither
  `retryable` nor `overloaded`), core's shape, no internals; the headers on REST,
  on the http refusal, kept on the dashboard and the Google page, added to an event stream that still streams; a body
  without Content-Length answered 411 on REST (with or without a token, at a path that is no route, at pairing) and
  for the dashboard's sign-in while the client still holds the body open; REST without a `Bearer umt_` token answered
  401 by the Worker without the object starting (no start line), while `/v1/info` (and HEAD), pairing at `/v1/pair`
  and `/v1/%70air` and the Google callback reach it, and a token of the server's shape is checked by the object.
  `pairing.test.ts` also counts five wrong codes sent to `/v1/%70air`, `/v1/pai%72` and `/v1/%70%61%69%72` as the
  host's, so another address still reaches the service.

Also: `npx wrangler deploy --dry-run` 5,443.86 KiB, 1,237.71 KiB gzipped (with steps 4–5's work in progress); the
server's Node suite and both tsc configs, core's and the dashboard's checks green.

## Not verified

On Cloudflare itself: that a request naming another host never reaches the Worker (so the workers.dev shape rule is
safe); that version addresses stay off; what `request.cf.timezone` holds for a real client (and behind a VPN); that
the edge replaces a client's `CF-Connecting-IP` for a workers.dev Worker (docs say it is the connecting address, and
that same-zone Worker subrequests can set it, through `x-real-ip`); whether `request.cf` reaches a Durable Object (not
relied on: the Worker copies it); the `retryable` and `overloaded` marks on real errors (so the 503 answers were never
seen); `keep_vars` against a dashboard variable and a Workers Builds deploy; Google
accepting a workers.dev redirect address (server-cloudflare.md, check (b)).
