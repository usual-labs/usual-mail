/** Cursor and ref encoding for both providers, UID sets, and their edge cases. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCursor, decodeRef, encodeCursor, encodeRef, type ImapCursor } from "../../src/imap/cursor.ts";
import { decodeUids, encodeUids, uidSetSize } from "../../src/imap/uidset.ts";
import { decodeEntry, decodeGmailCursor, encodeEntry, encodeGmailCursor } from "../../src/gmail/cursor.ts";
import { placementFromBits, seenFromBits, STATE_BITS, stateBits } from "../../src/gmail/labels.ts";

describe("UID sets", () => {
  it("compress runs and expand them back", () => {
    assert.equal(encodeUids([5, 1, 2, 3, 3, 9, 10, 7]), "1:3,5,7,9:10");
    assert.deepEqual(decodeUids("1:3,5,7,9:10"), [1, 2, 3, 5, 7, 9, 10]);
    assert.equal(uidSetSize("1:3,5,7,9:10"), 7);
    assert.equal(encodeUids([]), "");
    assert.deepEqual(decodeUids(""), []);
  });

  it("ignore impossible UIDs and reject damaged sets", () => {
    assert.equal(encodeUids([0, -1, 1.5, Number.NaN, 4]), "4");
    assert.throws(() => decodeUids("3:1"), /Bad UID range/);
    assert.throws(() => decodeUids("1,,2"), /Bad UID set/);
    assert.throws(() => decodeUids("x"), /Bad UID set/);
    assert.throws(() => decodeUids("1:99999999"), /too large/);
  });

  it("round-trip a large, gappy mailbox compactly", () => {
    const uids = Array.from({ length: 50_000 }, (_, i) => i + 1).filter((uid) => uid % 1000 !== 0);
    const set = encodeUids(uids);
    assert.ok(set.length < 1000, `${set.length} characters`);
    assert.deepEqual(decodeUids(set), uids);
  });
});

describe("IMAP refs", () => {
  it("carry folder, UIDVALIDITY and UID, also for folder names with colons", () => {
    const ref = encodeRef({ path: "Usual Mail/Reads: 2026", uidValidity: "1700000000", uid: 42 });
    assert.equal(ref, "1700000000:42:Usual Mail/Reads: 2026");
    assert.deepEqual(decodeRef(ref), { path: "Usual Mail/Reads: 2026", uidValidity: "1700000000", uid: 42 });
  });

  it("reject anything else", () => {
    for (const bad of ["", "abc", "1:0:INBOX", "1:x:INBOX", "1:2:", "18m3sGmailId"]) assert.equal(decodeRef(bad), undefined, bad);
  });
});

describe("IMAP cursor", () => {
  const cursor: ImapCursor = {
    v: 1,
    since: "2026-11-01T00:00:00.000Z",
    f: [
      { p: "INBOX", r: "inbox", v: "1", n: 12, x: 9, u: "1:9", m: "18446744073709551615" },
      { p: "Sent", r: "sent", v: "3", n: 9, x: 8, u: "5:8", s: "", k: ["", "5"], b: 5, bk: "first" },
      { p: "Usual Mail/Newsletters", r: "newsletter", v: "7", n: 4, x: 3, u: "1:3", m: "10", ms: "15", mc: 2, mx: "3" },
    ],
    g: [{ p: "Old", v: "2", u: "1:4" }],
  };

  it("round-trips, including 64-bit mod-sequences", () => {
    const text = encodeCursor(cursor);
    assert.ok(text.startsWith("imap1."));
    assert.match(text, /^imap1\.[A-Za-z0-9_-]+$/, "safe in URLs and JSON");
    assert.deepEqual(decodeCursor(text), cursor);
  });

  it("reads the pile roles of a cursor from before the fifth revision as the categories they became", () => {
    const old = structuredClone(cursor);
    old.f[2]!.r = "reads" as never;
    old.f.push({ p: "Usual Mail/Receipts", r: "receipts" as never, v: "8", n: 2, x: 1, u: "1" });
    const read = decodeCursor(encodeCursor(old));
    assert.deepEqual(read.f.map((f) => f.r), ["inbox", "sent", "newsletter", "receipt"]);
  });

  it("rejects foreign and damaged cursors", () => {
    assert.throws(() => decodeCursor(encodeGmailCursor({ v: 1, h: "1" })), /doesn't belong to an IMAP mailbox/);
    assert.throws(() => decodeCursor("imap1.%%%"), /damaged/);
    const damage = (patch: (c: ImapCursor) => void) => {
      const copy = structuredClone(cursor);
      patch(copy);
      return () => decodeCursor(encodeCursor(copy));
    };
    assert.throws(damage((c) => ((c as { v: number }).v = 2)), /damaged/);
    assert.throws(damage((c) => (c.f[0]!.r = "drafts" as never)), /damaged/);
    assert.throws(damage((c) => (c.f[0]!.n = 0)), /damaged/);
    assert.throws(damage((c) => (c.f[0]!.u = "9:1")), /damaged/);
    assert.throws(damage((c) => (c.f[0]!.m = "-1")), /damaged/);
    assert.throws(damage((c) => (c.since = "not a date")), /damaged/);
    assert.throws(damage((c) => (c.g = [{ p: "x", v: "1", u: "a" }])), /damaged/);
    assert.throws(damage((c) => delete c.f[1]!.bk), /damaged/, "a backlog needs its kind");
    assert.throws(damage((c) => (c.f[1]!.bk = "later" as never)), /damaged/);
    assert.throws(damage((c) => (c.f[1]!.b = 10)), /damaged/, "the backlog lies below n");
    assert.throws(damage((c) => (c.f[0]!.bk = "new")), /damaged/, "a kind without a backlog");
    assert.throws(damage((c) => (c.fs = -1)), /damaged/, "a first sync's count is a whole number from 0");
    assert.throws(damage((c) => (c.fs = 1.5)), /damaged/);
  });

  it("keeps how many of the first sync's backlog were sent", () => {
    const counted = { ...structuredClone(cursor), fs: 120 };
    assert.deepEqual(decodeCursor(encodeCursor(counted)), counted);
  });
});

describe("Gmail cursor", () => {
  it("round-trips with and without pending ids and listed states", () => {
    const full = {
      v: 1 as const,
      h: "123456789",
      s: "2026-11-01T00:00:00.000Z",
      t: 1_763_280_000_000,
      p: ["18c1f0a2b3c4d5e6", "18c1f0a2b3c4d5e7"],
      c: [encodeEntry("18c1f0a2b3c4d5e8", 0), encodeEntry("18c1f0a2b3c4d5e9", 511)],
    };
    assert.deepEqual(decodeGmailCursor(encodeGmailCursor(full)), full);
    assert.deepEqual(decodeGmailCursor(encodeGmailCursor({ v: 1, h: "5" })), { v: 1, h: "5" });
    assert.deepEqual(decodeEntry(full.c[1]!), { id: "18c1f0a2b3c4d5e9", bits: 511 });
  });

  it("rejects foreign and damaged cursors", () => {
    assert.throws(() => decodeGmailCursor("imap1.e30"), /doesn't belong to a Gmail inbox/);
    assert.throws(() => decodeGmailCursor("gmail1.e30"), /damaged/);
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "12x" })), /damaged/);
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "1", p: ["../etc"] })), /damaged/);
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "1", c: ["18c1f0a2b3c4d5e8"] })), /damaged/);
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "1", c: ["18c1f0a2b3c4d5e8:ZZ"] })), /damaged/);
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "1", n: -1 })), /damaged/, "a first sync's count is a whole number from 0");
    assert.throws(() => decodeGmailCursor(encodeGmailCursor({ v: 1, h: "1", n: 2.5 })), /damaged/);
  });

  it("keeps how many of the first sync's listing were sent", () => {
    const counted = { v: 1 as const, h: "9", f: true as const, n: 120, p: ["18c1f0a2b3c4d5e6"] };
    assert.deepEqual(decodeGmailCursor(encodeGmailCursor(counted)), counted);
  });
});

describe("Gmail label state", () => {
  it("turns labels into bits and bits into the placement and seen flag", () => {
    const ids = { newsletter: "Label_1", screening: "Label_3", reply_later: "Label_4" };
    const bits = stateBits(["Label_1", "Label_3", "Label_4", "CATEGORY_UPDATES"], ids);
    assert.equal(bits, STATE_BITS.newsletter | STATE_BITS.screening | STATE_BITS.reply_later);
    assert.deepEqual(placementFromBits(bits), { inInbox: false, category: "newsletter", screened: true, stack: "reply_later", trashed: false, spam: false });
    assert.equal(seenFromBits(bits), true);
    assert.deepEqual(placementFromBits(STATE_BITS.INBOX | STATE_BITS.UNREAD), { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false });
    assert.deepEqual(placementFromBits(STATE_BITS.UNREAD | STATE_BITS.TRASH), { inInbox: false, category: null, screened: false, stack: null, trashed: true, spam: false });
    assert.equal(seenFromBits(STATE_BITS.UNREAD), false);
  });
});
