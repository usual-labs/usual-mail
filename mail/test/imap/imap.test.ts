/**
 * IMAP cases the shared contract doesn't cover, against hoodiecrow: how the cursor tracks changes with and
 * without CONDSTORE, the scenarios in scenarios.ts (changes another app makes, the `since` window), folder
 * discovery and creation, stacks where keywords aren't allowed, and sending.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createImapProvider } from "../../src/index.ts";
import { applyTracked, syncAll } from "../../src/testing/index.ts";
import { plainMessage } from "../../src/testing/messages.ts";
import { decodeCursor, decodeRef } from "../../src/imap/cursor.ts";
import { NO_KEYWORDS_NOTE } from "../../src/imap/apply.ts";
import { externalChangeScenarios, find, withOtherApp } from "./scenarios.ts";
import { BARE, MODERN, NO_KEYWORDS, PASSWORD, USER, hoodiecrowHarness, startHoodiecrow, startSmtpSink } from "./servers.ts";

function message(subject: string) {
  return plainMessage({ from: "Bo <bo@people.example>", to: USER, subject });
}

function folderOf(ref: string): string {
  return decodeRef(ref)!.path;
}

describe("IMAP cursor", () => {
  it("uses HIGHESTMODSEQ where CONDSTORE works", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      await h.deliver(message("Hello").raw);
      const state = await syncAll(h.provider, null);
      const inbox = decodeCursor(state.cursor).f.find((f) => f.r === "inbox")!;
      assert.ok(inbox.m !== undefined, "modseq baseline kept");
      assert.equal(inbox.s, undefined, "no unseen set needed");
      assert.equal(inbox.b, undefined, "the backlog is done");
    } finally {
      await h.close();
    }
  });

  it("sees flag changes even when INBOX stays selected between syncs", async () => {
    const h = await hoodiecrowHarness({ ...MODERN, name: "INBOX only", storage: { INBOX: {}, "": { separator: "/" } } });
    try {
      const { raw, messageId } = message("Only folder");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const ref = find(state, messageId).ref;
      await withOtherApp(h.login, async (client) => {
        await client.mailboxOpen("INBOX");
        await client.messageFlagsAdd(String(decodeRef(ref)!.uid), ["\\Seen"], { uid: true });
      });
      const next = await syncAll(h.provider, state);
      assert.equal(next.view.get(ref)?.seen, true, "the change made elsewhere came back");
      assert.deepEqual(next.changed, [ref], "as a change, not fetched again");
    } finally {
      await h.close();
    }
  });

  it("keeps unseen and keyword sets where CONDSTORE is missing", async () => {
    const h = await hoodiecrowHarness(BARE);
    try {
      await h.deliver(message("Hello").raw);
      const state = await syncAll(h.provider, null);
      const inbox = decodeCursor(state.cursor).f.find((f) => f.r === "inbox")!;
      assert.equal(inbox.m, undefined);
      assert.equal(inbox.s, "1", "the unread message is in the unseen set");
      assert.deepEqual(inbox.k, ["", ""]);
    } finally {
      await h.close();
    }
  });

  it("rejects a damaged or foreign cursor with a readable error", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      await assert.rejects(h.provider.sync("gmail1.e30"), /doesn't belong to an IMAP mailbox/);
      await assert.rejects(h.provider.sync("imap1.bm90LWpzb24"), /damaged/);
    } finally {
      await h.close();
    }
  });
});

for (const profile of [MODERN, BARE]) {
  externalChangeScenarios(`IMAP on hoodiecrow (${profile.name})`, (options) => hoodiecrowHarness(profile, options));
}

for (const profile of [MODERN, BARE]) {
  describe(`IMAP flag changes across small batches (${profile.name})`, () => {
    it("sends new mail first, then every changed message once as a change, and finishes", async () => {
      const h = await hoodiecrowHarness(profile);
      try {
        const ids: string[] = [];
        for (const subject of ["F1", "F2", "F3"]) {
          const m = message(subject);
          ids.push(m.messageId);
          await h.deliver(m.raw);
        }
        const state = await syncAll(h.provider, null);
        const refs = ids.map((id) => find(state, id).ref);
        await withOtherApp(h.login, async (client) => {
          await client.mailboxOpen("INBOX");
          await client.messageFlagsAdd(refs.map((ref) => decodeRef(ref)!.uid).join(","), ["\\Seen"], { uid: true });
        });
        const late = message("New after the flags");
        await h.deliver(late.raw);
        const batches: string[][] = [];
        let cursor = state.cursor;
        for (let i = 0; i < 10; i++) {
          const batch = await h.provider.sync(cursor, { limit: 1 });
          const subjects = (ref: string) => state.view.get(ref)?.subject ?? "?";
          batches.push([...batch.upserted.map((m) => `new ${m.subject}:${m.seen}`), ...(batch.changed ?? []).map((c) => `changed ${subjects(c.ref)}:${c.seen}`)]);
          cursor = batch.cursor;
          if (!batch.more) break;
        }
        assert.deepEqual(batches, [["new New after the flags:false"], ["changed F1:true"], ["changed F2:true"], ["changed F3:true"]]);
        const quiet = await syncAll(h.provider, cursor);
        assert.equal(quiet.messages.size + quiet.changed.length, 0, "nothing is sent twice afterwards");
      } finally {
        await h.close();
      }
    });
  });
}

describe("IMAP folders", () => {
  it("finds Outlook-style folders by name and creates the archive and category folders under the namespace", async () => {
    const h = await hoodiecrowHarness(BARE);
    try {
      const { raw, messageId } = message("Where do I go");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const ref = find(state, messageId).ref;
      const [archived] = await h.provider.apply([{ op: "place", ref, inInbox: false, category: null, screened: false }]);
      assert.equal(folderOf(archived!.ref!), "INBOX.Archive");
      const [read] = await h.provider.apply([{ op: "place", ref: archived!.ref!, inInbox: false, category: "receipt", screened: false }]);
      assert.equal(folderOf(read!.ref!), "INBOX.Usual Mail.Receipts");
      const [trashed] = await h.provider.apply([{ op: "trash", ref: read!.ref! }]);
      assert.equal(folderOf(trashed!.ref!), "INBOX.Deleted Items");
      await h.provider.send({ from: { email: USER }, to: [{ email: "bo@people.example" }], cc: [], bcc: [], subject: "Out", text: "Hi" });
      const after = await syncAll(h.provider, state);
      const sent = [...after.messages.values()].find((m) => m.subject === "Out");
      assert.equal(sent && folderOf(sent.ref), "INBOX.Sent Items");
      assert.equal(sent?.outgoing, true);
      assert.equal(h.smtp.received.length, 1, "the message went out over SMTP once");
    } finally {
      await h.close();
    }
  });

  it("calls mail outgoing only in the Sent folder, never because From names the mailbox", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      await h.deliver(plainMessage({ from: `Me <${USER}>`, to: "deals@spam.example", subject: "Forged" }).raw);
      const state = await syncAll(h.provider, null);
      const forged = [...state.messages.values()].find((m) => m.subject === "Forged");
      assert.equal(forged?.outgoing, false);
    } finally {
      await h.close();
    }
  });

  it("reads Junk and Trash as spam and trashed, and placing takes a message out of Junk", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const junk = message("Cheap watches");
      h.server.appendMessage("Junk", [], new Date(), junk.raw);
      const state = await syncAll(h.provider, null);
      const found = find(state, junk.messageId);
      assert.deepEqual(found.placement, { inInbox: false, category: null, screened: false, stack: null, trashed: false, spam: true });
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: found.ref, inInbox: true, category: null, screened: false }]);
      assert.equal(folderOf(placed!.ref!), "INBOX");
      const next = await syncAll(h.provider, state);
      assert.deepEqual(next.view.get(placed!.ref!)?.placement, { inInbox: true, category: null, screened: false, stack: null, trashed: false, spam: false });
      // Out of spam, a message is sent whole even when this provider moved it: the server ignored it while it was
      // in spam, so it may not hold it (docs/contract.md, "Providers").
      assert.deepEqual([next.changed, next.upserted], [[], [placed!.ref!]], "out of spam, so sent whole");
      assert.ok(next.removed.includes(found.ref));
    } finally {
      await h.close();
    }
  });

  it("untrash moves mail trashed in another app to where the op says, and leaves no marks", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const theirs = message("Trashed elsewhere");
      await h.deliver(theirs.raw);
      const state = await syncAll(h.provider, null);
      await withOtherApp(h.login, async (client) => {
        await client.mailboxOpen("INBOX");
        await client.messageMove(String(decodeRef(find(state, theirs.messageId).ref)!.uid), "Trash", { uid: true });
      });
      const now = await syncAll(h.provider, state);
      const inTrash = find(now, theirs.messageId);
      assert.equal(inTrash.placement.trashed, true);
      const [back] = await h.provider.apply([{ op: "untrash", ref: inTrash.ref, inInbox: false, category: "receipt", screened: false, stack: "reply_later" }]);
      assert.equal(back?.ok, true);
      assert.equal(folderOf(back!.ref!), "Usual Mail/Receipts");
      const flags = await withOtherApp(h.login, async (client) => {
        const lock = await client.getMailboxLock("Usual Mail/Receipts");
        try {
          const item = await client.fetchOne(String(decodeRef(back!.ref!)!.uid), { flags: true }, { uid: true });
          return item ? [...(item.flags ?? [])] : [];
        } finally {
          lock.release();
        }
      });
      assert.deepEqual(flags.filter((flag) => flag.startsWith("$")), ["$UsualMail_ReplyLater"], "the stack keyword and nothing else of ours");
      assert.deepEqual(await h.provider.apply([]), []);
    } finally {
      await h.close();
    }
  });

  it("uses custom names for categories and stacks", async () => {
    const h = await hoodiecrowHarness(MODERN, { names: { newsletter: "Sorted/Newsletters", reply_later: "Sorted/Answer" } });
    try {
      const { raw, messageId } = message("Custom names");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const ref = find(state, messageId).ref;
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref, inInbox: false, category: "newsletter", screened: false, stack: "reply_later" }]);
      assert.equal(folderOf(placed!.ref!), "Sorted/Newsletters");
      const next = await syncAll(h.provider, state);
      assert.deepEqual(next.view.get(placed!.ref!)?.placement, { inInbox: false, category: "newsletter", screened: false, stack: "reply_later", trashed: false, spam: false });
      const flags = await withOtherApp(h.login, async (client) => {
        const lock = await client.getMailboxLock("Sorted/Newsletters");
        try {
          const item = await client.fetchOne(String(decodeRef(placed!.ref!)!.uid), { flags: true }, { uid: true });
          return item ? [...(item.flags ?? [])] : [];
        } finally {
          lock.release();
        }
      });
      assert.ok(flags.includes("$Sorted_Answer"), `keyword set: ${flags.join(" ")}`);
    } finally {
      await h.close();
    }
  });
});

describe("IMAP moves it made itself", () => {
  it("sends a message it moved as a change, and one another app moved whole", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const mine = message("Moved by Usual Mail");
      const theirs = message("Moved by another app");
      await h.deliver(mine.raw);
      await h.deliver(theirs.raw);
      const state = await syncAll(h.provider, null);
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: find(state, mine.messageId).ref, inInbox: false, category: null, screened: false, stack: "set_aside" }]);
      await withOtherApp(h.login, async (client) => {
        await client.mailboxOpen("INBOX");
        await client.messageMove(String(decodeRef(find(state, theirs.messageId).ref)!.uid), "Archive", { uid: true });
      });
      const next = await syncAll(h.provider, state);
      assert.deepEqual(next.changed, [placed!.ref!]);
      assert.deepEqual(next.upserted.map((ref) => next.view.get(ref)?.messageId), [theirs.messageId]);
      assert.deepEqual(next.view.get(placed!.ref!)?.placement, { inInbox: false, category: null, screened: false, stack: "set_aside", trashed: false, spam: false });
    } finally {
      await h.close();
    }
  });

  it("reports a ref it gave by its own move as removed once another app moved the message on before a sync saw it", async () => {
    // The server holds the ref the move returned; a ref it holds must be reported removed when it goes, or the server
    // can't tell a move from someone else's copy of the message (it compares Message-ID and content).
    const h = await hoodiecrowHarness(MODERN);
    try {
      const { raw, messageId } = message("Moved twice");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: find(state, messageId).ref, inInbox: false, category: null, screened: false }]);
      await withOtherApp(h.login, async (client) => {
        await client.mailboxOpen(folderOf(placed!.ref!));
        await client.messageMove(String(decodeRef(placed!.ref!)!.uid), "INBOX", { uid: true });
      });
      const next = await syncAll(h.provider, state);
      assert.ok(next.removed.includes(placed!.ref!), "the ref the move gave is reported gone");
      assert.deepEqual(next.upserted.map((ref) => next.view.get(ref)?.messageId), [messageId], "the copy where it went, whole");
      const batch = next.log.find((entry) => entry.removed.includes(placed!.ref!))!;
      assert.ok(batch.upserted.length > 0 || next.log.indexOf(batch) > 0, "never before the copy where it went");
      const again = await syncAll(h.provider, next);
      assert.deepEqual([again.removed, again.upserted], [[], []], "reported once");
    } finally {
      await h.close();
    }
  });

  it("downloads a moved message again once the provider that moved it is gone", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const { raw, messageId } = message("Moved before a restart");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: find(state, messageId).ref, inInbox: false, category: "newsletter", screened: false }]);
      const again = createImapProvider({ imap: { ...h.login, secure: false }, smtp: { ...h.login, port: h.smtp.port, secure: false } });
      try {
        const next = await syncAll(again, state);
        assert.deepEqual(next.upserted, [placed!.ref!], "a new process doesn't know the move, so it sends the message whole");
      } finally {
        await again.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe("IMAP stacks where keywords aren't allowed", () => {
  it("reports no stack for a folder that can't keep one, and says so in note when asked for one", async () => {
    const h = await hoodiecrowHarness(NO_KEYWORDS);
    try {
      const { raw, messageId } = message("No keywords here");
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const ref = find(state, messageId).ref;
      assert.equal("stack" in find(state, messageId).placement, false, "INBOX can't keep a stack, so none is reported");
      const [kept] = await h.provider.apply([{ op: "place", ref, inInbox: true, category: null, screened: false, stack: "set_aside" }]);
      assert.deepEqual(kept, { ok: true, ref, note: NO_KEYWORDS_NOTE });
      const [plain] = await h.provider.apply([{ op: "place", ref, inInbox: true, category: null, screened: false }]);
      assert.deepEqual(plain, { ok: true, ref }, "no stack wanted, nothing to say");
    } finally {
      await h.close();
    }
  });

  it("sets the stack in the folder the message moves to when only that one allows keywords", async () => {
    const h = await hoodiecrowHarness(NO_KEYWORDS);
    try {
      const { raw, messageId } = message("Archive me with a stack");
      await h.deliver(raw);
      let state = await syncAll(h.provider, null);
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: find(state, messageId).ref, inInbox: false, category: null, screened: false, stack: "reply_later" }]);
      assert.equal(placed?.ok, true);
      assert.equal(placed?.note, undefined, "the archive folder this provider made takes keywords");
      state = await syncAll(h.provider, state);
      assert.deepEqual(state.view.get(placed!.ref!)?.placement, { inInbox: false, category: null, screened: false, stack: "reply_later", trashed: false, spam: false });
    } finally {
      await h.close();
    }
  });
});

describe("IMAP sending", () => {
  it("says in note when the message went out but no copy was saved to Sent", async () => {
    const imap = await startHoodiecrow(MODERN);
    const smtp = await startSmtpSink();
    // SMTP takes the message; the IMAP login fails, so the copy for Sent can't be saved.
    const provider = createImapProvider({
      imap: { host: "127.0.0.1", port: imap.port, secure: false, user: USER, password: "wrong" },
      smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: USER, password: PASSWORD },
    });
    try {
      const result = await provider.send({ from: { email: USER }, to: [{ email: "bo@people.example" }], cc: [], bcc: [], subject: "Out", text: "Hi" });
      assert.ok(result.messageId);
      assert.match(result.note ?? "", /^Sent, but no copy was saved to the Sent folder: .*refused the user name or password/);
      assert.equal(smtp.received.length, 1);
    } finally {
      await provider.close();
      await imap.close();
      await smtp.close();
    }
  });

  it("saves no copy when the credentials say the server files sent mail itself", async () => {
    const h = await hoodiecrowHarness(MODERN, {}, { saveSent: false });
    try {
      const state = await syncAll(h.provider, null);
      const result = await h.provider.send({ from: { email: USER }, to: [{ email: "bo@people.example" }], cc: [], bcc: [], subject: "Out", text: "Hi" });
      assert.equal(result.note, undefined);
      assert.equal(h.smtp.received.length, 1);
      const after = await syncAll(h.provider, state);
      assert.equal(after.messages.size, 0, "nothing was appended to Sent");
    } finally {
      await h.close();
    }
  });

  it("refuses credentials whose saveSent isn't true or false", () => {
    const smtp = { host: "127.0.0.1", port: 25, secure: false, user: USER, password: PASSWORD };
    assert.throws(() => createImapProvider({ imap: smtp, smtp, saveSent: "no" }), /saveSent must be true or false/);
  });
});
