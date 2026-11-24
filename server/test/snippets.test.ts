// A thread's snippet (docs/contract.md, "Words"): plain reading text from its newest shown message, made the way a
// model reads a message (`modelText`: the text part, or the HTML's text when there is none or a stub) with links,
// tags, entities and control characters gone, cut at a word boundary; and, once at a first start, every stored
// thread's snippet made again by that rule, from the stored message bodies. Made-up mail only.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { MailEvent } from "@usualmail/core";
import { eq } from "drizzle-orm";
import { MOMENT_PASS } from "../src/ai/passes.ts";
import { PAYMENT_RULES } from "../src/ai/payment-store.ts";
import { acceptLine } from "../src/ai/prompt.ts";
import { SNIPPET_LIMIT, snippetText } from "../src/ai/text.ts";
import { serverState, threads } from "../src/db/index.ts";
import { MailServer } from "../src/index.ts";
import { historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

describe("a snippet", () => {
  const cases: Array<[string, string | null, string | null, string]> = [
    ["plain text stays", "Thanks for Thursday!", null, "Thanks for Thursday!"],
    ["a markdown-style link keeps its text", "Your parcel is on its way. [Track it](https://parcelway.example/t/PW1?x=1) or reply.", null, "Your parcel is on its way. Track it or reply."],
    ["a link in angle brackets goes", "Read more <https://news.example/a/b> today.", null, "Read more today."],
    ["a naked link goes", "See https://shop.example/orders/55 for details.", null, "See for details."],
    ["a mail that is only a link keeps its host", "https://www.fernhill.example/promo?id=1", null, "fernhill.example"],
    ["an HTML-only mail: its text, no head, styles or entities", null,
      "<html><head><meta charset=\"utf-8\"><title>Hi</title><style>p { color: red }</style></head><body><p>Hello&nbsp;there&zwnj;&#8204; friend</p></body></html>", "Hello there friend"],
    ["a text part that is HTML is read as HTML", "<html> <head> <meta name=\"x\" content=\"y\"> </head><body><div>Your code is ready</div></body></html>", null, "Your code is ready"],
    ["entities in a text part are read", "Hi&zwnj; there &amp; welcome &#8212; &bogus; done", null, "Hi there & welcome — done"],
    ["a stub text part gives way to the HTML's text", "View this email online",
      `<p>${"Your order of walking boots is confirmed and will ship soon. ".repeat(3)}</p>`, "Your order of walking boots is confirmed and will ship soon. Your order of walking boots is confirmed and will ship soon. Your order of walking boots is confirmed and will ship soon."],
    ["invisible characters, padding, dividers and line breaks collapse", "Hello​­ world\n\n-----------\n\n\tBye", null, "Hello world --- Bye"],
    ["control characters and leftover tags go", "Hi\u0007 there, price <b>low</b>‮ now", null, "Hi there, price low now"],
    ["nothing to read is empty", null, null, ""],
  ];
  for (const [name, text, html, expected] of cases) {
    test(name, () => assert.equal(snippetText(text, html), expected));
  }

  test(`is cut at a word boundary within ${SNIPPET_LIMIT} characters, and is always a safe plain line`, () => {
    const long = snippetText("Walking boots ".repeat(30), null);
    assert.ok(long.length <= SNIPPET_LIMIT && long.endsWith("boots") && !long.endsWith(" "), long);
    const word = snippetText("x".repeat(250), null);
    assert.equal(word.length, SNIPPET_LIMIT, "a single word longer than the limit is cut at it");
    for (const [, text, html] of cases) {
      const made = snippetText(text, html);
      if (made) assert.ok("summary" in acceptLine(made, 1_000), `${made}: passes the summary's checks`);
    }
  });
});

let t: TestServer;
beforeEach(async () => {
  t = await makeServer();
});
afterEach(() => t.close());

describe("a thread's snippet", () => {
  test("comes from its newest message, made plain as it arrives", async () => {
    const { inbox } = await t.connect({ address: "me@snippets.example", history: [historyFromKnown] });
    const thread = await t.receive(inbox, { from: KNOWN, subject: "Parcel", text: "On its way: [Track it](https://parcelway.example/t/1) <https://parcelway.example/help>" });
    assert.equal(thread.snippet, "On its way: Track it");
  });

  test("is made again once at a first start, from the stored bodies: a change for threads not done, silent for done ones", async () => {
    const { inbox } = await t.connect({ address: "me@snippets.example", history: [historyFromKnown] });
    const open = await t.receive(inbox, { from: KNOWN, subject: "Open", text: "Hello [there](https://a.example/x)" });
    const done = await t.receive(inbox, { from: KNOWN, subject: "Finished", html: "<html><head><title>T</title></head><body>Bye&zwnj; now</body></html>" });
    const same = await t.receive(inbox, { from: KNOWN, subject: "Same", text: "Nothing to change" });
    await t.server.act(t.person, { threadIds: [done.id], action: { kind: "done" } });
    await t.server.stop();
    // As a store from before: the old snippets, the payment rules' pass had and this one not.
    await t.host.db.update(threads).set({ snippet: "Hello [there](https://a.example/x)" }).where(eq(threads.id, open.id));
    await t.host.db.update(threads).set({ snippet: "<html> <head> T Bye&zwnj; now" }).where(eq(threads.id, done.id));
    await t.host.db.update(serverState).set({ paymentRulesApplied: PAYMENT_RULES });
    const versions = new Map((await t.host.db.select().from(threads)).map((row) => [row.id, row.version]));
    t.models.requests.length = 0;
    const events: MailEvent[] = [];
    const stop = t.host.events.subscribe((event) => events.push(event));
    const again = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await again.start();
    await again.whenIdle();
    const row = async (id: string) => (await t.host.db.select().from(threads).where(eq(threads.id, id)).get())!;
    assert.deepEqual([(await row(open.id)).snippet, (await row(done.id)).snippet, (await row(same.id)).snippet], ["Hello there", "Bye now", "Nothing to change"]);
    assert.ok((await row(open.id)).version > versions.get(open.id)! && (await row(done.id)).version > versions.get(done.id)!);
    assert.equal((await row(same.id)).version, versions.get(same.id), "unchanged: no new version");
    stop();
    const changed = events.filter((event): event is Extract<MailEvent, { type: "thread.changed" }> => event.type === "thread.changed").map((event) => event.thread.id);
    assert.ok(changed.includes(open.id) && !changed.includes(done.id), "announced for the open thread; the done one changed silently");
    assert.deepEqual(t.models.requests, [], "no AI request");
    assert.ok(t.infos.includes("Snippets made plain: 2 threads (1 done, changed silently)"));
    assert.equal((await t.host.db.select().from(serverState).get())!.paymentRulesApplied, MOMENT_PASS, "the last pass by rule");
    await again.stop();

    t.infos.length = 0;
    await t.host.db.update(threads).set({ snippet: "changed by hand" }).where(eq(threads.id, same.id));
    const third = await MailServer.create(t.host, { providers: t.providers, models: t.models });
    await third.start();
    await third.whenIdle();
    assert.equal((await row(same.id)).snippet, "changed by hand", "once");
    assert.ok(!t.infos.some((line) => line.startsWith("Snippets made plain") || line.startsWith("Payment details by rule")));
    await third.stop();
  });
});
