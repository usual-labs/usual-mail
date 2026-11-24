# Decisions: how the server's AI sorts

The decisions behind the words the categorize job gives a model, what a model reads of a message, and asking the AI
again about what it already filed ([contract-ai.md](../contract-ai.md)). The other cross-part decisions are in
[decisions.md](decisions.md).

## 2026-11-19, the sorting words, what a model reads, and asking again

The owner's decisions: asked "Tighten the sorting prompt so only real payments and purchases count as receipts?",
"Yes, tighten it"; then "make an opus subagent to go through emails and verify how good they have been labled. then
update the prompt for labling so the labling becomes more accurate". A read-only audit judged most of the threads
the AI had filed on the owner's server (a few hundred) against what the model had been shown: about 88% right in the
audited set (about 90% weighted); by kind, newsletters about 99% right, notifications 89%, receipts 72%,
conversations 63%. What it found: over a quarter of the receipts were bookings with no payment (appointments, free
registrations, reservations); about one notification in ten was marketing or a nudge to come back; over a third of
the conversations were mass mail in a person's voice; upcoming charges were filed inconsistently; over a third of the
messages were cut at 4,000 characters, most of those under 40% readable text (tracking links, invisible padding,
divider lines), and an order's total lay past the cut; a few text parts were stubs with the mail only in the HTML.
No mail content, senders or counts from that mailbox are kept here.

The coordinator's decisions, from that evidence, as built (test-first):

- **New words for all six kinds but `otp`, and a tie-break in the instructions:** when more than one kind fits, the
  first of otp, invoice, receipt, conversation, notification, newsletter; mail sent to many people is never a
  conversation; mail with no payment made or owed is never an invoice or receipt. The words live in one place
  (`CATEGORY_OPTIONS` and `categorizeInstructions` in `server/src/ai/prompt.ts`; server-ai.md quotes them in short).
  Why the tie-break goes in the instructions: it is about choosing between kinds, which no single kind's line can say;
  on the Decisions API the instructions are the question's own. The server's checks are unchanged: a model's `otp`
  alone never lifts screening, and normal processing never takes a thread out of `conversation`.
- **A model reads less noise, the same field:** links cut to their site, invisible characters and padding out, divider
  lines short, spaces collapsed, then the 4,000 and 8,000 limits; a text part that is a stub of its HTML (under 300
  characters cleaned, the HTML at least three times as long) is replaced with the HTML's text. Both jobs. Core's words
  and contract-ai.md say links are cut. The screening gate's check keeps reading the message as before.
- **The AI's own receipts, invoices and notifications are asked again once,** at the first start of this build, and
  its newsletters whose newest incoming message has a stub text part; not done, trashed or gone. Any of the six
  answers is applied the normal way (a silent record, written back as its label, undoable). Nothing a person, a rule,
  an outside agent or the mailbox decided. **Not conversations:** the contract says the AI never takes a thread out of
  `conversation`, and the coordinator asked the owner about them (answered in the second round, below).
  Why a marked thread instead of resetting it to `unknown`: the thread keeps its category and label until the answer
  comes, undoing the new record puts the old category back (as the person's, like any undo of the AI), and nothing
  shows in Home while it waits. **Summaries aren't redone.**
- **The migration only adds columns** (0011), and the server marks the threads at a start, so a running build of
  before that applies the migration on a restart changes nothing.

## 2026-11-19, the second round

The first round ran on the owner's server and the auditor measured again: about one thread asked in seven changed,
most of them corrections and a few a right label made wrong; about 94% of the mailbox right (about 90% before);
receipts from 72% to 100% precise; messages cut at 4,000 characters down by more than half, with no amount or
deadline past the cut any more. Left over: a few shop order confirmations with prices went from receipt to notification because they show a delivery
progress bar and the receipt's line said "Not a shipping update"; marketing nudges that name the reader (a cart
reminder, a "finish signing up" mail, a group's new-event mails) were asked and stayed notifications, partly because
the tie-break puts notification before newsletter. The owner approved the second round ("Yes, run it": two wording
fixes and a re-check of the conversations the person never replied in). The coordinator's decisions, as built
(test-first):

- **The receipt's line gains** "An order confirmation with a price is a receipt even when it shows delivery
  progress.", as its middle sentence, the rest unchanged. **The instructions gain** "A nudge to buy or finish signing
  up, or a group's new event, is a newsletter even when it names the reader.", after the two "never" rules. **The
  tie-break order stays:** a deadline hidden in Feed is worse than a nudge on Home.
- **Asked again a second time, with a new id** (`2026-11-19 second round`; the first stays done): the AI's `receipt`
  and `notification` threads (to apply both fixes), not `invoice` or `newsletter`; and, by the owner's explicit
  exception for this one-off only, the AI's `conversation` threads in which the mailbox never wrote (no `outgoing`
  message, from evidence: a forged "From: me" isn't the person writing). Their answer
  may take them out of `conversation` by the normal path. Normal processing keeps "the AI never takes a thread out of
  `conversation`". No schema change: 0011's columns do.
- **Not built, and not to be re-proposed without this case: "a thread the person wrote in is always a
  conversation".** Forwarding an invoice to an accountant, or replying to a shop about an order, keeps the same Gmail
  thread; such a rule would pull it out of Receipts or Invoices into Home. Having written in a thread only keeps the
  AI from asking about a conversation again in this one-off; it says nothing about what the thread is.
- **Re-asking flips some right labels:** the model answers identical templates differently, so any asking-again can
  make a right label wrong (about one change in six in the first round). known-issues.md keeps it.

## 2026-11-19, payment details for the Receipts tab

The owner's request: "lets thing on how we can make the items in the receipts tab list better and more targetted
summarised. maybe the title should be also generated? or title will show how much from where is invoiced, and the
subtitle gives a short summary of for what?", then "in the summarised version of each item in the receipts tab, lets
remove the receipt/invoice label in the header. and bring [it] in title. so title would start with to be paid if
invoice and paid if receipt." Round two of the asking-again had run (fewer than one in ten changed, no failures).

The coordinator's decisions, and the Mac app session's questions settled with them, as built (test-first):

- **The server supplies facts, never a finished title.** The app composes "To be paid: €49.00 to Paperloop" (invoice),
  "Paid: …" (receipt), "Refunded: … by …" (a receipt with `refund`) and the subtitle from `Thread.payment`; "To be
  paid" or "Paid" comes from the category, never from the model.
- **The same summarize job, one request per thread:** structured details in place of a summary for `receipt` and
  `invoice`, with the summarize model, settings, status and usage, from exactly what a summary request sends. No new
  job, so the apps' usage table doesn't change. `summary` is `what`, or absent, never a second line.
- **Nothing the model says is shown unchecked** (contract-ai.md, "Payment details"): an amount only when its number and
  currency are written in the mail; a due date only when written there; party and what through a summary's checks.
  Drops are logged by reason code only.
- **Minor units follow ISO 4217** (the Mac session's first point): the server's own table of active ISO codes; a code
  it doesn't list drops the amount rather than guessing its decimals. Why a table: the runtime's figures follow CLDR,
  which differs for a few currencies.
- **A refund only on a receipt** (its second point): on an invoice `refund` is always false and an amount read as a
  refund is dropped, since "To be paid" over a credit would be wrong. Turning a receipt into an invoice, or back,
  asks for the details again.
- **`party` and `what` may each be null on its own** (its third point); the app degrades ("Paid to Paperloop", or the
  subject).
- **No one-off flag:** a receipt or an invoice without details needs them by rule, so the first start of the build
  asks for every stored one, and a running older build that applies the migration (the column only)
  changes nothing.
- **Order, shipped, invoice in one thread:** the model is asked for the newest message's amount; a newer amount that
  checks out wins, a message stating none keeps the one before.
- **Zero is no amount** (after real receipts showed as "Paid: €0.00", from a "Total 0" line):
  dropped (`zero`) whatever the text says; a stored one is never carried forward, and `servedPayment` hides it.
- **Not now** (improvement-ideas.md): amounts from PDF attachments, marking an invoice paid (by the person or by a
  matching receipt), totals per month, "due soon" in Home.

## 2026-11-19, payment details revised after their audit

The details ran on the owner's server: every open receipt and invoice got them, no failures (an amount on most,
party and what on all, a due date on a few; two amounts dropped). The auditor judged every row: about 60% fully right,
a quarter right but vague, one in six misleading (the zero amounts among them, already fixed). What it found, without
mail content: an instalment's
receipt showed the order's total instead of what was paid; a payment processor named as the party; legal suffixes
and "Team" in names; `what` repeating the party or saying only that a payment was made; due dates on receipts; an
amount written with one decimal (like "12.5") dropped. The coordinator's decisions, as built (test-first):

- **The words:** the request says which kind the thread is filed as; `amount` is what was paid or charged in this
  message (for an invoice, what is due now), never an order's or a plan's total or a balance; `party` is the shop or
  service, without a legal suffix, never the payment service or wallet (a few named); `what` never repeats the party,
  the amount or a date, and is null when it would only say a payment was made; `dueDate` is for invoices, the charge
  date for an automatic charge, never on a receipt.
- **The server's rules:** an amount may be written with fewer decimals when only zeros are left out, never with more;
  a party loses trailing legal suffixes (a tested list) and "Team"; `what` loses a leading party name before a
  separator, and is null when only the party or only "a payment was made" is left; a due date on a receipt is dropped
  (`on_receipt`).
- **Asked again once, replacing:** every receipt and invoice not done is asked once more (a new one-off id beside the
  categories'), and the new answer replaces the old details whole, so a wrong old fact can't survive; a fact the new
  answer lacks or the server drops is null. An unusable answer keeps the old details (an empty reply isn't a better
  one). A flag per thread keeps the old details served until each answer lands, rather than clearing them at the start.
- **Not now:** a third verb, "Will be charged", for bills charged automatically, is the owner's open decision; the
  details' shape is unchanged so adding it later stays simple.

## 2026-11-19, the payment details' last round

The re-audit of every row after the revision: about two thirds fully right, a quarter right but vague, one in ten
misleading (about 60%, a quarter and one in six before). Fixed by the revision: the instalment's amount, the
one-decimal amount, the garbled total, the zeros, the due date on a receipt, the empty subtitle, and most rows
repeating the party in `what`. Left: a due date read the wrong way round (a shop's day-first date read month first), display text and resellers as the party, one
sender's name written two ways, and a plan's name lost from `what`. The coordinator's decisions, as built (test-first),
**with no new asking-again** (each one also breaks a few right rows) and still no state field:

- **A due date not before its message**, two days' tolerance (UTC dates and "due today/yesterday"); a reading before
  it is swapped when the other reading is written and fits, else dropped; when both fit, the mail's own way of writing
  dates decides, else the model's.
- **Paddle and FastSpring** join the payment services the request names; the server's list is the same one.
- **Display text as a party** is cut at its first separator, or falls back to the sender's name.
- **One name per sender**, on the server: domain endings and word-boundary prefixes unify within one sender and inbox,
  never across senders or for a payment service's mail. The domain-ending case keeps the form without the ending (the
  coordinator's default): it is what people call the shop, and it doesn't change with the country it billed from.
- **`what` may be just a product's or plan's name.** The one thread that lost its plan's name is left as it is.
- **Stored details** get these rules once at the next start, by rule only, with events and counts.

## 2026-11-19, the payment state, and one name per domain

The owner's decision: asked "Add a third title, 'Will be charged', for bills that are collected automatically?", "Yes,
add it". The last run of the rules had read a due date the other way round, cleaned a party and unified a few names.
The coordinator's decisions, as built (test-first):

- **`payment.state`: `paid`, `scheduled` or `due`, or null.** The titles follow it ("Paid: … to …", "Will be charged:
  … by …" with "on 30 Nov", "To be paid: … to …" with "due 30 Nov"); "Refunded" for a refund; null falls back to the
  category. The request names the evidence each needs; the amount follows the state (paid, will be charged, or owed
  now; an order bought on invoice: its amount owed). A refund is `paid`. A date is never kept while paid, which
  replaced "never on a receipt": a receipt may now be `due` or `scheduled` with a date, and an invoice `paid`; the
  category stays what sorting decided.
- **Asked once more, conservatively:** every receipt and invoice not done gives its state; a fact is filled only where
  the thread had none, never overwritten; the date follows the new state. Why: each full re-read also breaks a few
  right facts.
- **One name per domain** (a marketplace mails from several addresses), the registrable domain with the Public Suffix
  List, and **a district cut back to the sender's name**; applied once to what was stored.

Choices made in building it: the state is asked as a nullable string the server checks, like the other fields that
already work through the gateway, not an enum; a null state on a receipt counts as paid for the date rule, so no date
shows under "Paid"; a free mailbox's or a shared platform's senders keep their own address (different people, as the
sender pictures already treat them); no migration: the state lives in the details' JSON, and the asking-again reuses
the existing flag and marker with a new id.

## 2026-11-19, notification events for the Notifications tab

The payment details ended audited: about four rows in five right, the rest vague but one misleading (about 60% right
at the start); the auditor judged
their wording and rules finished. The owner then looked at the Notifications tab and asked what could be done there in
the product's style ("focusing on simplicity, and low noise and only give the important info first"). The coordinator
proposed rows that lead with the event and when it matters, and the tab in Today, Coming up and Earlier; the owner:
"Yes, build both". As built (test-first):

- **The server supplies facts, the app composes the row** ("{status} {when}" over "{about}"); a notification with no
  clear event keeps today's row; Home's row is unchanged, since `summary` stays a normal summary.
- **One request for the summary and the event**, the summarize job's, from what a summary request sends.
- **Checks in the payment details' spirit:** a date only when written within a year of its message, or said relative to
  the message's date and agreeing; times only when written, a start before its end, never without a date.
- **Sections are the clients'** from `when.date` and the person's clock, so every client agrees by one rule written in
  the contract; the server stores and sends none.
- **Not now:** one row per parcel or appointment across mails and senders, a "needs you" mark, adding to a calendar.

Choices made in building it: a year either side for written dates (past events count; years-old or years-ahead dates
are a misreading); a relative word's date is one of two days, because the server keeps a message's time in UTC
without the sender's offset (UTC−12 to UTC+14), which is the honest width; "morgen" only in lower case, "mañana" not
after "la" or "esta", French "hier" left out (German and Dutch "here"); long weekday names only (short ones are words:
"do", "so"); field-by-field combining, so a later "Delivered" keeps the delivery window; no one-off flag, since a
notification without an event needs one by rule.


## 2026-11-19, the day each message was sent, and the server's date for a time

With events live on the owner's server (only about one notification in five with a `when`, a third all null), about
one in ten lost a time to `no_date`, most an end time too: the request gave the model the messages' text but not when each was sent, so "today,
3–6 pm" had no date to resolve to. The coordinator's decisions, built test-first:

- **Each message carries its day sent**, `"sent": "Thursday 2026-11-19"` (weekday in English, ISO date) between
  `from` and `text`, **in the server's own time zone** (the person's machine or their chosen host; a host without one is
  UTC). Summarize, payment details and event requests only; categorize gets no date. Core's disclosure names it.
- **The server supplies the date** when an answer has a time (or a window) but no date and the message that writes the
  time also has a relative-day word: that message's day in the server's zone, moved by the word. No word: still
  dropped. The model's own dates are still checked against both possible days.
- **Payment requests get the dates too**; the due-date checks stay as they are (a due date must be written).
- **A one-off, new id** (`2026-11-19 event dates`): every notification not done with a status and no `when`
  asked once more; the answer only fills (`when` when it passes, `status` and `about` where null), never overwrites,
  and leaves the summary.

Choices made in building it: weekday names don't give the server's date ("on Monday" may lie before its message: the
check reads weekdays forward only, which is fine for accepting a model's date but not for supplying one); words that
disagree in the message ("not today: tomorrow") give none; the date also replaces a model's date that failed its
check; the one-off shares the payment details' marker and flag (`details_asked_again` in build order, `payment_again`)
so there is no migration; the instructions say "each with the day it was sent" (events, details) and that an event's
date may be "relative to the day its message was sent", while the summary's wording is unchanged.

## 2026-11-19, notification events after their audit

The message-dates build ran on the owner's server: notifications with a `when` more than doubled and Today's rows
more than tripled (with the delivery windows), no failures. The auditor then judged over a hundred notification rows:
about 60% right, a quarter right but vague, one in six misleading. Every date it checked was right against its
message's sent day; the problems were how `status` relates to `when` (a dozen or so rows read "Dispatched" with an
arrival day; a few had a relative word in the status), deadlines (the
worst miss: a contract change needing consent by a date, all null), a moment taken from beside the event (a limit's
reset time on a "75% used" alert), times marked UTC shown as local (build notices and limit alerts), and an
`about` cut to a place. The coordinator's decisions, built test-first in one round:

- **A status names what happens at its date**, never with a relative word; a small preferred list (deliveries,
  appointments and bookings, accounts) as examples, not a closed list; a dispatch notice with an arrival day is
  "Arriving". Server guards by rule: a dispatch word with a date after the newest message's day becomes "Arriving";
  a relative word is taken out when a phrase is left, else the status is dropped.
- **`when` is the event's own moment**, not a neighbouring one; said in the wording.
- **Deadlines are events:** the status names what is needed, the date is the deadline. The server also accepts "in"
  or "within" N days from the day sent (both possible days), in the matcher's seven languages, and a day and month
  written without a year.
- **Times marked UTC, GMT or "Z" are converted** to the server's time zone on the event's date (built: conversion;
  a time with another UTC offset is dropped and the date kept).
- **`about` keeps the sender's name** when taking it out would leave a single word or a place.
- **Not now** (improvement-ideas.md): windows that span two days; one row per parcel or appointment.
- **A one-off, new id** (`2026-11-19 event audit`): every notification not done asked once more; status
  and `when` taken together when the answer gives a status, `about` when it passes, else kept; an unusable or empty
  answer keeps the old event; the summary is left alone.

Choices made in building it: the year-less bound is 92 days before the message (a notification tells of the recent
past far more than of months ago, and deadlines rarely lie more than nine months ahead), year-less dates day first
only ("dd/mm", never a US month first), the dot after the month required in "dd.mm." (so a time like "05.12" isn't
one); "in N days" in digits only and each language with its own words (no "over 3 days" in English); relative words
taken out of a status in English only, "by" and "until" kept ("Pick up by"); a UTC offset other than zero isn't read,
since "GMT+1" is written with both signs; a time written both marked and plain counts as UTC; a converted window
whose end lands on another day loses the end; "Arriving" compares with the newest message's day in the server's zone;
the one-off replaces the day's earlier "event dates" one and shares its marker in build order, so no migration;
`event.ts` split into dates, times and lines modules. Mail joining still combines field by field (known issue).

## 2026-11-19, notification groups

The audit round ran on the owner's server: every notification asked, none failed; no "Dispatched" with a later day
(the model writes "Arriving" itself), no status with "today" or "tomorrow"; a status on about 70%, a `when` on about
half; Coming up now holds the deadlines; some UTC times converted, some offset times dropped. What still read wrong on screen: one parcel was
three rows in Today (arriving, out for delivery, delivered, each its own thread), and a moved appointment showed its
old "confirmed" row beside "moved". Asked "Build one row per parcel or appointment next?", **the owner answered "Yes,
build it"**. The coordinator's decisions, built test-first (server side; the clients collapse):

- **`event.group`**, an opaque string, equal for one inbox's notification threads about the same thing; clients only
  compare it. The contract says how a client shows a group (the newest mail's thread, the others behind it, unread if
  any is, an action on the row for every thread).
- **Found by a reference the mail prints** (asked as `reference`; kept only when written in the text and shaped like
  one; a hash of inbox, sender domain and reference), **else for an appointment by its subject and day**, else none.
  The reference is never served or stored.
- **Over-grouping is worse than a duplicate row:** more than 8 threads, or (for a reference) more than 60 days apart,
  and all of them lose the group.
- **Mail joining takes a status with its moment** (the open question of the audit round answered yes), `about` and the
  reference kept when the answer has none.
- **A one-off** (`2026-11-19 event groups`): every notification not done asked once more, only the reference taken.
- **Not now:** a shop's and a carrier's mails, an appointment moved to another day, grouping receipts or newsletters.

Choices made in building it: the reference's checks (5 to 40 letters and digits, a digit, no link, phone, amount or
date, written with separators and case aside, not inside a longer run) and a label taken off before it ("Order",
"Sendungsnummer"), so mails with and without a label join; the sender is counted as the payment details count it
(registrable domain, a whole address at a free mailbox; a payment service by its domain); "appointment-like" by the
words appointment, reservation and booking in the status (no new model field); the 60-day span only for references,
since an appointment's key holds its day and may be booked months ahead; the key a 24-hex SHA-256 prefix with "r" or
"a", kept server-side in `threads.event_key` (migration 0017) so a group can be re-checked without the reference;
the group written into the stored event only when not null, so events without one look as before; the one-off keeps
an event exactly as stored and gives an unusable answer's appointment a key from what is stored.

## 2026-11-19, groups by moment, after the audit of the groups

The grouping and snippet bundle ran on the owner's server: about a third of the notifications got a group, a dozen
groups joining two or three threads, no over-grouping, Today's rows about halved, Home down to its conversations,
every snippet remade, no failures. The auditor judged every multi-thread group right, nothing in any group that
doesn't belong, no per-mail id used as a reference; for the dated notifications about 92% right, a few vague, a few
misleading (about half right before). What was left: things still apart, several sets of one appointment or event told in differently worded mails, and one
usage alert showing its limit's reset time as its moment, unconverted. The coordinator's decisions, built test-first,
by rule only:

- **Join by sender and moment** whatever the status or `about` says, for threads without a reference group; the
  reference rule first; the 8-thread guard stays. Applied to every event as it is made, and once to what is stored.
- **A limit's reset time is not its moment**; and the time reader fixed for the form that slipped.
- **Not now** (improvement-ideas.md): a shop's mail printing a carrier's number, an order
  told by two numbers, a package of two orders, a subscription number as a reference.

Choices made in building it: precedence reference, then moment; a moment is the date with a time still ahead of the
mail, or an appointment's subject, and two moments are the same at the same upcoming minute or as two appointments
about the same thing that day, so a reminder joins its confirmation and a move joins both (a plain "time first" would
have split the confirmation from its move, the owner's earlier complaint); "upcoming" rather than a status-family
exclusion, because builds, sign-ins and payments report a past minute while appointments, meetups and deliveries
announce a future one, and two builds at one minute must stay apart while two reminders needn't; an event takes the
key most of its sender's same-moment notifications have (one key per thread, no merging of sets); the time reader now
reads fractions of seconds, numeric zero offsets after seconds and a mark before the time (the stored mail wasn't read
here, so which of these the alert used is not confirmed), and hyphen windows; the reset rule for limit statuses only,
dropping the date too unless it is the mail's own day, and the stored thread fixed by the same pass, from its stored
text. No migration (the pass shares the rule-pass marker after the snippets').
