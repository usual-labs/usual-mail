# mail.usual.dev

Usual Mail's small static website at [mail.usual.dev](https://mail.usual.dev): a landing page that says what Usual Mail
is, a privacy policy and terms of service. Google's console needs the three on an authorized domain (`usual.dev`)
before the Google OAuth client can move from Testing to In production, and Google's reviewers read them.

It has no build step, JavaScript, tracking, cookies or third-party requests; the fonts are self-hosted. Each page
follows the reader's light or dark appearance.

## Files

- `public/`: everything that is served, as is.
  - `index.html`: the landing page. The wallpaper, the wordmark and a line on what Usual Mail is; the Mac app drawn in
    HTML with made-up mail, whose tabs (Home, Feed, Receipts, Notifications, Screening) switch with radio inputs and
    CSS; what it does today; how it uses Gmail; where it stands; the footer with the Limited Use statement.
  - `privacy/index.html` and `terms/index.html`: the privacy policy and terms of service, effective 19 November 2026.
  - `assets/base.css` (every page: tokens, wallpaper, glass, header, footer, the policy pages), `home.css` (the
    landing page's hero and sections), `app.css` (the drawn app), `motion.css` (the landing page's motion).
  - `img/`: the wallpaper as two layers, `sky-*` (the hills and tree filled with sky) and `hills-*` (cut out), in
    AVIF and WebP, 1280, 1920 and 2560 wide, and a 3:4 crop (`p1080`, `p1620`) for tall screens.
  - `favicon.png` (64 × 64) and `apple-touch-icon.png` (180 × 180): the tree on its hill.
  - The wallpaper is a free photo from Unsplash under the Unsplash License, credited in each footer; its photo page is
    in the repository's `THIRD_PARTY_NOTICES.md`.
  - `fonts/`: Geist (variable WOFF2) for text and Prociono Regular for the wordmark, each with its SIL Open Font
    License; `icons-LICENSE.txt`: Hugeicons' MIT licence, for the icons inlined in `index.html`.
  - `_headers`: security headers (a Content-Security-Policy that allows no scripts and nothing from other sites, HSTS)
    and caching for fonts and pictures.
- `scripts/layers.sh`: makes `img/`, `favicon.png` and `apple-touch-icon.png` from the Mac app's wallpaper with
  ImageMagick 7 and `cwebp`. Run from this folder: `zsh scripts/layers.sh`.
- `wrangler.jsonc`: the Cloudflare Worker `usual-mail-site`, which serves `public/` as static assets on the custom
  domain `mail.usual.dev`.

## Preview

```sh
npx wrangler@4 dev
```

Opening `public/index.html` directly shows no fonts or pictures: the pages use root-relative paths.

## Deploy

```sh
npx wrangler@4 deploy
```

From this folder, with Wrangler signed in to the Cloudflare account that holds the `usual.dev` zone. `wrangler.jsonc`
pins no account, so when your login sees several accounts Wrangler asks which one to use, or stops when it can't ask.
Set `CLOUDFLARE_ACCOUNT_ID` to the account that holds the zone first:

```sh
CLOUDFLARE_ACCOUNT_ID=<the account's id> npx wrangler@4 deploy
```

It uploads `public/` and attaches `mail.usual.dev` as a custom domain; Cloudflare makes its DNS record and
certificate. There are no other environment variables, and no secrets or build output. To roll back,
`npx wrangler@4 rollback`, or pick an earlier version under Workers › usual-mail-site › Deployments.

## Design

The Mac app's look (`../docs/agents/apps.md`, `../docs/agents/design.md`): the full-bleed wallpaper of green hills
under a cloudy sky, frosted glass cards and round glass controls, the Prociono wordmark ("Usual" in ink, "mail" in
grey) and Geist for text. The drawn app keeps the app's own sizes and colours (the 700-wide card, the six avatar
colour pairs, "Sender - summary" lines) and stays light, as the app does; only its controls' ink turns light when the
page is dark.

- The hills sit lower than in the app (`--hills-y`), so the words have sky behind them; a light mist at the horizon
  keeps them readable over grass.
- Motion is CSS only: the hills rise and the page comes into focus, glass pops in, Home's items follow one another,
  a sheen crosses the card now and then, the sky drifts slowly behind the hills on screens 700 px and wider, and the
  sections rise as they scroll into view where the browser supports it. All of it is off under Reduce Motion.
- Glass blurs the wallpaper only if no ancestor animates `opacity` or `filter`: animate the glass element itself.
- Under Reduce Transparency the reading glass is nearly opaque.

## Copy

Say only what is true of Usual Mail today, from its README and docs: early, in development, nothing to download, no
hosted version. Names and addresses in the drawn app are made up (addresses end in `.example`). The privacy policy
follows `../docs/contract-ai.md` ("What leaves the server"), `contract-sync.md`, `contract-pictures.md`,
`contract-avatars.md` and `self-hosting.md`; change it when they change what the server reads, stores or sends.
