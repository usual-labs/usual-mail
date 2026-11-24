// Bundles the command into one file, dist/usual-mail.mjs, with core's routes inside. No runtime dependencies.
// `node scripts/build.mjs` writes it; tests call `build(outfile)` to bundle into a scratch directory.

import { build as esbuild } from "esbuild";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function build(outfile = join(root, "dist", "usual-mail.mjs")) {
  await esbuild({
    entryPoints: [join(root, "src", "cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: "#!/usr/bin/env node\n// usual-mail: run your own Usual Mail server. Bundled from cli/; `usual-mail --help` lists its commands." },
    logLevel: "error",
  });
  chmodSync(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Wrote ${await build()}`);
}
