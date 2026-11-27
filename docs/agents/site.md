# Site (`site/`)

Usual Mail's static website for `mail.usual.dev`: a landing page, a privacy policy and terms of service. Built on
2026-11-19 because Google's console needs an application home page, a privacy policy and terms on an authorized domain
(`usual.dev`) before the Google OAuth client (External, `gmail.modify` only) can move from Testing to In production,
and Google's reviewers read them. The folder's own [README](../../site/README.md) and [AGENTS](../../site/AGENTS.md)
hold the files, preview, deploy, design and copy rules.

## What is implemented

- **A Cloudflare Worker with static assets** (`site/wrangler.jsonc`: `usual-mail-site`, compatibility date
  2026-11-01, assets `./public`, custom domain `mail.usual.dev`), the same shape as the workspace's `usual.dev` site.
  It pins no Cloudflare account: when the deployer's Wrangler login sees several, `CLOUDFLARE_ACCOUNT_ID` picks the
  one that holds `usual.dev` (the folder's README, "Deploy").
  No JavaScript at all: `public/_headers` sends a CSP with `script-src 'none'` and only the site's own sources, plus
  `nosniff`, a referrer policy, a permissions policy and HSTS; fonts are cached for a year, pictures for a week.
- **The landing page** (`public/index.html`): the Mac app's look. The wallpaper as two layers (sky, and the hills
  and tree cut out, made by `site/scripts/layers.sh` from the app's `wallpaper.jpg`), so the sky drifts slowly behind
  the hills; Liquid-Glass-like controls and frosted cards in CSS; the Prociono wordmark and Geist. It says what Usual
  Mail is in the README's words, then shows the app drawn in HTML with made-up mail: the rail, the tabs, and the
  700-wide card, whose places (Home, Feed, Receipts, Notifications, Screening) switch with radio inputs and CSS. Then
  what it does today, how it uses Gmail (`gmail.modify`, what it reads, writes and sends, how access stops), where it
  stands (early, nothing to download, IMAP not ready for real mail, Outlook and iPhone later), and a footer with the
  privacy policy, the terms, a contact address and Google's Limited Use statement.
- **The privacy policy** (`public/privacy/`, effective 2026-11-19): who makes it, that each person runs their own
  server and nothing reaches the maker; the Google data read and written with `gmail.modify`; its uses (shown,
  synced, sorted, labelled, summed up, screened, sent) and what it is never used for (ads, selling, profiles, credit,
  training generalized AI models); what is stored on the server (the refresh token sealed with AES-256-GCM); what
  leaves the server, word for word from [contract-ai.md](../contract-ai.md) ("What leaves the server"), the pictures
  and avatars contracts and the optional agent connector; who can read mail; keeping and deleting (removing an inbox
  deletes its copy and asks Google to revoke; revoking in the Google Account); security; the website itself
  (no cookies or scripts, served by Cloudflare); children; changes; contact.
- **The terms** (`public/terms/`): early software provided as is, the person's own server and AI costs, Gmail under
  Google's terms, fair use, no warranty, liability, privacy, changes, contact.
- **Who and where:** the maker is Nestor Code Crafters UG (each footer, the privacy policy's "Who we are", the terms'
  first paragraph) and the contact `hello@usual.dev` (each footer, the privacy policy's "Who we are" and "Contact",
  the terms' "Contact"), the owner's values of 2026-11-19. Each footer credits the fonts, the icons and the wallpaper
  ("Wallpaper: Unsplash", the owner's word). The photo's page has been known since 2026-11-24
  (`THIRD_PARTY_NOTICES.md`); the deployed footers don't link it yet (improvement-ideas.md).

## Deployed (2026-11-19)

`npx wrangler@4 deploy` from `site/` (Wrangler 4.157.0), into the account that holds the `usual.dev` zone. The first
run uploaded the 34 files and the Worker, then failed attaching the domain with 10007 ("This Worker does not exist on
your account"), a race with the Worker it had just made; the same command again finished it, with the
custom domain `mail.usual.dev`. Checked with curl the same evening: `/`,
`/privacy/` and `/terms/` 200 and byte for byte the local files (`/privacy` redirects to `/privacy/`, an unknown path is
404); every file in `img/`, `fonts/`, `assets/` and the icons 200 with the right type; the CSP, HSTS, `nosniff`, referrer
and permissions policies on the pages, a year's immutable caching on fonts, a week on pictures, revalidation on HTML
and CSS; brotli; no `Set-Cookie`; the links to Google's policy, terms and account page 200. **Plain `http://` is served,
not redirected** (the zone has no "Always Use HTTPS"; usual.dev behaves the same); Google is given the https
addresses. Turning that on is a zone setting for the owner.

## Checked (2026-11-19, this Mac)

- Structure of the three pages with a local parser (balanced tags, unique ids, every `for`, `aria-labelledby`, `#`
  link and `<use>` target present, every local link and picture present, no script or event handler, every `<img>`
  with `alt`); `xmllint --html` reports nothing but HTML5 element names it doesn't know. An `npx html-validate` run
  was refused by this session's permissions, so no full HTML5 validator has run.
- The static look with Quick Look (WebKit), animations off, light and dark: each page at about 1,000 px, the landing
  page at 1440 × 900 and 390 × 844 and each of the drawn app's five places, through scratch `iframe`s. Contrast fixes
  came from it: the hills sit lower (`--hills-y`), a mist at the horizon and a halo behind the hero's text in light
  mode, an opaque wordmark suffix.
- Weight: the landing page is about 150 KB on a 1280-wide screen, 190 KB at 1920, 245 KB at 2560 (AVIF) and 180 to
  280 KB on a phone, fonts (about 100 KB) included; text gzipped is 17 KB.
- `npx wrangler@4 deploy --dry-run` (Wrangler 4.157.0) read the assets and exited without errors.
- `scripts/layers.sh` reproduced all 20 wallpaper layers byte for byte.

## Not verified

- No browser: the animations, the CSS-only tab switch, hover, focus rings, `prefers-reduced-motion`,
  `prefers-reduced-transparency` and scroll-driven reveals were never seen running.
- Google's review: on 2026-11-20 the owner's OAuth client's Branding page was given the three https links and the
  authorized domain `usual.dev`, and the client was pushed to In production, unverified (Google then shows "Your
  app requires verification"; no review was submitted). Search Console and DNS were left alone. The owner then
  connected a second Google account from the Mac app, unverified, and it worked.
