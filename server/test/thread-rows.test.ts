// What a stored thread row is served as, for the parts that differ from what is stored: a receipt's zero amount (kept
// from before the zero check) is served as no amount, and a sender picture never on a screened thread, whatever the
// row holds.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ThreadRow } from "../src/db/index.ts";
import { toThread } from "../src/service/rows.ts";

const row = (extra: Partial<ThreadRow>): ThreadRow => ({
  id: "thr_1", inboxId: "inb_1", threadKey: "k", subject: "Your receipt", snippet: "", participants: [], lastMessageAt: Date.parse("2026-11-19T10:00:00Z"),
  messageCount: 1, unread: false, hasAttachments: false, category: "receipt", categorizedBy: "ai", categorizedByActor: null, screened: false,
  screenedByMailbox: false, gatePending: false, summary: null, payment: null, avatar: null, categoryDue: false, categoryAskAgain: false,
  summaryDue: false, done: false, stack: null, comeBackAt: null, comeBackIfNoReply: false, comeBackSetAt: null, need: null, reason: null,
  sender: "news@brand.example", trashed: false, removed: false, version: 3, revision: 0, comeBackAnnounced: false, createdAt: 0,
  ...extra,
}) as ThreadRow;

describe("a thread row as it is served", () => {
  test("a stored zero amount is served as no amount; any other as stored", () => {
    const details = { party: "Brand", amount: { minor: 0, currency: "EUR" }, refund: false, state: null, dueDate: null, what: "A box" };
    assert.deepEqual(toThread(row({ payment: details })).payment, { ...details, amount: null });
    const paid = { ...details, amount: { minor: 1250, currency: "EUR" } };
    assert.deepEqual(toThread(row({ payment: paid })).payment, paid);
    assert.equal(toThread(row({ payment: paid, category: "newsletter" })).payment, undefined);
  });

  test("a sender picture is served as kept, but never on a screened thread", () => {
    const avatar = { picture: "/v1/avatars/0123456789abcdef0123456789abcdef", fit: "inset" as const, size: 64 };
    assert.deepEqual(toThread(row({ avatar })).avatar, avatar);
    assert.equal(toThread(row({ avatar, screened: true })).avatar, undefined);
    assert.equal("avatar" in toThread(row({})), false);
  });
});
