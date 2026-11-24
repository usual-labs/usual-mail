/**
 * The order in which the IMAP provider sends things, against hoodiecrow: the first sync newest first across
 * folders, removals not held back by the first sync's backlog, and a move that lands in a folder scanned
 * earlier in the same call still arriving before its removal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchOf, plainMessage, syncAll } from "../../src/testing/index.ts";
import { decodeCursor, decodeRef } from "../../src/imap/cursor.ts";
import { find, withOtherApp } from "./scenarios.ts";
import { BARE, MODERN, USER, hoodiecrowHarness, type CommandHandler } from "./servers.ts";

const MINUTE = 60_000;

function message(subject: string, date = new Date()) {
  return plainMessage({ from: "Bo <bo@people.example>", to: USER, subject, date });
}

for (const profile of [MODERN, BARE]) {
  describe(`IMAP order (${profile.name})`, () => {
    it("sends the first sync newest first, across folders", async () => {
      const h = await hoodiecrowHarness(profile);
      try {
        const start = Date.now() - 60 * MINUTE;
        const sent = profile === MODERN ? "Sent" : "INBOX.Sent Items";
        for (let i = 0; i < 6; i++) {
          const at = new Date(start + i * MINUTE);
          const m = message(`M${i}`, at);
          // Alternate folders, one minute apart, so only a merge by arrival time gets the order right.
          if (i % 2) h.server.appendMessage(sent, ["\\Seen"], at, m.raw);
          else await h.appendAt(m.raw, at);
        }
        const state = await syncAll(h.provider, null, 2);
        const order = state.log.map((batch) => batch.upserted.map((ref) => state.view.get(ref)!.subject));
        assert.deepEqual(order, [["M5", "M4"], ["M3", "M2"], ["M1", "M0"]]);
        assert.ok(decodeCursor(state.cursor).f.every((f) => f.b === undefined), "no backlog left");
        const quiet = await syncAll(h.provider, state);
        assert.equal(quiet.upserted.length, 0);
      } finally {
        await h.close();
      }
    });

    it("sends new mail before the rest of the first sync's backlog", async () => {
      const h = await hoodiecrowHarness(profile);
      try {
        for (let i = 0; i < 4; i++) {
          const at = new Date(Date.now() - (10 - i) * MINUTE);
          await h.appendAt(message(`Old ${i}`, at).raw, at);
        }
        const first = await h.provider.sync(null, { limit: 1 });
        assert.deepEqual(first.upserted.map((m) => m.subject), ["Old 3"]);
        await h.deliver(message("Just arrived").raw);
        const second = await h.provider.sync(first.cursor, { limit: 1 });
        assert.deepEqual(second.upserted.map((m) => m.subject), ["Just arrived"]);
        const third = await h.provider.sync(second.cursor, { limit: 1 });
        assert.deepEqual(third.upserted.map((m) => m.subject), ["Old 2"]);
      } finally {
        await h.close();
      }
    });

    it("doesn't hold a removal back for the first sync's backlog", async () => {
      const h = await hoodiecrowHarness(profile);
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const at = new Date(Date.now() - (10 - i) * MINUTE);
          const m = message(`Backlog ${i}`, at);
          ids.push(m.messageId);
          await h.appendAt(m.raw, at);
        }
        const first = await h.provider.sync(null, { limit: 1 });
        const newest = first.upserted[0]!;
        assert.equal(newest.messageId, ids[4]);
        await h.removeExternally(ids[4]!);
        const second = await h.provider.sync(first.cursor, { limit: 1 });
        assert.deepEqual(second.removed, [newest.ref], "reported while the backlog is still waiting");
        assert.equal(second.more, true);
      } finally {
        await h.close();
      }
    });
  });
}

describe("IMAP removals and moves", () => {
  it("holds a removal back until the new copy in a folder seen for the first time is sent", async () => {
    const h = await hoodiecrowHarness({ ...MODERN, name: "no archive yet", storage: { INBOX: {}, "": { separator: "/", folders: { Trash: { "special-use": "\\Trash" } } } } });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const m = message(`Archive ${i}`);
        ids.push(m.messageId);
        await h.deliver(m.raw);
      }
      const state = await syncAll(h.provider, null);
      const refs = ids.map((id) => find(state, id).ref);
      // Another app makes an archive folder and moves everything into it.
      await withOtherApp(h.login, async (client) => {
        await client.mailboxCreate("Archive");
        await client.mailboxOpen("INBOX");
        await client.messageMove(refs.map((ref) => decodeRef(ref)!.uid).join(","), "Archive", { uid: true });
      });
      const next = await syncAll(h.provider, state, 1);
      for (const [i, id] of ids.entries()) {
        const moved = [...next.view.values()].find((m) => m.messageId === id)!;
        assert.ok(batchOf(next, moved.ref, "arrived") <= batchOf(next, refs[i]!, "removed"), `the new copy of ${id} came first`);
      }
      assert.deepEqual([...next.removed].sort(), [...refs].sort());
    } finally {
      await h.close();
    }
  });

  it("holds removals back when a message moved into a folder scanned earlier in the same call", async () => {
    const h = await hoodiecrowHarness(MODERN);
    try {
      const m = message("Out of the trash, behind its back");
      await h.deliver(m.raw);
      let state = await syncAll(h.provider, null);
      const [trashed] = await h.provider.apply([{ op: "trash", ref: find(state, m.messageId).ref }]);
      state = await syncAll(h.provider, state);
      const inTrash = trashed!.ref!;
      // When the provider next selects Trash (scanned last), move the message back into INBOX (scanned first).
      const select = h.server.getCommandHandler("SELECT");
      let armed = true;
      const hooked: CommandHandler = (connection, parsed, data, callback) => {
        if (armed && String(parsed.attributes?.[0]?.value ?? "") === "Trash") {
          armed = false;
          const trash = h.server.getMailbox("Trash")!;
          const index = trash.messages.findIndex((item) => item.uid === decodeRef(inTrash)!.uid);
          const [moved] = trash.messages.splice(index, 1);
          h.server.copyMessage(h.server.getMailbox("INBOX")!, moved!);
        }
        return select(connection, parsed, data, callback);
      };
      h.server.setCommandHandler("SELECT", hooked);
      const next = await syncAll(h.provider, state);
      assert.equal(armed, false, "the move happened mid-sync");
      const back = [...next.view.values()].find((item) => item.messageId === m.messageId);
      assert.ok(back, "the new copy came back in the same run");
      assert.ok(next.removed.includes(inTrash), "the old ref was reported removed");
      assert.ok(batchOf(next, back.ref, "arrived") <= batchOf(next, inTrash, "removed"), "the new copy came before or with the removal");
    } finally {
      await h.close();
    }
  });
});
