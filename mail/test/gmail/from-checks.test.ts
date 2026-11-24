/**
 * What Gmail's own checker proved about each message's From domain, as the Gmail provider reports it when the server
 * asks (`ProviderOptions.authentication`): on every synced message (`fromCheck`) and, for mail stored before, read again
 * in the metadata form (`fromChecks`). Against the fake Gmail; made-up `.example` domains only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MailProvider, ProviderMessage } from "@usualmail/core";
import { createGmailProvider, parseMessage } from "../../src/index.ts";
import { FakeGmail, plainMessage, syncAll } from "../../src/testing/index.ts";

const ADDRESS = "me@inbox.example";
const organisationalDomain = (domain: string) => domain.split(".").slice(-2).join(".");

function setup(authentication = true) {
  const fake = new FakeGmail({ address: ADDRESS, now: () => Date.parse("2026-11-19T10:00:00Z") });
  const provider: MailProvider = createGmailProvider(fake.credentials, {
    fetch: fake.fetch,
    quotaPerSecond: 1_000_000,
    ...(authentication && { authentication: { organisationalDomain } }),
  });
  return { fake, provider };
}

/** A message as Gmail stores it: Gmail's own header on top, then the sender's. */
function received(subject: string, results: string | null, extra: string[] = []): string {
  const { raw } = plainMessage({ from: "Brand <news@brand.example>", to: ADDRESS, subject });
  const top = results === null ? [] : [`Authentication-Results: mx.google.com;\r\n       ${results}`];
  return [...top, ...extra, raw].join("\r\n");
}

const bySubject = (messages: Map<string, ProviderMessage>, subject: string) => [...messages.values()].find((m) => m.subject === subject)!;

describe("Gmail's word on the From domain", () => {
  it("comes with every synced message when the server asks", async () => {
    const { fake, provider } = setup();
    await fake.deliver(received("pass", "dkim=pass header.i=@brand.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.example"));
    await fake.deliver(received("fail", "dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=brand.example"));
    await fake.deliver(received("none", null));
    await fake.deliver(received("forged below", "spf=softfail smtp.mailfrom=a@evil.example", ["Authentication-Results: mx.google.com; dmarc=pass header.from=brand.example"]));
    const { messages } = await syncAll(provider, null);
    assert.deepEqual(bySubject(messages, "pass").fromCheck, { result: "verified", domain: "brand.example" });
    assert.deepEqual(bySubject(messages, "fail").fromCheck, { result: "unverified" });
    assert.deepEqual(bySubject(messages, "none").fromCheck, { result: "no_header" });
    assert.deepEqual(bySubject(messages, "forged below").fromCheck, { result: "repeated" });
  });

  it("isn't reported, nor read again, when the server doesn't ask", async () => {
    const { fake, provider } = setup(false);
    await fake.deliver(received("pass", "dmarc=pass header.from=brand.example"));
    const { messages } = await syncAll(provider, null);
    assert.equal([...messages.values()][0]!.fromCheck, undefined);
    assert.equal(provider.fromChecks, undefined);
  });

  it("is read again for stored mail in the metadata form, refs Gmail no longer has left out", async () => {
    const { fake, provider } = setup();
    const pass = await fake.deliver(received("pass", "dmarc=pass header.from=brand.example"));
    const none = await fake.deliver(received("none", null));
    const checks = await provider.fromChecks!([pass.id, none.id, "gone-ref"]);
    assert.deepEqual([...checks], [[pass.id, { result: "verified", domain: "brand.example" }], [none.id, { result: "no_header" }]]);
    const asked = fake.requests.filter((r) => r.path.includes("/messages/") && r.query.get("format") === "metadata");
    assert.equal(asked.length, 3);
    assert.deepEqual(asked[0]!.query.getAll("metadataHeaders"), ["Authentication-Results", "From"]);
  });
});

describe("parsing with the provider's checker", () => {
  it("proves the From address's own domain only", async () => {
    const raw = "Authentication-Results: mx.google.com; dmarc=pass header.from=brand.example\r\nFrom: Brand <news@brand.example>\r\nSubject: x\r\n\r\nHi\r\n";
    const parsed = await parseMessage(raw, { ownAddresses: [], authentication: { checker: "mx.google.com", organisationalDomain } });
    assert.deepEqual(parsed.fromCheck, { result: "verified", domain: "brand.example" });
    const other = raw.replace("From: Brand <news@brand.example>", "From: news@brand.example <other@evil.example>");
    assert.deepEqual((await parseMessage(other, { ownAddresses: [], authentication: { checker: "mx.google.com", organisationalDomain } })).fromCheck, { result: "unverified" });
    assert.equal((await parseMessage(raw, { ownAddresses: [] })).fromCheck, undefined);
  });
});
