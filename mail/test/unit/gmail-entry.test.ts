/**
 * `@usualmail/mail/gmail` pulls in no IMAP or SMTP code: the static import graph from `src/gmail/index.ts`, followed
 * through this package's sources and, by Node's own resolution, into every dependency's files (`import`, `export …
 * from`, `import()` and `require()` with a literal name), reaches no file of `src/imap/`, no ImapFlow, no SMTP client
 * or server. Sending composes with Nodemailer's MailComposer only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const SPECIFIERS = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const builtins = new Set(builtinModules);

/** Every file reachable from `entry`, and the packages they name. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier || specifier.startsWith("node:") || builtins.has(specifier) || builtins.has(specifier.split("/")[0]!)) continue;
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          queue.push(target.endsWith(".ts") ? target : createRequire(file).resolve(specifier));
          continue;
        }
        packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
        try {
          queue.push(createRequire(file).resolve(specifier));
        } catch {
          // A name only a bundler or another platform resolves (an optional dependency); it is still listed above.
        }
      }
    }
  }
  return { files, packages };
}

it("the Gmail entry reaches no IMAP or SMTP code", () => {
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  const { files, packages } = importGraph(resolve(src, "gmail/index.ts"));
  const own = [...files].filter((file) => file.startsWith(src)).map((file) => file.slice(src.length));
  assert.ok(own.includes("gmail/provider.ts") && own.includes("message/parse.ts"), "the walk followed the sources");
  assert.deepEqual(own.filter((file) => file.startsWith(`imap${sep}`) || file === "index.ts"), [], "no IMAP source, not the package's main entry");
  for (const name of ["imapflow", "smtp-server", "hoodiecrow-imap"]) assert.ok(!packages.has(name), `${name} isn't imported`);
  const reached = [...files].map((file) => file.split(sep).join("/"));
  assert.deepEqual(reached.filter((file) => /\/node_modules\/(imapflow|smtp-server|hoodiecrow-imap)\//.test(file)), []);
  const nodemailer = reached.filter((file) => file.includes("/node_modules/nodemailer/"));
  assert.deepEqual(nodemailer.filter((file) => /\/(smtp-|sendmail|ses-|stream-transport|json-transport|mailer\/)/.test(file)), [], "no Nodemailer transport");
  assert.ok(nodemailer.some((file) => file.endsWith("/mail-composer/index.js")), "MailComposer is what sending uses");
});

it("the package's main entry does reach ImapFlow, so the walk can see it", () => {
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  const { packages } = importGraph(resolve(src, "index.ts"));
  assert.ok(packages.has("imapflow"));
});
