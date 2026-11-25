# Server: mail that skips Screening, and senders let in without the AI

Built 2026-11-25 on the branch `screening-pass`, from the owner's decision of that day ([decisions.md](decisions.md),
"2026-11-25: mail that skips Screening"), then changed the same day after its security review (NO-GO, fixed: the
shape of the mail, linear patterns, judging only while held and only the newest message, a stranger joining a thread
that skipped Screening, the colleague a person, IMAP's codes as before), and again after a second review (NO-GO,
fixed: To or Cc only in a field the sender's signature vouches for, a deny list of notifiers that carry users' words,
more tenant platforms, the kind's categories kept, and a sweep of every pattern that reads mail). The contract's words are in
[contract.md](../contract.md) ("Words": Skipped Screening; "Rules and learning", step 3 and "Letting a sender in") and
[contract-ai.md](../contract-ai.md) ("A model's answer at the screening gate"); the kinds, their words and their
categories are core's (`core/src/screening.ts`), and the public mail domains too (`core/src/mail-domains.ts`, moved from
`server/src/avatars/freemail.ts`). Checked by type checks and tests only; never run against a real model or mailbox.

```
core/src/screening.ts          SCREENING_PASSES, SCREENING_PASS_WORDS, SCREENING_PASS_CATEGORIES, skippedScreeningLine
core/src/mail-domains.ts       isPublicMailDomain (was isFreemail), MAIL_COM_DOMAINS, isSharedPlatform
server/src/ai/gate.ts          gateCheck (mayPass, worthAsking, pass), trustsChecker, askableKinds, holdsCode
server/src/ai/gate-shape.ts    soleSender: no List-Id, Reply-To at home, addressed (mailboxKey), TENANT_PLATFORMS, carriers
mail/src/message/signed-recipients.ts   signedRecipients: To and Cc given once and signed by the aligned, passed DKIM
server/src/ai/gate-evidence.ts EVIDENCE per kind (phrases, links, references, amounts, cards, days), holdsLink
server/src/ai/pass-prompt.ts   passRequest (the question), PASS_OPTIONS, passInstructions, acceptPass
server/src/ai/process.ts       judging, checkAtGate, planPass, applyCategory
server/src/sync/sorting.ts     newMailInThread: a stranger joining a thread that skipped Screening screens it again
server/src/sync/let-in.ts      provedOwnSender, letInOwnSender, serverAddresses
server/migrations/0022_skipped_screening.sql   messages.signed_recipients, threads.skipped_screening
```

## The screening gate

- **The server's own check** (`gateCheck`, pure, one per message): it reads the message at most once, and only as far
  as the model read it: the subject's first 1,000 characters and `modelText(...)` cut to 4,000 (links cut to their
  site), plus `holdsLink` on the stored text and HTML. `home` is `avatarDomain` (the checker proved the From address's
  own domain, it has a registrable domain, no public mail domain or shared platform), only when `trustsChecker` (the
  inbox's provider is Gmail) and the server carries the Public Suffix List. **Every kind but a code** needs `home`,
  `messages.automated`, `soleSender` (gate-shape.ts: (a) no List-Id; (b) every Reply-To's registrable domain is
  `home`; (c) `addressedTo`: To or Cc's `mailboxKey` is the inbox's, a `+tag` dropped and dots at gmail.com and
  googlemail.com, on Gmail only in a field `messages.signed_recipients` holds (the mail part's `signedRecipients`:
  given once, named in the `h=` of every aligned DKIM signature Gmail's checker passed; null for mail stored before,
  so it never passes); (d) the proved domain isn't under a `TENANT_PLATFORMS` entry; (e) `carriesUsersWords`: no
  address at google.com, microsoft.com (and under them) but Microsoft's account team (`ACCOUNT_SECURITY`), nor at
  paypal.* (by name), venmo.com, square.com, squareup.com, stripe.com or sharepointonline.com) and `EVIDENCE[kind]`. **A code**
  needs machine-sent mail, (c), `holdsCode` and `home`, or no `home` when the inbox's provider has no checker (IMAP:
  0.1.2's behaviour, the coordinator's decision, (c) read on To and Cc as given); a Gmail inbox's missing or failed
  proof never falls back.
  `pass(category, chosen)`: `code` when the category is `otp` and the code passes; otherwise the chosen kind when the
  category is one of its (`SCREENING_PASS_CATEGORIES`) and `mayPass` holds; else null.
- **Linear patterns:** every quantifier in gate-evidence.ts is bounded (the reference's lookahead `{0,29}`, a card's
  mask `{2,8}`, a phrase's joiner `[\s-]{0,3}`, numbers `{1,5}` groups or `{1,9}` digits, months `{0,6}`, spaces
  around an `href` `{0,8}`); a reference is matched to its word in one ordered pass. text.ts's own patterns are linear
  too ([server-ai.md](server-ai.md), "What leaves the server"). Measured on 1 MB bodies: each well under 100 ms (before:
  "card " and 80,000 "*" 7.6 s, a link and 40,000 ")" 0.7 s in every categorize request and snippet).
- **Judged only while held, and only the newest message** (`judging`, `checkAtGate` in `process.ts`): the gate lets a
  thread through only while `gate_pending` is set (a new thread from a stranger while the AI may answer at once, or
  a thread a stranger's mail screened again) and the message the model read is still its newest incoming one. So a
  thread is written back once, never under Screening and out again: mail that arrived while the AI was off, paused or
  failing, or whose categorize failed and is tried again later, stays screened; mail that joined while the question
  was out isn't judged by the answer about the earlier message. A held thread may get any category (`onlyConversation`
  is false for it), so a thread screened again can be judged afresh.
- **One question at most** (`pass-prompt.ts`): `processThread` sends the categorize request, records its usage, then
  under the lock `planPass` asks `worthAsking` (judging, the answer is a category with askable kinds, not a code that
  already passes, the proof, machine-sent, the shape, and one of the category's kinds shows its evidence). Only then
  the question goes out on the categorize model: `passInstructions`, the same item as the categorize request
  (`categorizeItem`, so `AI_SENT_FIELD_WORDS` still names every field), options the category's kinds and `none`.
  `acceptPass` takes only one of the request's own options; its usage counts as `categorize`. `applyCategory` applies
  both answers in one `perform` (one silent record, one write-back). A failed question: the category is applied with
  no kind (screened), then `failed` records the failure and releases the gate. A stop between the two leaves
  `category_due` and `gate_pending`, so the next start asks both again.
- **`perform`'s `gate`** (`actions.ts`, replacing `holdGate`): every categorize by the AI at the gate carries it.
  `{ pass: kind }` sets `screened` and `screenedByMailbox` false and `skippedScreening` to the kind; `{ pass: null }`
  keeps them as they were, whatever the category. `threads.skipped_screening` (migration 0022, null on every thread
  after the upgrade) travels with the `screened` group in `ThreadState`, so undoing the AI's record screens the thread
  again and drops the kind; `stateColumns` writes null whenever the thread is screened; `toThread` serves it only while
  not screened.
- **After it skipped Screening** (`skippedWhileUnknown` in `service/store.ts`: the kind is set, the thread isn't
  screened, its sender isn't `known`): mail written into it lets nobody in (`ingest.ts`); `applyCategory` drops any
  answer outside its kind's categories (`fitsItsKind`: never `conversation`, never `invoice`, asked again or not); and `newMailInThread` (`sync/sorting.ts`), for mail from anyone not let in, screens
  it again (`screened`, the kind cleared, `category_due`, and `gate_pending` when the AI may answer now; the
  `screened` part's undo retired), so the gate judges the newest message: a qualifying update passes again without
  ever being written under Screening, anything else is written under Screening. Mail from someone let in asks nothing.
- **The fake models** answer the question by the mail's words among the offered kinds (`guessPass` in `fake.ts`).

## Senders let in without the AI (`sync/let-in.ts`)

- **When:** in `ingest`, for each new incoming message that isn't the first sync's history (nor a conversation opened
  from a search of the mailbox), before the thread is sorted, so its new thread reaches step 4 (let in) and never
  the gate. Mail the provider filed under Screening is left alone (the person's filter stands).
- **`provedOwnSender`:** the inbox's provider is Gmail (`trustsChecker`); not the mailbox's own mail; `fromCheck` is
  `verified` for exactly the From address's domain; not the inbox's own address; then either the address is another
  inbox's on this server (`serverAddresses`, read once per batch), or it is a person at exactly the inbox's own domain:
  not `automated`, no List-Id (a group relaying "X via info@company", a help desk or marketing tool sending as the
  company), the registrable domain no public mail domain and the domain no shared platform's.
- **`letInOwnSender`:** only for a sender with no standing yet, then `markKnown`: let in with a new mark, their
  screened threads lifted, their pictures settled; no record, as for the other ways in. Never the inbox's own address.

## Tests

- `screening-gate` (47, pure): each kind passing, a card alone, a day or time alone; unproved, another domain, a
  person's mail, a public domain, a shared platform, no Public Suffix List, no link, no evidence, ordinary words, a
  kind its category can't be, invoices; each shape: a List-Id, a Reply-To elsewhere and at home, not addressed (Bcc,
  undisclosed, codes too), a signed Cc in any case, a Cc added after signing, To given twice, nothing read, a `+tag`
  and Gmail's dots (with names Gmail wouldn't allow), tenants on each listed platform (the reserved label `ab--cd`,
  which no tenant has), Google's and payment services' notifiers (and the provider's own account alerts still passing);
  a code without the rest of the shape; IMAP (a code without proof, nothing else) and Gmail never falling back; whether
  to ask; the question; and the 1 MB bodies in workers (below).
- `screening-pass` (16) and `screening-after` (12): as before, with the fixtures signed, through the server: a Cc added,
  To given twice, a document's mention; a joined message that would pass on its own but wasn't asked about; asked
  again to an invoice; the stored and served "a screened thread carries no kind" backups.
- `screening-senders` (13), `migration-0022` (both columns), `e2e-ai-gmail` (the code carries a DKIM-Signature whose b=
  starts with Gmail's `header.b`, signing To), mail's `signed-recipients` (22: each attack the four reviews ran,
  through the parser too: a Cc added, To or Cc twice, a forged signature copying the passing one's first characters, a
  padded real signature, SPF-only DMARC with a forged brand signature, a signature lacking `d=`, `h=` or `b=` or
  writing `D=`, `To :`, a real signature whose `i=` names a subdomain, a Unicode or dotted `d=`, a `d=` that can't be
  placed, a signature matching a failed result, every malformed header line; an unmatched signature of the
  organisation still bounding the answer; and a monotone property: about 1,400 messages, each hostile field alone and
  in pairs at every place below Gmail's result, never adding a field). `ai-addresses` (12): names with marks,
  full-width at signs and dots, long domains, joined addresses and two-unit characters at a cut. Mail's
  `header-reading` (11, on raw bytes, the fifth review): a lone LF read as a blank line, a stray CR, mixed line ends,
  the 2 MiB limit and the early stop, sixteen signatures and a seventeenth, a top-level header the large-message
  rebuild drops (through `fromFullForm`), and Gmail's result with unquoted "/" and "=".
- **Speed** (`test/linear.ts`): 20 bodies of 1 MB, each run in a worker thread that is terminated at 10 seconds, since
  a slow pattern blocks the event loop and node:test's own timeout can't fire: the gate's check (`screening-gate`), and
  the requests, snippets, a model's answers, names, List-Ids and pictures' addresses (`ai-linear`), each under 3 s
  (all well under 1 s). Mutation-checked: the old address, markdown-link and markup patterns each fail at 10 s.
- Mutation-checked too: reading the planned message instead of the newest, dropping the newest-message id check,
  going back to `conversation` only, dropping `gate_pending`, not screening a joined thread again, dropping the
  stored or served backups, and each of `let-in.ts`'s guards.

## The pattern sweep (2026-11-25, the second security review)

Every entry point in the server, core and mail that reads mail text or headers, run on about 85 adversarial inputs
(each of 33 characters repeated; 53 short units repeated, such as `<a`, `<style `, `[](mailto:`, `&#`, `1,`, `order `,
`card `, `ending `; and a long run of 25 characters with something else at each end), first at 16 and 32 KB (flagged
when 32 KB took over 40 ms and nearly four times 16 KB), then at 1 MB. Core holds no pattern over mail. Found and
fixed: `prompt.ts`'s address pattern (55 s at 128 KB), the snippet's markdown link, the answers' markup check, party
names (a comma run), the status line's trailing trim, `normalizeListId`, and the tracker list's input (capped, as only
`present.ts` reaches it; the list's own patterns stay as shipped). The worst time at 1 MB after the fixes, per entry
point: `modelText` 50 ms; `readingText`, `snippetText`, `isStubText`, `plainLine` up to 109 ms; `withoutAddresses` 51 ms and
the summarize, details and event requests up to 105 ms (the address pattern read once per run of address characters;
bounded alone it took 600 ms on 1 MB of letters); the categorize request 169 ms; `acceptSummary` 64 ms; `checkDetails` 145 ms; `checkEvent` 263 ms; `checkReference` 70 ms; payment
`plainLine`, `parseAmount`, `currencyIn`, `writtenIn`, party names, the date and time readers and `appointmentLike`
under 45 ms; the gate's check 86 ms, `holdsCode` and the evidence 26 ms; `mailboxKey` and `addressedTo` under 20 ms;
search's `tokens`, `parseSearch`, `fold`, `tokensOf`, `runsOf` and `oneLine` under 80 ms; `presentPictures` 640 ms;
`iconsInPage` 15 ms; `asciiHost`, `normalizeListId`, `ruleMatches` 2 ms; `scrubKey` 100 ms; mail's `messageIds`,
`listIdOf`, `isNoReplyAddress`, `isAutomated` under 50 ms, `firstFromAddress` 194 ms, the authentication readers and
`signedRecipients` under 2 ms, `htmlToText` 80 ms, `sanitizeHtml` 339 ms, the CSS sanitizers and `servableCss` up to
292 ms, `canonicalPictureUrl` 22 ms, and `parseMessage` 719 ms (headers) and 406 ms (body). The sweep itself was a
scratch script, not kept; the worker tests above keep the cases that were slow.
