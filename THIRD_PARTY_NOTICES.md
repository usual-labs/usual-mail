# Third-party notices

Usual Mail's own code is licensed under the GNU Affero General Public License, version 3 only ([LICENSE](LICENSE),
`AGPL-3.0-only`). The files and packages below come from others and keep their own licences; the AGPL doesn't cover
them. Each was checked on 2026-11-23 for whether it may be distributed with Usual Mail under the AGPL; all may. The
wallpaper's photo page was added on 2026-11-24.

## Files in this repository

| What | Where | Licence | Licence text |
|---|---|---|---|
| Geist Sans and Geist Serif, © 2023 Vercel, in collaboration with basement.studio (npm package `geist` 1.9.2) | `design/dist/web/fonts/`, `design/swift/Sources/UsualMailDesign/Resources/Fonts/`, `site/public/fonts/`; the dashboard serves the web copies | SIL Open Font License 1.1 (`OFL-1.1`) | `Geist-OFL.txt` beside each copy |
| Prociono, © 2011 Barry Schwartz | `design/fonts/`, the same three font folders | SIL Open Font License 1.1 (`OFL-1.1`) | `Prociono-OFL.txt` beside each copy |
| Hugeicons' free set, Stroke Rounded, © 2025 Hugeicons (npm package `@hugeicons/core-free-icons` 4.4.0) | The design package's sprite (`design/dist/web/icons.svg`, used by the dashboard) and Swift asset catalog; the apps' own asset catalog (`apps/Packages/UsualMailUI/Sources/UsualMailUI/Resources/Assets.xcassets`, exported from the design file; `male-02` has a grey fill added); the connector's chat interface (`mcp/src/ui/design.generated.ts`); the website's inline sprite (`site/public/index.html`) | MIT | `design/dist/web/icons-LICENSE.md`, `design/swift/Sources/UsualMailDesign/Resources/Hugeicons-LICENSE.md`, `site/public/icons-LICENSE.txt` |
| The Public Suffix List (`publicsuffix/list`, commit `09c1b150f33c6145a73afcf7db0fb872fc54b4d1`), converted to JSON | `server/src/avatars/suffixes.json` | Mozilla Public License 2.0 (`MPL-2.0`); the converted file stays under it | `server/src/avatars/suffixes.LICENSE` |
| MailTrackerBlocker's list of email trackers, © 2020 Aaron Lee (`apparition47/MailTrackerBlocker`, `Source/MTBBlockedMessage.m` at commit `7463682a39af055a488539a3d0aa7898437b33f5`), converted to JSON | `server/src/pictures/trackers.json` | BSD 3-Clause (`BSD-3-Clause`) | `server/src/pictures/trackers.LICENSE`, and inside `trackers.json` |
| Material that MailTrackerBlocker's list builds on: the spy-pixel list used in HEY, by David Heinemeier Hansson, and Simplify Gmail's tracker list, © 2021 Michael Leggett | Within `server/src/pictures/trackers.json` | MIT and BSD 3-Clause | [Below](#the-tracker-lists-sources) |
| The wallpaper, a photograph of a tree on a green hill | `apps/Packages/UsualMailUI/Sources/UsualMailUI/Resources/Assets.xcassets/wallpaper.imageset/wallpaper.jpg`; cropped into the iPhone app's icon (`apps/AppPhone/Assets.xcassets/AppIcon.appiconset/icon-1024.png`), the website's `favicon.png`, `apple-touch-icon.png` and `img/` layers; behind the app in the onboarding tour's clips (`apps/Packages/UsualMailUI/Sources/UsualMailUI/Resources/tour-*.mp4`) | The [Unsplash License](https://unsplash.com/license), not the AGPL. The photo's page: [unsplash.com/photos/UgzSrkLwcxE](https://unsplash.com/photos/a-single-tree-stands-on-a-rolling-green-hill-UgzSrkLwcxE) ("A single tree stands on a rolling green hill"), a free download there, not an Unsplash+ photo. The photographer's name couldn't be confirmed (unsplash.com refuses automated reads), so it isn't given here; the photo page names them. The licence asks for no credit | [unsplash.com/license](https://unsplash.com/license) |

## Packages the built parts include

npm fetches these when a part is installed; none of them is in this repository. The server's bundle
(`dist/server.mjs`) and the Cloudflare Worker include the server's packages, which take in `mail/`, `dashboard/`,
`mcp/` and `core/` (the Node bundle includes libSQL's local client and loads its native part, `libsql`, from
`node_modules`); the `usual-mail` command bundles its own. The list holds every production package in the parts'
lockfiles on 2026-11-23, with the licence each lockfile records, except the packages of libSQL's clients for remote
databases (`@libsql/hrana-client`, `@libsql/isomorphic-ws`, `ws`, `@types/ws` and `promise-limit`) and the type
declarations `@types/ws` brings with it (`@types/node` and `undici-types`, which hold no code that runs): npm installs
them with `@libsql/client`, but since 2026-11-24 no part includes them. Development-only packages (TypeScript,
Wrangler, Miniflare, test servers) aren't distributed and aren't listed.

**Their licence texts.** Installed with npm, most packages keep theirs in their folder under `node_modules/`. The
Docker image has them all in `/app/THIRD_PARTY_LICENSES.txt`: the server's build writes the texts of everything its
bundle holds (`server/scripts/licenses.mjs`, from esbuild's list of the bundle's inputs, as
`dist/THIRD_PARTY_LICENSES.txt`), and the image adds those of the packages in its `node_modules` (`libsql` and its
own). The build fails when a package has no licence text. A few packages ship no licence file:
`@ai-sdk/provider-utils` and `drizzle-orm` (Apache-2.0; the file gives the standard text), and `@libsql/client`,
`@libsql/core` and libSQL's per-platform packages (MIT; the file gives their repositories' licences). None of the
Apache-2.0 packages has a NOTICE file. The Cloudflare Worker has no such
file: Cloudflare builds it in the deployer's own account from their copy of this repository, so this project passes
on no copy of it.

| Package | Version | Licence | In |
|---|---|---|---|
| `ai` | 7.0.173 | Apache-2.0 | `server/` |
| `@ai-sdk/anthropic` | 4.0.105 | Apache-2.0 | `server/` |
| `@ai-sdk/gateway` | 4.0.146 | Apache-2.0 | `server/` |
| `@ai-sdk/openai` | 4.0.118 | Apache-2.0 | `server/` |
| `@ai-sdk/provider` | 4.0.38 | Apache-2.0 | `server/` |
| `@ai-sdk/provider-utils` | 5.0.81 | Apache-2.0 | `server/` |
| `atomic-sleep` | 1.0.0 | MIT | `mail/` |
| `cross-spawn` | 7.0.6 | MIT | `mcp/` |
| `dayjs` | 1.11.23 | MIT | `mail/` |
| `detect-libc` | 2.0.2 | Apache-2.0 | `server/` |
| `dom-serializer` | 3.1.1 | MIT | `mail/` |
| `domelementtype` | 3.0.0 | BSD-2-Clause | `mail/` |
| `domhandler` | 6.0.1 | BSD-2-Clause | `mail/` |
| `domutils` | 4.0.2 | BSD-2-Clause | `mail/` |
| `drizzle-orm` | 0.45.4 | Apache-2.0 | `server/` |
| `encoding-japanese` | 2.5.0 | MIT | `mail/` |
| `entities` | 8.1.0 | BSD-2-Clause | `mail/` |
| `escape-string-regexp` | 4.0.0 | MIT | `mail/` |
| `eventsource` | 3.0.7 | MIT | `mcp/` |
| `eventsource-parser` | 3.1.1 | MIT | `mcp/`, `server/` |
| `hono` | 4.13.18 | MIT | `dashboard/`, `server/` |
| `@hono/node-server` | 2.1.8 | MIT | `server/` |
| `htmlparser2` | 12.0.0 | MIT | `mail/` |
| `iconv-lite` | 0.7.3 | MIT | `mail/` |
| `imapflow` | 2.12.1 | MIT | `mail/` |
| `ip-address` | 10.7.6 | MIT | `mail/` |
| `is-plain-object` | 5.1.0 | MIT | `mail/` |
| `isexe` | 2.0.0 | ISC | `mcp/` |
| `jose` | 6.2.17 | MIT | `mcp/` |
| `js-base64` | 3.9.6 | BSD-3-Clause | `server/` |
| `json-schema` | 0.4.0 | AFL-2.1 OR BSD-3-Clause (used under BSD-3-Clause) | `server/` |
| `launder` | 1.7.2 | MIT | `mail/` |
| `libbase64` | 1.4.1 | MIT | `mail/` |
| `libmime` | 5.6.5 | MIT | `mail/` |
| `libqp` | 3.0.2 | MIT | `mail/` |
| `libsql` | 0.5.29 | MIT | `server/` |
| `@libsql/client` | 0.18.0 | MIT | `server/` |
| `@libsql/core` | 0.18.0 | MIT | `server/` |
| `@libsql/darwin-arm64` | 0.5.29 | MIT | `server/` |
| `@libsql/darwin-x64` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-arm-gnueabihf` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-arm-musleabihf` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-arm64-gnu` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-arm64-musl` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-x64-gnu` | 0.5.29 | MIT | `server/` |
| `@libsql/linux-x64-musl` | 0.5.29 | MIT | `server/` |
| `@libsql/win32-x64-msvc` | 0.5.29 | MIT | `server/` |
| `@modelcontextprotocol/client` | 2.4.0 | Apache-2.0 | `mcp/` |
| `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 | `mcp/` |
| `@modelcontextprotocol/ext-apps` | 2.0.4 | MIT | `mcp/` |
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 | `mcp/` |
| `nanoid` | 3.3.20 | MIT | `mail/` |
| `@neon-rs/load` | 0.0.4 | MIT | `server/` |
| `nodemailer` | 10.6.0 | MIT-0 | `mail/` |
| `on-exit-leak-free` | 2.1.2 | MIT | `mail/` |
| `parse-srcset` | 1.0.2 | MIT | `mail/` |
| `path-key` | 3.1.1 | MIT | `mcp/` |
| `picocolors` | 1.1.1 | ISC | `mail/` |
| `pino` | 10.3.1 | MIT | `mail/` |
| `pino-abstract-transport` | 3.0.0 | MIT | `mail/` |
| `pino-std-serializers` | 7.1.0 | MIT | `mail/` |
| `@pinojs/redact` | 0.4.0 | MIT | `mail/` |
| `pkce-challenge` | 5.0.1 | MIT | `mcp/` |
| `postal-mime` | 4.2.1 | MIT-0 | `mail/` |
| `postcss` | 8.5.33 | MIT | `mail/` |
| `process-warning` | 5.1.1 | MIT | `mail/` |
| `quick-format-unescaped` | 4.0.4 | MIT | `mail/` |
| `real-require` | 0.2.0 | MIT | `mail/` |
| `real-require` | 1.0.0 | MIT | `mail/` |
| `safe-stable-stringify` | 2.5.0 | MIT | `mail/` |
| `safer-buffer` | 2.1.2 | MIT | `mail/` |
| `sanitize-html` | 2.18.2 | MIT | `mail/` |
| `shebang-command` | 2.0.0 | MIT | `mcp/` |
| `shebang-regex` | 3.0.0 | MIT | `mcp/` |
| `smart-buffer` | 4.2.0 | MIT | `mail/` |
| `socks` | 2.8.10 | MIT | `mail/` |
| `sonic-boom` | 4.2.1 | MIT | `mail/` |
| `source-map-js` | 1.2.2 | BSD-3-Clause | `mail/` |
| `split2` | 4.2.0 | ISC | `mail/` |
| `@standard-schema/spec` | 1.1.0 | MIT | `mcp/`, `server/` |
| `thread-stream` | 4.2.1 | MIT | `mail/` |
| `valibot` | 1.5.0 | MIT | `server/` |
| `@vercel/oidc` | 3.2.0 | Apache-2.0 | `server/` |
| `which` | 2.0.2 | ISC | `mcp/` |
| `@workflow/serde` | 4.1.0 | Apache-2.0 | `server/` |
| `zod` | 4.6.7 | MIT | `mcp/`, `server/` |
| `@zone-eu/mailsplit` | 5.4.31 | MIT OR EUPL-1.1+ (used under MIT) | `mail/` |

The Mac and iPhone apps use one Swift package: **GRDB.swift** 7.12.0, © 2015–2025 Gwendal Roué, MIT.

The apps also draw a few of Apple's **SF Symbols** (chevrons, a check mark, an exclamation mark, a copy icon and a
cross, in `UsualMailUI`'s onboarding and search chips). Apple licenses them for use on Apple platforms only; the system draws
them and no file of them is in this repository. The dashboard, the connector and the website use none.

## The tracker list's sources

MailTrackerBlocker credits two lists that its own builds on. Their notices:

**The spy-pixel list used in HEY** (<https://gist.github.com/dhh/360f4dc7ddbce786f8e82b97cdad9d20>). The gist states
no licence of its own; its author answered "What is the license of this piece of code?" with "MIT" in the gist's
comments on 2020-07-01
(<https://gist.github.com/dhh/360f4dc7ddbce786f8e82b97cdad9d20?permalink_comment_id=3360063#gistcomment-3360063>).

```
Copyright (c) 2020 David Heinemeier Hansson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Simplify Gmail's tracker list** (<https://github.com/leggett/simplify-trackers>):

```
BSD 3-Clause License

Copyright (c) 2021, Michael Leggett (simpl.fyi)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
