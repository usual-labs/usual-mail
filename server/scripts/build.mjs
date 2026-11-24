// Bundles the Node server into dist/server.mjs: the server, core, the mail providers, the dashboard and the
// connector, with their dependencies, libSQL's local client among them (src/node/db.ts). Only `libsql`, the native
// part, stays outside: it is loaded from node_modules next to dist/, with migrations/ beside it. It also writes
// dist/runtime.package.json, which names only what the bundle loads at run time (`libsql`, at the version the
// server's lockfile holds), so an image installs just that and its own dependencies, not the packages of libSQL's
// clients for remote databases (`@libsql/client` depends on them whichever entry is used), and
// dist/THIRD_PARTY_LICENSES.txt, the licence texts of every package the bundle holds (scripts/licenses.mjs); the
// build fails when a bundled package has no licence file.
//
//   node scripts/build.mjs           into dist/
//   node scripts/build.mjs <folder>  into another folder (relative to server/), leaving dist/ as it is
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { thirdPartyLicences } from "./licenses.mjs";

const serverDir = fileURLToPath(new URL("../", import.meta.url));
const outdir = resolve(serverDir, process.argv[2] ?? "dist");

/** The package the bundle leaves outside: libSQL's native part. */
const external = ["libsql"];

const result = await build({
  absWorkingDir: serverDir,
  entryPoints: ["src/node/main.ts"],
  outfile: join(outdir, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external,
  metafile: true,
  // Some bundled packages (ImapFlow, Nodemailer, sanitize-html) are CommonJS and require Node's own modules.
  banner: { js: 'import { createRequire as __usualMailRequire } from "node:module"; const require = __usualMailRequire(import.meta.url);' },
  logLevel: "info",
});

// The bundle's own run-time dependencies: each external at the version the server's lockfile holds (`libsql` comes
// with `@libsql/client`, which package.json pins).
const lock = JSON.parse(readFileSync(join(serverDir, "package-lock.json"), "utf8"));
const dependencies = Object.fromEntries(external.map((name) => {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`The server's lockfile holds no ${name}`);
  return [name, version];
}));
mkdirSync(outdir, { recursive: true });
writeFileSync(
  join(outdir, "runtime.package.json"),
  `${JSON.stringify({ name: "usual-mail-server", private: true, type: "module", dependencies }, null, 2)}\n`,
);

// The dashboard's fonts and icons are in the bundle as strings of its generated module, with their licences, which
// it also serves at /assets/licences/.
const { ASSET_PATHS, ASSETS } = await import("../../dashboard/src/generated/assets.ts");
const embedded = Object.keys(ASSET_PATHS)
  .filter((name) => name.startsWith("licences/"))
  .sort()
  .map((name) => {
    const asset = ASSETS[ASSET_PATHS[name]];
    return [name.slice("licences/".length), asset.base64 ? Buffer.from(asset.body, "base64").toString("utf8") : asset.body];
  });
if (embedded.length === 0) throw new Error("The dashboard's generated assets hold no licences/: its fonts and icons would have none");
writeFileSync(
  join(outdir, "THIRD_PARTY_LICENSES.txt"),
  thirdPartyLicences(result.metafile, serverDir, {
    title: "Third-party licences in Usual Mail's server bundle (dist/server.mjs)",
    embedded: [{ heading: "The dashboard's fonts (Geist, Prociono) and icons (Hugeicons), embedded in the bundle", texts: embedded }],
  }),
);
