// The licence texts of what the server's image holds from others, for its THIRD_PARTY_LICENSES.txt:
// - thirdPartyLicences(): the bundle's, from esbuild's metafile (scripts/build.mjs writes it to dist/);
// - `node scripts/licenses.mjs <node_modules folder>`: every package installed in that folder, printed (the
//   Dockerfile adds the image's own node_modules, libSQL's packages, to the bundle's file).
// Each npm package is named with its version and licence, followed by every LICENSE, LICENCE, COPYING and NOTICE
// file in its folder. A file of this repository with a licence of its own keeps it beside it as `<name>.LICENSE`
// (src/avatars/suffixes.LICENSE), which is included the same way. Sorted and with LF line endings, so the same
// inputs give the same text. Throws, naming them, when a package has no licence file: the image can't be passed on
// without its text. The only exceptions are the packages in STAND_INS, checked by hand.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const RULE = "=".repeat(78);
const TEXTS = fileURLToPath(new URL("licences/", import.meta.url));

/**
 * Packages that ship no licence file, checked 2026-11-23, and the text that stands in for it (in licences/), as long
 * as the package still states that licence. A package missing from here, or stating another licence, still fails.
 */
const STAND_INS = [
  {
    match: /^(@ai-sdk\/provider-utils|drizzle-orm)$/, licence: "Apache-2.0", file: "Apache-2.0.txt",
    source: "the standard Apache-2.0 text, from apache.org; Apache-2.0 asks for the licence itself, not a copyright line",
  },
  {
    match: /^@libsql\/(client|core)$/, licence: "MIT", file: "libsql-client-ts.txt",
    source: "the LICENSE of the package's repository, github.com/tursodatabase/libsql-client-ts at 9496c782af41",
  },
  {
    match: /^@libsql\/isomorphic-ws$/, licence: "MIT", file: "libsql-isomorphic-ts.txt",
    source: "the LICENSE of the package's repository, github.com/libsql/isomorphic-ts at ab3b09a269a7",
  },
  {
    match: /^@libsql\/(linux|darwin|win32)-[a-z0-9-]+$/, licence: "MIT", file: "libsql-js.txt",
    source: "the LICENSE of the package's repository, github.com/tursodatabase/libsql-js at 58861e8706af (the same as the libsql package's)",
  },
  {
    match: /^promise-limit$/, licence: "ISC", file: "ISC.txt",
    source: "the standard ISC text, from spdx.org: the package states ISC, but neither it nor its repository (github.com/featurist/promise-limit) has a licence file or a copyright line",
  },
];

/**
 * @typedef {{ heading: string, texts: Array<[name: string, text: string]> }} Section
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild's metafile
 * @param {string} workingDir the build's absWorkingDir, which the metafile's paths are relative to
 * @param {{ title: string, embedded?: Section[] }} options the text's first line; licences the bundle holds in
 *   another form (a generated module's strings), which the metafile can't show
 * @returns {string}
 */
export function thirdPartyLicences(metafile, workingDir, { title, embedded = [] }) {
  const packageDirs = new Set();
  const ownFiles = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const path = join(workingDir, input.replace(/^[a-z-]+:/, ""));
    const at = path.lastIndexOf("/node_modules/");
    if (at === -1) {
      const licence = join(dirname(path), `${basename(path, extname(path))}.LICENSE`);
      if (existsSync(licence)) ownFiles.set(licence, [...(ownFiles.get(licence) ?? []), relative(workingDir, path)]);
      continue;
    }
    const segments = path.slice(at + "/node_modules/".length).split("/");
    packageDirs.add(path.slice(0, at + "/node_modules/".length) + segments.slice(0, segments[0].startsWith("@") ? 2 : 1).join("/"));
  }
  const sections = packageSections([...packageDirs], workingDir);
  for (const licence of [...ownFiles.keys()].sort()) {
    const sources = ownFiles.get(licence).sort().join(", ");
    sections.push({ heading: `${sources} (in this repository)`, texts: [[basename(licence), readFileSync(licence, "utf8")]] });
  }
  return render(title, [...sections, ...embedded]);
}

/** Every package installed in a node_modules folder, nested ones too. */
export function installedLicences(nodeModules, title) {
  const dirs = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        for (const inner of readdirSync(join(folder, name)).sort()) visit(join(folder, name, inner));
      } else {
        visit(join(folder, name));
      }
    }
  };
  const visit = (dir) => {
    if (!existsSync(join(dir, "package.json"))) return;
    dirs.push(dir);
    if (existsSync(join(dir, "node_modules"))) walk(join(dir, "node_modules"));
  };
  walk(nodeModules);
  return render(title, packageSections(dirs, nodeModules));
}

/** One section per package (by name and version), sorted; throws for packages with no licence text. */
function packageSections(dirs, workingDir) {
  const packages = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const key = `${pkg.name}@${pkg.version}`;
    if (!packages.has(key)) packages.set(key, { pkg, dir });
  }
  const sections = [];
  const missing = [];
  for (const key of [...packages.keys()].sort()) {
    const { pkg, dir } = packages.get(key);
    const heading = `${pkg.name} ${pkg.version}, ${licenceOf(pkg)}`;
    const found = readdirSync(dir).filter((name) => LICENCE_FILE.test(name)).sort();
    const standIn = STAND_INS.find((entry) => entry.match.test(pkg.name) && entry.licence === pkg.license);
    if (found.length > 0) {
      sections.push({ heading, texts: found.map((name) => [name, readFileSync(join(dir, name), "utf8")]) });
    } else if (standIn) {
      sections.push({ heading, texts: [[`the package ships no licence file; ${standIn.source}`, readFileSync(join(TEXTS, standIn.file), "utf8")]] });
    } else {
      missing.push(`${key} (${relative(workingDir, dir)})`);
    }
  }
  if (missing.length > 0) throw new Error(`No licence file found for ${missing.length} package(s): ${missing.join(", ")}`);
  return sections;
}

function render(title, sections) {
  const out = [
    title,
    "",
    "These packages and files keep their own licences; Usual Mail's own code is under the GNU Affero General Public",
    "License, version 3 only (LICENSE). Each section is one package or file, with the text of every licence and",
    "notice file it comes with.",
  ];
  for (const { heading, texts } of sections) {
    out.push("", RULE, heading, RULE);
    for (const [name, text] of texts) out.push("", `--- ${name}`, "", text.replace(/\r\n?/g, "\n").trimEnd());
  }
  return `${out.join("\n")}\n`;
}

/** The licence a package states: the SPDX expression, or the older `licenses` list. */
function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return "licence not stated in package.json";
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) throw new Error("Usage: node scripts/licenses.mjs <node_modules folder>");
  process.stdout.write(installedLicences(folder, `Third-party licences of the packages in ${process.argv[3] ?? folder}`));
}
