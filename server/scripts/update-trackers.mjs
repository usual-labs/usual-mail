// Writes src/pictures/trackers.json (and trackers.LICENSE beside it) from MailTrackerBlocker's list of email
// trackers, at the commit given: `node scripts/update-trackers.mjs <commit>`. Run by hand when updating the list for
// a release, then review the difference like any other change. The server never downloads the list itself.
//
// The list is MailTrackerBlocker's (https://github.com/apparition47/MailTrackerBlocker, BSD-3-Clause): a dictionary
// in Source/MTBBlockedMessage.m from each tracker's maker to regular expressions over a picture's address. The
// generated file keeps the licence text, so a bundle that carries the list carries its notice. Another list can take
// its place as long as it is written in the same shape: { source, trackers: [{ name, patterns }] }.
import { writeFileSync } from "node:fs";

const REPOSITORY = "apparition47/MailTrackerBlocker";
const LIST_PATH = "Source/MTBBlockedMessage.m";

const commit = process.argv[2];
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("Usage: node scripts/update-trackers.mjs <the 40-character commit to take the list from>");
  process.exit(2);
}

async function download(path) {
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path}`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** The dictionary literal `getTrackerDict` returns: `@{ @"Maker": @[ @"pattern", ... ], ... }`. */
function parseTrackerDict(source) {
  const start = source.indexOf("getTrackerDict");
  const open = start < 0 ? -1 : source.indexOf("@{", start);
  if (open < 0) throw new Error("No getTrackerDict dictionary in the file");
  const trackers = [];
  let i = open + 2;
  let current = null;
  let key = null;
  const string = () => {
    // An Objective-C string literal: @"..." with backslash escapes.
    let out = "";
    i += 2;
    while (i < source.length && source[i] !== '"') {
      if (source[i] === "\\") {
        const next = source[i + 1];
        out += next === "\\" ? "\\" : next === '"' ? '"' : next === "n" ? "\n" : `\\${next}`;
        i += 2;
      } else {
        out += source[i++];
      }
    }
    i++;
    return out;
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s|,/.test(c)) i++;
    else if (source.startsWith("//", i)) i = source.indexOf("\n", i) + 1;
    else if (source.startsWith("/*", i)) i = source.indexOf("*/", i) + 2;
    else if (source.startsWith('@"', i)) {
      const value = string();
      if (current) current.patterns.push(value);
      else key = value;
    } else if (c === ":") i++;
    else if (source.startsWith("@[", i)) {
      if (key === null) throw new Error(`A list without a name near character ${i}`);
      current = { name: key, patterns: [] };
      key = null;
      i += 2;
    } else if (c === "]") {
      if (!current) throw new Error(`An unexpected ] near character ${i}`);
      trackers.push(current);
      current = null;
      i++;
    } else if (c === "}") break;
    else throw new Error(`Unexpected ${JSON.stringify(c)} near character ${i}`);
  }
  return trackers;
}

const [listSource, licence] = await Promise.all([download(LIST_PATH), download("LICENSE")]);
const trackers = parseTrackerDict(listSource);
const names = new Set();
for (const tracker of trackers) {
  if (names.has(tracker.name)) throw new Error(`${tracker.name} is listed twice`);
  names.add(tracker.name);
  if (tracker.patterns.length === 0) throw new Error(`${tracker.name} has no patterns`);
  for (const pattern of tracker.patterns) new RegExp(pattern, "i"); // throws on a pattern JavaScript can't read
}
trackers.sort((a, b) => a.name.localeCompare(b.name, "en"));
const patterns = trackers.reduce((sum, tracker) => sum + tracker.patterns.length, 0);
const source = {
  name: "MailTrackerBlocker",
  repository: `https://github.com/${REPOSITORY}`,
  commit,
  path: LIST_PATH,
  license: "BSD-3-Clause",
  licenseText: licence.trim(),
};
const out = new URL("../src/pictures/", import.meta.url);
writeFileSync(new URL("trackers.json", out), `${JSON.stringify({ source, trackers }, null, 1)}\n`);
writeFileSync(
  new URL("trackers.LICENSE", out),
  `The list of email trackers in trackers.json comes from MailTrackerBlocker\n(${source.repository}, ${LIST_PATH} at commit ${commit}),\nunder this licence:\n\n${source.licenseText}\n`,
);
console.log(`Wrote ${trackers.length} trackers with ${patterns} patterns from ${REPOSITORY} at ${commit}.`);
