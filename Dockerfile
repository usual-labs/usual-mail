# Usual Mail's server in one image: the server bundled into one file with esbuild, run by Node 22 as the
# unprivileged `node` user, with all its data in the volume at /data and one port, 8484.
#
# Build from the repository root:
#   docker build -t usual-mail .
# Run it with compose.yaml, with `usual-mail init --mode docker`, or by hand:
#   docker run -d --name usual-mail --stop-timeout 180 -p 127.0.0.1:8484:8484 -v usual-mail-data:/data usual-mail
# (--stop-timeout 180: stopping waits for the mail in hand to be stored, longer than Docker's default 10 seconds.)
#
# The server's bundle, dist/server.mjs, holds its sibling packages: core, the mail providers (mail/), the dashboard
# and the connector (mcp/), and libSQL's local client. Only `libsql`, libSQL's native part, stays in node_modules,
# installed on its own so the image carries no build tools, nor the packages of libSQL's clients for remote
# databases. .dockerignore lets in exactly those five folders (without tests, docs or local data), the entry point,
# LICENSE and THIRD_PARTY_NOTICES.md. The base image is pinned by version and digest.
#
# /app/THIRD_PARTY_LICENSES.txt holds the licence texts of everything from others besides Node and Debian: what the
# bundle holds (written by the server's build) and the packages in /app/node_modules (added below), both by
# server/scripts/licenses.mjs, which fails the build when a package has no licence text.

ARG NODE_IMAGE=node:22.23.5-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
# Each part is its own package. Install the production dependencies of every package the server names as
# "file:../<folder>" (today core, mail, dashboard and mcp), so the bundler finds each one's own dependencies, then
# the server's own (with esbuild), and build it with its own script.
RUN set -eu; \
    parts="$(node -p "Object.values(require('./server/package.json').dependencies ?? {}).filter((v) => v.startsWith('file:../')).map((v) => v.slice(8)).join(' ')")"; \
    for part in $parts; do \
      if [ -f "$part/package-lock.json" ]; then (cd "$part" && npm ci --omit=dev --no-audit --no-fund); fi; \
    done; \
    cd server; \
    npm ci --no-audit --no-fund; \
    npm run build
# What the running server needs and nothing else: the bundle's run-time dependencies (`libsql`), which the build
# wrote to dist/runtime.package.json, installed on their own at the versions the server's lockfile holds. Pruning
# the build's node_modules instead left build tools in it (esbuild, TypeScript, drizzle-kit's helpers), because
# npm keeps what the linked sibling packages pull in.
RUN set -eu; \
    mkdir /runtime; \
    cp server/dist/runtime.package.json /runtime/package.json; \
    cp server/package-lock.json /runtime/package-lock.json; \
    cd /runtime; \
    npm install --omit=dev --no-audit --no-fund; \
    rm -rf node_modules/.bin package-lock.json; \
    node /src/server/scripts/licenses.mjs node_modules /app/node_modules > /tmp/node_modules-licences.txt; \
    { cat /src/server/dist/THIRD_PARTY_LICENSES.txt; echo; cat /tmp/node_modules-licences.txt; } > THIRD_PARTY_LICENSES.txt

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    USUAL_MAIL_DATA_DIR=/data \
    USUAL_MAIL_HOST=0.0.0.0 \
    USUAL_MAIL_PORT=8484
WORKDIR /app
COPY --from=build /runtime/package.json ./
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /src/server/dist/server.mjs ./dist/server.mjs
COPY --from=build /src/server/migrations ./migrations
# The licence and what comes from others travel with the image.
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
COPY --from=build /runtime/THIRD_PARTY_LICENSES.txt /app/
COPY docker-entrypoint.sh /usr/local/bin/usual-mail-entrypoint
# /data belongs to `node` and only it may read it. A new named volume takes this owner and mode.
RUN mkdir /data && chown node:node /data && chmod 700 /data && chmod 755 /usr/local/bin/usual-mail-entrypoint
# No USER: the container starts as root so the entry point can give a root-owned volume to `node` (Railway mounts
# its volumes that way), then runs the server as `node`. `docker run --user` still runs it as that user instead, and
# is how to run it with no capabilities (--cap-drop ALL --user 1000:1000, on a folder that is uid 1000's).
VOLUME /data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.USUAL_MAIL_PORT || 8484) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["usual-mail-entrypoint"]
CMD ["node", "dist/server.mjs"]
