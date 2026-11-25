# Server: mail that skips Screening, and senders let in without the AI

Built 2026-11-25 on the branch `screening-pass`, from the owner's decision of that day ([decisions.md](decisions.md),
"2026-11-25: mail that skips Screening"), then changed the same day after its security review (NO-GO, fixed: the
shape of the mail, linear patterns, judging only while held and only the newest message, a stranger joining a thread
that skipped Screening, the colleague a person, IMAP's codes as before). The contract's words are in
[contract.md](../contract.md) ("Words": Skipped Screening; "Rules and learning", step 3 and "Letting a sender in") and
[contract-ai.md](../contract-ai.md) ("A model's answer at the screening gate"); the kinds, their words and their
categories are core's (`core/src/screening.ts`), and the public mail domains too (`core/src/mail-domains.ts`, moved from
`server/src/avatars/freemail.ts`). Checked by type checks and tests only; never run against a real model or mailbox.

```
core/src/screening.ts          SCREENING_PASSES, SCREENING_PASS_WORDS, SCREENING_PASS_CATEGORIES, skippedScreeningLine
core/src/mail-domains.ts       isPublicMailDomain (was isFreemail), MAIL_COM_DOMAINS, isSharedPlatform
server/src/ai/gate.ts          gateCheck (mayPass, worthAsking, pass), trustsChecker, askableKinds, holdsCode
server/src/ai/gate-shape.ts    soleSender: no List-Id, Reply-To at home, addressed to the inbox (mailboxKey), TENANT_PLATFORMS
server/src/ai/gate-evidence.ts EVIDENCE per kind (phrases, links, references, amounts, cards, days), holdsLink
server/src/ai/pass-prompt.ts   passRequest (the question), PASS_OPTIONS, passInstructions, acceptPass
server/src/ai/process.ts       judging, checkAtGate, planPass, applyCategory
server/src/sync/sorting.ts     newMailInThread: a stranger joining a thread that skipped Screening screens it again
server/src/sync/let-in.ts      provedOwnSender, letInOwnSender, serverAddresses
server/migrations/0022_skipped_screening.sql   threads.skipped_screening
```

## The screening gate

- **The server's own check** (`gateCheck`, pure, one per message): it reads the message at most once, and only as far
  as the model read it: the subject's first 1,000 characters and `modelText(...)` cut to 4,000 (links cut to their
  site), plus `holdsLink` on the stored text and HTML. `home` is `avatarDomain` (the checker proved the From address's
  own domain, it has a registrable domain, no public mail domain or shared platform), only when `trustsChecker` (the
  inbox's provider is Gmail) and the server carries the Public Suffix List. **Every kind but a code** needs `home`,
  `messages.automated`, `soleSender` (gate-shape.ts: (a) no List-Id; (b) every Reply-To's registrable domain is
  `home`; (c) `addressedTo`: To or Cc's `mailboxKey` is the inbox's, a `+tag` dropped and dots at gmail.com and
  googlemail.com; (d) the proved domain isn't under a `TENANT_PLATFORMS` entry) and `EVIDENCE[kind]`. **A code**
  needs machine-sent mail, (c), `holdsCode` and `home`, or no `home` when the inbox's provider has no checker (IMAP:
  0.1.2's behaviour, the coordinator's decision); a Gmail inbox's missing or failed proof never falls back.
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
  screened, its sender isn't `known`): mail written into it lets nobody in (`ingest.ts`); `applyCategory` drops an
  answer of `conversation` for it; and `newMailInThread` (`sync/sorting.ts`), for mail from anyone not let in, screens
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

- `screening-gate` (45, pure): each kind passing, a card alone, a day or time alone; unproved, another domain, a
  person's mail, a public domain, a shared platform, no Public Suffix List, no link, no evidence, ordinary words, a
  kind its category can't be, invoices; each shape: a List-Id (a project's mention), a Reply-To elsewhere (a comment on
  a shared document, a money request) and at home, not addressed (Bcc, undisclosed, codes too), Cc in any case, a
  `+tag` and Gmail's dots, tenant platforms; a code without the rest of the shape; IMAP (a code without proof, nothing
  else) and Gmail never falling back; whether to ask; the question; nine adversarial 1 MB bodies under 3 s each.
- `screening-pass` (16): a sign-in link, a security alert, an order update, a code without a question; Gmail's four
  failed proofs; IMAP's code (and not by Bcc, nothing else there); look-alikes not even asked; the shapes through the
  server; none, a kind not offered, a kind the check refuses; invoices; AI off; the AI turned on afterwards and a
  retried categorize (still screened, never moved out of Screening); the question failing; held while it waits.
- `screening-after` (8): undo; letting the sender in; its sender's qualifying update judged again and passing, never
  written under Screening; its sender writing like a person (screened again, not let in); a third party threaded in
  (out of Receipts, written under Screening, not let in); someone let in writing into it; mail joining while the
  question is out; the AI never making it a conversation.
- `screening-senders` (13): another inbox's proved address; spoofed; the inbox's own address; a colleague proved, not
  proved, at a subdomain, at another inbox's domain; a public mail domain; a blocked colleague; a filing under
  Screening (the label stays, the colleague isn't let in); a relaying group with a List-Id; a tool's machine-sent mail;
  an IMAP inbox; with the AI on and failing.
- `ai-text` (the linear readers), `migration-0022`, `migration-0018`, `ai-sorting`, `e2e-ai-gmail` (a proved code via
  a real `Authentication-Results`), `e2e-ai-imap` (back to 0.1.2's: a code passes, the Screening folder never made).
- Cloudflare: `test/cloudflare/screening.test.ts` (1, workerd and the fake Gmail): a colleague whose message carries
  Gmail's DMARC pass is let in; one without is screened. The AI's half isn't tried there (no fake models).
- Mutation-checked: reading the planned message instead of the newest, dropping the `conversation` guard, dropping
  `gate_pending`, not screening a joined thread again, and each of `let-in.ts`'s guards (the filing, person only,
  Gmail only) each fail a test.
