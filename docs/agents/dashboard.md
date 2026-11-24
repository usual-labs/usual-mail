# Dashboard

`dashboard/` is the package `@usualmail/dashboard`: the web pages a person opens on their own server to set it
up. It exports one function, `createDashboard(deps: InterfaceDeps): FetchHandler`. Every page is rendered on the
server and works with scripts turned off. It has no data or behaviour of its own: everything goes through
`deps.service`. It follows the contract's fifth revision (2026-11-17, as amended): categories in rules and Handled,
the server's AI as an actor, the AI on Home when it needs a person, an AI page whose key form shows what is sent and
to whom (the consent, for every inbox, since the owner removed the per-inbox AI switch on 2026-11-17), each inbox's
icon and place, and Sign in with Google for Gmail (2026-11-17). The owner put the dashboard after the Mac app, so it grew only where setting the product up from a
browser needs it.

**The look has not been checked by eye.** No page was opened in a browser. Keyboard use, 200% zoom, phone width,
screen readers, and light and dark were not tried. The checks are type checks and tests that call the handler
directly against a fake service, and request-only runs against the server's demo mode (see Checks).

## Run and check

All commands run in `dashboard/` after `npm install`.

| Command | What it does |
|---|---|
| `npm run check` | Fails if the embedded assets are stale, type-checks `src/` without Node types, type-checks `src/` and `test/` with them, and runs every test |
| `npm test` | The tests only (`node --test "test/*.test.ts"`) |
| `npm run embed` | Rewrites `src/generated/assets.ts` from `design/dist/web/` and `assets/dashboard.css` |

Run `npm run embed` after changing `assets/dashboard.css` or after `design/` regenerates `dist/web/`. The generated
file is checked in, because the server imports the package from source.

Dependencies: `hono` 4.13.18 (the server's version) and `@usualmail/core` from `file:../core`. Dev: `typescript`
7.0.2 and `@types/node` 22.20.5.

## Mounting it

The server mounts the handler at its root, after its own routes, so `/healthz`, `/v1/...` and `/mcp` are answered
first and everything else goes to the dashboard. In the server's `package.json`:
`"@usualmail/dashboard": "file:../dashboard"`. With Hono:

```ts
import { createDashboard } from "@usualmail/dashboard";

const dashboard = createDashboard({
  service,                                        // the MailService
  authenticate: (token) => server.authenticate(token),
  basePath: "",                                   // or "/dashboard"
});
// ...REST routes, /healthz and /mcp first...
app.all("*", (c) => dashboard(c.req.raw));        // last
```

- The handler answers every path it is given: its pages, `/assets/...`, a sign-in redirect, or its own 404 page.
  So it must be the last route.
- With a `basePath`, the request may arrive with or without the base on its path. Both work. Links, form actions
  and the cookie's `Path` use the base.
- It needs no `node:` module and reads no files at run time. The type check of `src/` runs without Node types,
  so a `node:` import there fails it. It has not been run on Cloudflare.
- Behind a reverse proxy, keep the `Host` header. The cookie's `Secure` flag and the old-browser `Origin` check
  read the request's host. `X-Forwarded-Proto: https` only hides the "not on HTTPS" note on the sign-in page.
- The dashboard sends no `Strict-Transport-Security`. Set it at the proxy that terminates TLS.

## What is implemented

### Signing in and out

- `/sign-in` takes a pairing code and a name for the browser, and calls `service.pair`. A code made for an agent
  is refused: the new agent token is revoked at once with its own caller, and no cookie is set.
- The token goes into a cookie: `HttpOnly`, `SameSite=Strict`, no `Domain`, `Path` the base, `Max-Age` 30 days.
  It is `Secure` everywhere except plain HTTP on localhost (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`).
  Over HTTPS at the root its name has the `__Host-` prefix.
- Every other page needs a session. Without one, a page redirects to `/sign-in?next=<path>`. An unknown or revoked
  token is cleared and redirected the same way. An agent's token gets a 403 page and the cookie is cleared.
- Sign out (`POST /sign-out`) revokes this browser's device with `revokeDevice` and clears the cookie.
- A wrong, used or expired code (`unauthorized`) gets its own words. Too many tries (`rate_limited`) says how long
  to wait from the service's `retryAfter` ("Wait 10 minutes"; under a minute in seconds; minutes rounded up), or
  "up to ten minutes" when there is none. A `ServiceError` from another copy of core keeps its `retryAfter`.
- The sign-in page says where a code comes from: the server prints the owner's code and writes it to
  `owner-pairing-code` in its data folder whenever no app or browser is paired.
- After signing in it goes to `next`, which `safePath` (`src/http/context.ts`) accepts only as a path on this
  site. A resolved path starting with `//` falls back (fixed 2026-11-17; tests in `test/auth.test.ts`).

### Pages

| Path | What it shows and does |
|---|---|
| `/` | What needs you: inboxes that need attention, the server's AI when its state is key refused, model not found or out of credit (with the service's words and a link to `/ai`), up to five proposals with Approve and Reject, changes that need a look (`handled` with `attentionOnly`), drafts that didn't send, and rules agents suggested with Accept and Dismiss. Says when nothing needs the person, and offers to connect a first inbox |
| `/inboxes` | Every inbox, in its place: hat, address, provider, status and its reason (while a first sync runs and the inbox is connecting or ok, how far it has got in core's words, "Fetching your mail · 120 of 340", since 2026-11-23; also on an inbox's own page), trust, whether agents may read it, last sync |
| `/inboxes/new?provider=imap\|gmail` | Connect an inbox. IMAP: server, port, TLS, user and password for IMAP and SMTP (SMTP user and password fall back to IMAP's), the address when it differs, and whether to save sent mail. Gmail: first "Sign in with Google" (name and colour; shown only when the server has Google sign-in), then the client ID, client secret and refresh token. Both: name, colour, trust. Any other `provider` shows IMAP |
| `/inboxes/:id` | One inbox, in its hat's tint: state, Sync now, Pause or Resume, Connection (the stored details, "Sign in with Google again" for a Gmail inbox when the server has it, and a form to give new secrets), and one form each for name and colour, icon and place, trust, agent access and the guide. This path is the contract's (`DASHBOARD_PATHS.inbox`): other interfaces may link to it |
| `/inboxes/:id/remove` | Says exactly what removing deletes and what it leaves alone, then removes |
| `/inboxes/:id/rules` | What the inbox learned, in the order the server checks rules: each rule's text, who made it (from `createdBy`: "You made it", "You taught it by correcting", or the agent by name, "Claude Code suggested it"; a rule from an older server that says `system` falls back to its source's words), how often it fired, its conditions and actions ("Put in Receipts, Mark done"), Turn on or off, Delete. Agents' suggestions first, with Accept and Dismiss. A form to add a rule, whose "Put it in" offers the six categories a person can choose (never "not sorted yet") |
| `/devices` | Apps and browsers, and agents with the inboxes each may see. Marks this browser. Remove each. A code for a new app, and a code for a new agent with the inboxes it may see |
| `/handled` | Proposals waiting (all of them, up to 200) with Approve, Reject, and Approve all or Reject all; then history (applied, undone, rejected, failed) of rules, agents and the server's AI, 50 at a time, with Undo where the record is undoable. Filter by inbox with hat chips. `?silent=1` also lists silent records, which include every category the server's AI set ("Usual Mail's AI put it in Invoices, using example/decision-1") |
| `/ai` | The server's AI: its state and why there are no summaries when it isn't working, the service's own words, the last run, what waits (`pending`) and what it works through (all synced mail; the first sync's days), Test now and Pause or Resume; the connection with a key form (service and key; the key field is never filled); each job's model with the server's default (empty means the default)|

#### What needs you (Home)

- Proposals: `handled` with `states: ["proposed"]`, limit 5. Proposals are never silent.
- **Changes that need a look:** `handled` with `attentionOnly: true` (newest 50): records that failed or carry an
  `error` (an undo the provider refused) or a `note`, in any state, whoever made them: since the final review's
  decisions (2026-11-17) the person's own change the provider refused shows here too ("You moved it to Receipts …
  It didn't go through: …"), while `/handled` stays rules' and agents' records. Silent records are never part of it: the
  dashboard never asks for them here, and drops any record marked silent. The heading counts them and says how many
  didn't go through; up to five are shown with the provider's words and Undo where it applies, then a link to
  Handled.
- **Drafts that didn't send:** `listDrafts` (limit 200), state `failed`, each with its inbox, subject, recipients,
  time and the provider's error. Nothing to do on the page: it says they stay drafts until sent again or deleted
  in the app.

#### The server's AI

- **The key, and the consent** (`GET /ai?service=…`, `POST /ai/key`): chips choose the service (Vercel's AI Gateway,
  OpenAI or Anthropic; default the one set). For that service the page shows what saving a key sends and to whom
  (the service's `aiDisclosure` answer, as `GET /v1/ai/disclosure` gives it, rendered by `disclosure()` in
  `src/view/ai.ts`; core's `aiDisclosure` and `AI_SENT_WORDS`: every inbox connected to the server,
  now and later; for a gateway, that it passes mail on to the company that runs each model; each job's model (the
  chosen ones for the service set, otherwise that service's defaults); that its terms apply; what is sent to categorize and to summarize; what is never sent; how far
  back history goes), then the key field (a password field that starts empty and is never filled again) and the
  button "Save the key and send every inbox's mail to …". The form carries the service the page showed, so the yes is
  to that service. It sends `updateAiSettings({ credentials })` and goes back to `/ai` ("From now on every inbox's
  mail goes to the AI"). A refusal is shown with the key taken out (`•••`). Nothing keeps the key.
- **Models** (`POST /ai/models`): one field per job, empty for the server's default (its id shown as the hint). Only
  what changed is sent, since saving a model tests it at once. An id with spaces is refused before sending.
- **No history setting** (since 2026-11-18): the History card and `POST /ai/history` are gone (that address is 404).
  The Status card says in one line what the AI works through: all synced mail that isn't done, newest first, and how
  many days a new inbox's first sync takes (`GET /v1/first-sync`), with `usual-mail sync-days` when a person can change
  it, or that `USUAL_MAIL_SYNC_DAYS` sets it. The page has no form for the window (YAGNI).
- **Pause and test** (`POST /ai/pause`, `POST /ai/test`).
- **Removing the key** (since 2026-11-17): while a key is set, the AI page's Connection card has "Remove the key",
  which opens `GET /ai/remove`: what removing it does (all processing stops: nothing more of any inbox's mail is sent;
  threads keep their categories and summaries; the service and models are remembered; to use AI again, set a key
  again; pausing instead), then "Remove the key" (`POST /ai/remove`, `updateAiSettings({ credentials: null })`) or
  "Keep it". Done goes back to `/ai` with "The AI key is removed. Nothing more is sent, for any inbox."
  Without a key both go back to `/ai` and send nothing.
- **No per-inbox AI switch** (since 2026-11-17): the inbox's page and list show no AI state, and `POST
  /inboxes/:id/ai` is gone (it answers the dashboard's 404).
- **Icon and place** (`POST /inboxes/:id/place`): the six icons as choices and the place as a list from 1; only what
  changed is sent (`icon`, `position` from 0), and the server renumbers the others.

#### Handled

- Silent records (applied alone by a rule or an agent in an `act_silently` inbox, and every category the server's AI
  set) are left out of history unless the person follows "Show silent changes too" (`?silent=1`, sent as
  `includeSilent: true`). The server's AI is "Usual Mail's AI", with the icon Usual Mail uses for itself (the design
  system has no AI icon), and its line names the model in place of a reason, which the AI doesn't give. The choice is kept in
  the inbox chips, the pager and every form's return path. A silent record shown is marked "Done silently".
- Every record shows what the provider said: on a failed record "It didn't go through: <error>"; on any other
  record with an error "Undo didn't go through: <error>"; a note as "Note from the provider: <note>".
- A record whose thread is now in the trash stays listed, marked "In the trash", with Undo when it is undoable.

#### An inbox's settings

- **Connection:** the stored details as facts (IMAP's and SMTP's server, port, TLS or STARTTLS and login, whether a
  copy of sent mail is saved; Gmail's client ID), from `Inbox.connection`. Then a disclosure, open when the inbox
  needs attention or the form came back ("Give a new password…", "Give a new client secret and token…"). Its form
  starts with the stored details (`connectionValues` in `src/pages/inboxes.ts`): servers, ports, TLS, the login,
  saving sent mail; the SMTP user only when it differs from IMAP's, and the address only when the login differs
  from it. So the person types the password (or the client secret and refresh token) and changes only what
  changed. Every field is sent again, because new credentials replace the stored ones whole. It posts to
  `/inboxes/:id/reconnect`, which calls `updateInbox(id, { credentials })` in the shape used to connect.
  - Missing fields are named and nothing is sent.
  - The server's answer is shown in words inside the form: the provider's words on `provider_error`, the server's
    on `invalid` (another address). Every secret typed is replaced by `•••` before a message is shown.
  - On success the page says the provider accepted the new details and the inbox syncs again unless paused.
- The attention note on a broken inbox points to Connection; the old "remove and connect again" text is gone.
- **Trust:** the three levels are explained as the contract's trust table has them: Suggest only proposes;
  Act with undo acts and every change shows in Handled with undo; Act silently acts quietly, Handled lists its
  changes only when asked, still with undo, and anything that went wrong is always shown. The form says a change
  applies from now on and earlier records stay as recorded. Trash and block always wait for a yes.
- **Removing:** the confirmation page says the server deletes its copy of the mail, the rules, the history in
  Handled, the drafts and the guide; agents lose access and briefs no longer show its section; nothing changes at
  the provider, labels and folders under "Usual Mail/" included; it can't be undone.

#### Devices

- Removing the last app or browser (this one or another) explains that the server then makes a new owner's code
  at once, prints it in its log and writes it to `owner-pairing-code` in its data folder.

#### Everywhere

- Form posts redirect back with `?done=<key>`. Only a fixed list of messages can be shown that way (`NOTICES` in
  `src/view/layout.ts`); nothing from the URL is printed.
- A pairing code is shown in the answer to its form, never in a URL, and the page is not cached.
- After Undo, when `undo` returns a teach prompt, Handled shows the question with Yes and No, which call
  `answerTeach`. The prompt can't be fetched again, so that page is rendered in the answer to the form.
- Service errors re-render the page the form came from, with the service's message and the status from
  `ERROR_STATUS`. Forms keep what was typed, never a password, secret or token. `internal` errors are not shown as
  they are. `rate_limited` says how long to wait from `retryAfter`.
- Steps that can't be undone say what happens first: removing an inbox has its own page; deleting a rule,
  dismissing a suggestion and removing a device open a short explanation (a `details` element) first.
- Times are shown in UTC, and every page says so in its footer.
- Outlook isn't a provider kind; only IMAP and Gmail are named or offered.

### Safety

- **Escaping:** pages are built with a small template tag (`src/html.ts`). Every string is escaped; only other
  templates go in as markup. Ids in paths are percent-encoded. Tests put hostile text in every name, address,
  subject, reason, error, note, failed draft (subject, recipient, error), guide, rule, device name, teach question,
  the AI service's `detail`, the models a person typed and the AI's model on its records, and in the provider's
  answer to new credentials, and a hostile cursor in Handled's query.
- **Secrets:** no page shows the session token or the AI key; the key field and every password field start empty;
  a service's answer that repeats a key or password typed in the same form is shown with it replaced by `•••`.
- **Cross-site forms:** every signed-in form carries a token derived from the session token (SHA-256 with a fixed
  prefix). The sign-in form uses a random value kept in its own `HttpOnly` cookie. Every post must also pass the
  browser's own check: when `Sec-Fetch-Site` is sent it must be `same-origin`; otherwise an `Origin` header, when
  sent, must name this host. A refused form changes nothing and gets a 403 page. Bodies over 256 KB get 413. A test
  finds every form on every page (Connection included) and fails on any form route not in its list; each listed
  route is posted without a token, with another session's token, and cross-site, and must change nothing.
- **Headers** on every response: `Content-Security-Policy: default-src 'self'; script-src 'none'; style-src
  'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action
  'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, a
  `Permissions-Policy`, and `Cache-Control: no-store` on everything but assets.

### Look

- `assets/dashboard.css` uses only the design system's variables. A test fails on any variable it doesn't define,
  any variable of its own, any colour literal, any length other than 0 and percentages, and any font not set
  through a type role or family token. Sizes that aren't tokens are written as multiples of one, for example the
  2px focus ring is `calc(var(--size-line) * 2)`.
- Headings are Geist Serif (title and heading roles); text and controls are Geist Sans. The wordmark is
  `Usual<span>mail</span>` in Prociono with the suffix colour, as in the design gallery. Light and dark follow the
  reader's setting through `tokens.css`. Surfaces are solid cards with the `raised` elevation.
- The pieces from `design/specs`: the hat label, small label and chip, the window tint inside one inbox, the
  attention line, and the reason line in Handled with its states. A provider's error is in the danger colour, a
  note in the body colour, each on its own line under the reason. The colour picker offers only the twelve hats.
- Every colour pairing used is one `design/test/contrast.test.mjs` checks.
- Accessibility the tests check: one `h1` per page, `lang`, a skip link, a label for every field, unique ids,
  hints and errors tied to fields with `aria-describedby` and `aria-invalid`, decorative icons hidden, visible
  focus (`:focus-visible`). Layout uses wrapping flex and grid with no fixed widths, so it should reflow at phone
  width and 200% zoom; that is untested.

### Assets

`scripts/embed.mjs` writes `src/generated/assets.ts`: `fonts.css`, `tokens.css` and `dashboard.css` joined into
one `app.css`; the three fonts; the icon sprite; and the font and icon licences, each at a content-hashed path
under `/assets/` served with `Cache-Control: public, max-age=31536000, immutable`. Font links inside the stylesheet
are rewritten to the hashed names. It also exports the twelve hats (name and light fill, read from the light block
of `tokens.css`) and the icon names. `--check` fails when the file on disk differs from what it would write.

## Layout

```
src/index.ts         the export
src/app.ts           the Hono app: headers, assets, sign-in, the session guard, errors
src/html.ts          the escaping template tag
src/hats.ts          the twelve hats and nearest-hat matching (OKLab), as design/scripts/lib does it
src/http/            session cookie and form tokens, security headers and assets, form and error helpers
src/routes/          one file per section: home (and Handled), inboxes, rules, ai, devices; credentials.ts reads
                     connection details for connecting and reconnecting
src/pages/           one file per page family; returns HTML. connect.ts also holds the shared IMAP and Gmail fields;
                     inbox-ai.ts the inbox's icon and place; google.ts the Sign in with Google pieces
src/view/            the page shell, shared pieces, the reason line, words; ai.ts the AI's words and what is sent
src/generated/       assets.ts, written by scripts/embed.mjs
assets/dashboard.css the dashboard's own styles
test/                fake-service.ts (an in-memory MailService) and fake-data.ts, helpers.ts, and the tests
```

## Decisions

- **No JSX.** The server runs from TypeScript source with Node's type stripping, which doesn't handle `.tsx`.
  Pages use a tagged template that escapes every string instead. Hono is used for routing, cookies and the body
  limit.
- **One stylesheet, one sprite.** The icon sprite is loaded by `<use href>` from this site; the policy's
  `default-src 'self'` covers it whichever directive a browser applies. The inbox icons (person, building, briefcase,
  house, shop, globe) come from the same sprite, re-embedded after `design/` added them.
- **`Referrer-Policy: same-origin`, not `no-referrer`.** With `no-referrer`, browsers send `Origin: null` on a
  site's own form posts, which would make them look cross-site.
- **Form tokens derived from the session,** so the dashboard keeps no state. They change when the session does.
- **Thirty-day cookie.** Device tokens don't expire on the server. A browser that never signs out stays in the
  device list until removed there.
- **UTC times.** A page rendered on the server doesn't know the reader's time zone, and there are no scripts.
- **A colour is only sent when a different hat is picked.** A stored colour that isn't a hat key shows as its
  nearest hat; saving the name alone doesn't change it.
- **New rules' actions are sent in a fixed order:** let the sender in, move, stack, read, done, block, trash.
  Stack and done together are refused, because a thread on a stack is never done.
- **An agent's pairing code typed into sign-in is used up.** Pairing happens before the kind is known, so the new
  agent device is revoked at once.
- **New credentials start from what was stored.** `Inbox.connection` gives the details that aren't secret, so the
  form fills them in and asks for the secrets; it still sends the whole connection, since credentials are replaced
  whole.
- **Silent records shown only by a link,** not a stored setting: the dashboard keeps no state, and the link keeps
  the choice in the URL.
- **The AI page is the one addition of the fifth revision,** because without it the product can't be set up from a
  browser.
- **Saving a key carries the service the person was shown,** so consent is to that service: the dashboard keeps no
  state, so the form does, and the service is chosen by a link (no script) so its words are on the page before the
  key is typed.
- **Sign in with Google links to Google instead of redirecting a form there:** the page's `form-action 'self'` would
  block a form whose answer redirects off-site. The form starts the sign-in and the answer is a page with "Continue to
  Google" (a new tab), how long it works, and Google's rules in core's words (`GOOGLE_RULES_WORDS`); only an http(s)
  address is linked. Google sends the person to the server's own page afterwards; this dashboard doesn't follow it
  (no scripts, no state), so the page says to come back and look.
- **"What needs you" includes notes,** because the contract says a record with a note is never silent and counts
  there; it asks `handled` with `attentionOnly`, so an older note or one on an undone record is found too.

## Checks (2026-11-17, this Mac, Node 22.23.2)

- **First-sync progress (2026-11-23):** `npm run check`: assets current, both type checks clean, 161 tests in 31
  suites pass. New in `test/pages.test.ts`: an inbox whose first sync runs shows "Fetching your mail · 1,200 of 3,400"
  in the list and on its page, and "Paused" once paused (failed first).
- **Sign in with Google, then the removal of the per-inbox AI switch, then the disclosure route (2026-11-17):** `npm
  run check`: assets current, both type checks clean, 159 tests in 31 suites pass (the AI page shows the service's
  answer word for word, the fake building it with core's builder) (162 after Sign in with Google; the switch's tests went with
  it). New `test/google.test.ts` (6): the Gmail connect page offers Sign in with Google first and only when the server
  has it; starting answers with a "Continue to Google" link, the time it works until and Google's rules in core's
  words; a missing name or hat, and a server refusal in its words; an address that isn't http(s) is never linked; a
  Gmail inbox's page offers "Sign in with Google again", an IMAP inbox's doesn't; a signed-in inbox says so. The two
  new forms are in the security test's list (refused without the form token, with another session's, and
  cross-site). Rewritten for the switch's removal: the AI page shows core's words above the key field for the service
  its chips chose (another service's without models), the button names the service, removing the key "stops all
  processing", an inbox's page has no AI switch and its old form answers 404, the list shows no AI column. The fake
  service implements `startGoogleSignIn` and `info().googleSignIn` (`googleInfo`) and no longer turns inboxes off.
  No page was opened in a browser.

- **Fifth revision:** `npm run check`: assets current (re-embedded from `design/dist/web`, with the inbox icons), both
  type checks clean, 150 tests in 29 suites pass (123 in 25 before). The fake service follows the fifth revision
  (inboxes with icon, position and `aiProcessing`, on only with a key; the AI's settings without the key, another
  service turning AI off everywhere; the AI as an actor in Handled; split into `test/fake-service.ts` and
  `test/fake-data.ts`). New `test/ai.test.ts` (19): the AI page in each state, the key sent once and never in a page,
  a refusal repeating the key shown as `•••`, models and history sending only what changed, pause and test, the
  switch's words before the button, a changed service refused, no key, icon and place with renumbering, the AI on Home
  only for the three states that need a person, the AI's line in Handled, the rules form's categories. Every new form
  is in the security test's list (refused without the form token, with another session's, and cross-site, changing
  nothing), the AI page is among the pages checked for escaping (a hostile `detail` and model ids), headers, one `h1`,
  labels and unique ids, and no page shows the sample's AI key. Older tests now read the fifth revision's sample.
- **After the review's decisions (2026-11-17):** `npm run check`: assets current, both type checks clean, 154 tests in
  30 suites pass. New: removing the key (its page asks first; cross-site and token-less posts refused, the page among
  every page's checks), the disclosure in core's words (the test checks core's sentences whole; "out of your server"
  now, as the command says it), service names from core. The fake service follows the server on removal (inboxes
  off, the service and the chosen models remembered, no defaults without a connection).
- **Independent review (2026-11-17):** `npm run check` again: assets current, both type checks clean, 150 tests in 29
  suites pass. **Joined, with requests only** against the fifth revision's built server (`--dev-fake-ai`; no browser):
  signed in through the form with a code from `usual-mail pair`; Home showed "Usual Mail's AI needs you" for key
  refused, model not found and out of credit (with the scrubbed words and a link to `/ai`) and not for unavailable;
  `/ai` had an empty password field and no part of the key; posting a key cross-site or without the form token was
  refused (403, nothing changed), a key with a space came back 400 without the key in the page, a good one was saved
  (303); the inbox's page showed the words of what is sent and to whom above "Turn AI on and send its mail to Vercel's
  AI Gateway"; after the service moved to OpenAI, that form answered 409 with OpenAI's words and nothing changed, and
  the form with OpenAI turned it on; a cross-site post to the switch was refused; a model id with markup came back
  escaped; history above the most allowed was refused.
- After the final review's decisions (2026-11-17): `npm run check`: assets current, both type checks clean, 123
  tests in 25 suites pass. New: Home shows the person's own refused change, `/handled` doesn't (failed first against
  the fake service, which then followed the old rule; the fake now mirrors the contract). Joined: on the built server
  with an IMAP inbox on a local test server, a person's move the IMAP server refused showed on Home as "1 change needs
  a look … You moved it to Receipts … It didn't go through: …" (requests only, no browser).
- `npm run check` (fourth revision): assets current, both type checks clean, 122 tests in 25 suites pass. New:
  the stored connection shown and filled in (TLS and STARTTLS, a login that isn't the address, a separate SMTP
  user, sent mail not saved, Gmail's client ID), Home asking with `attentionOnly` and showing an undone record's
  note, and rules naming the agent that made them.
- Final review (2026-11-17): `npm run check` again: assets current, both type checks clean, 122 tests in 25 suites
  pass. **Joined, with requests only** (the built server on a scratch data directory with an IMAP inbox on a local
  test server; no browser): a signed-out `/` redirected to `/sign-in`; signing in through the form with a code from
  `usual-mail pair` set `usual-mail-session` and redirected; Home listed the three proposals (two an agent's, one a
  rule's) and Handled's Approve all applied them, each then seen at the mailbox; the trust form changed the inbox to
  act with undo, then act silently; Handled left the silent record out and showed it, marked "Done silently", with
  `?silent=1`; the Connection form came filled with the stored details and no password, a wrong password came back
  as 502 with the provider's words and without the typed password, a cross-site post and a post without the form
  token were refused with 403, and the new password was accepted (the inbox went `connecting`, then `ok`); Home's
  "1 change needs a look" showed an agent's move the IMAP server refused, with the provider's words; Sign out
  revoked the last person's device (the server then wrote a new owner's code); while pairing was rate-limited the
  sign-in page answered 429 with "Too many wrong codes. Wait 9 minutes, then try again."
- Third revision: 120 tests in 25 suites pass.
- Request-only run against the server's demo mode, from the server's source as it stood mid-round (scratch port
  and data, stopped afterwards; no browser): sign-in with the owner's code through the form; Home (attention,
  proposals; the sample's silent record left out); Handled without and with `?silent=1` (the silent record shown
  only with it, marked "Done silently"); the inbox page with Connection open for the inbox that needs attention;
  new IMAP and Gmail credentials refused by the demo's memory provider with its words shown and no secret in the
  page; the removal page's words; the trust words.

## Not done or not verified

- The look, keyboard use, zoom, phone width and screen readers: nothing was viewed in a browser.
- Never run on Cloudflare.
- Times aren't in the reader's time zone.
- No live updates: pages show the state when loaded.
- Accepted new credentials were only checked against the fake: the demo's provider refuses real-shaped ones, and
  no real mailbox was used.
- Drafts: only failed ones are shown, on Home, without actions. A sent draft's `note` is kept in its thread for a
  day (`thread(id).drafts`), and the dashboard shows no threads, so it doesn't show draft notes: the apps' thread
  view and the connector's `read_thread` do.
- Not built: the brief, editing a rule's text or conditions, reading mail, sending or deleting drafts, counts or any
  thread list, following a Google sign-in's outcome on the page (no scripts: the person comes back and looks).
- **The AI page and switch were checked against the fake and, in the review of 2026-11-17, with requests against the
  built server.** No browser.
- **The service's `detail` is shown on `/ai` and Home as the server gives it.** The server scrubs the key from it
  (`scrubKey`), except the key written another way, such as base64 (see [known issues](known-issues.md)).
