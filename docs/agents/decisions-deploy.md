# Deploying beyond Cloudflare: decisions

State on 2026-11-23. The public guide is [docs/deploy.md](../deploy.md); the checks run are in [cli.md](cli.md)
(Checks); the hosts' traps are in [known-issues.md](known-issues.md) ("Hosting platforms").

## The owner's decision (2026-11-23)

- Make the server deployable beyond Cloudflare, in this order: **Docker with a guide for any VPS**, **Coolify**,
  then **Render and Railway buttons**.
- **Home servers (Unraid, CasaOS, Umbrel) come later**; nothing is built for them now.
- Test on this Mac by updating Docker Desktop (done the same day: 4.36.0 to 4.100.1, [cli.md](cli.md)).

## One image for every host

- **The same image everywhere:** `ghcr.io/usual-labs/usual-mail`, built from the root `Dockerfile`; every host file
  either uses it or builds the same Dockerfile. Nothing host-specific is in the server.
- **The container starts as root and runs the server as `node`** (`docker-entrypoint.sh`). Hosts that mount a volume
  owned by root (Railway; any disk made by root) made the server fail at start as `node`. The alternatives were
  `RAILWAY_RUN_UID=0`, which runs the whole server as root, and a note per host, which doesn't cover hosts whose
  disk owner isn't known (Render). The entry point fixes ownership with no host setting and still drops to `node`,
  as the official Postgres image does. `docker run --user` (and so `init --mode docker`) skips it.
- **The data folder's owner decides what the entry point takes** (reviews of 2026-11-23): a folder of root's
  becomes `node`'s, but only when it is new (empty, or holding only `lost+found`, as Railway's and Render's disks
  may) or already holds `usual-mail.db` or `secret.key` (a restore); with anything else in it the entry point stops
  with a line saying so, since a mistaken `-v /srv:/data` would otherwise re-own another service's files. In a
  folder of `node`'s, everything not `node`'s becomes `node`'s; a folder of anyone else's (a host user's bind mount,
  uid not 1000) is left alone with a line naming `--user <its uid:gid>`. The first review proposed taking only files
  of uid or gid 0, but `docker cp` into a container keeps the files' own uid and group (Engine 29.9.3: a backup made
  on a Mac, 501:0 there, arrived as 501:0; Docker's docs say root), so a restore made by anyone but root or uid 1000
  would have left the database unreadable.
- **Its lines when it can't** (all exit 1): a folder mounted read-only (`:ro`, read from `/proc/mounts` before
  anything else) gets its own line. Without the capabilities to change owners and users (`--cap-drop ALL`): on a
  folder of `node`'s, `find` can't read it and the line points to `--user 1000:1000`, with which the image works
  with no capabilities; on a folder of root's, `chown` fails and the line says to give the folder to 1000:1000
  first (one start without `--cap-drop`, or `chown -R 1000:1000` on the host), since `--user 1000:1000` alone hits
  `EACCES` there (seen). A trial `setpriv … true` catches a missing capability to change user.
- **The licence travels with the image:** `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied to `/app`
  (`.dockerignore` lets them in after its `**/*.md` rule), and so is `THIRD_PARTY_LICENSES.txt` (review of 2026-11-23:
  MIT, ISC and BSD need their notices in copies, Apache-2.0 §4(a) the licence itself, and nothing in the image held
  them). The server's build writes it beside the bundle from esbuild's metafile (`server/scripts/licenses.mjs`): every
  package the bundle takes code from (55 on 2026-11-23) with each LICENSE, LICENCE, COPYING and NOTICE file in its
  folder, the repository's own `<name>.LICENSE` files beside bundled data (the suffix and tracker lists), and the
  dashboard's embedded font and icon licences. The Dockerfile adds the image's own `node_modules` (libSQL's 15
  packages on arm64) with the same script's command-line form. A package with no licence text fails the build; those
  that ship none (eight in the arm64 image) are named in the script with what stands in (the standard Apache-2.0 text,
  their repositories' MIT LICENSE at a pinned commit, or the standard ISC text for `promise-limit`, which has no
  licence file or copyright line anywhere), in `server/scripts/licences/`. Sorted and with LF endings, so two builds
  give the same file. `node scripts/build.mjs <folder>` builds elsewhere, so it can be tried without touching `dist/`,
  which a running server may use. `.gitattributes` keeps `*.sh` at LF, since a CRLF entry point from a Windows
  checkout would break the image.
- **No licence file for the Cloudflare Worker:** feasible (wrangler can print its own metafile with
  `wrangler deploy --dry-run --outdir <dir> --metafile`, and a text module can be bundled), but not done. Wrangler
  bundles after `build.command`, so the true input list (including the `unenv` polyfills it injects for
  `nodejs_compat`) exists only after a second full bundling pass at every deploy, guarded against the build command
  running again, plus a route or module in the Worker to serve it. And nobody passes a Worker bundle on: Cloudflare
  builds it in the deployer's own account from their copy of the repository and npm, and it serves browsers no npm
  code (the views' script is hand-written; the font and icon licences are already served at `/assets/licences/`).
- **`compose.yaml` names the published image and keeps `build: .`:** Compose pulls, and builds from the checkout
  when the pull fails (seen with Compose v5.7.1, nothing published), so one file serves a checkout and a copy.

## Each host's file

- **`compose.caddy.yaml`, a VPS:** stands alone (no checkout on the server). Caddy 2.11.9 pinned by version and
  digest gets Let's Encrypt certificates; the Caddyfile is inline (`configs: content:`, Compose 2.23.1 or newer),
  so it is one file plus a `.env` with `USUAL_MAIL_DOMAIN` (required, `:?`). The server publishes no port. The
  project is named `usual-mail`, so the guide's volume name (`usual-mail_usual-mail-data`) holds. Backups are stop,
  `docker compose cp`, start; restore is `down`, remove the volume, `create`, copy in, `up` (both tried).
- **`compose.coolify.yaml`, Coolify v4:** no `ports:` (Coolify's docs: published ports bypass its proxy);
  `SERVICE_URL_USUALMAIL_8484` declared so the proxy routes the domain to 8484, but `USUAL_MAIL_PUBLIC_URL` from
  `SERVICE_URL_USUALMAIL`, because the suffixed variable's value carries the port (`https://…:8484`, which sent
  Google `…:8484/v1/google/callback`). Read in Coolify's source on 2026-11-23: in v4.7.6 both the parser
  (`bootstrap/helpers/parsers.php`, `$urlWithPort = "$url:$port"`) and saving a domain (`services.php`,
  `updateCompose`) set `SERVICE_URL_<NAME>_<PORT>` with the port and `SERVICE_URL_<NAME>` without it, as its test
  `ServiceDomainPortCorruptionTest.php` expects (`SERVICE_URL_GITLAB_80` = `http://git.example.com:80`); the
  parser did so already in beta.434, and `updateCompose` from beta.445 (not in beta.444). The key comes from
  `SERVICE_REALBASE64_32_SECRETKEY` (real base64 of 32 random bytes; `SERVICE_BASE64_32_*` isn't base64). The key
  lives apart from the volume because Coolify's volume backups can go to S3. The guide makes the person set an
  HTTPS domain before the first deploy, since the server exits on Coolify's plain-HTTP `sslip.io` address.
- **`render.yaml`, Render:** `runtime: docker` builds from the repository (the button needs the repository anyway,
  and it works before an image is published); `plan: starter` (0.5 CPU, 512 MB; Render's docs say legacy plan names
  stay valid, new ID `0.5c-512mb`); a 5 GB disk at `/data` (it can grow, never shrink); `PORT=8484` so Render routes
  to it; `USUAL_MAIL_PUBLIC_URL` with `sync: false` (the `onrender.com` address isn't known before creation);
  `USUAL_MAIL_SECRET_KEY` with `generateValue` (256 random bits in base64, which the server takes);
  `autoDeployTrigger: "off"`, quoted because YAML 1.1 readers take a bare `off` for false. Render's JSON schema and
  `render blueprints validate` (read-only, against the owner's workspace) accepted it: valid, one service to create.
- **Railway:** no file, because its templates are made in its dashboard; the guide says how to set up the service
  and make the template, and the README holds a placeholder. The key stays on the volume: Railway's template
  generator isn't known to make base64 of 32 bytes.

## Publishing the image

- **`.github/workflows/image.yml`:** runs on `released` (a full release, or a pre-release made one) and on
  `published` for pre-releases only (a full release fires both; the `tags` job's `if` keeps one run). The `tags` job
  checks the tag first (`vX.Y.Z` with an optional suffix), so a bad tag pushes nothing, and chooses the tags:
  `X.Y.Z` always; `X.Y` when it is the newest full release of that line and `latest` when it is the newest of all,
  from the repository's releases (`gh api`, `sort -V`), so 1.1.5 after 1.2.0 moves `1.1` but not `latest`. The list
  is fetched on a line of its own (review of 2026-11-23): bash turns `-e` off inside `$(…)`, so a failed `gh api`
  inside `{ gh …; echo "$TAG"; }` was lost, and with a 502 an older release took `latest`. Then
  amd64 builds on `ubuntu-24.04` and arm64 on `ubuntu-24.04-arm` (native, no emulation; free for public
  repositories), each pushed by digest, and the publish job joins them with `docker buildx imagetools create`, with
  OCI labels and index annotations (`org.opencontainers.image.source` links the package to the repository),
  provenance (`mode=max`) and an SBOM, then attests the index with `actions/attest-build-provenance` pushed to the
  registry, with `create-storage-record: false`: its default storage record would need `artifact-metadata: write`
  and only feeds the organisation's Linked Artifacts page, which nothing here uses, so the job keeps the fewer
  permissions. Run by hand, the `check` job builds both platforms with `contents: read` only and publishes nothing;
  `packages: write` is held only by the release's build and publish jobs. The two jobs share the matrix and steps
  through YAML anchors (GitHub supports anchors, not merge keys).
- **The builder and the SBOM scanner are pinned by digest:** BuildKit v0.35.1 (what `buildx-stable-1` was on
  2026-11-23) and `docker/buildkit-syft-scanner` 1.12.1 (buildx's default `stable-1` then), in the workflow's `env`.
- **Only GitHub-owned actions, pinned by SHA, and plain `docker buildx`:** the other usual-labs repositories allow
  GitHub-owned actions only (usual-bot and usual-ui also zizmor's and Scorecard's, with SHA pinning required;
  tailscalekit-build GitHub-owned only), read from GitHub's API on 2026-11-23. So no `docker/*` actions. The pins are
  the ones tailscalekit-build already uses.
- **Checked locally, not on GitHub:** actionlint 1.7.12 (with shellcheck 0.11.0) clean; zizmor 1.33.1 (auditor
  persona, offline) no findings, and on a copy with the anchors expanded only two `undocumented-permissions` notes,
  because expanding drops the permissions' comments (zizmor warns it reads anchors imprecisely). Its
  `concurrency-limits` hint appears only when the workflow has no `concurrency` at all (tried). The tag step itself,
  cut from the workflow, was run with a stand-in `gh` under bash 5.2.37 and GNU sort 9.7 (in the image): first
  release, 1.2.0, 1.1.5 after 1.2.0, 1.1.4 after 1.1.5, 1.10.0 against 1.9.3, pre-releases, bad tags, and `gh`
  failing with HTTP 502 (the job fails with no tags; the earlier snippet gave 1.1.5 `latest`). The pinned builder and scanner built the image locally with
  provenance and an SBOM. Earlier (before the review's changes): push-by-digest and `imagetools create` rehearsed
  against a local `registry:3`, the index pulled and run.

## What waits for the owner

- The repository public and a first release published; then check the GHCR package is public (and allowed by the
  organisation's package settings) and linked to the repository.
- The repository's Actions policy for `image.yml`'s actions (as for the other repositories). A manual run of the
  workflow first (the `check` job) would show on GitHub what was only checked locally: the anchors, the arm64 runner
  and the pinned builder.
- A Railway template made in Railway's dashboard, and its address in the README's button.
- Whether the standard ISC text is enough for `promise-limit` (under `@libsql/client`; no licence file or copyright
  line in the package or its repository), or to ask its maintainers for a licence file.
- Trying a real VPS, Coolify, Render and Railway once the image is published.
