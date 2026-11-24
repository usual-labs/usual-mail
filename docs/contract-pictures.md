# Pictures from the web

How the server shows the pictures a message's HTML takes from the web: through itself, with tracking pictures taken
out first, and held back for senders who aren't let in. Part of [the contract](contract.md); the shapes are in
`core/src/pictures.ts` (`RemotePictures`, `picturePath`, `MAX_PICTURES_PER_MESSAGE`, `MAX_SHOWN_HTML_LENGTH`) and
`Message.htmlTooLarge`, and the route in `core/src/api.ts` (`picture`).

The owner's decision of 2026-11-18: load pictures through the server and take tracking pictures out, as HEY does.
Revised the same day after two rounds of security review.

- **A message's `html` loads nothing from the web by itself.** Each time the server serves a message (`thread`, the
  triage queue), it writes the HTML it stored again: each picture from the web (an `<img>`'s `src`, a table part's
  `background`, an address in a style attribute or a style block: `url()`, `src()`, and the strings of `image-set()`,
  `image()` and `cross-fade()`, nested or not) points at the picture route, `picturePath(message, picture)`
  (`/v1/messages/<message id>/pictures/<picture id>` under the server's root), or is left out. CSS is read as a
  browser reads it: comment markers inside strings are text, a `)` inside a string doesn't end a function, a newline
  ends a string. Fonts from the web are taken out. `cid:` and `data:` pictures stay as they are, except **SVG, which
  is never shown, `data:` ones included**. Read token by token, **a CSS declaration is dropped** when its name isn't
  a plain name (`^(--)?-?[A-Za-z_][\w-]*$`), when it is broken in a way that could hide something, when it loads
  more than 100 addresses, when an address it loads isn't a picture path, `cid:` or a non-SVG `data:` picture, or
  when any string in it names the web ("http:", "https:", "//"), since a custom property can hand a string to
  `image-set()`. Escapes elsewhere are fine (a bullet in `content`, an icon font's glyph, a font's name). A whole
  style attribute or style block is read once more after that, and goes if it still would load anything; rules
  nested deeper than 16 drop their block. The sanitizer that stores mail holds the same names, depth and whole
  re-read, so stored HTML (what agents and any client get) is as strict about what it may load.
- **Trackers go before anything is fetched:** a picture whose address is on the server's list of trackers
  (MailTrackerBlocker's list, shipped with the server), and an `<img>` declared at most 1×1 or hidden by its own
  style. Such an `<img>` goes whole, alt text and all; a tracker in CSS becomes `none`.
- **Held back until the sender is let in:** while a thread is screened, or its sender (or the address a message
  says it is from) is blocked, no picture of any of its messages is shown, the inbox's own included; an `<img>`
  keeps its place and alt text without an address. Letting the sender in shows them. A blocked sender's message in
  someone else's thread, which isn't shown, is held back too. A forged "From: <the inbox's own address>" is no
  exemption: such mail isn't the inbox's own ([contract.md](contract.md), "The mailbox's own mail").
- **At most 100 pictures** of a message are shown (`MAX_PICTURES_PER_MESSAGE`), and at most 300 different addresses
  are looked at; any further ones are left out, unfetched.
- **HTML longer than 1,000,000 characters** (`MAX_SHOWN_HTML_LENGTH`, about ten times Gmail's own clipping size)
  isn't shown: the message comes without `html`, with `htmlTooLarge: true`, and its `text` stands for it. It shows
  no pictures. So one huge mail can't hold the server up. A message the picture pass fails on (it shouldn't) is
  served the same way without the flag, and the server logs a reason code; it never fails the thread or a list.
- **Written once per state:** the served HTML is kept with its plan (per message, held-back state and HTML; at most
  200 messages and 24,000,000 characters, counting the served HTML and the addresses plans hold: twenty messages of
  the largest HTML shown fit), so viewing a thread again, or asking for its pictures, writes nothing again. Beyond
  that the least recently served are written again when next viewed.
- **`Message.remotePictures`** says what was done: `shown`, `trackersRemoved` (each address once; a tiny picture
  named as a spacer goes without being counted), `trackers` (the list's names for the trackers it knew) and
  `heldBack` (`screened` or `blocked`, when pictures that would show were held back). It is absent when the HTML
  takes nothing from the web.
- **The picture route** (`GET /v1/messages/:id/pictures/:pictureId`, a person's device only: an agent gets
  `needs_person`) answers only a picture that message's HTML shows as it is served now. Anything else (a tracker's
  id, a held-back picture's, another message's, an id no picture has) is `not_found`, so the server fetches only
  pictures that appear in mail it holds, never an address a caller gives it.
- **Fetched when first asked for, then kept:** the server fetches a picture the first time a person's device asks
  for it and keeps it for that inbox, whatever the site's caching headers say; later views, from any device, come
  from what it kept. Nothing is fetched ahead of time. Removing an inbox deletes what it kept.
- **What is fetched, and how:** http or https on ports 80 and 443 only; from public addresses only (never the
  server itself, an address in a network of the server's own interfaces (a global IPv6 address's whole /64; a
  prefix shorter than /16 for IPv4 or /32 for IPv6 counts as the address's /24 or /64), the person's network, a
  link-local or cloud metadata address); each name asked of DNS servers once (not the hosts file) within the time
  limit, and the
  connection made to the address checked; every redirect checked again, at most three; a new connection each time; no
  cookies, no referrer and a common browser's user agent; at most 10 MB and 15 seconds, the name's lookup included.
  Only PNG, JPEG, GIF, WebP and AVIF are served, with the type read from the bytes, and only when read whole; SVG and
  anything else are refused, and so is a picture of more than 20,000 pixels a side or 40 million in all, judged by
  the size a decoder uses (every GIF frame, every AVIF image size); a GIF may end without its trailer when its last
  block ends where the data ends; AVIF image sequences are refused. A picture of at most 2×2 pixels is served blank.
  **On Cloudflare** (the server as a Worker) the same rules hold except where a Worker can't keep them: each name is
  asked of Cloudflare's resolver over HTTPS and every address it gives is checked, but the connection can't be pinned
  to the address checked (a name rebound between the check and the fetch isn't caught). There is no network of the
  server's own to keep out; instead the server itself is never asked, by any of its host names (the one a request
  came to, its workers.dev address once a request has come to it, `USUAL_MAIL_PUBLIC_URL`'s), as a failure that may
  pass. An IP address written in a picture's address is refused for good and served blank, a public one too, because
  Cloudflare's documentation says a Worker can't fetch a bare IP address (unverified on Cloudflare itself). An answer
  in gzip or br is taken, its 10 MB counted on the decoded bytes; any other encoding is refused.
- **A picture the rules or its content refuse** (an address the mail itself names in a special range, or on
  Cloudflare any IP address it names, a port or scheme never used, something that isn't a picture the server shows,
  too large) **is served blank** (200, a 1×1
  transparent GIF) and remembered: its site isn't asked again. A refusal that depends on where the server runs
  rather than on the sender (a name the DNS answers with a private address, an address in the server's own
  networks, on Cloudflare one of the server's own host names) is treated as a failure, below.
- **A picture whose site fails** (no answer, an error status) answers `provider_error` (502) with the reason in a
  person's words, for example "The picture couldn't be loaded: its site answered 404"; an app shows the picture's alt
  text, as a page shows a missing picture. The server tries such a picture at most three times: when first asked
  for, again after ten minutes, a last time after a day; then it keeps it as failed. These records of refusals and
  failures are kept apart from the pictures, outside the 256 MB they may fill (at most 50,000, a year unserved), so
  filling the cache can't make them asked again. A server without pictures from the web (demo mode) answers
  `not_found`.
- **What it hides, and what it doesn't:** the device that asks (its address away from the server's network, its
  browser, its cookies) and every opening after the first, except that a failing picture is asked for up to three
  times, and that **a picture once shown but pushed out of the 256 MB it keeps is fetched again** when its message is
  next opened. Not that a message was opened, and when, if a picture's address is unique to the person and isn't on
  the list; and the site sees the server's address, which for a server at home is the person's home address (on
  Cloudflare, a Cloudflare address, with a `CF-Worker` header naming the Worker's zone, which for a workers.dev address
  may name the account's subdomain: unverified). **A router in front of the server has a public IPv4 address the
  server can't see from inside**, so a picture at that
  address isn't refused as the server's own network. SVG is never shown. Whether a browser lets `image-set(attr(title))`
  turn an attribute into an address hasn't been checked in WebKit; the page's policy loads nothing but the server's
  paths either way ([agents/known-issues.md](agents/known-issues.md), "What pictures through the server don't hide").
