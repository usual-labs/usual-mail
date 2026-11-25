# Mail providers (`mail/`)

`mail/` is the package `@usualmail/mail`. It implements core's `MailProvider` for IMAP with SMTP and for
Gmail's REST API. A provider is a plain adapter: it holds a connection and nothing else. The server owns the
store, the cursor and every decision. Read [the contract](../contract.md) first, especially its page on
[sync and providers](../contract-sync.md).

State on 2026-11-17: both providers match the contract's fifth revision as amended the same day (categories and the
Screening gate in place of piles): everything below is built and covered by tests that pass, except where a section
says otherwise, and both are joined into the server (`server/src/node/parts.ts`). Nothing has touched a real
mailbox. The Docker-backed tests first ran on 2026-11-25 (Docker answered): GreenMail's pass; Dovecot's fail, its
logins refused ([mail-checks.md](mail-checks.md), [known-issues.md](known-issues.md)). Before, Docker on the build
machine didn't answer, and for the fifth revision it wasn't tried (`USUAL_MAIL_SKIP_DOCKER=1`). Gmail push notifications are not
built. Since 2026-11-21 the Gmail provider has its own entry (`@usualmail/mail/gmail`, no IMAP code), converts
messages a few at a time, and, with a size limit set, reads messages over it without their attachments' bytes and
serves their attachments through `messages.attachments.get`: [mail-gmail-large.md](mail-gmail-large.md), tested
against `FakeGmail` only.

## What is implemented

| Path | What it holds |
|---|---|
| `src/index.ts` | `createImapProvider`, `createGmailProvider`, `GMAIL_SMALL_MEMORY`, `providers` (both, checked against `ProviderFactory`), `sanitizeHtml`, `htmlToText`, `parseMessage`, `attachmentContent`, and the picture pass (`remotePictures`, `rewritePictures`, `canonicalPictureUrl` and their types) |
| `src/gmail/index.ts` | `@usualmail/mail/gmail`: `createGmailProvider`, `GmailProviderOptions`, `GMAIL_SMALL_MEMORY`, `createGate`, `MessageGate`, `GmailApiError`, `GoogleTokenError`, `FetchLike`, and nothing that reaches ImapFlow, an SMTP client or `src/imap/` (for the Cloudflare host; `test/unit/gmail-entry.test.ts` walks the import graph) |
| `src/message/pictures.ts` | `@usualmail/mail/pictures`: the picture pass alone, without the providers, for host-neutral code (the server imports it from there) |
| `src/message/` | MIME parsing, `automated`, thread keys, HTML sanitizer, CSS filter and the CSS reader it uses (`css-tokens.ts`), the picture pass (`pictures.ts`, `picture-refs.ts`), HTML to text, composing outgoing mail |
| `src/imap/` | Folder discovery, cursor and refs, scanning, sync, write-back, the moves it made itself (`own-moves.ts`), SMTP sending, IDLE watching, the connection |
| `src/gmail/` | REST client with token refresh, quota and backoff, labels, cursor, sync, write-back and sending; reading messages (`messages.ts`), the full form for large messages (`full.ts`, rebuilt as MIME in `payload.ts`), attachments (`attachments.ts`, streamed by `download.ts`) |
| `src/testing/` | `@usualmail/mail/testing`: the contract suite, `syncAll` and `applyTracked`, a fake of Gmail's API (its full form in `fake-gmail/payload.ts`), a fake of Google's sign-in (`FakeGoogle`), test message builders |
| `test/unit/` | MIME fixtures, sanitizer against hostile HTML (the inputs and the check shared in `hostile-html.ts`), the picture pass, headers and thread keys, cursors, label state, limits, composer; the HTML's bound (`html-depth.test.ts`) and speed tests that run each reader in a worker stopped at its limit (`linear.ts`, `linear.test.ts`) |
| `test/imap/` | Contract, IMAP cases, sync order and connection tests against hoodiecrow in process; contract and scenarios against GreenMail and Dovecot in Docker |
| `test/gmail/` | Contract and Gmail cases against the fake API; `fake-google.test.ts` holds the sign-in fake to Google's documentation; `large.test.ts` and `large-faults.test.ts` (helpers and the 30 MB message in `large-message.ts`) the large-message path ([mail-gmail-large.md](mail-gmail-large.md)) |

## Run and check

```
cd mail
npm install
npm run check          # tsc, then every test (node --test)
npm run test:unit      # no servers
npm run test:imap      # hoodiecrow in process, plus Docker when it answers
npm run test:gmail     # fake Gmail API
```

- What each pass ran and saw, newest first: [mail-checks.md](mail-checks.md).
- **Docker tests** (`test/imap/docker.test.ts`) start `greenmail/standalone:2.1.15` (IMAP 3143, SMTP 3025) and
  `dovecot/dovecot:2.4.5` (IMAP 31143, `USER_PASSWORD` set; sending goes to an in-process SMTP sink), bound to
  127.0.0.1 on random ports. They pull an image only when it is missing, run the contract suite and the IMAP
  scenarios, and remove the containers afterwards. Each test gets a fresh user, so a fresh mailbox.
- On 2026-11-16 and 2026-11-17, `docker version` didn't answer within 10, 20, 30 or 60 seconds, although Docker
  Desktop's processes were running; checked once more on 2026-11-17 for each of the third and fourth revisions, it
  hung again (no output within 60 seconds). In the final review that day it printed nothing for over 18 minutes (a
  60-second alarm signal didn't stop it); stopped by hand, it printed only its client section (27.3.1), never the
  daemon's. The file reports one skipped test with the reason. `docker version` gets 10 seconds
  (`USUAL_MAIL_DOCKER_TIMEOUT_MS`); `USUAL_MAIL_SKIP_DOCKER=1` skips on purpose.
- Unverified about Docker: how GreenMail reports keywords and special-use folders (the harness probes keywords).
  Dovecot's default image let the harness's probe log in on 31143 on 2026-11-25, but refused most per-test users
  after it, so its suite fails (open, [known-issues.md](known-issues.md)).

## The first sync's window

The server opens a provider with the inbox's window as it is set then (`ProviderOptions.since`, counted back from
when the inbox was connected), and the window can be changed between starts. Since 2026-11-17 (contract, "Sync"):

- **A later `since` narrows a first sync still being sent:** nothing older is sent from then on; what was sent stays,
  and nothing is reported removed. **An earlier `since` never widens it.** Mail that arrives later is taken whatever
  its date, as before.
- **Gmail:** the first sync's listing is marked in the cursor (`f`). Opened with a later `since` than the window so
  far (`w`, else `s`), the provider lists the new window once (`after:`, 5 quota units a page of 500) and keeps only
  the ids still to send that are in it (`narrowFirstSync`), then records `w`. `s` stays the window the first sync began
  with, so a listing after history expired still covers what was fetched and the server drops nothing of it. Ids
  carried from a history batch are new mail and never narrowed. A cursor written before the mark isn't narrowed (it
  can't be told from a carried batch): such a first sync finishes with its old window (a known issue).
- **IMAP:** a "first" backlog is searched with the narrower window (`narrowedWindow`, cursor field `w`, kept while a
  "first" backlog remains); a "reset" backlog keeps the cursor's `since`, the window the first sync began with, so a
  UIDVALIDITY change reports nothing fetched as gone. IMAP's backlogs always said which is the first sync's, so a first
  sync from before the change is narrowed too. SEARCH SINCE counts whole days, as for the first window.

## How far a first sync has got

Since 2026-11-23 (the owner's decision; contract, "Sync", "How far a first sync has got"), every batch of a first sync
carries `progress` (`sent`, `total`), counted from the cursor so it carries on in a new provider, and a smaller window
lowers `total` (what was sent stays counted); later batches carry none. `test/gmail/progress.test.ts` (7) and the IMAP
scenarios ("counts the first sync's window …", and the window test's counts) show it; `syncAll`'s log keeps each
batch's `progress`.

- **Gmail:** `n` in the cursor, kept with `f`, counts the listing's ids sent (a message gone before it was fetched
  counts as sent: the count is of the listing). `total` is `n` plus the ids still in `p`. `onProgress` is called once
  the window is listed (0 of the total) and after each message is fetched (`fetchMessages`' `onFetched`), this batch's
  included. An empty window is one batch, 0 of 0. A smaller window that leaves nothing of the listing ends the count at
  `n` of `n` and drops `f`, `w` and `n`, so ids history carries later are never narrowed as the listing (before, `f`
  and `w` stayed in such a cursor). A cursor from before the count has no `n`: it counts from 0 of what was left.
- **IMAP:** `fs` in the cursor, kept while a "first" backlog remains, counts the messages its "first" backlogs sent;
  `total` is that plus what each scan still finds in them, searched again at every call, so removals meanwhile lower
  it too. No `onProgress`: a batch is quick. A folder whose UIDVALIDITY changes during the first sync becomes a "reset"
  backlog, which isn't counted.

## Using it

- `createImapProvider(credentials, options)`: `ImapCredentials`, including `saveSent` (default true; false for
  servers that file sent mail themselves). Options are core's `since` and `names`, plus `timeouts`.
- `createGmailProvider(credentials, options)`: `GmailCredentials`. The refresh token needs the scope
  `https://www.googleapis.com/auth/gmail.modify`. Options: `since`, `names`, and `fetch` (tests pass the fake),
  `clock`, `quotaPerSecond` (80), `concurrency` (4 requests in flight), `maxRetries` (6), `timeoutMs` (60 s),
  `resyncWindowMs` (2 days), `largeMessageBytes` (`Infinity`: no size check), `messageConcurrency` (4) and `gate` (one
  `createGate` gate shared by several providers). What the Cloudflare host passes, and why:
  [mail-gmail-large.md](mail-gmail-large.md).
- Credentials are checked when the provider is made; a bad shape throws a readable error.
- A refused refresh token or client throws `GoogleTokenError` with `kind` (`token_refused`, `client_refused`); the
  server words it for an inbox connected by signing in with Google ("Sign in with Google again"). Google's sign-in
  itself (the code exchange, revocation) is the server's (`server/src/google/`); the provider only refreshes and calls
  Gmail.
- `connection()` answers at once, without the network, with what of the credentials isn't secret, as core's
  `InboxConnection`: IMAP's and SMTP's host, port, `secure` and user, and `saveSent` (true unless the credentials
  say false); Gmail's client id. Never a password, client secret or refresh token. The server stores it as
  `Inbox.connection`.
- `limit` in `sync` bounds `upserted` and `changed` together, in every batch. Removals don't count. IMAP's
  default is 100, Gmail's 50.
- `place` and `untrash` with `inInbox: true` together with a `category` or `screened` answer `ok: false` ("A message
  can be in the inbox only without a category's label or folder and without Screening.", `IN_INBOX_ONLY_UNFILED`),
  and the other ops go on. The server never sends that; IMAP can't express it, so Gmail refuses it too rather than
  reporting a placement IMAP never could.
- `names` in the options (core's `ProviderOptions.names`) renames the folders and labels: `newsletter`, `invoice`,
  `receipt`, `notification`, `otp`, `screening`, `reply_later`, `set_aside`.

## Libraries

- **ImapFlow 2.12.1** for IMAP: maintained, typed, handles CONDSTORE, MOVE with fallback, UIDPLUS, IDLE with a
  polling fallback, special-use folders with a name fallback, namespaces.
- **Nodemailer 10.6.0** for SMTP and for composing outgoing mail (`MailComposer`), so SMTP, the Sent folder and
  Gmail get the same bytes. The `./gmail` entry reaches `MailComposer` and its helpers only, no transport.
- **postal-mime 4.2.1** for MIME, for both providers. No dependencies, decodes charsets with `TextDecoder`, and
  has limits against hostile messages.
- **sanitize-html 2.18.2** (htmlparser2 and postcss underneath) for HTML: an allow-list, no DOM needed.
  DOMPurify was not chosen: in Node it needs jsdom.
- **postcss 8.5.33** for the CSS filter; **htmlparser2 12.0.0** for HTML to text.
- Dev only: **hoodiecrow-imap 3.3.1** (a strict, scriptable IMAP server for testing clients),
  **smtp-server 3.21.6** for the SMTP sink. Dependencies didn't change for the third revision.
- ImapFlow, Nodemailer and sanitize-html (through postcss) are CommonJS and require Node's own modules. Bundled
  into an ES module they need a `require`; the server's build script gives the bundle one.

## Reading messages

`parseMessage(raw, { ownAddresses, receivedAt })` in `src/message/parse.ts`:

- Addresses: groups flattened, emails lower case, names unfolded. No From at all gives `{ email: "" }`.
- `date`: the Date header in UTC. Missing, unreadable, or more than a day after the time of receipt: the time of
  receipt (IMAP INTERNALDATE, Gmail internalDate).
- `text`: the text part; with only HTML, text made from the HTML. `html`: sanitized, absent for plain-text mail.
  U+0000 is taken out of both and of the subject (2026-11-22): SQLite takes it for a text's end, and libSQL reads a
  stored text back only up to it, so what followed was lost on Node.
- Attachments: `id` is the attachment's position in the parsed message. IMAP's `fetchAttachment` fetches the message
  again and returns those bytes; so does Gmail's, unless the message was stored from the full form (over a size
  limit), when it reads the position from the same rebuild ([mail-gmail-large.md](mail-gmail-large.md)). `inline` is
  true for a picture with a Content-ID inside the message.
  File names lose path parts and direction-override characters.
- `messageId`, `inReplyTo` (first id), `references`: without angle brackets (`stripBrackets` reads the closing run
  from its start: from every ">" of a long run, `>+$` read to its end, 25.6 s for 256 KB; 0.1.3). `listId`: lower case.
- `automated`: Auto-Submitted other than "no"; Precedence bulk, list, junk or auto_reply; any List-* header;
  X-Autoreply, X-Autorespond or Feedback-ID; a multipart/report; an empty Return-Path; or a no-reply sender.
- `outgoing`: the message is in Sent (the IMAP folder, Gmail's `SENT` label), nothing else. A From naming the
  mailbox counts for nothing: `parseMessage` reports `fromSelf`, which nothing trusts.
- `fromCheck` (2026-11-19, sender pictures; [contract](../contract-avatars.md)): only with `authentication` in the parse
  context, which only the Gmail provider gives, and only when the server asked (`ProviderOptions.authentication`):
  what the topmost `Authentication-Results` header, written by Gmail's own checker (`mx.google.com`), proved about the
  From domain (`message/auth-results.ts`: RFC 8601's grammar, comments and quoting, bounded; `dmarc=pass` for exactly
  the From address's domain, else, with no DMARC result at all, an aligned `dkim=pass` by the organisational-domain
  rule the server passes; any `dmarc=fail` loses; one From mailbox only; two or more headers from Gmail's checker are
  `repeated` and prove nothing; read strictly since the review of 2026-11-19: a quote in a comment, a quoted value with
  `;`, `(` or `)`, or an `smtp.*` property on a DKIM or DMARC result makes the header unreadable). The message's own
  headers only, never an attached message's. The Gmail provider then also has `fromChecks(refs)`: the same read again from the metadata form
  (`Authentication-Results` and `From` only, 20 quota units a message) for mail stored before.
- `signedRecipients` (2026-11-25, the screening gate's second security review; [contract](../contract-ai.md#mail-is-untrusted-input-to-a-model)):
  only when `fromCheck` is verified. Which of To and Cc the sender's own DKIM signature vouches for
  (`message/signed-recipients.ts`): none when the message gives To or Cc twice (postal-mime merges a second field
  into the first, so an added one would otherwise read as the sender's); else each field given once that every
  aligned DKIM signature matching a pass in Gmail's trusted result names in its `h=` (a signature fits a pass only
  when the result names exactly its domain, `header.d` or else `header.i`'s, and, when Gmail prints `header.b`, it
  starts with it; the intersection, so a signature added later only takes a field away). None is ever skipped: any
  signature that can't be read (a tag twice, over 16 KB) or lacks `d=`, `h=` or `b=` leaves no field (the final
  security review: a real signature padded past the limit was skipped and a forged one decided). Tag names are kept
  case-sensitive (RFC 6376), header names are counted trimmed (`To :` is a To). At most 16 signatures. Gmail's large
  messages keep every header when rebuilt (`gmail/payload.ts`), so the same holds there. Tests:
  `test/unit/signed-recipients.test.ts` (14: each attack the reviews ran, through the parser too).
- A message the parser refuses becomes a short note instead of failing the sync.
- **Thread keys (IMAP):** the first id in References, else In-Reply-To, else the own Message-ID (`mid:<id>`);
  with no ids, a hash of From, To, Date and Subject. A client that keeps only In-Reply-To deep in a
  conversation splits it; subjects are never compared. Gmail's key is its thread id.

## Safe HTML

`sanitizeHtml` in `src/message/sanitize.ts`, with the CSS filter in `src/message/css.ts`:

- Kept: text formatting, headings, lists, tables, `font`, images, links, `style` blocks and attributes after
  the CSS filter, `class`, `id`, `aria-*`.
- Links: http, https, mailto, tel, `#` anchors, protocol-relative. Images: http, https, protocol-relative,
  `cid:` and `data:image/`. Remote images stay.
- Dropped with their content: script, iframe, object, applet, svg, math, template, noscript, noembed,
  noframes, textarea, select, option, xmp, title. Every event handler and unlisted attribute goes.
- CSS: `@import` and most at-rules go; so do `expression()`, behaviors, bindings, `javascript:`, and other URL
  schemes. CSS is read as a browser reads it (`css-tokens.ts`, CSS Syntax Level 3's tokens): comments only outside
  strings, strings with their escapes, unquoted `url(` tokens, functions and their nesting, escaped names. Every
  address a value loads (`url()`, `src()` with one string, the strings of `image-set()`, `image()`, `cross-fade()` and
  their `-webkit-` forms) must be http(s), protocol-relative, `cid:` or a `data:` picture; a value broken in a way
  that could hide one goes. Script-like words are looked for in the text as a browser reads it. A kept value is
  written as it was checked, without its comments. Every `<` in a style block becomes `\3c `. (Until 2026-11-18
  regular expressions stopped at a function's first `)` and stripped comments inside strings.)
- Tests: 62 hostile inputs, each output parsed again and checked against the allow-list.
- **Bounded before any parser reads it** (`html-depth.ts`, 0.1.3; [known-issues.md](known-issues.md), "Reading a
  message could take minutes"). htmlparser2 12 puts each open element at the front of an array and searches it at
  every closing tag, so a tag costs as much as the elements open around it (1 MB of `<b>` took 42.6 s). `boundedHtml`,
  which `sanitizeHtml` (on the HTML as sanitize-html parses it, `<![CDATA[` written as `<!&#91;CDATA[` first) and
  `htmlToText` call, cuts the HTML to `MAX_PARSED_HTML` (2,000,000 characters, never inside a character written as
  two) and reads it once with htmlparser2's own parser, dropping each opening tag that would make more than
  `MAX_HTML_DEPTH` (256) elements open: its content and every closing tag stay, and `<!>` stands in for it so the text
  on either side can't join into a tag. Void elements are never dropped, nor, outside SVG and MathML (where these
  names aren't raw text), raw-text elements (script, style, title, textarea, xmp, iframe, noembed, noframes,
  plaintext). Ordinary mail comes back unchanged: 12,407 comparisons with 0.1.2's
  readers (the fixtures, the hostile inputs, crafted mail with 30 nested tables and 120 levels of quoted replies, and
  3,000 random tag soups, each through the sanitizer, the text, both picture passes and `parseMessage`) gave the same
  output. What follows the cut is read by no parser: neither the stored HTML nor text made from it has it.
- `position: fixed` and similar layout tricks stay. The apps should render mail with scripts off.

**The picture pass** (2026-11-18; the contract's [pictures from the web](../contract-pictures.md)). Reading a
message keeps remote pictures; the server decides them each time it serves the message, by running the stored HTML
through `sanitizeHtml(html, hook)` again (`rewritePictures`; `remotePictures` only lists them), so the output is held
to the same allow-list:

- The hook gets each picture from the web once per place, in the HTML's order and style blocks last: an `<img>`'s
  `src` (`site: "img"`, with `tiny`), a table part's `background` (`"background"`) and a `url()`, `src()`,
  `image()`, `image-set()`, `-webkit-image-set()` or `cross-fade()` in a style attribute or block (`"css"`). The
  address comes canonical (`canonicalPictureUrl`: http or https, protocol-relative taken as https, no fragment); one
  with a user name or that isn't an address is held without asking.
- `show` puts the hook's address in (refused, and held instead, if it is itself on the web); `hold` takes the
  address away (an `<img>` keeps its place and alt text, a `background` attribute goes, CSS becomes `none`);
  `remove` takes an `<img>` out whole, or acts as `hold` elsewhere: the `<img>` is written as nothing but a class new
  to each pass and taken out of what the sanitizer wrote (sanitize-html's `exclusiveFilter`, used before 0.1.3, copied
  everything written so far once per picture removed).
- Fonts from the web go: a declaration in `@font-face` that loads from the web is dropped without asking.
- A CSS value that hides an address on the web behind escapes is dropped, not rewritten. **The last check**
  (`servableCss`, token by token) runs on every served declaration and again on each whole attribute and block: it
  fails anything broken, more than 100 addresses in a value, an address other than the server's picture paths,
  `cid:` and non-SVG `data:` pictures, and any string naming the web ("http:", "https:", "//"). Escapes elsewhere
  stay. A held or removed string takes its whole `image-set()` with it (`none`). Rewriting is one pass.
- For stored and served HTML alike: a declaration's name must be a plain name (`^(--)?-?[A-Za-z_][\w-]*$`), a whole
  attribute or block is read again after its declarations, rules nested deeper than 16 drop their block, and a
  value is written as it was checked (postcss's raw text with comments isn't). sanitize-html doesn't write style
  attributes again (`parseStyleAttributes: false`); the CSS filter writes them as `name:value;…`.
- `tiny` (`isTinyOrHidden`): hidden by its own style (`display:none`, `visibility:hidden`, `opacity:0`, a zero
  maximum size), or declared at most 1×1 (one side at most 1 with the other not given, or a side of 0). Styles from
  a block or a class aren't seen. A length is trimmed before it's read (`pixels`): with three runs of spaces side by
  side, its pattern took time cubic in the spaces of a `width` (2,000 took 1.3 s; 0.1.3). `srcset`, `<picture>`'s sources and `poster` never reach the pass: the sanitizer
  drops them when the message is read.

## IMAP with SMTP

Folders, keywords and placement, the cursor, sync, sending, watching and connections:
[mail-imap.md](mail-imap.md).

## Gmail

### Labels and placement

| Usual Mail | Gmail |
|---|---|
| In the inbox | `INBOX` |
| A filed category | Labels `Usual Mail/Newsletters`, `/Invoices`, `/Receipts`, `/Notifications`, `/One-Time Codes`, created on demand |
| Screened | Label `Usual Mail/Screening`, together with the category's label when it has one (Gmail keeps both) |
| Stack | Labels `Usual Mail/Reply Later`, `/Set Aside` |
| Seen | No `UNREAD` |
| Trash | `messages.trash` and `messages.untrash` |
| Spam (read; `place` removes it) | `SPAM` |

- `place` adds or removes `INBOX` as asked, adds the category's label, the Screening label and the stack's as asked,
  removes the other Usual Mail labels and `SPAM`. It leaves `TRASH` alone. A stacked or waiting conversation comes
  without `INBOX`, a stacked one with its stack's label.
- A message's labels read as: `category` the filed category whose label it carries (the first in core's
  `FILED_CATEGORIES` order if someone added two) or `null`, also while screened; `screened` the Screening label;
  `stack` the stack or `null`. The reset's label bits now hold the five categories, Screening and both stacks (16 to
  2048); a reset cursor a fourth-revision build wrote would read its pile bits as categories (only mid-reset; no real
  mailbox was connected).
- Trashing keeps a message's other labels; while it carries `TRASH` only that counts (contract).
- `untrash` calls `messages.untrash`, then sets the labels as `place` would. Google's reference doesn't say
  which labels untrashing restores (checked 2026-11-16), so nothing relies on it.
- A label someone creates between listing and creating it (409) is listed again and used.
- Gmail always keeps stacks: `stack` is the stack or `null`. Refs are message ids and never change.
  `threadKey` is Gmail's thread id.
- Mail a Gmail filter files on arrival (skips the inbox, adds a Usual Mail label, or goes to `SPAM`) is reported
  with that placement; the server keeps the filing. A label created at Gmail after the provider listed labels is
  found (tested with a category's label the fake created after the inbox was connected).

### Cursor and sync

- `gmail1.` plus base64url JSON: `h` the history id to continue from, `s` the first window, `t` when history
  last answered, `p` ids still to send whole and `c` ids still to send as `changed` (each with its label state
  as bits), both newest first; `f` while `p` is the first sync's own listing, `n` how many of it were sent (a first
  sync's count) and `w` the window it was narrowed to.
- **First sync:** take the profile's history id, list the ids in the window (`after:<since>`, drafts and chats
  left out, spam and trash in), then send them newest first, `limit` at a time. History from the saved id
  then brings everything that changed meanwhile.
- **Later syncs** read history (`messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`) and stop between
  records once the batch is full. One record can name more messages than `limit` (a bulk change made in another
  app); what doesn't fit is carried in the cursor (`p` whole, `c` as changes with their label bits) and sent by
  the next calls before history goes on. A new message is fetched whole. A label change on any other message is sent
  as `changed`, from the labels the history record carries, with no request. When a record leaves the labels
  out, the message is fetched in the minimal form (20 units, not 60). Messages Gmail no longer has are
  reported removed. Drafts and chats are skipped. **A message that leaves spam** (a `labelsRemoved` entry whose
  removed labels include `SPAM`, from "Not spam" in Gmail or from `place`) is fetched whole and sent in `upserted`,
  never as `changed`: the server ignored it while it was in spam and doesn't hold it (since the final review's
  decisions, 2026-11-17).
- A label change on a message the server doesn't hold (older than the window) still comes as `changed`; the
  contract says the server ignores it. Leaving spam is the exception above.
- **Reset.** When history answers 404, the provider has lost its place. It takes a fresh history id and lists
  the whole window again; the first batch says `reset`. Messages that arrived from `resyncWindowMs` (2 days)
  before the last good sync on are fetched whole, newest first. Older ones are sent as `changed`, their labels
  read from one listing per label (INBOX, UNREAD, TRASH, SPAM and each Usual Mail label), so a 30-day window
  costs a few list calls instead of a download per message. When the listing ends, the server drops what it
  left out, such as mail deleted while history was gone.
- Without `since`, the window, and so a reset listing, is the whole mailbox.

### Sending

The raw message (with Bcc; Gmail removes it for recipients) goes to `messages.send`. A reply uses
`threadKey` as the thread id; without one, the thread is found by searching `rfc822msgid:` for the parent.
The Message-ID Gmail kept is read back (metadata form) and returned.

### Searching the mailbox (2026-11-20)

`search` and `fetchThread` (`src/gmail/search.ts`; [search](../contract-search.md#older-mail-in-the-mailbox)), read-only:
`gmailQuery` turns the server's `ProviderSearchQuery` into Gmail's operators (words bare or quoted, `"phrases"`,
`-words`, `from:`, `to:`, `subject:(…)`, `has:attachment` or `-has:attachment`, `after:`/`before:` as Unix seconds,
`is:unread`/`is:read`, the filed categories' labels as `label:usual-mail-receipts` (lower case, spaces and slashes as
hyphens, several in `{…}`), Screening's label, `-in:inbox` for archived, always `-in:drafts -in:chats`). A page is
`threads.list` with `q`, `maxResults` and `pageToken`, then `threads.get` in the metadata form (Subject, From, Date) per
conversation: subject from its first message, sender and time from its newest, Gmail's snippet, `hasAttachments` when a
message's top-level type is `multipart/mixed` (the metadata form carries no parts), spam, trash, drafts and chats left
out. `fetchThread` is `threads.get` in the minimal form, then each message whole through the sync's own conversion.
Never run against Gmail: the label form, Gmail reading `after:` as Unix seconds for search as it does for the first
sync, and `payload.mimeType` in the metadata form are from Google's documentation as known, not checked live.
`FakeGmail` answers `threads.list` and `threads.get` and reads the operators above in `testing/fake-gmail/search.ts`
(messages.list goes through the same reader now); its metadata form gives the message's own top-level type.
The contract suite's search part is `testing/contract-search.ts` (both or neither; words, phrases, exclusions, sender,
subject, newest first, spam left out, archived, attachments, paging, `fetchThread` as a sync sends it, read-only).
Tests: `test/gmail/search.test.ts` (3).

### Large messages and bounded memory (2026-11-21)

Turns for messages (a gate, shareable between providers), the size check, the full form rebuilt for the raw form's
parser, the per-message download budget, attachments through `messages.attachments.get`, failures that never stop an
inbox, and what the Cloudflare host passes: [mail-gmail-large.md](mail-gmail-large.md).

### Limits and backoff

- Quota, from Google's page (read again 2026-11-16 and 2026-11-21): 6,000 units a minute per user; `messages.get`
  costs 60 in the raw or full form and 20 in the minimal or metadata form; `messages.attachments.get` 20; list 5,
  modify 5, trash 20, untrash 5, send 100, history 2; `threads.list` 10, `threads.get` 40 (counted as 20 from 2026-11-20
  until the page was read on 2026-11-21). A token bucket spends 80 units a second with bursts of 600. Four requests at a
  time.
- Retries up to 6 times on 429, 500, 502, 503, 504 and 403 rate-limit reasons, from 1 s doubling to 32 s with up
  to 1 s of jitter, or Retry-After when longer (capped at 5 minutes). A 401 refreshes the token once.
  `dailyLimitExceeded` isn't retried.
- A `GmailApiError` carries a `kind` the server sorts by (0.1.2, `errorKind`, the same test as its words): `scope`
  for a 403 whose reason is `insufficientPermissions` or whose message names a scope ("The Gmail token lacks the needed
  scope …"; a new sign-in fixes it), `daily_quota` for `dailyLimitExceeded` ("… used up its daily Gmail quota. Gmail
  answers again once Google resets it, at midnight Pacific time."; it may pass).
- Gmail's HTTP batch endpoint isn't used: it saves no quota.
- No `watch`: Gmail push needs a Google Cloud Pub/Sub topic. The server polls.

## The contract suite and test servers

- `providerContract(name, makeHarness)` from `@usualmail/mail/testing`. A harness gives the provider, its
  address, `deliver(raw)`, `removeExternally(messageId)`, `close()`, optionally `loseSyncPlace()` (Gmail:
  history expires) and `supports.keywords: false` for an IMAP server without keywords.
- `syncAll(provider, from, limit)` plays the server: upserts, then `changed` for messages it holds, then
  removals; after a `reset` listing ends, it drops whatever the listing didn't include in `upserted` or
  `changed`. `from` is a cursor or an earlier result to continue from. It reports what came back, what is
  held, each batch, resets, drops, and `changed` refs it didn't hold.
- `applyTracked(provider, state, ops)` applies ops as the server does: a held message `apply` gave a new ref is
  held under the new ref from then on. Tests that move a message and sync again use it.
- Optional harness parts: `deliverFiled(raw, to)` puts a message straight into the archive, a category's folder or
  label, Screening, or spam, as a filter or server-side rule would on arrival (answers false when the mailbox has no
  such place), `supports.categoryWhileScreened` (default false for IMAP, true otherwise) says whether a screened
  message still reports its category,
  `takeOutOfSpam(messageId)` takes it out of spam into the inbox as another mail app would, and `secrets` lists the
  credentials' secrets. The IMAP harness files into Archive, category folders and Screening through a second
  provider's `place` (so the folder is made as the provider makes it) and into the junk folder by APPEND; the Gmail
  harness delivers with labels; the server's `MemoryMailbox` harness with a placement.
- It checks: verify; `connection()` of the provider's own kind, exactly the contract's fields, with none of the
  harness's secrets in it; mail filed on arrival into the archive, each category's place and Screening, in a first sync and later, reported out
  of the inbox with that category (none for the archive; for Screening, screened and, where the mailbox keeps one
  folder, no category), unread, on no stack; mail delivered to spam
  reported with `spam: true`, in a first sync and later; a message taken out of spam elsewhere (`takeOutOfSpam`:
  Gmail's "Not spam", a move from the junk folder to INBOX, the server's `MemoryMailbox.update`) coming back whole in
  `upserted`, never in `changed`, in the inbox; the first sync and its parsed fields; `sync` repeated with the same cursor; incremental
  sync; small limits, every batch within the limit; **every category (none and the five filed), screened or not, with every stack and done state** placed and read back
  exactly (`category` as written, or left out while screened where the mailbox keeps one folder; `stack` or `null`,
  or left out with a `note` where it can't be kept); a message the
  provider placed, trashed or flagged itself comes back in `changed`, never fetched whole, whether its ref stayed or
  changed; a new ref arrives before or with the old one's removal; `untrash` into every category, gate, stack and done state;
  trash; seen as a change; `limit` counting three flag changes and two new messages together; `inInbox: true` with a category or Screening refused (for `place` and `untrash`) while the next op goes on, the
  message left where it was; one failing op among others, and no `error` on
  success; a reply sent with `threadKey` comes back as outgoing in its thread with no `note`; removals; the reset
  (where the harness can cause one); attachments byte for byte, with inline pictures' Content-IDs.
- `FakeGmail` answers the routes the provider uses with Google's documented shapes and errors. What Google
  doesn't document, it takes the harder way: untrashing restores no label (trashing removes INBOX unless
  `mailbox.trashRemovesInbox` is false), and sending replaces the Message-ID (developers report Gmail
  sometimes does). Its full form and `messages.attachments.get` are described in
  [mail-gmail-large.md](mail-gmail-large.md). Test controls: `deliver`, `expireAccessTokens`, `expireHistory`,
  `failNext`, `historyLabelIds`, and for large messages `bodyDataLimit`, `sizeEstimateOf`, `latencyMs` and
  `peakInFlight`. It writes one history record per message; a Gmail test merges each history page into one record to
  stand for a bulk change made in another app.
- hoodiecrow runs in three shapes: a current server (CONDSTORE, MOVE, UIDPLUS, SPECIAL-USE, IDLE), a bare
  IMAP4rev1 server with an `INBOX.` namespace, Outlook folder names and no archive, and one whose INBOX, Sent
  and Trash refuse custom keywords.
- node:test runs no `afterEach` for a test skipped while it runs, so such tests close their harness first.

## Known limits

- IMAP downloads whole messages to sync them, attachments included; `fetchAttachment` downloads the message
  again. Gmail does the same in the raw form unless `largeMessageBytes` is set, and then only for messages at or
  under it; the limits of the full form's way are in [mail-gmail-large.md](mail-gmail-large.md).
- IMAP: a move made in another app is downloaded again under its new ref; so is one Usual Mail made before the
  provider was made again (a restart, a pause, new credentials).
- IMAP: after a UIDVALIDITY change, a folder's messages are sent again only inside the `since` window. Messages
  with an older internal date that the server held are reported removed.
- IMAP: a removal waits behind new mail found with it. If more than `limit` new messages kept arriving between
  every two calls, it would keep waiting.
- IMAP: QRESYNC isn't used. A server that turns CONDSTORE on or off between syncs loses that gap's flag changes.
  Messages flagged `\Deleted` but not expunged count as present. Mail in other folders is invisible.
- Gmail: during a first sync or a reset, the cursor holds the ids still to send (about 20 characters each), so
  a large window makes a large cursor until it drains.
- Gmail: a message imported during a history gap with an internal date older than the reset's two days is sent
  as `changed` and the server, not holding it, ignores it.
- Calendar parts come back as UTF-8 with LF line ends (postal-mime normalises them), not byte for byte.
- Gmail over IMAP would show duplicates (labels as folders); use the Gmail provider.
- IMAP: when the server answers NO to a move, the op's `error` is this provider's sentence ("The server refused to
  move the message to …"), not the server's own reason (seen in the review of 2026-11-17 with a refusal reading
  "Mailbox is locked by policy"). **Left as it is, on purpose** (checked 2026-11-17 in ImapFlow 2.12.1's
  `dist/esm/commands/move.js` and `tools.js`): `messageMove` catches the NO, hands the error (with `responseText`)
  only to the connection's logger (`log.warn({ err, cid })`) and returns `false`; the COPY fallback does the same.
  The documented API gives no reason, and reading it from a logger that remembers the last warning would rely on the
  undocumented shape and timing of that log call, which is guesswork.
- Gmail: a first sync begun by a build from before 2026-11-17 isn't narrowed when the window is made smaller (its
  cursor has no `f`); it finishes with the window it began with. Removing the inbox and connecting it again starts a
  new first sync with the new window.
- Gmail: a message that left spam during a history gap (history expired) and is older than the reset's two days is
  listed as `changed`, like any old message in a reset, so the server, which never held it, ignores it. Only
  history's `labelsRemoved` tells that a message left spam.

## Not done

- QRESYNC, OBJECTID (stable ids across moves), NOTIFY (watching several folders), Gmail push.
- Fetching only text parts during sync for IMAP. Streaming an attachment through to the caller: Gmail's is decoded as
  it arrives, but `fetchAttachment` still returns the whole attachment as one `Uint8Array` (core's interface).
- TLS options in credentials (client certificates, self-signed certificates on other machines).
- Running on Cloudflare: the `./gmail` entry bundles without ImapFlow or a Nodemailer transport (esbuild, 2026-11-21:
  149 inputs, 906 KiB, against 343 and 2,901 KiB for the main entry). It runs in local workerd in the server's
  Cloudflare tests (`server/test/cloudflare/`, 2026-11-21: a 30 MB message within `GMAIL_SMALL_MEMORY`, two inboxes on
  one shared gate); never on Cloudflare itself.
- Not run against GreenMail or Dovecot (Docker didn't answer), nor against any real account. Real Gmail's
  history records are assumed to carry `labelIds`, as the existing code already assumed for `messageAdded`;
  without them the provider asks for the labels.

## Contract points this part relies on

- Avoiding a download after its own move relies on the server storing the ref `apply` returns before its next
  `sync` call. The contract's fourth revision says so ("The server stores that ref before its next `sync`, so the
  provider may then report the message under it in `changed`"), and the server does.
- The server keeps the filing of mail reported outside the inbox on arrival, treats spam as trashed and ignores new
  mail in spam (fourth revision). The providers needed no change for that beyond reporting placements exactly, which
  the new contract tests now check.
- Fifth revision: the server compares a placement's `category` only where the provider reports one, so IMAP leaving
  it out in the Screening folder means "the server keeps it". Nothing of the server's AI touches the providers.
- A message that leaves spam is sent whole, never as `changed` (the contract's provider section, since the final
  review's decisions of 2026-11-17): Gmail turns a `SPAM` removal into a whole message; IMAP never remembers a move
  out of the junk folder as its own, and another app's move out of it was already new mail under a new UID. Tests
  that failed first: the contract suite's new case on Gmail, `takes a placed message out of spam` (Gmail) and `reads
  Junk and Trash as spam and trashed, and placing takes a message out of Junk` (IMAP, which used to expect `changed`).
