// What a model reads of a message's text (src/ai/text.ts; the audit of 2026-11-19 found a third of the messages cut at
// 4,000 characters, most of them mostly links, invisible padding and divider lines, and two whose text part was a stub
// with the real mail only in the HTML). The same field as before, with less noise, in both jobs; the screening gate's
// own check still reads the message as it always did.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { dataItems, type ChoiceRequest, type TextRequest } from "../src/index.ts";
import { cleanText, isStubText, modelText, plainText, readableHtml, STUB_RATIO, STUB_TEXT } from "../src/ai/text.ts";
import { historyFromKnown, KNOWN, makeServer, type TestServer } from "./helpers.ts";

describe("cleaning a message's text", () => {
  test("a link keeps its scheme and site, never its path, query or who signed in", () => {
    assert.equal(cleanText("Track it: https://track.shop.example/t/8c1f9e?u=42&utm_source=mail#top now"), "Track it: https://track.shop.example/… now");
    assert.equal(cleanText("Go to http://Shop.example."), "Go to http://shop.example.", "a link with nothing after its site stays whole, and a full stop after it stays");
    assert.equal(cleanText("(see https://shop.example/a/b), then <https://user:pw@login.example:8443/x>"), "(see https://shop.example/…), then <https://login.example:8443/…>");
    assert.equal(cleanText("Unsubscribe: https://lists.example/u?e=dana%40lumen.example"), "Unsubscribe: https://lists.example/…", "an address in a link goes with it");
  });

  test("invisible characters and padding go, and other spaces become one", () => {
    const padding = "͏ ‌".repeat(80);
    assert.equal(cleanText(`Your order shipped${padding}​ today­.`), "Your order shipped today.");
    assert.equal(cleanText("A  　b\t\tc  d"), "A b c d");
    assert.equal(cleanText("left‎mark ‮flipped‬ ﻿bom"), "leftmark flipped bom");
  });

  test("a divider line becomes a short one; ratings, sums and words stay", () => {
    assert.equal(cleanText(`Total\n${"=".repeat(60)}\nEUR 12.00`), "Total\n===\nEUR 12.00");
    assert.equal(cleanText(`${"─".repeat(40)}\n${"- ".repeat(30)}\n${"*".repeat(8)}`), "───\n---\n***");
    assert.equal(cleanText("★★★★★ … wait!!!! $$$$ 1000000"), "★★★★★ … wait!!! $$$$ 1000000");
  });

  test("blank lines and spaces at the ends of lines collapse, the lines themselves stay", () => {
    assert.equal(cleanText("  Hello  \r\n\r\n\r\n\r\n  world \n\n \n end  "), "Hello\n\nworld\n\nend");
  });
});

describe("text made from HTML", () => {
  test("entities are read, so padding made of them is invisible too", () => {
    assert.equal(readableHtml("<p>Fish&nbsp;&amp;&nbsp;chips &mdash; &#8364;9&#x2c; &hellip;</p>&zwnj;&#847;&shy;"), "Fish & chips — €9, …");
    assert.equal(readableHtml("<p>&amp;lt;b&amp;gt; stays text</p>"), "&lt;b&gt; stays text", "read once, never twice");
    assert.equal(readableHtml("<style>p{}</style><p>Hi</p><script>x()</script>"), "Hi");
  });
});

describe("a stub text part", () => {
  const html = `<html><body><h1>Your booking</h1><p>${"Check-in from 3 pm, room 12, two nights. ".repeat(12)}</p></body></html>`;

  test(`is under ${STUB_TEXT} characters once cleaned while the HTML gives at least ${STUB_RATIO} times as much`, () => {
    assert.equal(isStubText("View this email in your browser: https://mail.example/v/1234567890abcdef", html), true);
    assert.equal(modelText("View this email in your browser: https://mail.example/v/1234567890abcdef", html).startsWith("Your booking"), true, "the HTML's text is read instead");
    assert.equal(isStubText("Thanks, see you then!", "<p>Thanks, see you then!</p>"), false, "a short mail with a short HTML part is just short");
    assert.equal(isStubText("x".repeat(STUB_TEXT), `<p>${"y".repeat(STUB_TEXT * 10)}</p>`), false, "long enough to be the text");
    assert.equal(isStubText("Short.", null), false, "no HTML, nothing to prefer");
    assert.equal(modelText(null, html).startsWith("Your booking"), true, "no text part: the HTML's text, as before");
    assert.equal(modelText("  ", null), "");
  });
});

describe("the screening gate's own check", () => {
  test("still reads the message as before: the text part untouched, links whole", () => {
    assert.equal(plainText("Code: https://x.example/verify?code=482913 ", "<p>ignored</p>"), "Code: https://x.example/verify?code=482913");
    assert.equal(plainText(null, "<p>A&nbsp;b &zwnj;</p>"), "A b &zwnj;");
  });
});

describe("in each job's request", () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await makeServer();
  });
  afterEach(() => t.close());

  test("both jobs read the cleaned text, cut after cleaning, and a summary request still carries no address", async () => {
    const { inbox } = await t.connect({ address: "me@text.example", history: [historyFromKnown] });
    await t.aiOn();
    const noise = Array.from({ length: 80 }, (_, i) => `https://click.shop.example/ls/click?upn=${"a".repeat(40)}${i}`).join("\n");
    await t.receive(inbox, {
      from: KNOWN,
      subject: "Your order",
      text: `View online: https://shop.example/view/abc`,
      html: `<p>Order 1187 for dana@lumen.example</p><p>${"&zwnj;&nbsp;".repeat(200)}</p><pre>${noise}</pre><p>${"_".repeat(70)}</p><p>Total EUR 41.90</p>`,
    });
    const categorize = dataItems((t.models.sent("choose")[0]!.request as ChoiceRequest).data)[0]!;
    const text = String(categorize.text);
    assert.ok(text.startsWith("Order 1187 for dana@lumen.example"), "the stub's HTML is read");
    assert.ok(text.endsWith("___\nTotal EUR 41.90"), "the total, past what was 4,000 characters of noise, is read");
    assert.ok(text.length < 4_000);
    assert.ok(!text.includes("upn=") && !text.includes("&zwnj;"));

    // A receipt here, so the summarize job asks for its details: the same data a summary request carries.
    const summarize = dataItems((t.models.requests.find((sent) => sent.kind !== "choose")!.request as TextRequest).data);
    assert.ok(String(summarize[1]!.text).startsWith("Order 1187 for [address]"), "addresses are still replaced");
    assert.ok(String(summarize[1]!.text).includes("https://click.shop.example/…"));
  });
});
