# Server: mail that skips Screening, and senders let in without the AI

Built 2026-11-25 on the branch `screening-pass`, from the owner's decision of that day ([decisions.md](decisions.md),
"2026-11-25: mail that skips Screening"). The contract's words are in [contract.md](../contract.md) ("Words": Skipped
Screening; "Rules and learning", step 3 and "Letting a sender in") and [contract-ai.md](../contract-ai.md) ("A model's
answer at the screening gate"); the kinds, their words and their categories are core's (`core/src/screening.ts`), and
the public mail domains too (`core/src/mail-domains.ts`, moved from `server/src/avatars/freemail.ts`). Checked by type
checks and tests only; never run against a real model or a real mailbox.

```
core/src/screening.ts          SCREENING_PASSES, SCREENING_PASS_WORDS, SCREENING_PASS_CATEGORIES, skippedScreeningLine
core/src/mail-domains.ts       isPublicMailDomain (was isFreemail), MAIL_COM_DOMAINS, isSharedPlatform
server/src/ai/gate.ts          provedMachineMail, showsEvidence, mayPass, askableKinds, worthAsking, screeningPass, holdsCode
server/src/ai/gate-evidence.ts EVIDENCE per kind (phrases, links, references, amounts, cards, days), holdsLink
server/src/ai/pass-prompt.ts   passRequest (the question), PASS_OPTIONS, passInstructions, acceptPass
server/src/ai/process.ts       planPass and applyCategory: the question between categorizing and applying
server/src/sync/let-in.ts      provedOwnSender, letInOwnSender, serverAddresses
server/migrations/0022_skipped_screening.sql   threads.skipped_screening
```

## The screening gate

- **The server's own check** (`gate.ts`, pure): `provedMachineMail` is `avatarDomain` (the checker proved the From
  address's own domain, it has a registrable domain, it is no public mail domain or shared platform) plus
  `messages.automated`; `showsEvidence(kind)` reads the subject and `plainText` (links whole) with `holdsCode` for
  `code` and `EVIDENCE[kind]` (`gate-evidence.ts`: phrase lists matched whole, any case, a phrase's words joined by a
  space, a hyphen or nothing; a link in the text or an `href` in the HTML; a reference: 5-30 capitals, digits and
  hyphens with a digit, within 40 characters after a reference word, case-sensitive; an amount: a symbol or an ISO 4217
  code from `currencies.ts` next to a number; a card's last four; a day or time). `mayPass` is both.
  `screeningPass(category, chosen, message, suffixes)`: `code` when the category is `otp` and the code check holds;
  otherwise the chosen kind when the category is one of its (`SCREENING_PASS_CATEGORIES`) and `mayPass` holds; else
  null. The suffix list is `ctx.avatars?.suffixes`: without it nothing is proved and nothing passes. The check before
  2026-11-25 (`looksLikeCode`: machine-sent and a code) is now `code`'s, with the proof added.
- **One question at most** (`pass-prompt.ts`): `processThread` sends the categorize request, records its usage, then
  under the lock `planPass` asks `worthAsking` (at the gate, the answer is a category with askable kinds, not a code
  that already passes, `provedMachineMail`, and at least one of the category's kinds shows its evidence). Only then
  the question goes out on the categorize model: `passInstructions`, the same item as the categorize request
  (`categorizeItem`, so `AI_SENT_FIELD_WORDS` still names every field), options the category's kinds
  (`askableKinds`, never `code`) and `none` (`PASS_OPTIONS`, the server's words). `acceptPass` takes only one of the
  request's own options. Its usage counts as `categorize`. `applyCategory` then applies both answers in one `perform`
  (one silent record, one write-back). A failed question: the category is applied with no kind (screened), then
  `failed` records the failure and releases the gate. A stop between the two leaves `category_due` and
  `gate_pending`, so the next start asks both again.
- **`perform`'s `gate`** (`actions.ts`, replacing `holdGate`): every categorize by the AI at the gate carries it.
  `{ pass: kind }` sets `screened` and `screenedByMailbox` false and `skippedScreening` to the kind; `{ pass: null }`
  keeps `screened`, `screenedByMailbox` and `skippedScreening` as they were, whatever the category. The column
  `threads.skipped_screening` (migration `0022_skipped_screening`, null on every thread after the upgrade, so a code
  that skipped Screening before says no kind) travels with the `screened` group in `ThreadState` (`withGroups`), so
  undoing the AI's record screens the thread again and drops the kind; `stateColumns` writes null whenever the thread
  is screened. `toThread` serves it as `Thread.skippedScreening` only while not screened.
- **After it skipped Screening** (`skippedWhileUnknown` in `sync/sorting.ts`: the kind is set, the thread isn't
  screened and its sender isn't `known`): mail written into it lets nobody in (`ingest.ts`), and `newMailInThread`
  doesn't set its category due, so the AI isn't asked to move it to `conversation`. Its summary is still redone.
- **The fake models** answer the question by the mail's words among the offered kinds (`guessPass` in `fake.ts`), so
  demo mode and `--dev-fake-ai` show it; tests set `choose` per request (`options` holding `none` is the question).

## Senders let in without the AI (`sync/let-in.ts`)

- **When:** in `ingest`, for each new incoming message that isn't the first sync's history (nor a conversation opened
  from a search of the mailbox), before the thread is sorted, so its new thread reaches step 4 (let in) and never
  the gate. Mail the provider filed under Screening is left alone (the person's filter stands).
- **`provedOwnSender`:** not the mailbox's own mail; `fromCheck` is `verified` for exactly the From address's domain
  (lower case, ASCII by `asciiHost`); not the inbox's own address; then either the address is another inbox's on this
  server (`serverAddresses`: every inbox's address, read once per batch when first needed), or the domain is exactly
  the inbox's own (no subdomain) and its registrable domain (`ctx.avatars.suffixes`) is no public mail domain and the
  domain no shared platform's.
- **`letInOwnSender`:** only for a sender with no standing yet (`senderStatus` null: not let in, not blocked), then
  `markKnown`, which lets them in with a new mark, unscreens their screened threads (those the mailbox filed under
  Screening too, as every way in does) and settles their pictures; the threads that changed are written back with
  the batch. No record, as for the other ways in. `markKnown` never lets the inbox's own address in.
- **Hosts:** the same code on Node and Cloudflare. Gmail proves the From domain when the server carries the Public
  Suffix List (both hosts ship it); IMAP gives no `fromCheck`, so neither rule applies to an IMAP inbox, and the
  "own addresses" rule needs the receiving inbox to be Gmail.

## Tests

- `screening-gate` (26, pure): each kind passing; unproved, proved for another domain, a person's mail, a public
  domain, a shared platform, no Public Suffix List, no link, no evidence, ordinary words as references, a kind its
  category can't be, invoices; whether to ask; the question's options and accepted answers.
- `screening-pass` (14, the whole server on fake models): a sign-in link (in `otp`, its sender's newsletter still
  screened), a security alert (Notifications, summary and event), an order update (Receipts), a code without a
  question; look-alikes not even asked (unverified, no checker's word, another domain, a person's mail, a public
  domain); no link, `none`, a kind not offered, a kind the check refuses; invoices never asked; AI off; the question
  failing (screened, written back under Screening, both requests in the usage, one failed); held unwritten while the
  question waits; undo; its sender writing into it again (nobody let in, no categorize request, the shop's sale
  screened); letting the sender in afterwards.
- `screening-senders` (10): another inbox's proved address let in and its earlier screened thread lifted; spoofed
  (unverified, another domain, no word); the inbox's own address; a colleague proved, not proved, at a subdomain, at
  another inbox's domain; a public mail domain (`yahoo.example`, public by its first label); a blocked colleague; a
  filing under Screening; with the AI on (no question) and failing.
- `migration-0022` (1), `migration-0018` (now compares only the columns that existed before), `ai-sorting` (the code
  fixture carries a proved `fromCheck`), `e2e-ai-gmail` (the code carries Gmail's own `Authentication-Results`),
  `e2e-ai-imap` (the code now waits in Screening: IMAP proves nothing).
- Cloudflare: `test/cloudflare/screening.test.ts` (1, workerd and the fake Gmail): a colleague at `mail.example` whose
  message carries Gmail's DMARC pass is let in; one without is screened. The AI's half isn't tried there: that
  host's tests have no fake models.
- Mutation-checked once: with `letInOwnSender` returning nothing, 4 of `screening-senders` fail; without the
  writing-in exception, `screening-pass`'s "writing into it again" fails.
