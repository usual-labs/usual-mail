# Decisions: pictures from the web, and which mail is whose

The decisions behind [pictures from the web](../contract-pictures.md) and the three security reviews that followed
them, which reached into what counts as the inbox's own mail and which stored message new mail is. The other
cross-part decisions are in [decisions.md](decisions.md).

## 2026-11-18, pictures from the web through the server

The Mac app held back every picture from the web until the person clicked "Show them" for that message. Shown the
options, the owner chose "Load through your server and strip tracking pixels (what HEY does)": "I like this idea lets
do this!" The design was researched first (HEY's, Gmail's and Apple's ways, open tracker lists and their licences, the
dangers of a server fetching addresses from mail); the coordinator decided its questions:

1. **Fetched when a message is first opened, then kept** (as HEY and Gmail do), not ahead of time on arrival (as
   Apple does): fetching every arriving mail's pictures would tell every sender, spammers included, that the address
   is live, and cost traffic for mail never read.
2. **Screened and blocked senders' pictures are held back** until the sender is let in: opening a stranger's mail to
   decide about it shouldn't tell them it was opened.
3. **The tracker list is MailTrackerBlocker's** (BSD-3-Clause; 320 trackers, 468 patterns at the pinned commit),
   generated with its licence by a script from a pinned version, kept swappable (any list in its shape). For now: it
   credits a HEY list of unknown licence, which the owner must accept before the repository is published
   (improvement-ideas.md; the fallback is Trocker's Apache-2.0 list plus the size rules).
4. **People's devices only:** an agent's token gets `needs_person` on the picture route, as on the other person-only
   routes, since an agent reading mail would otherwise tell senders "opened" for every message it reads.
5. **SVG is refused** (as HEY does): only PNG, JPEG, GIF, WebP and AVIF, typed by their bytes.
6. **No "ask before loading pictures" setting.** The bar goes from the app.

Also decided in the design, as built: the server writes the HTML again each time it serves a message (so every
client benefits, older mail too); a picture id is the SHA-256 of its address; at most 100 pictures a message; trackers
on the list and tiny or hidden pictures go before anything is fetched and are counted in `Message.remotePictures`
(spacers go uncounted); upstream caching headers are ignored, so a "no-store" can't turn each opening into a new
request; kept per inbox under `<data-dir>/pictures` (256 MB, 30 days unserved), deleted with the inbox; only public
addresses, the connection pinned to the address checked, ports 80 and 443, three redirects checked again, Apple
Mail's user agent and no cookies, referrer or compression, 10 MB and 15 seconds; a refusal is `provider_error` (502)
in a person's words. What this doesn't hide is in known-issues.md.

## 2026-11-18, pictures from the web after the security review

An independent review found three serious and five minor holes, and eight defences no test noticed. The
coordinator's decisions, as built (each fix began with a test that failed):

- **CSS is read as a browser reads it** (`mail/src/message/css-tokens.ts`), for stored mail and served mail alike,
  and the served pass drops any declaration still naming the web ("http:", "https:", "//"), holding a backslash, or
  loading anything but the server's picture paths, `cid:` and `data:` pictures. A last check over the whole style
  block catches anything outside declarations. Strict on purpose: some designed CSS is lost (known issues).
- **Plans are kept per message** (message id, held-back state, a hash of the HTML; 200 kept), at most 300 different
  addresses are looked at, and **HTML over 1,000,000 characters isn't shown** (`htmlTooLarge`, its text instead).
  The numbers: a sanitizer pass costs about 0.1 s a megabyte here (a 1 MB mail: about 0.2 s served first, 0.08 s
  after, 100 picture lookups 0.04 s in all; before, 0.5 s per lookup on 5 MB); Gmail clips mail at about 100 KB, so
  ten times that leaves real mail alone and bounds a hostile one.
- **Held back means every message of a screened or blocked thread, the inbox's own included.** The coordinator asked
  for the person's own mail to be told apart by the provider's evidence (Gmail's SENT label, IMAP's Sent folder);
  the server stores no such evidence per message, and holding the own mail back too costs a person almost nothing
  (their own pictures in a stranger's thread, until they let them in). So From exempts nothing, without a migration.
  The wider hole (From decides "outgoing" everywhere) is handed back with a proposal (known issues).
- **What can't be had is remembered** (on disk, as long as a picture): a refusal by the rules or for what it is is
  served blank and never asked again; a failure is tried at most three times (at once, after ten minutes, after a
  day), then kept as failed. A failing picture can so reveal up to three openings.
- **Names are asked of DNS servers** with `dns.Resolver` (2 s, 2 tries a query), within the fetch's 15 seconds; the
  hosts file and local names are no longer read.
- **Addresses inside a network of the server's own interfaces are refused** (read at each fetch), IPv6 and public
  ones included. A router's public IPv4 address in front of the server can't be seen and isn't covered.
- **Sizes as decoders use them:** every GIF frame where it sits (the GIF read to its end), every AVIF image size
  (its boxes read whole).
- **Removing an inbox marks it first**, and a picture written meanwhile is removed after; half-written files older
  than an hour are swept.
- **The service keeps `requirePerson`** (now tested on its own); **the separate check for a blocked sender's message
  in another's thread went**, as holding back covers it (and its test stays).

## 2026-11-18, pictures after the second security review, and "outgoing" from evidence only

The review's second round closed the round-one holes but found one leak, one slowdown and the From hole at its root.
The coordinator's decisions, as built (test-first):

- **"Outgoing" comes only from evidence** (closes contract question 78): Gmail's SENT label, IMAP's Sent folder, or a
  Message-ID the server itself sent from that inbox (a new table, kept 90 days). A From naming the inbox is a hint
  for nothing: such mail is screened like a stranger's, its pictures held, the AI reads it as the sender's words,
  and apps show its From. The inbox's own address is never let in by itself, only by `allow_sender`; migration 0009
  forgets it where earlier builds had let it in (at most one row per inbox), since otherwise every forgery would
  still pass. Mail stored earlier isn't re-derived: what is stored can't tell a forgery from a copy to self. Within a
  sync batch, a copy the provider says was sent goes first, so a copy of it in the inbox joins it.
- **Style declarations must have plain names**, and whole attributes and blocks are read again, stored and served:
  postcss let a string in a name run past a newline that a browser ends it at.
- **The served guard decides by tokens:** strings naming the web, non-servable addresses and SVG (`data:` too, the
  coordinator's decision) go; escapes elsewhere stay (bullets, icon glyphs, escaped font names).
- **One pass, at most 100 addresses a declaration, served HTML kept** with the plan (200 messages, 8,000,000
  characters; 24,000,000 with plans counted since the third review), so a message is written once per state. Rules nest at most 16 deep (stored and served); a failing
  rewrite serves the message as text and logs a reason code.
- **Refusal and failure records sit outside the 256 MB cap** (at most 50,000, a year unserved). A refusal that depends
  on where the server runs (a DNS answer that is private, an address in its own networks) follows the failure
  schedule; one the mail itself names (a private literal, a port, a scheme, the content) is final and served blank.
- **Own networks:** a global IPv6 address counts with its /64; a missing prefix means the address's /24 or /64;
  prefixes shorter than /16 (IPv4) or /32 (IPv6) count only as that neighbourhood, so a VPN's /0 can't make the
  internet local; only public interface addresses count (the loopback's ::1/128 widened to ::/64 had made every
  IPv4 address look local).
- **GIFs without a trailer are accepted** when their last block ends at the data's end; **AVIF sequences are refused**.


## 2026-11-18, which stored message new mail is, after the pictures' third security review

The third round found that a Message-ID alone let new mail change a stored message on IMAP, and that the server's
record of what it sent let in any copy with a known Message-ID. The coordinator's rules, as built (test-first):

- **A Message-ID alone never lets new mail change a stored message:** not its content, sender, `outgoing` or
  placement. The Message-ID match exists for IMAP only: another app moving a message (new UID), a UIDVALIDITY reset,
  and one message in INBOX and Sent at once. So the same message is its ref, or on IMAP the same Message-ID **and the
  same content** (From, To, Cc, subject, date, text, HTML, attachments; worked out from stored fields, so no column).
  Gmail ids never change, so on Gmail only the ref counts. Anything else is a separate message from its own From.
- **A copy recognised by content is a move only once the stored copy's ref is reported removed**, since anyone who
  received a message knows its content: in the same batch it takes the new ref and placement; otherwise it is held
  (a table, migration 0010, the one migration of this round) until that removal, then the move completes with its
  latest state. Decided after the fix's own probe showed an exact copy filed as spam trashing the thread. Providers
  must report every ref the server holds as removed when it goes; IMAP now does for refs its own moves gave. A Sent
  copy joining an inbox copy only makes it the inbox's own and works its thread's sender and screening out again
  (the stored copy stays the one placed); an inbox copy of a message stored as sent changes nothing.
- **The server's record of what it sent is the Message-ID with a hash** of the From, To, Cc, subject and text (since
  the fourth review also the HTML and attachments, which a text-only send has none of: a recipient could resend the
  person's words with HTML of their own and it was stored as "You"), kept in the same column (no migration for it; records from before match nothing, since their copies already
  synced). Bcc stays out of the hash (a Sent copy doesn't carry it), so a copy with a Bcc added still matches. A
  copy that matches lets nobody in: its recipients were let in when it was sent. Records go after 90 days, at a start.
- **The evidence-first order in a batch is kept** (decided against dropping it): within one sync a Cc-to-self copy
  would otherwise be stored first as a stranger's mail and end a come-back wait for someone else's reply.
- **The kept served HTML counts its plans** and is bounded at 24,000,000 characters (twenty messages of the largest
  HTML shown fit, so viewing them in turn doesn't rewrite each).
- **No Sent folder on IMAP:** the person's mail from other apps stays a stranger's; a per-inbox Sent-folder setting
  is proposed, not built (known-issues.md).
