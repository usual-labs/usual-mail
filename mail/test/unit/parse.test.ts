/**
 * MIME parsing against awkward real-world shapes: alternatives, nesting, inline pictures, calendar
 * invites, bounces, newsletters, odd charsets and encodings, missing or wrong dates, no Message-ID.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { attachmentContent, parseMessage, parseOrNote } from "../../src/message/parse.ts";

const OWN = ["me@mail.example"];
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const parse = (raw: Uint8Array | string, receivedAt?: Date) => parseMessage(raw, receivedAt ? { ownAddresses: OWN, receivedAt } : { ownAddresses: OWN });
const crlf = (lines: string[]) => lines.join("\r\n");

describe("parseMessage", () => {
  it("takes U+0000 out of the text, the HTML and the subject, keeping what comes after it", async () => {
    // libSQL reads a text back only up to its first U+0000, so a stored one would lose the rest of the message.
    const alternative = await parse(crlf([
      "From: Ann <ann@people.example>",
      "To: me@mail.example",
      "Subject: =?utf-8?q?Before=00After?=",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Before the NUL.=00After the NUL.",
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>Before=00After</p>",
      "--b--",
      "",
    ]));
    assert.equal(alternative.text, "Before the NUL.After the NUL.");
    assert.equal(alternative.html, "<p>BeforeAfter</p>");
    assert.equal(alternative.subject, "BeforeAfter");
    const htmlOnly = await parse(crlf([
      "From: Ann <ann@people.example>",
      "To: me@mail.example",
      "Subject: Only HTML",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>Before=00After the NUL.</p>",
      "",
    ]));
    for (const value of [htmlOnly.text, htmlOnly.html]) assert.ok(value !== undefined && !value.includes("\u0000") && value.includes("After the NUL."), value);
  });

  it("reads a quoted-printable multipart/alternative with encoded words and a group address", async () => {
    const m = await parse(fixture("alternative-qp.eml"));
    assert.equal(m.subject, "Grüße aus Köln");
    assert.deepEqual(m.from, { name: "Ann Müller", email: "ann@people.example" });
    assert.deepEqual(m.to, [{ name: "Me", email: "me@mail.example" }, { email: "bo@people.example" }]);
    assert.deepEqual(m.cc, [], "an empty group adds no address");
    assert.equal(m.date, "2026-11-10T07:15:00.000Z", "converted to UTC");
    assert.match(m.text!, /schöne Grüße aus Köln, mit einer sehr langen Zeile, die weich umbrochen wurde\./);
    assert.equal(m.html, "<p>Hallo,<br />schöne <b>Grüße</b> aus Köln</p>");
    assert.equal(m.messageId, "alt-1@people.example");
    assert.equal(m.threadKey, "mid:alt-1@people.example");
    assert.equal(m.automated, false);
    assert.equal(m.fromSelf, false);
  });

  it("finds text, html, an inline picture and an attachment with an RFC 2231 name in nested parts", async () => {
    const raw = fixture("nested.eml");
    const m = await parse(raw);
    assert.equal(m.text, "Thanks for your order.");
    assert.match(m.html!, /<style>p\{color:#333\}<\/style>/);
    assert.match(m.html!, /<img src="cid:logo123" \/>/);
    assert.equal(m.attachments.length, 2);
    const [logo, pdf] = m.attachments;
    assert.deepEqual(logo, { id: "0", filename: "image-1.gif", mimeType: "image/gif", size: 42, inline: true, contentId: "logo123" });
    assert.equal(pdf!.filename, "€ invoice 1042.pdf");
    assert.equal(pdf!.mimeType, "application/pdf");
    assert.equal(pdf!.inline, false);
    const bytes = await attachmentContent(raw, pdf!.id);
    assert.equal(Buffer.from(bytes!).toString("latin1").slice(0, 8), "%PDF-1.4");
    assert.equal(await attachmentContent(raw, "7"), undefined);
    assert.equal(await attachmentContent(raw, "../0"), undefined);
  });

  it("keeps a calendar invite as an attachment next to the text", async () => {
    const m = await parse(fixture("calendar-invite.eml"));
    assert.equal(m.text, "You have been invited to Planning.");
    const types = m.attachments.map((a) => [a.mimeType, a.filename]);
    assert.deepEqual(types, [
      ["text/calendar", "invite.ics"],
      ["application/ics", "invite.ics"],
    ]);
  });

  it("reads a bounce as automated, with the report attached", async () => {
    const m = await parse(fixture("bounce.eml"));
    assert.equal(m.automated, true);
    assert.equal(m.from.email, "mailer-daemon@mx.mail.example");
    assert.match(m.text!, /could not be delivered/);
    assert.ok(m.attachments.some((a) => a.mimeType === "message/delivery-status"));
  });

  it("reads a newsletter: list headers, automated, text from HTML, and the HTML made safe", async () => {
    const m = await parse(fixture("newsletter.eml"));
    assert.equal(m.listId, "weekly.letters.example");
    assert.equal(m.listUnsubscribe, "<https://letters.example/unsub?u=1>, <mailto:unsub@letters.example>");
    assert.equal(m.listUnsubscribePost, "List-Unsubscribe=One-Click");
    assert.equal(m.automated, true);
    assert.deepEqual(m.replyTo, [{ email: "hello@letters.example" }]);
    assert.equal(m.text, "Five good things\n\nCafé culture, naïve art & more.\n\n- One\n- Two\n\nbad Read online\n\nVote");
    const html = m.html!;
    assert.doesNotMatch(html, /script|onload|javascript:|@import|<form|<input|<button|<title/i);
    assert.match(html, /<a href="https:\/\/letters\.example\/read">Read online<\/a>/);
    assert.match(html, /<img src="https:\/\/letters\.example\/pixel\.gif" width="1" height="1" \/>/, "remote images stay");
    assert.match(html, /\.a\{color:red\}/, "the safe part of the style sheet stays");
  });

  it("decodes ISO-2022-JP, windows-1252 and KOI8-R, and survives unknown or mislabelled charsets", async () => {
    const jp = Buffer.concat([
      Buffer.from(crlf([
        "From: =?ISO-2022-JP?B?GyRCRURDZhsoQg==?= <tanaka@people.example>",
        "To: me@mail.example",
        "Subject: =?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=",
        "Content-Type: text/plain; charset=ISO-2022-JP",
        "",
        "",
      ])),
      Buffer.from("1b24424b5c4a382447243921231b2842", "hex"),
    ]);
    const m1 = await parse(jp);
    assert.equal(m1.subject, "こんにちは");
    assert.equal(m1.from.name, "田中");
    assert.equal(m1.text, "本文です。");

    const cp1252 = Buffer.concat([
      Buffer.from(crlf(["From: a@people.example", "Subject: =?windows-1252?Q?=80_and_=93quotes=94?=", "Content-Type: text/plain; charset=windows-1252", "", ""])),
      Buffer.from([0x80, 0x20, 0x93, 0x6f, 0x6b, 0x94]),
    ]);
    const m2 = await parse(cp1252);
    assert.equal(m2.subject, "€ and “quotes”");
    assert.equal(m2.text, "€ “ok”");

    const koi = Buffer.concat([
      Buffer.from(crlf(["From: a@people.example", "Subject: x", "Content-Type: text/plain; charset=koi8-r", "", ""])),
      Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]),
    ]);
    assert.equal((await parse(koi)).text, "Привет");

    const unknown = Buffer.concat([
      Buffer.from(crlf(["From: a@people.example", "Subject: x", "Content-Type: text/plain; charset=x-unknown-8bit", "", ""])),
      Buffer.from("Grüße", "latin1"),
    ]);
    const m4 = await parse(unknown);
    assert.ok(m4.text && m4.text.length > 0, "an unknown charset still gives text");

    const rawUtf8Headers = Buffer.from(crlf(["From: Zoë <zoe@people.example>", "Subject: Überraschung", "", "Body"]), "utf8");
    const m5 = await parse(rawUtf8Headers);
    assert.equal(m5.subject, "Überraschung");
    assert.equal(m5.from.name, "Zoë");
  });

  it("falls back to the time of receipt for a missing or far-future date, and hashes a thread key without a Message-ID", async () => {
    const received = new Date("2026-11-16T10:00:00Z");
    const m = await parse(fixture("no-date-no-id.eml"), received);
    assert.equal(m.date, "2026-11-16T10:00:00.000Z");
    assert.equal(m.messageId, undefined);
    assert.match(m.threadKey, /^hash:[0-9a-f]{32}$/);
    assert.equal((await parse(fixture("no-date-no-id.eml"), received)).threadKey, m.threadKey, "the hash is stable");

    const future = crlf(["From: a@people.example", "Subject: x", "Date: Fri, 01 Jan 2099 00:00:00 +0000", "", "x"]);
    assert.equal((await parse(future, received)).date, "2026-11-16T10:00:00.000Z");
    const garbage = crlf(["From: a@people.example", "Subject: x", "Date: sometime last week", "", "x"]);
    assert.equal((await parse(garbage, received)).date, "2026-11-16T10:00:00.000Z");
    const slightlyAhead = crlf(["From: a@people.example", "Subject: x", "Date: Mon, 16 Nov 2026 11:00:00 +0000", "", "x"]);
    assert.equal((await parse(slightlyAhead, received)).date, "2026-11-16T11:00:00.000Z", "clock skew within a day is kept");
  });

  it("threads a reply by the root of its References", async () => {
    const m = await parse(fixture("reply-chain.eml"));
    assert.equal(m.inReplyTo, "reply-2@mail.example");
    assert.deepEqual(m.references, ["lunch-1@people.example", "reply-2@mail.example"]);
    assert.equal(m.threadKey, "mid:lunch-1@people.example");
  });

  it("marks mail from the mailbox's own address", async () => {
    const m = await parse(crlf(["From: Me <ME@mail.example>", "To: bo@people.example", "Subject: mine", "", "x"]));
    assert.equal(m.fromSelf, true);
  });

  it("keeps inline pictures apart from attached ones, and cleans dangerous file names", async () => {
    const raw = crlf([
      "From: a@people.example",
      "Subject: pictures",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "See the pictures.",
      "--B",
      "Content-Type: image/png",
      "Content-Disposition: inline",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--B",
      "Content-Type: image/jpeg",
      'Content-Disposition: attachment; filename="../../etc/‮gpj.exe"',
      "Content-ID: <not-inline@people.example>",
      "Content-Transfer-Encoding: base64",
      "",
      "/9j/",
      "--B--",
      "",
    ]);
    const m = await parse(raw);
    assert.equal(m.attachments[0]!.inline, false, "inline disposition without a Content-ID isn't referenced from HTML");
    assert.equal(m.attachments[1]!.inline, false, "an attachment with a Content-ID is still an attachment");
    assert.equal(m.attachments[1]!.filename, "gpj.exe");
  });

  it("turns a message the parser refuses into a note instead of failing the sync", async () => {
    const parts = ["From: a@people.example", 'Content-Type: multipart/mixed; boundary="B"', ""];
    for (let i = 0; i < 10_050; i++) parts.push("--B", "", "x");
    parts.push("--B--", "");
    const m = await parseOrNote(crlf(parts), { ownAddresses: OWN, receivedAt: new Date("2026-11-16T00:00:00Z") }, "seed");
    assert.equal(m.subject, "(This message couldn't be read)");
    assert.equal(m.threadKey, "unreadable:seed");
    assert.equal(m.date, "2026-11-16T00:00:00.000Z");
  });
});
