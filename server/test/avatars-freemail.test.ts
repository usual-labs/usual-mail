// Mailbox providers anyone can sign up to are never a brand: a sender at one of them never wears the provider's logo.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isFreemail, isSharedPlatform, MAIL_COM_DOMAINS } from "../src/avatars/freemail.ts";
import { avatarDomain } from "../src/avatars/rules.ts";
import { TEST_SUFFIXES } from "./avatar-hosts.ts";

describe("mailbox providers anyone can sign up to", () => {
  test("are known by their registrable domain", () => {
    for (const domain of ["gmail.com", "googlemail.com", "icloud.com", "proton.me", "fastmail.com", "web.de", "qq.com"]) {
      assert.equal(isFreemail(domain), true, domain);
    }
  });

  test("are known in every country by their first label", () => {
    for (const domain of ["hotmail.com", "hotmail.co.uk", "outlook.de", "yahoo.co.jp", "gmx.at", "yandex.ru", "aol.example"]) {
      assert.equal(isFreemail(domain), true, domain);
    }
  });

  test("don't take in the providers' own other domains, or brands that merely contain their names", () => {
    for (const domain of ["google.com", "microsoft.com", "apple.com", "brand.example", "gmail.brand.example", "notgmail.com", "yahooshop.example", "mail.example"]) {
      assert.equal(isFreemail(domain), false, domain);
    }
  });
});

describe("the gaps the review of 2026-11-19 found", () => {
  test("Microsoft's live.* in every country, Zoho's consumer domains, and mail.com's whole published list", () => {
    for (const domain of ["live.fr", "live.co.uk", "live.com.au", "live.nl", "zoho.eu", "zoho.in", "zohomail.com", "zohomail.com.au", "consultant.com", "post.com", "myself.com", "dr.com", "engineer.com", "europe.com", "usa.com", "techie.com"]) {
      assert.equal(isFreemail(domain), true, domain);
    }
    assert.ok(MAIL_COM_DOMAINS.length >= 140, "mail.com's list, as its domains page publishes it");
    for (const domain of MAIL_COM_DOMAINS) assert.equal(isFreemail(domain), true, domain);
  });

  test("a platform anyone can sign up to is no brand: not its tenants, groups or writers, nor the platform itself", () => {
    for (const host of ["contoso.onmicrosoft.com", "onmicrosoft.com", "googlegroups.com", "groups.io", "someone.substack.com", "substack.com", "mail.beehiiv.com", "someone.ghost.io", "buttondown.email"]) {
      assert.equal(isSharedPlatform(host), true, host);
    }
    for (const host of ["microsoft.com", "google.com", "notsubstack.com", "substack.com.evil.example", "brand.example"]) {
      assert.equal(isSharedPlatform(host), false, host);
    }
  });

  test("so a proved platform domain gives no picture", () => {
    assert.equal(avatarDomain("contoso.onmicrosoft.com", "team@contoso.onmicrosoft.com", TEST_SUFFIXES), null);
    assert.equal(avatarDomain("googlegroups.com", "club@googlegroups.com", TEST_SUFFIXES), null);
    assert.equal(avatarDomain("live.fr", "someone@live.fr", TEST_SUFFIXES), null);
    assert.equal(avatarDomain("mail.brand.example", "news@mail.brand.example", TEST_SUFFIXES), "brand.example");
  });
});

