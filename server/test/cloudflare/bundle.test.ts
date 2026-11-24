// The deployable bundle, built from wrangler.jsonc as `npx wrangler deploy` builds it: Gmail only (no ImapFlow, no SMTP
// client), none of the test entry's hooks, no demo, development or Node-only code (its source map names every file it
// holds), and nothing imported that workerd doesn't provide.

import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { buildWorker, ROOT, TEST_ENTRY, wranglerConfig } from "./harness.ts";

/** The repository's files a built script holds, as its source map names them, relative to the repository's root. */
async function ownSources(script: string): Promise<string[]> {
  const map = JSON.parse(await readFile(`${script}.map`, "utf8")) as { sources: string[] };
  return map.sources.filter((source) => !source.includes("node_modules/") && !source.includes(":")).map((source) => relative(ROOT, resolve(dirname(script), source)));
}

/** Files of ours that must never be in the deployable bundle: demo mode, fake models, test doubles, the Node host, tests. */
const NEVER_BUNDLED = /(?:^|\/)(?:server\/src\/(?:demo|testing|node)\/|server\/src\/ai\/fake|server\/test\/|mail\/src\/(?:testing|imap|smtp)\b|core\/fixtures\/)/;

test("builds the deployable Worker without test hooks, demo or development code, IMAP or an SMTP client", async () => {
  const config = await wranglerConfig();
  assert.equal(config.main, "server/src/cloudflare/worker.ts");
  const build = await buildWorker();
  try {
    const text = await readFile(build.script, "utf8");
    const size = (await stat(build.script)).size;
    const upload = /Total Upload: ([\d.]+ KiB) \/ gzip: ([\d.]+ KiB)/.exec(build.output);
    assert.ok(upload, build.output);
    console.log(`The deployable bundle: ${upload[1]}, ${upload[2]} gzipped (${(size / 1024).toFixed(0)} KiB on disk)`);
    assert.match(build.output, /env\.SERVER \(UsualMailServer\)\s+Durable Object/);
    for (const hook of ["__test/", "Reset by a test", "TEST_BACKSTOP_MS"]) {
      assert.ok(!text.includes(hook), `the test entry's ${hook} is not in the deployable bundle`);
    }
    for (const name of ["imapflow", "ImapFlow", "smtp-connection", "SMTPConnection", "hoodiecrow", "FakeGmail"]) {
      assert.ok(!text.includes(name), `${name} is not bundled`);
    }
    // Every file of ours the bundle holds, from its source map (wrangler writes one beside the script).
    const ours = await ownSources(build.script);
    assert.ok(ours.some((source) => source === "server/src/cloudflare/object.ts"), "the source map names the bundle's files");
    assert.deepEqual(ours.filter((source) => NEVER_BUNDLED.test(source)), [], "no demo, development, test or Node-only file is bundled");
    for (const name of ["seedSample", "demoProviders", "FakeModels", "dev-fake", "DEVELOPMENT ONLY", "MemoryMailbox"]) {
      assert.ok(!text.includes(name), `${name} is not bundled`);
    }
    const imports = new Set([...text.matchAll(/^import .* from "([^"]+)";?$/gm)].map((match) => match[1]!));
    const foreign = [...imports].filter((name) => !name.startsWith("node:") && name !== "cloudflare:workers" && !["fs", "path", "url"].includes(name));
    assert.deepEqual(foreign, [], `only workerd's own modules are imported: ${[...imports].join(", ")}`);
    assert.match(text, /export\s*\{[^}]*UsualMailServer/);
  } finally {
    await rm(build.dir, { recursive: true, force: true });
  }
  // The control: the test entry's bundle does carry its hooks.
  const tests = await buildWorker(TEST_ENTRY);
  try {
    const text = await readFile(tests.script, "utf8");
    for (const hook of ["__test/", "Reset by a test"]) assert.ok(text.includes(hook), hook);
    assert.ok((await ownSources(tests.script)).some((source) => NEVER_BUNDLED.test(source)), "the test entry's own files are named");
  } finally {
    await rm(tests.dir, { recursive: true, force: true });
  }
});
