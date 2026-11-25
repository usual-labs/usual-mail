# Mail: check runs

What each pass ran and saw, newest first, split out of [mail.md](mail.md). Commands and the Docker notes are in
mail.md, "Run and check".

- **0.1.3's freeze fix, after its review (2026-11-26, `hotfix-0.1.3`):** mail `npm test`: tsc clean; 653 tests, 601
  passed, 29 skipped, 23 failed, every failure in "IMAP on Dovecot", as before. New: `test/unit/linear.test.ts` (25,
  each in a worker stopped at its limit, readers timed apart and each held under 3 s: 17 HTML shapes at the 2,000,000
  characters a parser reads, five of them at 1 MB too, and three times the cap; message ids of 1 MB of ">" and a whole
  message's four id fields; the rebuild's Content-Transfer-Encoding of 1 MB of "("), `test/unit/html-depth.test.ts`
  (8) and property tests of `stripBrackets` and a picture's width against the patterns they replace. Each fix's test
  failed with that fix undone (the old bracket pattern, the old width pattern, no depth bound, no CDATA rewrite before
  the bound, the old comment pattern, no stand-in for a dropped tag, raw-text elements dropped), but the tracker
  removal's: its old cost, 1.3 s at most at the cap, stays under 3 s. Times at 1 MB and at the cap, slowest reader:
  1 MB of `<b>` 58 and 82 ms (42.6 s before), closing tags that close nothing at the deepest 168 and 310 ms, style
  blocks at the deepest 640 and 1,165 ms (the CSS filter reading each block), tracking pixels 48 and 84 ms. A
  comparison of 0.1.2's readers with these (12,407 outputs) found no difference ([mail.md](mail.md), "Safe HTML").

- **IMAP's temporary login refusals and Gmail's error kinds (2026-11-25, the server review of 0.1.2):** mail
  `npm run check`: tsc clean; 618 tests, 566 passed, 29 skipped, 23 failed, the same Dovecot failures as before
  ([known-issues.md](known-issues.md)). New: `test/unit/imap-login-errors.test.ts` (a wrong password is
  `SignInRefused`; `UNAVAILABLE`, `INUSE`, `LIMIT`, `SERVERBUG` and Exchange's "authenticated but not connected" aren't)
  and Gmail's scope and daily-quota kinds and words.

- **A refused IMAP login named (2026-11-25, 0.1.2):** mail `npm run check`, with Docker answering for the first time:
  tsc clean; 615 tests, 563 passed, 29 skipped, 23 failed, every failure in "IMAP on Dovecot (dovecot/dovecot:2.4.5)",
  whose per-test logins Dovecot refused ("The IMAP server at 127.0.0.1 refused the user name or password."). The
  same 23 failed with this change undone (`connection.ts` as on `main`), so they aren't its. GreenMail's suite passed.
  `test/imap/connection.test.ts` checks the refused login's name, `SignInRefused`.

- **First-sync progress (2026-11-23):** mail `npm run check` (`USUAL_MAIL_SKIP_DOCKER=1`): tsc clean; 552 tests in 73
  suites, 537 passed, 15 skipped, 0 failed. New: `test/gmail/progress.test.ts` (7: every first-sync batch's count, the
  last included, none later; counting on in a new provider; `onProgress` once listed and after each message; a smaller
  window lowering the total, and one leaving nothing; an empty window; a cursor from before the count), the IMAP
  scenario counting a first sync across a reopened provider and the window test's counts (against hoodiecrow's two
  profiles), and the cursors' `n` and `fs` (round trip, damaged). Each seen failing before the providers counted.
- **U+0000 out of parsed text (2026-11-22):** mail `npm run check` (`USUAL_MAIL_SKIP_DOCKER=1`): tsc clean; 541 tests,
  526 passed, 15 skipped, 0 failed. New in `parse.test.ts`: a U+0000 (quoted-printable `=00`) in the text part, the
  HTML part and an encoded-word subject, and in an HTML-only message, taken out with what follows kept; it fails on
  the parser before. Server: both tsc configs clean, `npm test` 999 tests, 993 passed, 6 skipped.
- **After the re-review (2026-11-21, last):** mail `npm run check` (`USUAL_MAIL_SKIP_DOCKER=1`): tsc clean; 540 tests,
  525 passed, 15 skipped, 0 failed. New in `large-faults.test.ts`: the reviewer's probe 4 (every `body.size` one byte
  off either way: the text and the PDF kept), and a token refresh refused for an unnamed reason during a download
  failing the batch (`GoogleRefreshError`); data errors now say `TEXT_NOT_GIVEN`. Server (not edited): both tsc
  configs clean, `npm test` 979 tests, 973 passed, 6 skipped, 0 failed.
- **After the large-message review (2026-11-21, later the same day):** `npm run check` with `USUAL_MAIL_SKIP_DOCKER=1`:
  tsc clean; 538 tests in 72 suites, 523 passed, 15 skipped (as before), 0 failed. The review's three probes failed
  first (a UTF-16 invite served as 1 byte; a boundary with an escaped quote making image "0" serve the PDF; `\u003d`
  in `attachments.get` refused; eight 1.6 MiB logs all downloaded) and pass now; they are tests in
  `test/unit/download.test.ts` (now 7), `test/unit/payload.test.ts` (4, new) and `test/gmail/large-faults.test.ts` (12,
  new: attachments served the way the message was stored, the UTF-16 invite, a forwarded message without bytes refused,
  the per-message budget, unreadable answers leaving parts out while the next sync goes on, a full form the rebuild
  can't read becoming the note, a 503 failing the batch and the retry succeeding, a gate shared by two providers, a
  minimal form without `sizeEstimate`). `large.test.ts`'s attachment test now expects the minimal form first. The
  server (not edited): `tsc -p tsconfig.json` and `-p tsconfig.node.json` clean; `npm test` 979 tests, 973 passed, 6
  skipped, 0 failed (other sessions' tests added meanwhile).
- **Large messages, the `./gmail` entry, attachments through `attachments.get` (2026-11-21):** `npm run check` with
  `USUAL_MAIL_SKIP_DOCKER=1`: tsc clean; 519 tests in 67 suites, 504 passed, 15 skipped (the IMAP profiles' search
  and reset cases and the Docker file, none new), 0 failed. New: `test/gmail/large.test.ts` (12: the 30 MB message
  through the full form and stored deep-equal to the raw form, its attachment through `attachments.get`, every
  attachment as the raw form's parser serves it, every fixture through the full form with and without parts left out,
  a text part over the limit, the concurrency bound through `peakInFlight`, bad limits, normal mail by default and with
  `GMAIL_SMALL_MEMORY`, `fetchThread` taking sizes from the conversation), `test/unit/download.test.ts` (4: the
  streamed base64url field in any chunking, past decoys, cut short, megabytes) and `test/unit/gmail-entry.test.ts` (2:
  the import graph from `src/gmail/index.ts`, through the sources and every dependency's files by Node's resolution,
  reaches no `src/imap/`, ImapFlow, smtp-server or Nodemailer transport; the main entry does reach ImapFlow). An
  esbuild metafile of `src/gmail/index.ts` (the server's esbuild 0.28.2, platform node, not written to disk): 149
  inputs, 902.2 KiB, no ImapFlow input, no `src/imap/` input, Nodemailer only `mail-composer`, `mime-node`,
  `mime-funcs`, `addressparser`, `base64`, `qp`, `punycode`, `fetch`, `shared` and two small files; the main entry: 343
  inputs, 2,898 KiB, 57 ImapFlow inputs. The existing Gmail tests passed unchanged, the quota-pace test included (the
  size check is off by default). Against the changed `mail/`, the server (not edited): `tsc -p tsconfig.json` and
  `-p tsconfig.node.json` clean, `npm test` 972 tests, 966 passed, 6 skipped, 0 failed.
- **After the pictures' third review (2026-11-18):** tsc clean; every suite: 440 tests, 434 passed, 6 skipped. New:
  `imap.test.ts` "reports a ref it gave by its own move as removed once another app moved the message on before a
  sync saw it" (failing first; `ownGone` in `imap/sync.ts`, `OwnMoves.in`).
- **After the pictures' second review (2026-11-18):** tsc clean; every suite: 439 tests, 433 passed, 6 skipped.
  New: `test/unit/css-tokens.test.ts` (the reader token by token: a newline ends a string, bad tokens, `URL(` in any
  case, `src()`, unclosed `url(`, the 100-address cap, comments), declaration names, whole re-reads, the depth cap
  and a value written as checked in `sanitize.test.ts`, the token-based served guard and SVG in `pictures.test.ts`,
  and the hostile list's newline-in-a-name cases. `outgoing` now comes only from Gmail's SENT label and IMAP's Sent
  folder (`gmail/messages.ts`, `imap/convert.ts`; tests in `gmail.test.ts` and `imap.test.ts`, failing first);
  `parseMessage` still reports `fromSelf`, which nothing trusts.
- **After the pictures' security review (2026-11-18):** tsc clean; every suite: 396 tests, 390 passed, 6 skipped (the
  Docker suites). The review's hostile CSS (nested functions, a `)` in a string, comment markers inside strings, an
  escaped `url` name, a font behind a decoy, a custom property) joined `test/unit/hostile-html.ts`, so both the
  sanitizer's and the pass's tests run them; they failed first (four of them let `javascript:`, `vbscript:`, `file:`
  and `data:text/` into stored HTML). `pictures.test.ts` has 120, `sanitize.test.ts` 86.
- **Pictures from the web, the picture pass (2026-11-18):** tsc clean; `node --test` over every suite: 342 tests, 336
  passed, 6 skipped (the Docker suites, as before). New: `test/unit/pictures.test.ts` (85: finding pictures, writing
  the HTML again for each decision, fonts from the web, escapes, addresses with a user name, tiny or hidden pictures,
  and every hostile input through the pass three ways, checked safe and loading nothing from the web). The hostile
  inputs and their check moved to `test/unit/hostile-html.ts`, shared with the sanitizer's tests. Reading a message
  is unchanged: `parseMessage` still calls `sanitizeHtml` without a hook.
- **A smaller window for a first sync in progress (2026-11-17, after the owner's first run):** `npm run check` with
  `USUAL_MAIL_SKIP_DOCKER=1`: tsc clean; 257 tests in 43 suites, 251 passed, 6 skipped (as before). New, each failing
  first (the older mail was fetched): Gmail's case in `test/gmail/gmail.test.ts` and IMAP's in `test/imap/scenarios.ts`
  (both hoodiecrow shapes); see "The first sync's window" below. `syncAll` takes `batches` (stop after that many calls)
  and the IMAP test harness `reopen` (another provider on the same mailbox).
- **Sign in with Google (2026-11-17):** `npm run check` with `USUAL_MAIL_SKIP_DOCKER=1`: tsc clean; 254 tests in 43
  suites, 248 passed, 6 skipped (as before, plus 7 new). New: `GoogleTokenError` (`src/gmail/client.ts`, exported):
  a refused refresh token (`invalid_grant`) is `kind: "token_refused"`, a refused client `client_refused`, with the
  same messages as before, so the server can tell a signed-in inbox to sign in again (the new test failed first).
  `FakeGoogle` (`src/testing/fake-google.ts`): Google's authorization endpoint (checks the client and the exact
  redirect address, else Google's own error page; does what `consent` says the person did: allow, decline, another
  account, scopes left unticked, no refresh token), the token endpoint (`authorization_code` with PKCE S256 or plain,
  codes once for ten minutes, the same redirect address; a refresh token only with `access_type=offline`, on the first
  grant or with `prompt=consent`; `refresh_token` routed to the account's `FakeGmail`), revocation (ends the
  account's whole grant; unknown token 400; `failNextRevoke`), and Gmail's API routed by access token, one `FakeGmail`
  per account. `FakeGmail` gained `grantedRefreshTokens`, `acceptsRefreshToken`, `issueAccessToken`,
  `holdsAccessToken` and `revokeGrant`. Built from Google's documentation read on 2026-11-17; never compared with
  Google itself. One run of the check that day went without the skip switch by mistake: Docker's probe got no answer
  and the Docker file skipped, as always.
- After the review's decisions (2026-11-17): nothing in `mail/` changed (the first sync's new rule for recent filed
  mail and a blocked sender's mail in a thread are the server's reading of what providers report); `npm run check`
  with `USUAL_MAIL_SKIP_DOCKER=1` against the changed `core/`: tsc clean, 247 tests in 42 suites, 241 passed, 6
  skipped, as before.
- `npm run check` on 2026-11-17 for the fifth revision, with `USUAL_MAIL_SKIP_DOCKER=1`: tsc clean; 247 tests in 42
  suites, 241 passed, 6 skipped. The skips: the reset contract test for the three hoodiecrow profiles (the IMAP
  harness has no `loseSyncPlace`), the two spam contract tests for the hoodiecrow profile without a junk folder, and
  the Docker file (skipped on purpose). The contract suite now places every category with and without Screening and
  each stack (39 destinations). Before: 246 tests, 240 passed, 6 skipped (fourth revision).
- **Independent review (2026-11-17):** `npm run check` with `USUAL_MAIL_SKIP_DOCKER=1` again: 247 tests, 241 pass, 6
  skipped, as above. Joined through the built server against hoodiecrow in another process: each category's mail in
  its own `Usual Mail/` folder, a stranger's mail of any category but a code in `Usual Mail/Screening` alone, the
  stranger's code in `One-Time Codes`, conversations in INBOX, a correction moving the message between folders and
  an undo moving it back; a second server on the same mailbox read the filed categories back (decided by the
  mailbox), Screening as screened `unknown` (the one-folder rule), and conversations as `unknown`. Gmail ran only in
  the server's own end-to-end tests against `FakeGmail`, not joined by hand.
- The server runs the same contract suite against its own in-memory mailbox, and its end-to-end tests run the real
  IMAP provider against hoodiecrow and the real Gmail provider against `FakeGmail` (see [server.md](server.md)).
