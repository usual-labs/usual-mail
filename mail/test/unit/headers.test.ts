/** Thread keys, message-id lists, list headers and the `automated` rule. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headerMap, isAutomated, isNoReplyAddress, listIdOf, messageIds, stripBrackets } from "../../src/message/headers.ts";
import { threadKeyFor } from "../../src/message/thread.ts";

const headers = (pairs: Record<string, string>) => headerMap(Object.entries(pairs).map(([key, value]) => ({ key, value })));

describe("thread keys", () => {
  it("use the first References id, then In-Reply-To, then the message's own id", () => {
    assert.equal(threadKeyFor({ messageId: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"] }, ""), "mid:a@x");
    assert.equal(threadKeyFor({ messageId: "c@x", inReplyTo: "b@x", references: [] }, ""), "mid:b@x");
    assert.equal(threadKeyFor({ messageId: "c@x", references: [] }, ""), "mid:c@x");
  });

  it("join a whole conversation when every reply keeps References", () => {
    const root = threadKeyFor({ messageId: "root@x", references: [] }, "");
    const reply = threadKeyFor({ messageId: "r1@x", inReplyTo: "root@x", references: ["root@x"] }, "");
    const replyToReply = threadKeyFor({ messageId: "r2@x", inReplyTo: "r1@x", references: ["root@x", "r1@x"] }, "");
    assert.equal(reply, root);
    assert.equal(replyToReply, root);
  });

  it("split when a client keeps only In-Reply-To deep in a conversation (a known limit)", () => {
    const root = threadKeyFor({ messageId: "root@x", references: [] }, "");
    const lossy = threadKeyFor({ messageId: "r2@x", inReplyTo: "r1@x", references: [] }, "");
    assert.notEqual(lossy, root);
  });

  it("hash the headers when there is no id at all", () => {
    const a = threadKeyFor({ references: [] }, "from:a\nsubject:x");
    assert.match(a, /^hash:[0-9a-f]{32}$/);
    assert.equal(threadKeyFor({ references: [] }, "from:a\nsubject:x"), a);
    assert.notEqual(threadKeyFor({ references: [] }, "from:b\nsubject:x"), a);
  });
});

describe("message id lists", () => {
  it("read bracketed ids, drop duplicates, and cope with missing brackets", () => {
    assert.deepEqual(messageIds("<a@x> <b@x>\r\n <a@x>"), ["a@x", "b@x"]);
    assert.deepEqual(messageIds("a@x b@x"), ["a@x", "b@x"]);
    assert.deepEqual(messageIds("<a@x> (comment) <b@x>"), ["a@x", "b@x"]);
    assert.deepEqual(messageIds(undefined), []);
    assert.deepEqual(messageIds("   "), []);
  });

  it("take the brackets off a message id, however many, and read as before 0.1.3 (the closing run read from its start)", () => {
    assert.equal(stripBrackets(" <<a@x>> "), "a@x");
    assert.equal(stripBrackets("a>b>>"), "a>b");
    const before = (value: string) => value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
    const parts = ["<", ">", "a", "@", " ", "\t"];
    for (let round = 0; round < 5_000; round++) {
      const value = Array.from({ length: Math.floor(Math.random() * 10) }, () => parts[Math.floor(Math.random() * parts.length)]).join("");
      assert.equal(stripBrackets(value), before(value), JSON.stringify(value));
    }
  });

  it("read the list id inside angle brackets, lower case", () => {
    assert.equal(listIdOf(`"Weekly" <Weekly.Letters.Example>`), "weekly.letters.example");
    assert.equal(listIdOf("plain.list.example"), "plain.list.example");
    assert.equal(listIdOf(undefined), undefined);
  });
});

describe("automated", () => {
  it("is true for auto-submitted mail, bulk precedence, list headers, reports, empty return paths and no-reply senders", () => {
    assert.equal(isAutomated(headers({ "auto-submitted": "auto-generated" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ precedence: "bulk" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ precedence: "list" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "list-unsubscribe": "<https://x.example/u>" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "list-id": "<l.x.example>" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "content-type": "multipart/report; report-type=delivery-status" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "return-path": "<>" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "x-autoreply": "yes" }), "a@x.example"), true);
    assert.equal(isAutomated(headers({ "feedback-id": "1:campaign:esp" }), "a@x.example"), true);
    for (const sender of ["noreply@x.example", "no-reply@x.example", "do-not-reply@x.example", "DoNotReply@x.example", "mailer-daemon@x.example", "postmaster@x.example", "bounces+123@x.example", "noreply-billing@x.example"]) {
      assert.equal(isAutomated(headers({}), sender), true, sender);
    }
  });

  it("is false for ordinary mail, an explicit Auto-Submitted: no, and look-alike names", () => {
    assert.equal(isAutomated(headers({ subject: "Lunch?" }), "ann@people.example"), false);
    assert.equal(isAutomated(headers({ "auto-submitted": "no" }), "ann@people.example"), false);
    assert.equal(isAutomated(headers({ "return-path": "<ann@people.example>" }), "ann@people.example"), false);
    for (const sender of ["noreen@x.example", "replies@x.example", "info@x.example", "postmasterson@x.example"]) {
      assert.equal(isNoReplyAddress(sender), false, sender);
    }
  });
});
