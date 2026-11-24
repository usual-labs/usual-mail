# Design

`design/` holds Usual Mail's design values. One file, `design/tokens.json`, generates the web styles and the Swift
values. The fonts and icons ship with them. Design is shared as values, not code: each platform uses its own
controls, and the web uses solid surfaces in the same palette instead of Apple's glass.

**The look has not been checked by eye.** Nothing here was opened in a browser, simulator or device. The checks are
builds, tests and computed contrast.

## Implemented

| Path | What it is |
|---|---|
| `tokens.json` | The one source: colours (light and dark), the hat palette, font families and weights, type roles, space, radii, sizes, elevation, motion |
| `icons.json` | The 47 icons Usual Mail uses, each mapped to a Hugeicons free-set name |
| `fonts/` | Prociono Regular and its licence, copied from `usual.dev/public/fonts` (same bytes) |
| `scripts/build.mjs`, `scripts/lib/` | The generator: reads the two lists and writes everything below |
| `dist/web/` | Generated: `tokens.css`, `fonts.css`, `fonts/` (WOFF2, Prociono TTF, licences), `icons.svg`, `icons-LICENSE.md` |
| `swift/` | The Swift package `UsualMailDesign` (macOS 26, iOS 26). `Generated/` and `Resources/` are written by the generator; the rest is hand-written |
| `specs/` | The four pieces: `hat.md`, `brief-card.md`, `pile-row.md`, `reason-line.md` |
| `gallery/index.html` | Generated: the HTML gallery |
| `test/` | Node tests for the generator, contrast, icons, tokens and the gallery |

The galleries show the colours, the hats, the type roles, space and radii, the icons, and the four pieces, using
`core/fixtures/sample.json` (the contract's fifth revision): each sample inbox with its icon beside its hat, rows
whose line under the subject is the thread's summary or, while it has none, its snippet, rows covering a screened
thread and a one-time code, brief counts by category ("Newsletters 1 · Receipts 1 · Done 1"; no counts line when
there are none), and reason lines from a rule, a proposal, the server's AI ("Usual Mail's AI put it in Invoices"),
an agent, an undone record and the person. The HTML gallery is `design/gallery/index.html`; the SwiftUI one is
`GalleryView` with two previews. The pieces are shown in light and dark side by side. The generator writes every
label for both, so they show the same words. Times are in UTC.

- **Words** (`scripts/lib/sample.mjs`): the categories as lists name them (Conversations, Newsletters, Invoices,
  Receipts, Notifications, One-time codes, Not sorted yet); `categorize` is "put it in Newsletters" or "wants to put
  it in Newsletters"; the server's AI is "Usual Mail's AI" and takes the `inboxes` icon (Usual Mail's own), since
  there is no AI icon. A thread or record id the gallery shows that the sample no longer has stops the build with its
  id named.
- **The inline sprite** at the top of the HTML gallery takes no space: it has `width="0"`, `height="0"` and the class
  `sprite` (`position: absolute`, zero size, `overflow: hidden`). Before, it had only `hidden`, which an `svg` in HTML
  ignores, so it drew an empty 300 by 150 box, seen as a blank band when the gallery was first opened in a browser.

## Regenerate and check

```sh
cd design
npm ci                 # geist 1.9.2 and @hugeicons/core-free-icons 4.4.0, exact
npm run build          # write what changed, remove stale generated files
npm run check          # fails if any generated file is out of date, then runs the Node tests
npm run check:swift    # swift build && swift test in design/swift (macOS)
npm run check:ios      # xcodebuild for generic/platform=iOS, no signing, no simulator
```

- The generator owns `dist/`, `swift/Sources/UsualMailDesign/Generated/`, `swift/Sources/UsualMailDesign/Resources/`
  and `gallery/`. A file there that it didn't write is stale: `check` fails and `build` deletes it.
- Generated files are checked in. The root `.gitignore` ignores every `dist/`, so `design/.gitignore` re-includes
  `design/dist`.
- The build reads `../core/fixtures/sample.json` for the galleries. A change to the fixture makes `check` fail until
  `npm run build` runs.

## Tokens

- **Format:** Design Tokens Format Module 2025.10 (stable, 28 October 2025). Types used: `color` (sRGB, with
  `components` and a required `hex` that must agree), `dimension` (px), `duration` (ms), `cubicBezier`,
  `fontFamily`, `fontWeight`, `typography`, `shadow`. References use `{group.token}`. `scripts/lib/tokens.mjs`
  checks this subset; it doesn't implement `$ref`, `$extends` or the Resolver module.
- **Light and dark in one file:** `$value` is light. `$extensions["dev.usual.mail"].dark` is dark. The format's
  Resolver module would split the modes into separate files; one file was asked for.
- **Other extensions,** all under `dev.usual.mail`: `reducedMotion` on durations, `appleTextStyle` (the iPhone
  text style a role grows like, or null to stay fixed) and `iphone.fontSize` on type roles.
- **Editing a colour:** change `hex` and `components` together. The error message gives the components for a hex.

### Names

| Token | CSS | Swift |
|---|---|---|
| `color.line-strong` | `--color-line-strong` | `UsualColor.lineStrong` |
| `color.hat.blue.fill` | `--color-hat-blue-fill`; `--hat-fill` inside `data-hat="blue"` | `UsualHat.blue.fillColor` |
| `type.body` | `--type-body` (font shorthand), `--type-body-size`, `-line-height`, `-tracking`, `-weight`, `-family` | `.usualFont(.body)`, `UsualTextRole.body.style` |
| `space.16` | `--space-16` | `UsualSpace.s16` |
| `radius.lg` | `--radius-lg` | `UsualRadius.lg` |
| `size.icon-sm` | `--size-icon-sm` | `UsualSize.iconSm` |
| `elevation.raised` | `--elevation-raised` | none (see below) |
| `motion.duration.base`, `motion.easing.standard` | `--motion-duration-base`, `--motion-easing-standard` | `UsualDuration.base`, `UsualEasing.standard` |
| icon `reply-later` | `#icon-reply-later` in `icons.svg` | `UsualIcon.replyLater` |

## Using the web output

- Link `dist/web/fonts.css` and `dist/web/tokens.css`. Colours follow the reader's light or dark setting.
  `data-theme="light"` or `"dark"` on any element fixes the appearance for everything inside it.
- Type sizes are rem, so they follow the browser's text size. Set `font: var(--type-label)` and
  `letter-spacing: var(--type-label-tracking)`. Set `font-synthesis: none` where the serif is used.
- `data-hat="<name>"` sets `--hat-fill`, `--hat-on` and `--hat-tint` for everything inside.
- Under `prefers-reduced-motion: reduce`, the fast, base and slow durations become `0ms`; `fade` stays.
- **Inbox icons** (`Inbox.icon`): `person` (UserIcon, also "you" as an actor), `building` (BuildingIcon),
  `briefcase` (Briefcase07Icon), `house` (House03Icon), `shop` (Store01Icon), `globe` (Globe02Icon). The last five
  are the ones the Mac app's design draws (`apps/` ships its own copies at 16 points); the Mac app draws `person` as
  Male02Icon, which the design system doesn't have. Swift: `UsualIcon.building` and so on.
- **Icons are one sprite,** `dist/web/icons.svg`: `<svg><use href="icons.svg#icon-now"/></svg>`. One request, one
  cached file, and the icons take `currentColor`. Individual files would need a request each, and an `<img>` can't
  take the text colour. A page opened from `file://` can't reach an external sprite in Chromium, so the gallery
  inlines the same symbols.
- Serve `design/` over HTTP to see the gallery's fonts. Some browsers refuse fonts from `file://` URLs in another
  folder.

## Using the Swift package

- Depend on it by path: `.package(path: "../design/swift")`, product `UsualMailDesign`.
- **Colours:** `UsualColor.ink` and the rest follow the system appearance and SwiftUI's `colorScheme`.
- **Hats:** `UsualHat.matching(hex: inbox.color)` picks the hat whose light fill is nearest in OKLab, the same
  maths as the web. A test checks both sides agree on the fixture's colours.
- **Type:** `.usualFont(.reading)` sets the font, tracking and line height (`lineHeight(.exact(points:))`). On
  iPhone and iPad the size starts at the role's `iphone` size and grows with the text size setting like its
  `appleTextStyle`, through `UIFontMetrics`. On the Mac it stays fixed. `weight:` changes Geist Sans only; the
  serif and Prociono have one weight, so they are never drawn bold.
- **Fonts** are bundled in `Resources/Fonts` and register with Core Text the first time `.usualFont` runs.
  `UsualFonts.register()` does it ahead of time. Geist Serif ships as WOFF2 because the npm package has no TTF;
  Core Text registers WOFF2 directly (tested on macOS).
- **Icons:** `UsualIcon.now.image` is a template image from `Icons.xcassets`, so it takes the foreground style.
  `swift build` (Swift Build) compiles the asset catalog; so does Xcode.
- **Space, radii, sizes and motion:** `UsualSpace`, `UsualRadius`, `UsualSize`, `UsualDuration`, `UsualEasing`.
  `.usualAnimation(_:value:)` turns movement off under Reduce Motion and keeps fades.
- **No elevation in Swift:** what floats uses the system's glass, and cards are solid with no shadow.
- `GalleryView` and the pieces inside it are reference renderings for the gallery, not components. They are
  internal except `GalleryView`. `GalleryRow.category` replaced `pile`, and `GalleryInbox` gained `icon`; both are
  internal, so `apps/` sees only the five new `UsualIcon` cases.

## Choices and why

- **A small generator, not Style Dictionary.** Style Dictionary 5 reads the format, but its Swift formats write
  UIKit `UIColor` values with no light and dark, and its CSS format has no media query plus attribute selector for
  modes. Fonts, the icon sprite and the asset catalog are outside it too. Custom formats for all of that would be
  most of this code plus a dependency tree. The generator is plain `.mjs` with no dependencies of its own.
- **Palette:** the family's monochrome tokens from Usual Base's `app.css`, with two changes found by the contrast
  test. `meta` is `#5f6b7b` in light, not `#6b7888`, which reads at 4.19:1 on the background. `success` is
  `#17774d` in light, not `#1f8a5b`, which reads at 4.33:1 on white. `attention` and its tint come from Usual Bot's
  "needs you" amber. `selected` is new.
- **Hats:** twelve hues (red, orange, amber, olive, green, teal, sky, blue, violet, plum, pink, slate) at even
  lightness in OKLCH: fill at L 0.515 in light and 0.77 in dark, tint at L 0.962 and 0.255. Light fills take white
  text, dark fills take near-black. Hues were picked to keep the closest pair apart in OKLab (0.065 in light,
  0.055 in dark). The fixture's three colours are not palette keys; they land on blue, green and orange.
- **Type:** display 34, title 26, heading 20 and reading 17 in Geist Serif; body 15, label 13 (medium) and caption
  12 in Geist Sans; mono 13 in the system monospace; the wordmark 22 in Prociono. iPhone sizes are a step larger
  for reading, body, label, caption and mono, as Usual Bot's chat text is. Geist Mono is in the package but was not
  decided, so mono is the system's.
- **Web fonts:** Geist Sans as the one variable WOFF2 (100 to 900). Prociono stays TTF, as on usual.dev, because
  there is no official WOFF2 and converting it needs a tool this repository doesn't have.
- **`legacy-peer-deps`:** `geist` names Next.js as a peer for its `next/font` helpers. Only its font files are used.

## Licences shipped

| What | Licence | Files |
|---|---|---|
| Geist Sans and Geist Serif (Vercel, `geist` 1.9.2) | SIL OFL 1.1 | `dist/web/fonts/Geist-OFL.txt`, `Resources/Fonts/Geist-OFL.txt` |
| Prociono (Barry Schwartz) | SIL OFL 1.1 | `dist/web/fonts/Prociono-OFL.txt`, `Resources/Fonts/Prociono-OFL.txt`, `fonts/Prociono-OFL.txt` |
| Hugeicons free set (`@hugeicons/core-free-icons` 4.4.0) | MIT | `dist/web/icons-LICENSE.md`, `Resources/Hugeicons-LICENSE.md` |

The Hugeicons paid set may not be redistributed. It is not installed, and a test fails if any other `@hugeicons/`
package appears in `package.json`.

## Checks (2026-11-16, this Mac: Node 22.23.2, Swift 6.4, Xcode 27.1)

- **After the review's decisions (2026-11-17):** the sample's threads gained `sender` and `categorizedByActor`, which
  the galleries don't draw; `npm run check`: all 104 generated files current (nothing to regenerate), 38 Node tests
  pass. Nothing in `design/` changed.

- **Fifth revision (2026-11-17):** `npm run build` wrote 14 files (the five new icons for the sprite and the asset
  catalog, `UsualIcon.swift`, `GallerySample.swift`, the gallery). `npm run check`: all 104 generated files current;
  38 Node tests pass (36 before; new: the sprite takes no space, each sample inbox's icon is drawn; the icon list now
  names the six inbox icons). `npm run check:swift`: 19 tests in 7 suites pass (the icon test ran for all 39 icons).
  `npm run check:ios`: build succeeded. Tokens and specs unchanged. The gallery's look wasn't checked by eye.
- Independent review of the fifth revision (2026-11-17): `npm run check` passed (104 generated files current, 38
  tests) and `npm run check:swift` passed (19 tests in 7 suites); `check:ios` and `build` weren't re-run.
- `npm run check`: all 94 generated files current; 36 Node tests pass.
- `swift build` and `swift test` in `design/swift`: 19 tests in 7 suites pass (the icon test runs once per icon).
  They cover font registration, every colour and hat resolving in light and dark, every icon resolving as a
  template, hat matching, fixed Mac sizes, reduced motion, and the gallery rendering with `ImageRenderer`.
- `xcodebuild` for `generic/platform=iOS` with `CODE_SIGNING_ALLOWED=NO`: build succeeded.
- Final review of the first milestone (2026-11-17), all four re-run: `npm run build` wrote nothing (94 files, 0
  written or removed); `npm run check` passed (94 current, 36 tests); `npm run check:swift` built and passed 19
  tests in 7 suites; `npm run check:ios` succeeded.

## Not done or not verified

- The look, in every form: neither gallery was viewed, and no screenshot was taken.
- iOS was built, not run. WOFF2 registration and Dynamic Type scaling on iPhone are unverified at run time.
- Firefox and Safari behaviour of the CSS (the `data-theme` scopes, the `font` shorthand with `var()`) is unverified.
- Hat names, icon choices (`now` is a sun, `rule` a mortarboard, trust levels are signal bars) and the type scale
  are first proposals waiting for the maintainer. The pile icons (`people`, `reads`, `receipts`, `screening`) and
  `now` keep their names and descriptions from the fourth revision; nothing in the design system names a category
  yet, and there is no icon for the server's AI or for the categories. Not changed this pass, by the coordinator's
  instruction: tokens and specs aren't being redesigned. `specs/pile-row.md` and `specs/reason-line.md` still speak
  of piles and moves.
- No JSON export of the tokens for JavaScript. A dashboard that needs to match a stored colour to a hat copies
  `matchHat` (`scripts/lib/sample.mjs`) and the OKLab helpers (`scripts/lib/color.mjs`), or asks for an export.
- No lint of the web pages against the tokens, and no automatic comparison of the two galleries.
- `tokens.json` is about 840 lines of data, over the 500-line guide. Splitting it would break the one source.

## Known issues

- **Resolving a `Color` built on a dynamic `NSColor` off the main thread hung** a Swift Testing test (the test
  never finished). The colour and gallery tests run `@MainActor`.
- **The root `.gitignore` ignores `dist/`.** `design/.gitignore` re-includes it; keep that file.
