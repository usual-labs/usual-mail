# mail.usual.dev

Usual Mail's static website: the landing page, the privacy policy and the terms. Read [README.md](README.md) first: it
covers the files, preview, deployment, design and copy. The project's note is
[../docs/agents/site.md](../docs/agents/site.md).

## Working here

- Hand-written HTML and CSS in `public/`: no build step, framework, JavaScript, analytics or third-party requests. The
  CSP in `public/_headers` blocks every script and any other site; change it together with the pages. Inline `style`
  attributes are allowed (the motion's `--i`), inline scripts and event handlers are not.
- Colours are tokens on `:root` in `assets/base.css`, redefined for dark mode; add a new colour to both. The drawn app
  in `assets/app.css` keeps the Mac app's own light colours.
- Keep each file under about 500 lines; split by responsibility, as the four stylesheets are.
- **Copy is a promise to Google and to readers.** The pages say only what the code and docs say today. Check
  `../README.md`, `../docs/contract-ai.md` ("What leaves the server"), `../docs/contract-sync.md`,
  `../docs/contract-pictures.md`, `../docs/contract-avatars.md` and `../docs/self-hosting.md` before changing a claim,
  and update the privacy policy when the server reads, stores or sends something new. Made-up names and addresses
  only; addresses end in `.example`. No download button or repository link until they exist.
- Pictures come from the Mac app's wallpaper through `scripts/layers.sh`; check every result by eye.
- Don't test in a browser unless asked. For a static look, copy `public/` to a scratch folder, make the root paths
  relative (`/assets/`, `/fonts/`, `/img/`, and `url('/fonts/` in `base.css`), add a style that turns animations and
  transitions off, and run `qlmanage -t -s 1400 -o <dir> index.html` (WebKit, about 1,000 px wide, the system's
  appearance). For a phone or a desktop size, render a scratch page holding the page in an `iframe` of that size.
- Deploying changes a public site: only when the maintainer asks. The first deploy of a new Worker can upload and
  then fail with "This Worker does not exist on your account" (10007) while attaching the domain; running the same
  deploy again finishes it. After `npx wrangler@4 deploy`, check
  `https://mail.usual.dev/`, `/privacy/`, `/terms/`, the assets and the headers with curl. A Mac that looked the name up
  before its record existed can cache the miss; use `curl --resolve mail.usual.dev:443:<ip>` with an address from
  `dig @<the zone's Cloudflare nameserver> mail.usual.dev`.

## Status

Live since 19 November 2026 as the Cloudflare Worker `usual-mail-site` on the custom domain `mail.usual.dev`
(version `653f0eaf-fd4d-4f9c-b452-db872ab79fb3`), in the account that holds the `usual.dev` zone. The pages name
Nestor Code Crafters UG as the maker and `hello@usual.dev` as the contact. Plain `http://` is served, not redirected:
the zone has no "Always Use HTTPS"; the pages send HSTS once visited over HTTPS.
