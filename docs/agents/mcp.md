# MCP connector

`mcp/` is the package `@usualmail/mcp`: the connector a person's own agent uses to work on their mail, over the
Model Context Protocol. It has no behaviour of its own beyond the limits below: every tool calls `MailService` with
the agent's own `Caller`, so the server's limits apply. It exports one function,
`createMcp(deps: InterfaceDeps): FetchHandler`. It follows the contract's fifth revision (2026-11-17, as amended):
categories, Home and the new lists, `categorize`, summaries, the server's own AI as an actor, and the triage queue
as the `unknown` threads the server's AI won't process.

The guide for people (giving an agent access, connecting Claude Code, Codex or another client, stopping it) is
[`mcp/AGENT-GUIDE.md`](../../mcp/AGENT-GUIDE.md). It says the server categorizes and summarizes mail itself with the
person's key, and that an agent sorts what the server's AI doesn't.

## Run and check

All commands run in `mcp/` after `npm install`.

| Command | What it does |
|---|---|
| `npm run check` | Checks `src/ui/design.generated.ts` is current, type-checks `src/` without Node types, type-checks `src/` and `test/` with them, and runs every test |
| `npm test` | The tests only |
| `npm run build:design` | Rewrites `src/ui/design.generated.ts` from `design/dist/web` (tokens.css, six icons, the hat fills) |

Checked on 2026-11-23 on this Mac (Node 22.23.2), after first-sync progress: `npm run check` passes, 134 tests in 32
suites (new in `test/tools-read.test.ts`: `list_inboxes` gives `firstSync` only while it runs; failed first). Before,
on 2026-11-17, for the fifth revision: 129 tests in 32 suites. A bundle of
`src/index.ts` for the `workerd` condition was last checked in the second round (no `node:` import); it has not
run in workerd or on Cloudflare.

## Mounting it

```ts
import { createMcp } from "@usualmail/mcp";

const mcp = createMcp({ service, authenticate: (token) => server.authenticate(token), basePath: "/mcp" });
app.all("/mcp", (c) => mcp(c.req.raw));
app.all("/mcp/", (c) => mcp(c.req.raw));
```

- The request reaches the handler **with its full URL**, as the contract says for mounted interfaces: it answers
  only when the path is `basePath` or `basePath/`, and anything else is `404`.
- Mount it **outside** the REST middleware: the connector reads the raw body itself (at most 1 MiB), does its own
  sign-in, and answers in JSON-RPC, not in the REST error shape.
- `basePath: ""` serves it at `/`.
- The `Origin` check compares a browser's `Origin` with the request URL's hostname. Behind a reverse proxy, keep the
  public `Host` header so the URL the handler sees has the public hostname.
- No `node:` module is imported in `src/`; `tsconfig.json` checks it without Node types, so one would fail the check.

## Layout

```
src/index.ts          the one export
src/handler.ts        endpoint path, Origin, bearer sign-in, refusing person tokens, the SDK's HTTP handler
src/server.ts         one McpServer per request: instructions, tools, view resources
src/instructions.ts   the server's instructions: the server's own AI and the categories, the workflow, the limits, why person tokens are refused, mail and summaries are untrusted
src/boundary.ts       the marked data block and the result helpers
src/errors.ts         ServiceError codes to tool errors with a next step (the wait from retryAfter on rate_limited)
src/format.ts         short shapes of core's types, HTML to text, times, cursors
src/tools/            inboxes.ts, rules.ts, triage.ts, ai.ts, threads.ts, actions.ts, drafts.ts, briefs.ts, shared.ts
src/ui/               views.ts (HTML, CSS, resources), view-script.ts, structured.ts, hats.ts, design.generated.ts
scripts/build-design.mjs   writes src/ui/design.generated.ts
test/                 fake-service.ts (in-memory MailService) and fake-data.ts (its callers, sample and paging), helpers.ts (real MCP client), fake-dom.ts, *.test.ts
```

## What is implemented

### Transport and sign-in

- MCP Streamable HTTP, protocol revision **2026-07-28**, stateless, from `createMcpHandler` in
  `@modelcontextprotocol/server` 2.4.0. Its default legacy mode also serves **2025-era clients** that open with
  `initialize`, each request on a fresh server with no sessions. `GET` and `DELETE` answer `405`.
- `Authorization: Bearer <token>` on every request, turned into a `Caller` by `deps.authenticate` each time, so a
  revoked token fails on its next request.
  - No token or a malformed header: `401` with `WWW-Authenticate: Bearer realm="usual-mail"`.
  - Unknown or revoked token: `401` with `error="invalid_token"`.
  - **A person's token: `403`**, as the contract says: an AI acting with it would count as the person, so no trust
    check would apply and trash and block_sender would happen at once. The server's instructions say the same.
  - `authenticate` throwing: `500` with no detail.
  - The body of each is a JSON-RPC error without an id, with a message saying what to do.
- `Origin`: absent passes (agents and servers don't send it); a browser page from another hostname gets `403`, using
  the SDK's `originValidationResponse`.

### Tools

Registered in this order, the same for every agent token. Nothing that needs a person is registered.

| Tool | Calls | Notes |
|---|---|---|
| `list_inboxes` | `listInboxes` | Name, address, trust, status, guide, and while a first sync runs `firstSync` (`fetched`, `total`; 2026-11-23, said in the description: more older mail is still to come); with `needs_attention`, `statusDetail` and `statusReason` (0.1.2, the description says what each means); never the connection (no `aiProcessing` since the per-inbox switch was removed, 2026-11-17). The description explains the three trust levels as the contract's table does |
| `update_guide` | `updateInbox(id, { guide })` | Only `guide` is ever sent |
| `list_rules` | `listRules` | Each rule with who made it (`createdBy`: `person`, `agent <name>`, or `Usual Mail` for a rule from an older server), so an agent can tell its own suggestions |
| `suggest_rule` | `createRule(draft)`; with `listFromThread`, `thread` first | `then` steps may `categorize` (with `category`). No source passed; the server makes it `agent` and off. `listFromThread` (a thread id) sets `match.listId` from the newest incoming message's `listId` and the inbox from the thread, so the agent copies nothing out of mail. Refused before the service: a thread without a List-Id, a thread in another inbox than `inboxId`, a `match.listId` that differs, no inbox, an empty match |
| `update_rule` | `updateRule(id, patch)` | Text, match or then (each replaced whole). Never sends `enabled`. The result says whether the rule is on: the server switches an enabled agent rule off when its match or then changes. A rule a person made answers `needs_person` |
| `delete_rule` | `deleteRule` | A rule a person made answers `needs_person` |
| `take_triage_batch` | `triageQueue` | The `unknown` threads nobody decided that the server's AI won't process (the AI not working, or its answer dropped; since 2026-11-18 age is no reason, as the AI's history is all synced mail); the description and the instructions say the server categorizes and summarizes everything else itself. Default 10, at most 25; newest message cut to 2000 characters |
| `sort_threads` | `decide` | 1 to 50 decisions: a category (any but `unknown`), done, need, reason (required, at most 200 characters) |
| `get_ai_status` | `aiStatus` | The AI's state, the job with a missing model, last run and `pending` (all synced mail that isn't done; no `beyondHistory` since 2026-11-18), with fixed words for each state. Never `detail` (a service's message can repeat part of the key), never the settings |
| `read_thread` | `thread` | The thread's category, `categorizedBy`, `screened`, summary and, for a receipt or an invoice, `payment` (as data, like the summary; since 2026-11-19, in every row `threadSummary` builds), then messages from the newest back (default 5, at most 20); each cut to 4000 characters; HTML-only messages become text; drafts included |
| `search_threads` | `search` | Service cursor passed through; default 20, at most 50. Full text with Gmail's operators and the filters (`kinds`, `from`, `to`, `hasAttachment`, `unread`, `after`, `before`; `inboxId` sent as `inboxIds`), filters alone allowed; each row the thread's summary plus `matchedIn` and the excerpt as plain text (2026-11-20). Never the mailbox's own search: that is a person's |
| `list_threads` | `home`, `category`, `stack`, `waiting` or `screening`, plus `listInboxes` | `view`: home (default), one of the seven categories, a stack, waiting or screening. Has the thread-list view |
| `act_on_threads` | `act` | All twelve action kinds, flattened (`category`, `stack`, `comeBackAt`, `ifNoReply`); `categorize` replaces `move`; reason required; times made whole-second UTC. The lead counts silent records ("1 applied (1 silently)") |
| `undo_action` | `undo` | |
| `list_handled` | `handled` | Default states from the service; `includeSilent` and `attentionOnly` pass through (default off). The server's AI is an actor, "Usual Mail's AI (categorize with <model>)"; its records are silent, so they show only with `includeSilent` (or `attentionOnly` when something went wrong). With `attentionOnly` the service also gives the person's own refused changes (`actor: "person"`), only in inboxes the agent may see. Each record with its thread's subject and state (`trashed` too), and `silent`, `error`, `note` when set |
| `write_draft` | `thread`, `listInboxes`, `saveDraft` | Replies only; with `draftId`, only the body of a draft an agent wrote (the server answers `needs_person` for a person's). See Decisions |
| `list_drafts` | `listDrafts` | Drafts in state `draft` or `failed`, with who wrote each, `error` and `note`; default 20, at most 50 |
| `delete_draft` | `deleteDraft` | Only a draft an agent wrote: the server answers `needs_person` for a person's. See Decisions |
| `write_brief` | `writeBrief` | Times normalised; `from` before `to`. The server fills in counts and each highlight's `subject` |
| `get_brief` | `latestBrief` or `brief`, `listInboxes` | Each highlight's `subject` as the brief carries it; no thread is read. Has the brief view |

- A thread's state (every tool that returns threads) carries `skippedScreening` when the thread skipped Screening while
  its sender isn't let in (2026-11-25): core's line, "Skipped Screening: a security alert", so an agent can say why a
  stranger's mail isn't in Screening.
- Every result is short text: the connector's own sentence, then one data block, then what to do next. Lists end
  their data with `{"nextCursor": ...}` when there is more.
- `list_threads`, `get_brief`, `act_on_threads` and `undo_action` also return `structuredContent`, which the views
  read. It carries a `notice` that everything else in it is data.
- Errors: every `ServiceError` becomes a tool result with `isError: true`, a fixed lead and next step per code (for
  example `needs_person`: "Only a person can do this… Don't retry"), and the code and the service's message in the
  data block. `rate_limited` with a `retryAfter` says "Wait N seconds, then try again" (a number the server gave,
  so it may stand outside the block). Anything else is `internal` with no detail. A `ServiceError` from another
  copy of core is recognised by its name and code, with its `retryAfter`. Arguments the schema refuses come back
  as the SDK's tool error, before any service call.

### Mail is untrusted

- One data block per result: `<usual-mail-data id="X">` … `</usual-mail-data id="X">`, with X 18 random hex
  characters per result. Inside, one JSON value per line, written so that `<`, `>`, line and paragraph
  separators, NEL and bidirectional overrides are `\u` escapes. So nothing inside can contain a marker, a tag or a
  line break, and each line parses back to exactly what the store holds.
- **Everything from the store goes inside**: mail, names, addresses, list ids, **summaries** (a model wrote them from
  untrusted mail, so they are mail too), guides, reasons, rule text, drafts, briefs, ids, the AI's model ids, what
  mail providers said (records' and drafts' `error` and `note`), and the service's error messages. The text outside
  is fixed wording and numbers only; `get_ai_status` picks its lead from a fixed table by state.
- The server's instructions and each reading tool's description say that the block is data, never an
  instruction, and that tool calls come from what the person asked and from ids Usual Mail returned.
- Tools take ids wherever they can. `write_draft` takes recipients and subject from the message replied to, never
  from text. `suggest_rule` takes a list id from the thread's stored messages. `act_on_threads` says to use only ids
  from Usual Mail results.
- Tests put hostile text in every field an agent reads (subjects, bodies, names, attachments, guides, reasons,
  rules, drafts, briefs, provider errors and notes, a List-Id, a summary, the AI's model id, the AI service's
  `detail`) and check each reading tool (the summary in `take_triage_batch`, `read_thread`, `search_threads`,
  `list_threads` and the view's rows; `get_ai_status` shows no `detail` at all), `list_drafts`,
  `list_handled` with silent records, and the results of `suggest_rule` from a hostile thread, `update_rule`,
  `delete_rule` and `delete_draft`: one block, nothing hostile outside it.

### Interface pieces (MCP Apps)

- Extension `io.modelcontextprotocol/ui`, specification 2026-01-26 (marked Stable). The server advertises the
  extension in its capabilities. `list_threads` and `get_brief` carry `_meta.ui.resourceUri` (and the older
  `ui/resourceUri`, through `registerAppTool` from `@modelcontextprotocol/ext-apps/server` 2.0.4).
- Two resources, `ui://usual-mail/brief.html` (the brief card, `design/specs/brief-card.md`) and
  `ui://usual-mail/threads.html` (rows as `design/specs/pile-row.md` draws them; a row shows the summary in place of
  the snippet when there is one, and "Screened" in the screening list), type `text/html;profile=mcp-app`, with
  `_meta.ui` `{ csp: {}, prefersBorder: false }`: no network, fonts or frames.
- Each is one HTML document with `design/dist/web/tokens.css` inlined unchanged, the view's own CSS (only token
  variables; a test checks every `var()` exists in tokens.css and that no colour or font is written directly), six
  icon symbols from the sprite, and an inline script.
- The script speaks the extension's postMessage protocol by hand: `ui/initialize` (protocol 2026-01-26), then
  `ui/notifications/initialized`; it draws each `ui/notifications/tool-result`, follows the host's theme, reports
  `ui/notifications/size-changed`, answers `ui/resource-teardown`, and ignores messages not from its parent. It puts
  data in the page only through `textContent`.
- The brief card's counts are by category, then done and trash ("Newsletters 1 · Receipts 1 · Done 1"); a section
  with none has no counts line. The list's label names its view (Home, Newsletters, Waiting, Screening, …).
- Actions in the views: rows offer Done and Reply later (`act_on_threads`), then Undo (`undo_action`) when the
  record is undoable; a proposal shows "Proposed: waiting for your yes in Usual Mail". A brief highlight asks the
  host, with `ui/message`, to open the thread by id, when the host supports messages. The brief card's subject
  line under each highlight is the one the brief carries.
- **Fonts:** the extension's default policy has no font source, and declaring one needs a public origin serving
  the files. So Geist isn't loaded; the token stacks fall back to Georgia and the system sans.
- The view tests run the script in `node:vm` with a fake DOM and a clock pinned to the sample's "now"
  (`test/fake-dom.ts`), so times read the same on any day. Before 2026-11-17 one test read the wall clock and
  failed the day after it was written.

## Decisions and why

- **Person tokens are refused.** Through the connector an AI acts. With a person's token its actions would be
  recorded as the person's ("You moved it"), trust wouldn't apply, and trash and block_sender would apply at once.
  The contract now says so; the instructions repeat it.
- **The triage queue is only what the server's AI won't do.** The instructions and `take_triage_batch` say so, so an
  agent doesn't re-sort what the server categorized; `act_on_threads` with `categorize` still corrects a category.
- **Summaries are data.** A summary is a model's words made from untrusted mail, so it goes inside the block and the
  views put it in the page as text, like the mail itself.
- **The AI's status, not its settings, and never its `detail`.** The contract lets anyone read the status; the
  service and models are the person's. A service's error message can repeat part of the key, so the
  connector drops `detail` and words each state itself.
- **Person-only actions are not registered at all,** whatever the token, so they can't be called by guessing a name
  (the SDK answers "Tool … not found"). The service would refuse them anyway. `update_rule` never sends `enabled`.
- **One data block per result, JSON lines, escaped:** the guarantee is mechanical (no `<`, `>` or line break inside),
  not a matter of the model noticing. All store data goes inside, including what people, agents and providers
  wrote, because a guide, a reason or a note can carry text an earlier, tricked agent or a mail server copied.
- **Recipients from the thread, replies only:** an injected "reply to this other address" can't choose who a draft
  goes to. New mail to new people isn't offered. Sending stays a person's.
- **A person's drafts are left alone, by the server.** Since the fourth revision the contract says an agent may
  change or delete only a draft an agent wrote, and the service enforces it, so `delete_draft` calls `deleteDraft`
  straight away (no lookup of its own any more) and `write_draft` with `draftId` gets `needs_person` for a person's
  draft. The connector's earlier own guard (a lookup in `listDrafts`, up to 10 pages) is gone. The reason stands:
  a deletion leaves nothing for the person to review, so an agent tricked by a message can't remove what the person
  wrote.
- **Rules for lists from a thread id:** `Message.listId` is stored by the server, so the agent names the thread
  and the connector reads the list id; no text from the mail body is copied.
- **Not offered, though the contract allows agents them:** `me` (the connector already knows the agent from its
  token) and revoking its own token (an injected message could make an agent cut itself off; a person removes
  agents).
- **Required reasons** for `sort_threads` and `act_on_threads`, so every line in Handled says why.
- **Small pages** (triage 10, lists 20, thread messages 5, text cut at 2000 and 4000 characters) to keep an
  agent's context small; it can page or read the whole thread.
- **The tool list is the same for every client.** The 2026-07-28 revision doesn't vary lists per connection, and the
  extension asks for text that works without it, so view tools always answer in text too.
- **The SDK's stateless legacy mode** rather than sessions: nothing to keep between requests, which suits
  Cloudflare. A 2025 client that needs a GET stream gets `405`.
- **Hand-written view script, no bundle:** the extension allows it, the views stay two small strings, and the
  connector needs no build step. `@modelcontextprotocol/ext-apps` is used only for its server helpers.
- **Design values copied by a script,** not read at run time: `scripts/build-design.mjs` writes
  `src/ui/design.generated.ts`, and `npm run check` fails when it is stale. Hat matching repeats the OKLab maths of
  `design/scripts/lib`; a test checks the sample's colours land on blue, green and orange as the design note says.

## Versions and sources (checked 2026-11-16, versions rechecked 2026-11-17)

| What | Version | Source |
|---|---|---|
| MCP specification | 2026-07-28, still the current revision on 2026-11-17 | modelcontextprotocol.io/specification/versioning |
| `@modelcontextprotocol/server`, `client`, `core` | 2.4.0, still npm `latest` on 2026-11-17 (published 2026-10-23) | npm registry; ts.sdk.modelcontextprotocol.io/v2 |
| MCP Apps | specification 2026-01-26, Stable; `@modelcontextprotocol/ext-apps` 2.0.4, npm `latest`. 2.1.0 was published on 2026-10-27, after 2.0.4, but is not tagged `latest`; not adopted | npm registry; github.com/modelcontextprotocol/ext-apps |
| zod | 4.6.7, still npm `latest` | npm, peer range of the SDK |
| Claude Code and Codex MCP setup (for the guide) | as documented | code.claude.com/docs/en/mcp; Codex's MCP page |

## Checks (2026-11-17, this Mac, Node 22.23.2)

- **Blocked senders (2026-11-20):** nothing for agents: the list and the unblock by address are a person's, so no
  tool names them; the fake service answers both `needs_person`. The sample's new agent block (approved) is a fifth
  row in `list_handled`'s default list. 133 tests pass.
- **Notifications out of Home, and their groups (2026-11-19, the owner's decisions):** the instructions,
  `list_threads` and the category note say Home holds conversations and unknown threads, notifications their own
  list (replacing the 2026-11-18 wording); `list_threads` says what a notification's `group` is (the same opaque
  string on one inbox's notifications about the same thing; each thread still listed on its own, no collapsing here),
  and `threadSummary` passes it through with the event. Tests on both, failing first; the fake service's Home uses
  core's `HOME_CATEGORIES`. Type check clean, 132 tests pass.
- **Notifications in Home (2026-11-18, the owner's decision; reversed 2026-11-19):** the instructions, `list_threads`
  and the category note said Home holds conversations, notifications and unknown threads. Type check clean, 130 tests
  pass.
- **Sign in with Google and the removal of the per-inbox AI switch (2026-11-17):** `npm run check`: design file
  current, both type checks clean, 129 tests in 32 suites pass. Changed: the fake service implements
  `startGoogleSignIn`, `googleSignIn` and `aiDisclosure` (person only, never reached: the connector offers neither,
  and agents may not use them) and `info().googleSignIn`; `list_inboxes` no longer carries `aiProcessing`; the instructions,
  `take_triage_batch` and `get_ai_status` say the AI processes every inbox's mail; the triage tests lost the "inbox
  with AI off" case; the sample's `pending` is 4 (its personal inbox had AI off).

- **After the review's decisions (2026-11-17):** `npm run check`: design file current, both type checks clean, 129
  tests in 32 suites pass. Changed: `AGENT-GUIDE.md` says trust governs agents and the rules an agent made, and rules
  the person taught always apply; the fake service merges several categories in one list and sets
  `categorizedByActor` with `categorizedBy`. The connector shows neither `Thread.sender` nor `categorizedByActor` yet
  ([improvement ideas](improvement-ideas.md)).

- **Fifth revision:** `npm run check`: design file current, both type checks clean, 129 tests in 32 suites pass (117
  in 31 before). The fake service follows the fifth revision (Home, categories, waiting, screening with screened
  threads left out elsewhere, `categorize` and `categorizedBy`, a triage queue of `unknown` threads the AI won't
  process, the AI's status for anyone and its settings for a person only). New or changed: Home by default and every
  other view with its service call, Now and the piles refused; summaries in reading tools and rows; the triage queue's
  meaning (an inbox with AI off, the AI failing); `sort_threads` with categories, never `unknown` or a pile;
  `categorize` in `act_on_threads` and rules; the AI as an actor in `list_handled`, silent unless asked; `get_ai_status`
  (no settings call, no `detail`); hostile summaries, model ids and AI `detail`; the AI's settings and testing among
  what is never called or reachable by guessing a name.
- **Independent review (2026-11-17):** `npm run check` again: 129 tests in 32 suites pass. **Joined** against the fifth
  revision's built server (`--dev-fake-ai`, an agent's token from `usual-mail agent add`, the SDK's own client over
  HTTP): 20 tools listed; `list_inboxes` (with `aiProcessing`, no connection); `list_threads` Home with summaries
  inside the data block; `read_thread` of a hostile mail (a subject imitating the block's end tag, U+2028 and U+202E)
  with everything escaped inside one block; `get_ai_status` without `detail`; with the inbox's AI off,
  `take_triage_batch` gave the new thread and `sort_threads` applied it in an `act_with_undo` inbox; `list_handled`
  with `includeSilent` named "Usual Mail's AI (categorize with dev-fake/categorize)". A person's token got 403, no
  token 401, a foreign `Origin` 403, and `update_ai_settings` "Tool … not found". No real agent or chat app.
- After the final review's decisions (2026-11-17): `npm run check`: design file current, both type checks clean, 117
  tests in 31 suites pass. New: `list_handled` with `attentionOnly` lists the person's own refused change in an inbox
  the agent sees and not in one it doesn't (failed first against the fake service, which then followed the old rule;
  the fake now mirrors the contract); the tool's description says so. Joined: on the built server, an agent's
  `GET /v1/handled?attentionOnly=true` gave the person's refused move (REST, not through the connector).
- `npm run check` (fourth revision): design file current, both type checks clean, 116 tests in 31 suites pass.
  New or changed: `list_rules` says who made each rule; `list_handled` with `attentionOnly`; `read_thread` shows a
  sent draft's note; `delete_draft` and `write_draft` on a person's draft get the service's `needs_person`; the
  hostile fixture's rule has a hostile maker's name, which stays inside the block.
- Final review (2026-11-17): `npm run check` again: design file current, both type checks clean, 116 tests in 31
  suites pass. **Joined** (the built server with an IMAP inbox on a local test server, the SDK's own client over
  HTTP, an agent token from `usual-mail agent add`): 19 tools listed; `list_inboxes` gave the guide inside the data
  block and no connection; `take_triage_batch` then `sort_threads` proposed two moves in a `suggest` inbox (approved
  in the dashboard and seen at the mailbox), applied one in `act_with_undo` (archived at the mailbox) and one
  silently in `act_silently` ("1 applied (1 silently)"), which `list_handled` left out unless `includeSilent`;
  `act_on_threads` with a move the IMAP server refused came back in `list_handled` with `attentionOnly`, the error
  inside the data block; `write_draft` addressed a reply from the thread, which a person sent; `write_draft` with
  a person's draft id and `delete_draft` of a person's draft answered `needs_person` from the service; a person's
  token got `403`, and so did a request with a foreign `Origin`.
- Third revision: 114 tests in 31 suites pass. The runs below used the fourth revision's server.
- Against the server's demo mode, from the server's source as it stood mid-round, with the SDK's own client over
  HTTP and an agent token made through an agent pairing code: 19 tools listed in order; `list_handled` leaves the
  sample's silent record out and shows it, marked silent, with `includeSilent`; `get_brief` gives each highlight's
  subject from the brief; `suggest_rule` with `listFromThread` made an off rule matching the list's id;
  `update_rule` changed it (still off); `update_rule` on a person's rule answered "Needs a person"; `delete_rule`
  and `delete_draft` (an agent's draft) worked; a person's token got `403`.

## Not done

- **Sign-in for chat apps (OAuth).** Claude and ChatGPT in a browser connect only with OAuth, so they can't use the
  connector yet, and the views have only been run in tests. It would need: the protected resource metadata document
  (RFC 9728) and a `resource_metadata` link in the `401` challenge; an authorization server (authorization code
  with PKCE, client registration by Client ID Metadata Documents, which 2026-07-28 prefers, with dynamic
  registration as a fallback); a consent page where a person picks the inboxes, which creates an agent device; and
  access tokens that `authenticate` turns into that agent's `Caller`. The connector itself would only add the
  metadata link; `createMcp` already checks every token through `authenticate`.
- Waking an agent when mail arrives; the connector never pushes. A `subscriptions/listen` stream (served by the SDK)
  receives nothing.
- Attachment contents: agents see names, types and sizes only.
- Pictures from the web (2026-11-18): the connector never loads them. The HTML it turns into text arrives from the
  server with trackers taken out and pictures pointing at the server's picture route, which an agent's token can't
  open (`needs_person`); nothing in the connector changed.
- Draft notes reach an agent only through `read_thread`, for the day the server keeps a sent draft with a note;
  `list_drafts` lists only unsent and failed drafts, as the contract says.
- **Not verified:** a real Claude Code, Codex or other client against this endpoint (only the SDK's own client, in
  both eras); the views in a real MCP Apps host or any browser (only a fake DOM in Node); a run on Cloudflare.

## For the contract, core and design

- **`AiStatus.detail` and the key.** The contract says since 2026-11-17 that the status never carries the key in any
  form (the server's `scrubKey` takes it out written out, in base64 or hexadecimal, spaced out or broken up). The
  connector still leaves `detail` out for agents; REST gives it to them.
- **No AI icon** in the design system: the views have no place that needs one yet.
- **Fonts in chat views:** to show Geist, the server would serve `design/dist/web/fonts` at a public origin and the
  views would declare it in `_meta.ui.csp.resourceDomains`; hosts may warn people about that. Left out.
