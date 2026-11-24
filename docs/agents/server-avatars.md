# Server: sender pictures

How the server builds [sender pictures](../contract-avatars.md) (2026-11-19). Built and tested with made-up mail, a
made-up suffix list, a fake site source and fake sites on the loopback addresses; no test reaches the real network.
Reviewed for security on 2026-11-19 (fixes below), with the Public Suffix List shipped (below). The rules
are the contract's page; this note is where the code is and why.

## The Public Suffix List

Shipped since 2026-11-19 (the owner approved the download: "Yes, download it"). `node scripts/update-suffixes.mjs
09c1b150f33c6145a73afcf7db0fb872fc54b4d1` took `public_suffix_list.dat` and `LICENSE` from `publicsuffix/list` at that
commit: the list was 342,384 bytes and 16,745 lines, sha256 `0cbae6dbe9f1a6c4231f7719402817d345bf39a4bdff0894231e9a2cbec30d8d`
(also kept in `suffixes.json`'s `source`); 6,951 ICANN and 3,512 private rules, in ASCII. Written:
`src/avatars/suffixes.json` (172,093 bytes, sha256 `d53d41562b98a14286926a8192df8f14f315de32b84a6505549c248fd63f7304`)
and `suffixes.LICENSE` (the MPL-2.0 text, sha256 `543ea9b97ed839650938a7da28440b332ff62a9f6d36876033da9408b31857f5`).
Checked before use: `co.uk` and `com.au` registrable one label down, `github.io` and `blogspot.com` in the private
section (a customer's own), `*.ck` with `!www.ck` and `*.kawasaki.jp` with `!city.kawasaki.jp` as the list's algorithm
says, IDN rules in their xn-- form; `onmicrosoft.com`, `googlegroups.com` and `substack.com` are not split by it, so
`isSharedPlatform` is what keeps their tenants from a picture (`avatars-shipped.test.ts`). The script was run twice:
the first run kept no hash of the file, so it was changed to record the file's size, lines and sha256 and run again
on the same commit. Pictures are on by default from this build; a server built without the file would log
`SENDER_PICTURES_OFF` and fetch nothing.

## Where the code is

```
mail/src/message/auth-results.ts  the provider's checker's word (RFC 8601 reader, fromAuthentication, fromCheckOf)
mail/src/gmail/messages.ts        fetchFromChecks: the metadata form, Authentication-Results and From only
src/avatars/                      host-neutral
  host.ts          asciiHost: a host name in ASCII or null
  suffixes.ts      rulesFromList (the list's file), SuffixList (publicSuffix, registrableDomain)
  shipped.ts       the shipped list from suffixes.json, or null
  freemail.ts      mailbox providers anyone can sign up to
  rules.ts         organisational (automated or filed), avatarDomain (proved, the address's own, registrable, not freemail)
  discover.ts      icons in a page's head and a manifest, bounded; ranking; the conventional fallbacks
  ico.ts, png.ts   ICO's largest image as a PNG; a BMP converted; the server's own PNG writer (CompressionStream)
  picture.ts       avatarPicture: what may be kept (formats, sizes, square-ish, still)
  sites.ts         avatar_sites: wanting a domain, recording a fetch, pictures by domain, the route's lookup, forgetting
  settle.ts        threads.avatar worked out again (settleThreadAvatars, settleSenders, settleDomain); messageAvatars
  queue.ts         AvatarQueue: one fetch at a time, the gap, the day's cap, the daily sweep
  backfill.ts      backfillFromChecks: asking the provider again at each start, counts only in the log
  service.ts       Avatars: on with a list, the queue and backfill started and stopped, the route's answer
  site-icons.ts    SiteIcons: one domain's page, manifest and icons through a host's fetcher (both hosts share it)
src/node/avatars/site.ts          NodeSiteIcons: SiteIcons over Node's fetchWebBytes (Cloudflare's: src/cloudflare/web/sources.ts)
src/node/pictures/fetch.ts        fetchWebBytes (the final address after redirects), `accept`, `cutAt`
```

Wired in: `sync/rows.ts` (`from_check`, `from_verified` stored), `sync/ingest.ts` (threads settled before the batch's
events; new incoming mail wants its domain looked at again), `service/store.ts` (`saveThreadState` settles the thread;
`setSenderStatus` and `markKnown` settle the sender's threads and want a new domain), `service/actions.ts` (a sender
action sends its threads as they are after the sender changed), `service/rows.ts` (`toThread` serves `row.avatar`,
never on a screened thread), `service/views.ts` (`messagesOf` adds message pictures), `sync/engine.ts`
(`authentication` in the provider options while pictures are on), `rest/` (the route and `avatarResponse`),
`node/main.ts` (`NodeSiteIcons` outside demo mode, the one log line), `demo/seed.ts` (`DEMO_SUFFIXES`, the sample's
pictures drawn and kept under the sample's ids).

## Choices

- **A thread's picture is kept on its row** (`threads.avatar`) and worked out again where what it depends on changes,
  raising the version, so a served copy always matches its version and a picture appearing is a `thread.changed` with
  a higher version, as the Mac app needs. A message's picture is worked out when served; when a domain's picture
  changes, every thread with a proved message from that domain gets a higher version too, so the mail page is read
  again.
- **Wanting a domain** happens only where new mail arrives (`fresh`: also looks again after 30 days), where a sender is
  let in, and where the backfill proves a message (`new`: only a domain never wanted). A thread merely changed (marked
  done, say) never wants one, so a forgotten domain isn't fetched again for an old thread.
- **Pictures are kept in the store**, base64 in `avatar_sites.data` (a Worker has no disk; at most 1 MB a picture and
  one row a domain), not in the pictures' disk cache.
- **The organisational-domain rule reaches `mail`** through `ProviderOptions.authentication`, so `mail` doesn't carry
  the list; the DKIM fallback uses it. Gmail's checker name is `GMAIL_CHECKER`; IMAP gets none.
- **The day's cap and the gap are kept in memory** (a restart forgets them): the random delay already spreads a first
  sync's domains over six hours.
- **No re-encoding**: the original bytes are served, with `size` and `fit` (the coordinator's decision). Only a BMP
  inside an ICO is turned into a PNG, by the server's own writer.

## Tests and checks

New tests (2026-11-19): in `mail/test/`, `unit/auth-results` (38 after the review: the grammar, the topmost header only, a forged pass
lower down, another checker on top, an attached message's header, folded headers, the DKIM fallback, several From
addresses, hostile input, the parser's own address) and `gmail/from-checks` (4). In `server/test/`: `avatars-suffixes`
(10), `avatars-freemail` (3), `avatars-discover` (19), `avatars-ico` (17), `avatars-picture` (12),
`pictures-fetch-pages` (7), `avatars-site` (12, fake sites: best icon, manifest, ICO, inline, www, SVG and moving ones
skipped, a private address never asked, 6 requests, time, cut page), `avatars-queue` (5: one at a time however often
woken, gap, day's cap, a throwing source, no source), `avatars-service` (15: shown within six hours with a higher
version, one fetch for every inbox, screened, blocked, forged From, person, freemail, the inbox's own mail, a
rule-sorted stranger, a let-in sender's thread filed under Screening, no list, looking again, a failed look again,
failures, none, forgetting), `avatars-backfill` (2: the restart that asks Gmail again and its counts; the route's
headers and refusals), `avatars-shipped` (skipped until the list is added), `thread-rows` (2), `migration-0013` (1), and
one in the demo test. Shared helpers: `avatar-hosts.ts`, `avatar-pictures.ts`.

Run on 2026-11-19 with migration 0013 in a scratch copy of `server/` (the project's `migrations/` untouched until the
last step): server 731 tests, 730 passed, 1 skipped (the shipped list), both type checks clean; mail 473 (467 passed,
6 skipped as before); core's check; cli, dashboard and connector type checks; a scratch bundle (7.2 MB) built and
smoke-tested in the copy (the project's `dist/` not rebuilt).

After the review (below): server 737 tests, 735 passed, 2 skipped (both wait for the shipped list); mail 482 (476
passed, 6 skipped as before); core's check; cli, dashboard and connector type checks; a scratch bundle smoke-tested.
A mutation run (scratch `mutate.mjs`) weakened 94 defences one at a time, the review's fixes included: 90 were caught by
a test. The other four are guarded twice: an inline picture's length cap (also capped as an attribute's length and by the manifest's size), each
of the site source's two request caps (each holds the other's line), and the site's own deadline (each request's time
limit is what is left of it).

## The security review of 2026-11-19, and what changed

The independent review found one thing to fix and four smaller ones; each was done test-first:

1. **Injection into Gmail's own header through the envelope sender.** A quote inside a comment delimits nothing, so a
   quoted local part with `)` that Gmail echoes in its SPF comment could end the comment and add `dkim=pass` or
   `dmarc=pass` for a brand. Now any `"` in a comment (escaped or not), a quoted value with `;`, `(` or `)`, or an
   `smtp.*` property on a DKIM or DMARC result makes the header unreadable (`mail/src/message/auth-results.ts`; tests
   with the reviewer's strings, nested and escaped variants, other comment positions, a HELO-shaped injection).
2. **Freemail gaps:** `live.*`, `zoho.*` and `zohomail.*` by label; mail.com's 143 domains from its own "Domains" page
   (https://www.mail.com/mail/domains/, read 2026-11-19, `MAIL_COM_DOMAINS`); platforms whose customers share their
   domain (`isSharedPlatform`: onmicrosoft.com, googlegroups.com, groups.io, freelists.org, substack.com, beehiiv.com,
   ghost.io, buttondown.email, convertkit-mail.com and -mail2.com, mailchimpapp.com, mcsv.net, sendgrid.net,
   amazonses.com, mailgun.org, sparkpostmail.com, by suffix, whatever the list says). A test checks these against the
   real list once it ships (skipped until then).
3. **Two or more results from the trusted checker prove nothing** (`fromCheck` `repeated`, core's `FromCheck`); a
   header that can't be read counts by the name it starts with. The backfill's log line counts them apart.
4. **The route for a caller limited to some inboxes** answers only when proved mail from the picture's domain is in one
   of them (`pictureShownIn`); not one indexed lookup, and never needed today (known-issues.md).
5. **Tests for the reviewer's gaps:** the checker's name compared whole (prefixes and suffixes), and no message
   pictures in a thread the mailbox filed under Screening for a let-in sender.

The reviewer's probes, run from copies in the scratch folder after the fix: the header probe proves only the honest
cases (the two injections and the HELO case are unreadable; a forged header below Gmail's is `repeated`); the imported
case with a single forged header on top is still proved, as documented; 4,000 hostile icon files gave only valid PNGs.

## Not done

- A trusted checker for IMAP providers (each provider's own authserv-id would have to be known and trusted).
- People's pictures (initials; ideas in [improvement-ideas.md](improvement-ideas.md)).
