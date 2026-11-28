# Deploying beyond Cloudflare: decisions

Updated 2026-11-28. The public guide is [docs/deploy.md](../deploy.md); the checks run are in [cli.md](cli.md)
(Checks); the hosts' traps are in [known-issues.md](known-issues.md) ("Hosting platforms").

## The owner's decision (2026-11-23)

- Make the server deployable beyond Cloudflare, in this order: **Docker with a guide for any VPS**, **Coolify**,
  then **Render and Railway buttons**.
- **Home servers (Unraid, CasaOS, Umbrel) come later**; nothing is built for them now.
- Test on this Mac by updating Docker Desktop (done the same day: 4.36.0 to 4.100.1, [cli.md](cli.md)).

## Portable default (2026-11-26)

The README and the guide linked from the app start with Docker Compose and the published image. A local install
downloads one Compose file and binds to loopback. Hosts with a domain can use the Caddy file or point an existing
HTTPS proxy at the local service. The platform buttons are alternatives in the quick guide.

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
- **Its lines when it can't** (all exit 1): a folder on a read-only mount gets its own line, checked before anything
  else with `findmnt -T` on the folder or the nearest folder above it that exists, so the folder's own `:ro`, a
  read-only mount above it, a `--read-only` container with the folder on it, and a path with spaces are all caught
  (final review, 2026-11-24: reading `/proc/mounts` for the folder's own line missed all but the first, since that
  file escapes a space as `\040`, and those cases got the capabilities line). Without the capabilities to change owners and users (`--cap-drop ALL`): on a
  folder of `node`'s, `find` can't read it and the line points to `--user 1000:1000`, with which the image works
  with no capabilities; on a folder of root's, `chown` fails and the line says to give the folder to 1000:1000
  first (one start without `--cap-drop`, or `chown -R 1000:1000` on the host), since `--user 1000:1000` alone hits
  `EACCES` there (seen). A trial `setpriv … true` catches a missing capability to change user.
- **The licence travels with the image:** `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied to `/app`
  (`.dockerignore` lets them in after its `**/*.md` rule), and so is `THIRD_PARTY_LICENSES.txt` (review of 2026-11-23:
  MIT, ISC and BSD need their notices in copies, Apache-2.0 §4(a) the licence itself, and nothing in the image held
  them). The server's build writes it beside the bundle from esbuild's metafile (`server/scripts/licenses.mjs`): every
  package the bundle takes code from (58 since 2026-11-24, with libSQL's local client) with each LICENSE, LICENCE,
  COPYING and NOTICE file in its folder, the repository's own `<name>.LICENSE` files beside bundled data (the suffix
  and tracker lists, named by their data files only: the code beside them, `suffixes.ts` and `trackers.ts`, is the
  project's own and was listed too until the final review of 2026-11-24), and the dashboard's embedded font and icon
  licences. The Dockerfile adds the image's own `node_modules` (`libsql` and its own dependencies, 5 packages on
  arm64; 15 before 2026-11-24, when `@libsql/client` was installed with its remote clients' packages) with the same
  script's command-line form. A package with no licence text fails the build; those that ship none (six in the arm64
  image) are named in the script with what stands in (the standard Apache-2.0 text, or their repositories' MIT
  LICENSE at a pinned commit), in `server/scripts/licences/`. `promise-limit`, which has no licence file or copyright
  line anywhere and had only the standard ISC text, is no longer in the image. Sorted and with LF endings, so two
  builds give the same file. `node scripts/build.mjs <folder>` builds elsewhere, so it can be tried without touching `dist/`,
  which a running server may use. `.gitattributes` keeps `*.sh` at LF, since a CRLF entry point from a Windows
  checkout would break the image.
- **No licence file for the Cloudflare Worker:** feasible (wrangler can print its own metafile with
  `wrangler deploy --dry-run --outdir <dir> --metafile`, and a text module can be bundled), but not done. Wrangler
  bundles after `build.command`, so the true input list (including the `unenv` polyfills it injects for
  `nodejs_compat`) exists only after a second full bundling pass at every deploy, guarded against the build command
  running again, plus a route or module in the Worker to serve it. And nobody passes a Worker bundle on: Cloudflare
  builds it in the deployer's own account from their copy of the repository and npm, and it serves browsers no npm
  code (the views' script is hand-written; the font and icon licences are already served at `/assets/licences/`).
- **The Compose files give the server three minutes to stop** (`stop_grace_period: 3m`, final review of 2026-11-24).
  The server's stop (SIGTERM) waits for each inbox's batch in hand and the AI's thread in hand: 0.10 to 0.19 s at
  rest (`docker stop` and `docker compose stop`, measured), but up to about two and a half minutes during a Gmail
  first sync on Node (200 messages at about 1.3 a second). Docker's default of ten seconds would kill such a stop:
  nothing stored is lost (`ingest` writes the cursor last, so the batch is fetched again), but the fetching is wasted,
  and so is an AI answer in hand, which is paid. Three minutes covers that batch; it is a ceiling, so a stop at rest
  is as quick as before, and a stop that hangs is still killed. Compose writes it to the container's `StopTimeout`
  (180, seen), so a plain `docker stop` waits as long; the guide gives `docker run --stop-timeout 180`, and the
  `usual-mail` command gives the same 180 seconds in both modes ([cli.md](cli.md)). The other hosts (docs read
  2026-11-24): **Render** sends SIGTERM and kills 30 seconds later, and `maxShutdownDelaySeconds` (a Blueprint or API
  field, 1 to 300) "can't" be customised for a service with a persistent disk (render.com/docs/deploys and
  render.com/docs/disks; the Blueprint reference gives the range), so `render.yaml`, whose service has a disk, doesn't
  set it, and the guide says to deploy when no first sync runs. **Railway**'s `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`,
  "the SIGTERM to SIGKILL buffer time", defaults to 0 (docs.railway.com/reference/variables; also a Settings field
  and `drainingSeconds` in its config file, docs.railway.com/guides/deployment-teardown), and its pages give no
  maximum: the Railway import sets it to 180. Neither tried on the host itself.
- **The stop closes every inbox together** (`SyncEngine.stop`, 2026-11-24, after the final review): each inbox is
  marked closing before any close waits, so the stop waits for the longest batch in hand, not one after another.
  Before, inboxes closed in turn, and one whose close hadn't begun went on starting batches (a unit test saw a second
  inbox start four more; in the image, a second IMAP inbox fetched another whole batch four seconds into the stop and
  the stop took 7.7 s against 6.6 s now). So "about two and a half minutes" holds for any number of inboxes.
- **Coolify's own Stop and Restart don't use `stop_grace_period`** (read in Coolify's source on 2026-11-24, the
  v4.7.6 tag and `main`): `app/Actions/Service/StopService.php` runs `docker stop --time=30` (10 for more than five
  containers), then `docker rm -f`; `RestartService.php` runs `StartService` with `stopBeforeStart`, which runs those
  commands first unless it pulls the latest images. A deploy runs `docker compose up -d --force-recreate`, which stops
  the old container with the file's value. Issue #5620 asked for the grace period; PR #9746, in v4.1.0, made it a
  setting for Applications only, and a Compose resource is a Service. So Stop or Restart during a first sync can cut
  off the batch in hand (nothing stored is lost; it is fetched again), and the file and the guide say to redeploy
  instead.
- **`compose.yaml` names the published image and keeps `build: .`:** Compose pulls, and builds from the checkout
  when the pull fails (seen with Compose v5.7.1, before the first release), so one file serves a checkout and a
  copy.

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
- **`render.yaml`, Render:** `runtime: docker` builds from the repository (the button needs the repository anyway);
  `plan: starter` (0.5 CPU, 512 MB; Render's docs say legacy plan names
  stay valid, new ID `0.5c-512mb`); a 5 GB disk at `/data` (it can grow, never shrink); `PORT=8484` so Render routes
  to it; `USUAL_MAIL_PUBLIC_URL` with `sync: false` (the `onrender.com` address isn't known before creation);
  `USUAL_MAIL_SECRET_KEY` with `generateValue` (256 random bits in base64, which the server takes);
  `autoDeployTrigger: "off"`, quoted because YAML 1.1 readers take a bare `off` for false. Render's JSON schema and
  `render blueprints validate` (read-only, against the owner's workspace) accepted it: valid, one service to create.
- **Railway** imports [one service and its named volume](../../deploy/railway/compose.yaml). The importer stages
  settings for review. An invalid initial owner email stops the image if someone deploys before setting their address.
  Set the HTTPS origin after generating the domain. The volume holds the key. A native deploy button needs the URL
  of a Railway template. [Railway template sharing](https://docs.railway.com/templates/publish-and-share)
- **Azure and AWS** use the released Caddy Compose file and pin its Usual Mail image to the matching release.
  A dedicated disk mounted by UUID holds Docker’s volumes. Both hosts require the owner email at creation so the
  host can finish setup by SSH and pairing code. Azure allocates a DNS name. On AWS the host points a name they own
  at the stack’s Elastic IP. [VM deployment guide](../deploy-cloud-vms.md)
- **Launch links** use each provider’s supported entry point. Azure’s button loads `deploy/azure/main.json` from
  public `main`. Regenerate it with `bicep build deploy/azure/main.bicep` after changing the Bicep or embedded shell
  script. AWS accepts a local template upload. A prefilled AWS launch URL requires a template hosted in S3.
  Coolify accepts a Compose resource in the host’s own dashboard while external catalog submissions are paused.
  [Azure buttons](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-to-azure-button) ·
  [AWS quick-create links](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html) ·
  [Coolify catalog](https://coolify.io/docs/contribute/service)

**Local checks on 2026-11-28.** Bicep compiled the portal JSON and `cfn-lint` accepted the stack. Ubuntu 24.04’s
disk tools distinguished a blank image from ext4. On Docker Desktop, the VM Compose file served `/healthz` with
Caddy’s local CA. The VM, Coolify and Railway configurations all reported the expected Google redirect, accepted
the owner’s pairing code and kept the password after replacing the container. The Railway import’s initial invalid
email stopped the server as intended. These checks used local volumes and simulated platform settings.

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

## The first release (2026-11-24)

- **0.1.0, released by the owner:** the repository went public, `1881044` set the version, and the release `v0.1.0`
  published `ghcr.io/usual-labs/usual-mail` as `0.1.0`, `0.1` and `latest`, for amd64 and arm64. On GitHub, the
  workflow's manual run (the `check` job, which publishes nothing) and the release's run both succeeded; the
  release's second event (`published`) was skipped, as the `tags` job's `if` means.
- **The package is public since 2026-11-24:** the owner made it public after 0.1.0; it is linked to the repository
  (its Packages page), and each release's image pulls without signing in.
- **The version is written by hand in many places:** each `package.json` and lockfile, and four source files
  (`server/src/version.ts`, `cli/src/version.ts`, `mcp/src/server.ts` and `mcp/src/ui/view-script.ts`). Only the
  CLI's version is tested against its `package.json`. A release bumps them all in a commit of its own; the tag goes on
  the release's last commit, which is that commit unless fixes follow it.

## What waits for the owner

- A Railway template made in Railway's dashboard, and its address in the README's button.
- An S3-hosted copy of the AWS template for a prefilled CloudFormation launch link.
- First installs on Azure, AWS, Coolify, Render, Railway and a standalone VPS, including public HTTPS and persistence.
