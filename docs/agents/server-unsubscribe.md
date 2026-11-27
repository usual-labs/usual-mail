# Server: unsubscribing from a sender (`server/src/unsubscribe/`)

Built 2026-11-27 at the owner's request, for the Feed's swipe ("unsubscribe from it, so I won't ever get that any feed
from those or email from those, and I want this to be agentic"), with the owner's plan of the same day: "Make the 1st
step, and also then, let's make the 2nd step, but the 2nd step would be optional. So user can go into settings in the
AI section and then set it up ... give out a browser use API key ... the cheapest way possible because it's not also
a very hard task." What it does is the contract's ([unsubscribing](../contract.md#unsubscribing)); the apps' side is
in [apps-phone.md](apps-phone.md) and [apps.md](apps.md). **Tested with fake hosts and a fake Browser Use only:** no
real sender has been asked, and Browser Use's API has never been called (no key here).

## What is built

The first build was reviewed for security the same day (the coordinator's review of 2026-11-27: no-go, two blockers;
then a re-review: no-go, one more, links in a body) and changed as below before anything shipped.

- **Only proved, signed mail, sent to this inbox** (blocker B2, and the re-review): mail's parser reads which of a
  message's unsubscribe headers the sender's own signature vouches for (`signedUnsubscribe` in
  `mail/src/message/signed-recipients.ts`, the same monotone check as the recipient fields: List-Unsubscribe and
  List-Unsubscribe-Post each given once and named in the `h=` of every aligned signature), stored as
  `messages.signed_unsubscribe`. The queue uses a message only in a Gmail inbox (`trustsChecker`), only when the checker
  proved exactly the From address's domain with a DKIM signature of its organisation (`provedFromSender`, the bar of
  `provedOwnSender`), and only when its signed To or Cc names this inbox (`sentHere`, the screening gate's
  `addressedTo`, aliases included): so a newsletter someone sent on, with their unsubscribe token, is never used. Then
  only the signed header's ways. **No link in a body is used** (the re-review's blocker N1): a signed welcome mail can
  repeat a name someone gave at sign-up ("unsubscribe https://…"), and a Content-Type added above a signed plain-text
  mail turns its words into HTML links while DKIM checks the one below. Without such mail nothing is tried: it is
  `failed` with words saying why (`UNPROVED`: `inbox` for IMAP, `mail` when nothing is proved, `forwarded` when nothing
  proved was sent here, `old` when their only proved mail was stored before 0.1.5 and its signed headers were never
  read: "the next time they write, unsubscribing will work").
- **`ways.ts`**: `headerWays`: the signed header's https address (a one-click one only with a signed
  List-Unsubscribe-Post, and the page) and its mailto. **A mailto can't make the inbox say anything** (blocker B1): one address of plain ASCII, its subject only when 1 to
  100 characters of plain ASCII (else "unsubscribe"), and always the server's own body (`EMAIL_BODY`). **Pages** are
  https at a host name with a registrable domain (the Public Suffix List when the server has it): never an IP address
  (`https://169.254.169.254/`), a user name, or over 2,000 characters.
- **`requests.ts`**: `MailService.unsubscribe` (person only; a paused inbox is `conflict`): one row per inbox and
  sender in `unsubscribes` (migration 0023), `working` with step `start`; asking again starts over with a higher
  `version`, unless one is still working. `BlockedSender.unsubscribe` comes from the same rows (`service/senders.ts`).
- **`queue.ts`**: `Unsubscribes`, a queue in the cost lookups' pattern (`ai/costs.ts`), started and stopped with the
  server: what waits is in the store, so a restart carries on. `start` reads the sender's 20 newest messages in the
  inbox, the thread asked from first; the first proved one sent here whose signed header offers a way gives all of its
  own. Then, in order: the
  one-click POST through the host (`Host.oneClick`: `postOneClick` in `node/pictures/fetch.ts` and
  `cloudflare/web/fetch.ts`, under the pictures' address rules, https only, no redirect followed; **only a 2xx is a
  yes**; demo mode and most tests have none), the email through the inbox's provider, then the page: to Browser Use
  when a key is set (step `agent`, read every five seconds, stopped after ten minutes from asking or past the cost cap),
  else to the person. **Before an email is sent or a run started, `tried` is written** (and the run's `marker`): a server
  stopped part way first stops a run it may have started, found by its marker, before anything else (the re-review's
  N2: one click and the email had failed, the run was marked, the server stopped before keeping its id; it says the run
  was stopped only when Browser Use took the stop of one it found, else that it asked), and doesn't send an email again
  (it says it can't know whether it went); a start whose answer was lost is found and stopped the same way. **A key
  removed or replaced, or the inbox or the asking gone, while a run's start is on its way** stops that run once the
  start answers, with the client in hand (`#stillWanted`): the removal's own stop couldn't know of it yet. Each change of state
  or way raises the version and sends `unsubscribe.changed`; a poll that changes nothing sends nothing. A row asked again
  meanwhile isn't overwritten (its version is the key the queue writes against).
- **`browser-use.ts`**: Browser Use's API v4 (`https://api.browser-use.com/api/v4`, read in its docs on 2026-11-27):
  `POST /runs` with the fixed instruction (`instruction()`, ending with the run's marker), model `bu-fast` (its own fast
  model; the docs give no price for it apart, so what a run costs is held to the cap), `maxCostUsd`
  0.1 (which its docs say covers model and search charges, not browser time), no proxy (`proxyCountryCode: null`) and
  an output schema of `{ unsubscribed: boolean }`; no `keepAlive` (its shortest, 120 seconds, is the default, and kept
  time is billed). Then `GET /runs/:id` every five seconds: its status, and `totalCostUsd`, which the server holds to
  the same cap itself; once it ends, `PATCH /browsers/:sessionId` `{ "action": "stop" }` stops its browser (whether the
  run's `sessionId` is the browser's id there is the docs' path name, not tried). `POST /runs/:id/cancel` stops a run
  that takes too long or costs too much; `GET /runs?limit=50` finds a run by its marker when its start's answer was
  lost (its order and reach aren't documented: a lost run outside the newest 50 isn't found, its cost still capped;
known-issues.md). The key goes only in `X-Browser-Use-API-Key`. Its errors are the server's own words by status (401 or 403
  `key_refused`, 402 `out_of_credit`, 429 and the rest `unavailable`; a run failed "Out of credits" is
  `out_of_credit`), never the service's answer. The key test reads the status of a run that doesn't exist (an all-zero
  id): 404 is a key taken (documented), 401 one refused.
- **`agent.ts`**: the key, sealed in `server_state.browser_agent_credentials` under its own context
  (`browser-agent`), and its state; `AiSettings.browserAgent` (`ai/settings.ts`, where `PATCH /v1/ai` takes
  `browserAgent` and tests a new key before answering). A refusal during a run is recorded there too, and the settings'
  event sent when what they show changed. **Replacing or removing the key, or removing an inbox, first stops the runs
  it has going** (`cancelAgentRuns`). **Demo mode** (`browserAgent: { off: true }`, Node's `--demo`) takes no key and
  uses none.

## Tests

`server/test/unsubscribe.test.ts` (21 tests): only signed headers read, one-click only with both signed; a mailto's
body never sent, its subject only short plain ASCII, one plain address; no IP address, user name or unregistrable host
as a page; one click posted and said (events, the blocked item); a redirect no yes, the email then sent with the
server's own body; unproved mail, a header added after signing and an SPF-only pass never followed; an IMAP inbox saying
so; the signed header's page handed over, and a signed welcome mail's link to someone else's page never used; mail sent
on from another inbox not used, an alias of this one used; mail from before 0.1.5 saying so (only mail proved and sent
here counts for it); a person's alone;
`postOneClick` refusing http and private addresses; the key saved, tested and shown nowhere; a refused key, and demo mode
refusing one; a run with `bu-fast`, the cap, no proxy and no `keepAlive`, read until done, its browser stopped; a run
that doesn't confirm, takes too long or costs past the cap; a run refused for credit; a lost start found by its marker
and stopped, never started twice; a restart after one click and the email failed and a run was marked, stopping that run
first, and saying only that it asked when no marked run is found; a key removed while a run's start is on its way,
stopping that run once it answers; removing the key or the inbox stopping the run.
`mail/test/unit/signed-recipients.test.ts`: the unsubscribe headers the signature vouches for, directly and through the
parser.
`server/test/migration-0023.test.ts`: the migration's table, columns and fields, empty, the AI's settings untouched.

## Not done, not verified

- **Never run against a real sender or Browser Use.** Whether Browser Use's `bu-fast` reliably presses a real page's
  controls, what a run costs in practice (its median task is quoted at under a cent), and its 404 for the key test are
  unproven.
- **Mail stored before 0.1.5** has no `signed_unsubscribe`, so it is never used: a sender whose only mail is older
  can't be unsubscribed from automatically until new mail from them arrives (and the words say so).
- **No body links,** so a sender whose mail has no signed List-Unsubscribe is only blocked
  ([improvement-ideas.md](improvement-ideas.md)).
- **Only https pages,** and only the sender's newest 20 messages are read. A page that needs signing in is left to the
  person, as the instruction tells the agent to stop.
- **Stopping a run's browser** uses the run's `sessionId` as the browser's id, as the docs' path names it; not tried.
- **Browser Use's other options** left out: its zero-data-retention setting (a project setting on its side, which the
  person can turn on), webhooks (v4 has none; the queue polls), its EU address.
