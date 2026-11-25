# Decisions: the licence, the contributor agreement and going public

The licence and contributor agreement Usual Mail uses, the third-party notices, and the checks made before the
repository was published. Published on 2026-11-24 as `usual-labs/usual-mail` on GitHub, branch `main`, with a fresh
history of one commit (the owner's decision).

## 2026-11-23: AGPL-3.0-only with a contributor agreement

The owner's decision of 2026-11-23: the licence is the AGPL-3.0, with a contributor agreement so that the maker can
still publish to app stores and offer other terms. A trademark on the name comes later. The repository (planned as
`usual-labs/usual-mail`) went public after the checks below and the owner's OK to push (2026-11-24).

- **`LICENSE`** is gnu.org's text (`https://www.gnu.org/licenses/agpl-3.0.txt`, fetched 2026-11-23): 34,523 bytes,
  661 lines, sha256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`. The Internet Archive's copies
  of the same address from 2022-06-01, 2023-06-07, 2024-06-01 and 2026-01-01 have the same bytes. SPDX's copy
  (`license-list-data`, `AGPL-3.0-only.txt`) differs only in line wrapping and three `http`/`https` addresses;
  GitHub's (`/licenses/agpl-3.0`) in one line break of the appendix.
- **`AGPL-3.0-only`, not `-or-later`,** in every `package.json`, and in the lockfiles wherever npm records it: each
  root entry and each entry for a linked part (`../core`, and in the server's `../dashboard`, `../mail`, `../mcp`).
  `npm install --package-lock-only` on copies of the parts left the lockfiles byte for byte as edited, but for
  `design/`'s, where this npm adds about a thousand lines of `geist`'s optional peer packages with or without the
  licence (as it does to the committed lockfile). Nothing in the notes or the private plan argues for "or later";
  with the contributor agreement the maker can still move to a later version deliberately.
- **No licence headers in source files:** no file had one and no convention asks for them. The AGPL's appendix
  suggests them; it doesn't require them.
- **The contributor agreement (`CLA.md`)** is version 0.1, a draft without a legal review, and says so at the top.
  It is the Harmony Individual Contributor License Agreement 1.0 (HA-CLA-I) with outbound option five: the maker may
  license a contribution under any licence, and promises to also license it under the licence the project used on
  the day it was submitted. Harmony was chosen over the Apache ICLA because its templates are published for reuse
  (CC BY 3.0 Unported, `harmonyagreements.org`) and option five is the app-store case. Following CC BY 3.0, the file
  credits Project Harmony, links the licence, lists the changes and says Harmony doesn't endorse it; it isn't called
  a Harmony agreement. "We" is Nestor Code Crafters UG, the maker the website's pages already name; the governing law
  is Germany's. Both are marked in the draft to be confirmed, with the Media licence (CC BY 4.0), whether an
  agreement for companies is needed (section 3(c) mentions one), whether agreeing in a pull request is enough, and
  whether the agreement reaches back (the re-review of 2026-11-23): section 1's "Effective Date" is the earlier of
  agreeing and the first Submission, which counts issues and comments, while `CLA.md`'s "How to agree" and
  `CONTRIBUTING.md` say it covers the pull request it is agreed in and later contributions. Left to the legal review.
- **Agreeing** is a sentence in the description of the contributor's first pull request (`CONTRIBUTING.md` gives
  it). No CLA bot and no GitHub configuration (the owner's instruction). `CONTRIBUTING.md` says pull requests can't
  be merged until the agreement is final, and that the sentence applies only then (not to the 0.1 draft, which
  `CLA.md` says not to rely on).
- **`THIRD_PARTY_NOTICES.md`** is the one list of what comes from others: the fonts (OFL-1.1), Hugeicons' free set
  (MIT), the Public Suffix List (MPL-2.0), the tracker list (BSD-3-Clause, with its two sources' MIT and BSD-3-Clause
  notices in full), the wallpaper (the Unsplash License, its photo page linked), the 87 production npm packages the parts include (the lockfiles' production packages but those of libSQL's remote clients and the type declarations they bring; 94 before 2026-11-24) (MIT, Apache-2.0,
  ISC, BSD-2-Clause, BSD-3-Clause, MIT-0; `@zone-eu/mailsplit` used under MIT of "MIT OR EUPL-1.1+", `json-schema`
  under BSD-3-Clause of "AFL-2.1 OR BSD-3-Clause"; no Apache-2.0 package has a NOTICE file), GRDB.swift 7.12.0
  (MIT) and the apps' SF Symbols. All may be distributed with Usual Mail under the AGPL. The LGPL-3.0 packages in the
  lockfiles (sharp's libvips, under Wrangler and Miniflare) are development-only and never distributed.
- **The licence texts travel with the Docker image** (review of 2026-11-23): `/app/THIRD_PARTY_LICENSES.txt`, written
  by `server/scripts/licenses.mjs` from the bundle's esbuild metafile plus the image's `node_modules`; the build fails
  when a package has no licence text. Packages that ship none get their repository's LICENSE or the standard text
  (`server/scripts/licences/`). `promise-limit` (ISC), which has no licence file or copyright line anywhere and got
  the standard ISC text only, is no longer shipped (2026-11-24): the server takes only libSQL's local client, so the
  image installs `libsql` and its own dependencies, not `@libsql/client` with its remote clients' packages
  ([known-issues.md](known-issues.md), Fixed). The Cloudflare Worker gets none, since the project passes on no copy of it
  ([decisions-deploy.md](decisions-deploy.md)).
- **The website's terms and privacy policy** (`site/public/terms/`, `site/public/privacy/`) say nothing about the
  licence, so they were left unchanged; see improvement-ideas.md for a line to consider when the repository is public.

## 2026-11-23: the checks before going public

Each check's verdict: "OK to publish", "fix first" or "owner decides". Sources at the end.

1. **The tracker list's provenance: OK to publish (keep the list).** The question was a credited gist of unknown
   licence. What is known now: MailTrackerBlocker's list (BSD-3-Clause, © 2020 Aaron Lee) credits two lists in its
   README and ACKNOWLEDGEMENTS: the spy-pixel list used in HEY, a public gist by DHH (one Ruby file, "Current list of
   spy pixels named'n'shamed in HEY, as of April 23, 2020"), and Simplify Gmail's list (`leggett/simplify-trackers`,
   BSD-3-Clause, © 2021 Michael Leggett). The gist states no licence itself, but its owner answered "What is the
   license of this piece of code?" with "MIT ✌️" in its comments on 2020-07-01 (comment 3360063, marked as the
   gist's owner). 40 of the gist's 49 named services are among the 320 trackers shipped. The fallback, Trocker's
   list, isn't needed. What remains: the gist's grant is a one-word comment with no copyright line (the notices give
   "© 2020 David Heinemeier Hansson" as its author); `trackers.LICENSE` and the `licenseText` inside `trackers.json`
   carry only MailTrackerBlocker's notice, so `server/scripts/update-trackers.mjs` should add the two upstream
   notices (left for the server's next change: improvement-ideas.md). `THIRD_PARTY_NOTICES.md` carries both now.
2. **The wallpaper: settled (2026-11-24), the Unsplash License.** The photograph (a tree on a green hill, 3,840 ×
   2,160 JPEG, no metadata at all) is Unsplash's photo `UgzSrkLwcxE`,
   [unsplash.com/photos/a-single-tree-stands-on-a-rolling-green-hill-UgzSrkLwcxE](https://unsplash.com/photos/a-single-tree-stands-on-a-rolling-green-hill-UgzSrkLwcxE),
   whose page the owner sent on 2026-11-24. Checked that day: the page's download answers without signing in, from
   `images.unsplash.com` (Unsplash+ photos are paid downloads), and a small copy of it matches the repository's
   `wallpaper.jpg` by eye. So it is a free photo under the Unsplash License: copying, changing and distributing it,
   commercially too, with no credit needed; not compiling photos into a competing service, and not selling unaltered
   copies. That allows it in the apps, the website and a public repository. It isn't covered by the AGPL, and
   `THIRD_PARTY_NOTICES.md` says so. The photographer's name couldn't be confirmed (unsplash.com refuses automated
   reads, and a web search didn't find the page), so the notices link the page and name nobody. The photo also
   appears as the iPhone app's icon (a crop), the website's favicon, touch icon and background layers, and behind
   the app in the onboarding tour's clips (`tour-*.mp4`, which replaced `onboarding-screenshot.png` on 2026-11-25).
   The website's footers still say "Wallpaper: Unsplash" without the link; adding it needs a site deploy
   (improvement-ideas.md).
3. **The icons: OK to publish.** Every icon the apps, the dashboard, the connector and the website ship is in
   Hugeicons' free set (`@hugeicons/core-free-icons` 4.4.0): the design package's 47 (Swift catalog and web sprite,
   which the dashboard uses), the connector's 6 and the website's 18 have exactly the free set's path data; the
   apps' own 38 (exported from the design file) are the free set's drawings, 18 with the same path data and 20
   re-encoded by Figma (16-point frames, other stroke colours), each rendered beside the free icon of the same name
   and found pixel for pixel the same, with a wrong icon as a control. `male-02` alone differs: Figma added a grey
   fill inside the free outline, a change MIT allows. **SF Symbols** are used only in the Apple apps' `UsualMailUI`:
   `chevron.right` (`Onboarding/AiKeyStep.swift`, `Onboarding/GoogleClientPaths.swift`,
   `Onboarding/WhileWaitingStep.swift`), `chevron.left` (`Onboarding/WhileWaitingStep.swift`), `checkmark` and
   `exclamationmark.circle` (`Onboarding/ConnectGmail.swift`), `checkmark` and `doc.on.doc`
   (`GoogleClientPaths.swift`'s copy button) and `xmark` (`Search/SearchChips.swift`). The dashboard, the connector
   and the website use none.
4. **What a public repository would expose: done (2026-11-24).** The history, the identity it is published under and
   what the notes say were checked. The owner chose a fresh history of one commit under their GitHub noreply address,
   and notes trimmed of details from their own mailbox and machine before that commit; the findings stay in the
   maintainer's private notes, outside this repository. No secret was found: every token-shaped string here is a
   made-up test value.

**Sources** (read 2026-11-23): gnu.org's AGPL text and the Internet Archive's copies of it; SPDX `license-list-data`;
GitHub's licences API; Harmony's templates (`harmonyagreements.org/agreements.html`, `docs/ha-cla-i-v1.odt`, the
guide) and their CC BY 3.0 notice; MailTrackerBlocker at commit `7463682a…` (`README.md`, `LICENSE`,
`Resources/ACKNOWLEDGEMENTS`, `Source/MTBBlockedMessage.m`); the gist
`https://gist.github.com/dhh/360f4dc7ddbce786f8e82b97cdad9d20` and its comments through GitHub's API;
`leggett/simplify-trackers`' `LICENSE`; GRDB.swift's licence through GitHub's API; Unsplash's licence and help pages
through a web search; the parts' lockfiles. Added 2026-11-24: the wallpaper's photo page (from the owner), its
download's answer (`unsplash.com/photos/UgzSrkLwcxE/download`) and a small copy of the photo.
