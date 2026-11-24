// Writes src/avatars/suffixes.json (and suffixes.LICENSE beside it) from the Public Suffix List at the commit given:
// `node scripts/update-suffixes.mjs <commit>`. Run by hand when updating the list for a release, then review the
// difference like any other change. The server never downloads the list itself.
//
// The list is Mozilla's (https://github.com/publicsuffix/list, public_suffix_list.dat), under the Mozilla Public
// License 2.0. suffixes.json holds its rules converted to ASCII (`rulesFromList` in src/avatars/suffixes.ts), so it is
// a modified form of that file and stays under the same licence; suffixes.LICENSE says where the original is.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rulesFromList } from "../src/avatars/suffixes.ts";

const REPOSITORY = "publicsuffix/list";
const LIST_PATH = "public_suffix_list.dat";

const commit = process.argv[2];
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("Usage: node scripts/update-suffixes.mjs <the 40-character commit to take the list from>");
  process.exit(2);
}

async function download(path) {
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path}`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

const [listText, licence] = await Promise.all([download(LIST_PATH), download("LICENSE")]);
const rules = rulesFromList(listText);
for (const [section, list] of Object.entries(rules)) {
  if (new Set(list).size !== list.length) throw new Error(`The ${section} section lists a rule twice`);
}
// The list has thousands of rules in each section; far fewer means the file isn't the list.
if (rules.icann.length < 5_000 || rules.private.length < 1_000) {
  throw new Error(`Only ${rules.icann.length} ICANN and ${rules.private.length} private rules: is this the list?`);
}
const source = {
  name: "Public Suffix List",
  repository: `https://github.com/${REPOSITORY}`,
  commit,
  path: LIST_PATH,
  license: "MPL-2.0",
  // The downloaded file as it was, so a later reader can check it against the commit.
  bytes: new TextEncoder().encode(listText).length,
  lines: listText.split("\n").length - (listText.endsWith("\n") ? 1 : 0),
  sha256: createHash("sha256").update(listText).digest("hex"),
};
const out = new URL("../src/avatars/", import.meta.url);
writeFileSync(new URL("suffixes.json", out), `${JSON.stringify({ source, icann: rules.icann, private: rules.private })}\n`);
writeFileSync(
  new URL("suffixes.LICENSE", out),
  `suffixes.json holds the rules of the Public Suffix List\n(${source.repository}, ${LIST_PATH} at commit ${commit}),\n` +
    `converted to ASCII. It is a modified form of that file and is available under the\nMozilla Public License 2.0, ` +
    `whose text follows. The original is at\n${source.repository}/blob/${commit}/${LIST_PATH}\n\n${licence.trim()}\n`,
);
console.log(`Wrote ${rules.icann.length} ICANN and ${rules.private.length} private rules from ${REPOSITORY} at ${commit} (${source.bytes} bytes, ${source.lines} lines, sha256 ${source.sha256}).`);
