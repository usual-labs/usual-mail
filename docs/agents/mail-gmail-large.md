# Mail: Gmail's large messages and bounded memory

Part of [mail.md](mail.md). Built 2026-11-21 for the Cloudflare host ([server-cloudflare.md](server-cloudflare.md),
build plan step 3), whose isolate has 128 MB, and revised the same day after an independent review. Built and tested on
Node against `FakeGmail` only, never against Gmail. In local workerd since 2026-11-21 (the server's
`test/cloudflare/gmail.test.ts`): a 30 MB message from a fake outside the isolate synced through the minimal and full
forms only, workerd growing 4 MB, and two inboxes sharing one gate of two.

## What a host passes

| Option of `createGmailProvider` | Default (Node) | Meaning |
|---|---|---|
| `largeMessageBytes` | `Infinity` | Over this `sizeEstimate`, a message is read in the full form without its attachments' bytes; also each such message's download budget. `Infinity`: every message raw, no size check, exactly as before |
| `messageConcurrency` | 4 | Messages (and attachments) fetched and converted at once by this provider; ignored when `gate` is given |
| `gate` | none | A `MessageGate` from `createGate(slots)`, shared by every provider given it |

`GMAIL_SMALL_MEMORY` is `{ largeMessageBytes: 2 MiB, messageConcurrency: 2 }`. **The Cloudflare host** makes one gate
for the whole isolate (module scope or the Durable Object's constructor; a gate is plain JavaScript, no timers or
random values) and passes it with the limit to every Gmail provider it creates:

```ts
import { createGate, createGmailProvider, GMAIL_SMALL_MEMORY } from "@usualmail/mail/gmail";
const gate = createGate(GMAIL_SMALL_MEMORY.messageConcurrency); // once per isolate
createGmailProvider(credentials, { ...options, largeMessageBytes: GMAIL_SMALL_MEMORY.largeMessageBytes, gate });
```

Why these numbers: the raw form peaks at about eight times a message's size while it is parsed (the spike: a 30 MB
message took local workerd from 101 to 350 MB), so two raw messages of at most 2 MiB stay near 32 MB, for all inboxes
together with the shared gate (one Durable Object syncs every inbox, concurrently). Mail over 2 MiB is nearly always
mail with attachments, which the server never stores. What the gate doesn't bound: each sync batch's converted
messages (their text and HTML) until the server takes them (`limit`, the server's batch size, step 4).

## How it works

- **Turns.** `fetchMessages` (sync, `fetchThread`) and `fetchAttachment` run each message in a slot of the gate:
  fetch, convert, drop the raw text, next. Until 2026-11-21 a whole batch (up to 50) was fetched under one
  `Promise.all` and held before any was converted.
- **The size check.** With a finite limit, each message is first read in the minimal form (20 quota units) for its
  `sizeEstimate`; list and history answers don't carry one. At or under the limit: the raw form (60), as always. Over
  it, **or without a `sizeEstimate`** (Google documents the minimal form as "only email message ID and labels"): the
  full form (60), which is memory-safe whatever the size. `fetchThread` takes sizes from the conversation's own minimal
  form. Node's default skips the check: it would add a third to every message's quota (a first sync takes that much
  longer at 80 units a second) for memory Node has.
- **The full form, rebuilt** (`gmail/full.ts`, `gmail/payload.ts`). Gmail gives each part's headers and either its
  bytes (`data`) or an `attachmentId`. The provider writes the tree back as MIME, every part with its own headers and
  its bytes as base64, every multipart with a boundary of its own (never the header's: a boundary such as
  `"in\"ner"` the parser reads differently from Gmail would lose parts), and a short marker with a random nonce as the
  body of each part left out, then runs `parseMessage`, the raw form's parser. So text, HTML, headers, threading
  fields, `fromCheck` and the attachments' numbering, names, types, `inline` and Content-IDs come out as for the raw
  form; a marked attachment's `size` is Gmail's `body.size`. A marked calendar invite is declared UTF-8 (its other
  parameters kept as written), since the parser decodes a calendar's content by its charset and a UTF-16 invite would
  garble the marker.
- **Rounds and the budget.** Which parts the parser reads into the text isn't guessed: a rebuild shows which markers
  come back as attachments. The others, in the order they come, are written out from Gmail's expanded children (a
  forwarded message read inline, whose own attachments are numbered with the rest), or downloaded while they fit the
  message's **budget of `largeMessageBytes` bytes in all** (a text body, a forwarded message Gmail left out), or
  written empty; then the message is rebuilt (rounds bounded at 12; no further look after a round without an
  expansion). Calendar invites taken as attachments are downloaded within the same budget, because the parser
  rewrites them as UTF-8 with LF line ends and their size depends on that. Until the review each part was checked
  against the limit alone, so eight text logs of 1.6 MiB in one 17 MiB mail were all downloaded (12.6 MiB of text).
  A message left with no text at all says so: `TEXT_LEFT_OUT` ("too large to keep here") when a part didn't fit the
  budget, `TEXT_NOT_GIVEN` ("Gmail didn't give this message's text") when Gmail refused it, its answer couldn't be
  read, or it was nested too deep.
- **Failures never stop an inbox.** The server retries a failed batch from the same cursor, forever, so only a failure
  that may pass, or one the person must see, fails it (`failsTheBatch` in `gmail/client.ts`: no connection after the
  retries or an answer that broke off (`GmailUnreachable`), a timeout, Gmail's 401, 403, 408, 429 and 5xx,
  `GoogleTokenError`, and `GoogleRefreshError`, any other refusal of the token refresh, which isn't known to last and
  isn't worded "sign in again").
  Anything else on the full form's way is deterministic and handled where it happens: a part Gmail won't give (400,
  404) or whose answer can't be read (`GmailDataError`: not JSON, no data, or empty data for a part with a size) stays
  out;
  the rebuild or the parser failing makes the message the usual "couldn't be read" note, as the raw form's parser
  refusing it does. (Found by the review: the first version rethrew everything but the parser's refusals.)
- **Attachments, served the way the message was stored** (`gmail/attachments.ts`). No limit: the raw form and the
  parser, as always. With a limit: the minimal form first; at or under it, the raw form; over it (or of unknown
  size), the full form, the same rounds with the same decisions and budget (`serve`: forwarded messages downloaded as
  for storing, text written empty, calendar invites left marked), then a last rebuild that marks every part but
  forwarded messages, and the parser's attachment at the stored position: Gmail's `data`, else
  `messages.attachments.get` (20 units) for its `attachmentId`, streamed (`gmail/download.ts`: the JSON read as it
  arrives, JSON's Unicode escapes (of `=`, say) included, the base64url decoded into a buffer sized by `body.size`).
  **A size mismatch is tolerated** (since the re-review, 2026-11-21): `body.size` only sizes the buffer, bytes that
  decoded cleanly are kept whatever their count, and a mismatch is logged (`console.warn`, the message id and both
  counts). Before, a part whose bytes didn't match was refused, so a `body.size` counted differently (one byte more,
  the reviewer's probe 4) stored "too large to keep here" for a short text and failed the PDF's open. A calendar invite is read once more through the parser, so both forms serve the same bytes. A part written
  empty, a forwarded message Gmail expanded without its bytes or an id, or a position that names nothing answers "The
  message has no such attachment." Gmail's attachment ids are never stored; each full-form answer brings its own.
  (Until the review every attachment went through the rebuild, so ids numbered by the raw parse were served by the
  rebuild without a check: a UTF-16 invite came out as 1 byte, and a boundary with an escaped quote made image "0"
  serve the PDF.)

## The fake

`FakeGmail`'s full form (`testing/fake-gmail/payload.ts`) splits the raw message into parts with their own headers
(unfolded: line break removed, folding whitespace kept), `data` after the transfer encoding, and an `attachmentId` for
a part with a filename, for any part over `bodyDataLimit` (default never), and for every message/rfc822 part that
isn't base64 or quoted-printable, which it also expands into its one child (**the fake's choice, unverified**: Gmail
shows such a part as an attachment, and the provider handles either). `messages.attachments.get` answers each id a full
form handed out (a new id on every answer). Controls: `bodyDataLimit`, `sizeEstimateOf(message, format)` (the raw
length by default; undefined leaves the field out), `latencyMs`, `peakInFlight`.

## Checked

`test/gmail/large.test.ts`, `test/gmail/large-faults.test.ts`, `test/unit/payload.test.ts`, `test/unit/download.test.ts`,
`test/unit/gmail-entry.test.ts` (runs in [mail-checks.md](mail-checks.md)):

- A 30.0 MB message (a 22.5 MB attachment, quoted-printable flowed text, Latin-1 HTML with an inline picture, a calendar
  invite with CRLF lines, a forwarded message read inline with its own PDF, a forwarded message as an attachment)
  syncs through the minimal form, the full form and one `attachments.get` (the invite), never the raw form, and is
  stored deep-equal to the raw form's result; its attachment comes through `attachments.get` byte for byte, every other
  attachment as the raw form's parser gives it.
- Every MIME fixture plus that shape, forced through the full form, with and without every part left out of it,
  stores and serves the same as the raw form.
- The review's probes as tests: a UTF-16 invite stored and served as the raw form (raw on Node's default, minimal plus
  raw under a limit, full form over it); a boundary with an escaped quote; a decoded From; JSON escapes and random
  chunkings in the streamed field; eight 1.6 MiB logs downloading one.
- An unreadable or mis-sized `attachments.get` answer, or an answer that isn't JSON, leaves the part out and the next
  sync goes on from the cursor; a full form the rebuild can't read becomes the note; a 503 fails the batch and the next
  try takes the message whole.
- A gate of 2 shared by two providers holds two raw messages at once across both (four without it); a minimal form
  without `sizeEstimate` takes the full form on a host with a limit and changes nothing on Node's default.
- The `./gmail` entry's import graph reaches no `src/imap/`, ImapFlow, smtp-server or Nodemailer transport.

## Assumed about Gmail, unverified

From Google's reference (read 2026-11-21), which doesn't say; `FakeGmail` is built on the same assumptions:

- Full-form header values as written, encoded words included, in the message's order (`fromCheck` reads the topmost
  Authentication-Results), names as written (a name holding a space is dropped, as the parser ignores it). If Gmail
  decoded encoded words, little would change: postal-mime reads a decoded `Müller, Ann <ann@people.example>` as it
  reads the encoded form (checked); only odd quoting inside a decoded name could read differently.
- `body.data` is the part's bytes after its transfer encoding, in its own charset; `body.size` is their count (used for
  the budget, a marked attachment's stored size and the buffer; a different count only logs).
- `attachments.get`'s `data` is base64url, possibly with JSON escapes.
- A message/rfc822 part Gmail expands has the forwarded message as its one child; whether it also carries an
  `attachmentId` is unknown (the fake gives one).
- The minimal form carries `sizeEstimate` (handled when it doesn't), close to the raw size.

## Known limits

- The full form still carries every part Gmail sends inline, so a message whose own HTML is huge (pictures written in
  as `data:` addresses) is held whole while it is converted; Google doesn't say when it gives a body an `attachmentId`.
- A calendar invite that doesn't fit the budget keeps Gmail's size, not the parser's (UTF-8 with LF line ends).
- An attachment's position is read by the form the message was stored from, chosen by its size and the host's limit.
  A host that changes `largeMessageBytes` with mail already stored, or Gmail answering the full form differently from
  the MIME tree, could make a position name another part; the stored metadata isn't passed to `fetchAttachment`, so
  nothing compares them.
- A forwarded message Gmail left out that the budget can't take is written empty in both storing and serving, so its
  own attachments are missing and the later ones are numbered without them, alike in both.
