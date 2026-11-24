/**
 * IMAP scenarios that need a second client, written once and run against every test server: changes
 * another mail app makes (flags, moves, deleted folders, UIDVALIDITY resets) and the `since` window.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ImapFlow } from "imapflow";
import type { MailProvider, ProviderMessage } from "@usualmail/core";
import { plainMessage, syncAll, type ContractHarness, type SyncResult } from "../../src/testing/index.ts";
import { decodeRef } from "../../src/imap/cursor.ts";

export interface ImapTestHarness extends ContractHarness {
  login: { host: string; port: number; user: string; password: string };
  /** Puts a message into INBOX with this arrival time. */
  appendAt(raw: string, at: Date): Promise<void>;
  /**
   * Another provider on the same mailbox with these options, as the server opens one again after a restart (with the
   * window as it is set then). The test closes it. Leave it out to skip the tests that need it.
   */
  reopen?(options: { since?: string }): MailProvider;
}

export async function withOtherApp<T>(login: ImapTestHarness["login"], fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({ host: login.host, port: login.port, secure: false, auth: { user: login.user, pass: login.password }, logger: false, disableAutoIdle: true });
  client.on("error", () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function inFolder<T>(client: ImapFlow, path: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export function find(result: SyncResult, messageId: string): ProviderMessage {
  const message = [...result.messages.values()].find((m) => m.messageId === messageId);
  assert.ok(message, `message ${messageId} came back`);
  return message;
}

const folderOf = (ref: string) => decodeRef(ref)!.path;
const uidOf = (ref: string) => decodeRef(ref)!.uid;

export function externalChangeScenarios(name: string, makeHarness: (options?: { since?: string }) => Promise<ImapTestHarness>): void {
  describe(`${name}: changes made by another app`, () => {
    let h: ImapTestHarness;
    let closed = false;
    // node:test runs no afterEach for a test skipped while it runs, so such a test closes the harness itself.
    const closeHarness = async () => {
      if (closed) return;
      closed = true;
      await h?.close();
    };
    beforeEach(async () => {
      closed = false;
      h = await makeHarness();
    });
    afterEach(closeHarness);
    const deliver = async (subject: string) => {
      const m = plainMessage({ from: "Bo <bo@people.example>", to: h.address, subject });
      await h.deliver(m.raw);
      return m.messageId;
    };

    it("reports a flag another app changed", async () => {
      const id = await deliver("Flag me elsewhere");
      const state = await syncAll(h.provider, null);
      const ref = find(state, id).ref;
      await withOtherApp(h.login, (client) => inFolder(client, "INBOX", () => client.messageFlagsAdd(String(uidOf(ref)), ["\\Seen"], { uid: true })));
      const next = await syncAll(h.provider, state);
      assert.equal(next.view.get(ref)?.seen, true);
      assert.deepEqual(next.changed, [ref], "only the changed message came back, as a change");
      assert.deepEqual(next.upserted, [], "nothing was fetched whole");
    });

    it("reports a stack keyword another app set as a change", async (t) => {
      if (h.supports?.keywords === false) {
        await closeHarness();
        return t.skip("this server takes no custom keywords");
      }
      const id = await deliver("Stack me elsewhere");
      const state = await syncAll(h.provider, null);
      const ref = find(state, id).ref;
      await withOtherApp(h.login, (client) => inFolder(client, "INBOX", () => client.messageFlagsAdd(String(uidOf(ref)), ["$UsualMail_SetAside"], { uid: true })));
      const next = await syncAll(h.provider, state);
      assert.deepEqual(next.changed, [ref]);
      assert.equal(next.view.get(ref)?.placement.stack, "set_aside");
    });

    it("reports a move another app made as the new copy first, then the old ref removed", async () => {
      // Let the provider create a category's folder, so the move lands in a folder that is synced.
      const anchor = await deliver("Anchor");
      const moved = [await deliver("Move me 1"), await deliver("Move me 2")];
      const first = await syncAll(h.provider, null);
      const [placed] = await h.provider.apply([{ op: "place", ref: find(first, anchor).ref, inInbox: false, category: "newsletter", screened: false }]);
      assert.ok(placed?.ok && placed.ref, placed?.error);
      const settled = await syncAll(h.provider, first.cursor);
      const target = folderOf(placed.ref);
      const refs = moved.map((id) => find(first, id).ref);
      await withOtherApp(h.login, (client) => inFolder(client, "INBOX", () => client.messageMove(refs.map(uidOf).join(","), target, { uid: true })));
      let cursor = settled.cursor;
      const seen: string[] = [];
      const removed: string[] = [];
      for (;;) {
        const batch = await h.provider.sync(cursor, { limit: 1 });
        for (const m of batch.upserted) seen.push(m.messageId!);
        if (batch.removed.length) assert.equal(seen.length, moved.length, "removals came only with the last new copy");
        removed.push(...batch.removed);
        cursor = batch.cursor;
        if (!batch.more) break;
      }
      assert.deepEqual([...seen].sort(), [...moved].sort());
      assert.deepEqual([...removed].sort(), [...refs].sort());
    });

    it("reports a folder deleted with its messages as removals", async () => {
      const id = await deliver("Read me later");
      let state = await syncAll(h.provider, null);
      const [placed] = await h.provider.apply([{ op: "place", ref: find(state, id).ref, inInbox: false, category: "newsletter", screened: false }]);
      assert.ok(placed?.ok && placed.ref, placed?.error);
      state = await syncAll(h.provider, state.cursor);
      await withOtherApp(h.login, (client) => client.mailboxDelete(folderOf(placed.ref!)));
      const next = await syncAll(h.provider, state.cursor);
      assert.ok(next.removed.includes(placed.ref!), "the deleted folder's message was reported removed");
    });

    it("starts a folder over when its UIDVALIDITY changes", async () => {
      const id = await deliver("Screen me");
      let state = await syncAll(h.provider, null);
      const [placed] = await h.provider.apply([{ op: "place", ref: find(state, id).ref, inInbox: false, category: "invoice", screened: true }]);
      state = await syncAll(h.provider, state.cursor);
      const folder = folderOf(placed!.ref!);
      await withOtherApp(h.login, async (client) => {
        const source = await inFolder(client, folder, async () => {
          const item = await client.fetchOne(String(uidOf(placed!.ref!)), { source: true }, { uid: true });
          return item ? item.source : undefined;
        });
        await client.mailboxDelete(folder);
        await client.mailboxCreate(folder);
        await client.append(folder, source!);
      });
      const next = await syncAll(h.provider, state.cursor);
      assert.ok(next.removed.includes(placed!.ref!), "the old ref is gone");
      const again = find(next, id);
      assert.notEqual(decodeRef(again.ref)!.uidValidity, decodeRef(placed!.ref!)!.uidValidity, "new UIDVALIDITY");
      assert.equal(again.placement.screened, true);
      assert.equal("category" in again.placement, false, "the Screening folder keeps no category");
    });
  });

  describe(`${name}: since`, () => {
    it("takes only mail newer than `since` on the first sync, and everything that arrives afterwards", async () => {
      const h = await makeHarness({ since: "2026-01-01T00:00:00Z" });
      try {
        const old = plainMessage({ from: "bo@people.example", to: h.address, subject: "From 2024" });
        const fresh = plainMessage({ from: "bo@people.example", to: h.address, subject: "From now" });
        await h.appendAt(old.raw, new Date("2024-03-01T10:00:00Z"));
        await h.appendAt(fresh.raw, new Date());
        const first = await syncAll(h.provider, null);
        assert.deepEqual([...first.messages.values()].map((m) => m.messageId), [fresh.messageId]);
        const late = plainMessage({ from: "bo@people.example", to: h.address, subject: "Old mail appended later" });
        await h.appendAt(late.raw, new Date("2023-05-05T10:00:00Z"));
        const next = await syncAll(h.provider, first.cursor);
        assert.deepEqual([...next.messages.values()].map((m) => m.messageId), [late.messageId]);
      } finally {
        await h.close();
      }
    });

    it("counts the first sync's window on every batch until all of it is sent, across a restart, then says nothing", async () => {
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const h = await makeHarness({ since: new Date(now - 30 * DAY).toISOString() });
      try {
        for (const days of [40, 5, 4, 3, 2, 1]) {
          await h.appendAt(plainMessage({ from: "bo@people.example", to: h.address, subject: `${days} days old` }).raw, new Date(now - days * DAY));
        }
        const counted = (result: SyncResult) => result.log.flatMap((batch) => (batch.progress ? [batch.progress] : []));
        const first = await syncAll(h.provider, null, { limit: 2, batches: 1 });
        assert.deepEqual(counted(first), [{ sent: 2, total: 5 }], "the window's five, not the one older than it");
        // The cursor carries the count, so another provider (a restart) counts on.
        const provider = h.reopen ? h.reopen({ since: new Date(now - 30 * DAY).toISOString() }) : h.provider;
        try {
          const rest = await syncAll(provider, first, 2);
          assert.deepEqual(counted(rest), [{ sent: 4, total: 5 }, { sent: 5, total: 5 }]);
          await h.appendAt(plainMessage({ from: "bo@people.example", to: h.address, subject: "New mail" }).raw, new Date());
          const later = await syncAll(provider, rest);
          assert.deepEqual(counted(later), [], "a later sync says nothing");
        } finally {
          if (provider !== h.provider) await provider.close();
        }
      } finally {
        await h.close();
      }
    });

    it("a smaller window takes effect for a first sync in progress; a larger one doesn't widen it; nothing fetched is dropped", async (t) => {
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const h = await makeHarness({ since: new Date(now - 30 * DAY).toISOString() });
      const opened: MailProvider[] = [];
      // The server opens the provider again, after a restart, with the window as it is set then.
      const reopen = (days: number) => {
        const provider = h.reopen!({ since: new Date(now - days * DAY).toISOString() });
        opened.push(provider);
        return provider;
      };
      const names = (result: SyncResult) => [...result.messages.values()].map((m) => m.subject).sort();
      try {
        if (!h.reopen) return t.skip("this harness can't open a second provider");
        for (const days of [25, 10, 5, 2, 1]) {
          await h.appendAt(plainMessage({ from: "bo@people.example", to: h.address, subject: `${days} days old` }).raw, new Date(now - days * DAY));
        }
        const first = await syncAll(h.provider, null, { limit: 1, batches: 1 });
        assert.deepEqual(names(first), ["1 days old"]);
        assert.deepEqual(first.log[0]!.progress, { sent: 1, total: 5 });
        // The window goes down to 7 days while the first sync is still being sent: older mail isn't fetched.
        const smaller = await syncAll(reopen(7), first, { limit: 1, batches: 1 });
        assert.deepEqual(names(smaller), ["2 days old"]);
        assert.deepEqual(smaller.log[0]!.progress, { sent: 2, total: 3 }, "the smaller window lowers the total; what was sent stays counted");
        // Up to 60 later: the first sync doesn't widen again. What was fetched stays; nothing is reported removed.
        const rest = await syncAll(reopen(60), smaller, 1);
        assert.deepEqual(names(rest), ["5 days old"]);
        assert.deepEqual(rest.log[0]!.progress, { sent: 3, total: 3 }, "nor does a larger one raise it");
        assert.deepEqual([rest.removed, rest.dropped], [[], []]);
        assert.deepEqual([...rest.view.values()].map((m) => m.subject).sort(), ["1 days old", "2 days old", "5 days old"]);
        // Mail that arrives later is taken whatever its date, as before.
        await h.appendAt(plainMessage({ from: "bo@people.example", to: h.address, subject: "Appended later, 20 days old" }).raw, new Date(now - 20 * DAY));
        const later = await syncAll(reopen(7), rest);
        assert.deepEqual(names(later), ["Appended later, 20 days old"]);
      } finally {
        for (const provider of opened) await provider.close();
        await h.close();
      }
    });
  });
}
