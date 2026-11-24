// The Public Suffix List the server ships (src/avatars/suffixes.json, written by scripts/update-suffixes.mjs from a
// pinned commit). Until it is added, the file is an empty placeholder and the server shows no sender pictures; this
// test is skipped and says so, so the one thing left to add stays visible.

import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarDomain } from "../src/avatars/rules.ts";
import { SHIPPED_SUFFIXES, SHIPPED_SUFFIXES_SOURCE } from "../src/avatars/shipped.ts";

test("the shipped Public Suffix List is carried, with its source and licence", (t) => {
  if (!SHIPPED_SUFFIXES) {
    t.skip("NOT ADDED YET: the shipped Public Suffix List (run scripts/update-suffixes.mjs <commit> once the owner approves the download)");
    return;
  }
  assert.equal(SHIPPED_SUFFIXES_SOURCE?.license, "MPL-2.0");
  assert.match(SHIPPED_SUFFIXES_SOURCE?.commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(SHIPPED_SUFFIXES.registrableDomain("news.shop.example.co.uk"), "example.co.uk");
  assert.equal(SHIPPED_SUFFIXES.registrableDomain("mail.example.com"), "example.com");
  assert.equal(SHIPPED_SUFFIXES.registrableDomain("someone.github.io"), "someone.github.io", "a platform's customers are apart");
  assert.equal(SHIPPED_SUFFIXES.registrableDomain("co.uk"), null);
});

test("with the shipped list, platforms' tenants and groups are still no brand", (t) => {
  if (!SHIPPED_SUFFIXES) {
    t.skip("NOT ADDED YET: the shipped Public Suffix List (run scripts/update-suffixes.mjs <commit> once the owner approves the download)");
    return;
  }
  for (const [domain, email] of [
    ["contoso.onmicrosoft.com", "team@contoso.onmicrosoft.com"],
    ["googlegroups.com", "club@googlegroups.com"],
    ["someone.substack.com", "someone@someone.substack.com"],
    ["substack.com", "someone@substack.com"],
    ["live.co.uk", "someone@live.co.uk"],
    ["zoho.com.au", "someone@zoho.com.au"],
  ]) {
    assert.equal(avatarDomain(domain!, email!, SHIPPED_SUFFIXES), null, domain);
  }
});

