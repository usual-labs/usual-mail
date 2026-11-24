/**
 * The behaviour every MailProvider must show, as a node:test suite, from docs/contract.md ("Providers" and
 * "Sync"). Run it with a harness that can put mail into a test mailbox and take it out again behind the
 * provider's back. `syncAll` (sync-all.ts) plays the server.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FILED_CATEGORIES, STACKS, type FiledCategory, type MailProvider, type ProviderMessage, type ProviderOpResult, type ProviderPlacement, type Stack } from "@usualmail/core";

/**
 * Where a filter or a server-side rule can put mail as it arrives: the archive, a filed category's folder or label,
 * the Screening folder or label, or spam.
 */
export type FiledTo = "archive" | FiledCategory | "screening" | "spam";
import { everyByte, messageWithAttachments, plainMessage, TINY_PNG } from "./messages.ts";
import { applyTracked, batchOf, syncAll, type SyncResult } from "./sync-all.ts";
import { searchContract } from "./contract-search.ts";

export interface ContractHarness {
  provider: MailProvider;
  /** The mailbox's own address. */
  address: string;
  /** Puts a raw message into the inbox, unread, as if it had just arrived. */
  deliver(raw: string): Promise<void>;
  /** Deletes the message with this Message-ID for good, as another mail app would. */
  removeExternally(messageId: string): Promise<void>;
  /** Stops whatever the harness started, the provider included. */
  close(): Promise<void>;
  /**
   * Makes the provider lose its place, so its next sync must list its window again with `reset` (Gmail:
   * the history it would continue from expires). Leave it out for a provider that never loses its place.
   */
  loseSyncPlace?(): Promise<void>;
  /**
   * Set `keywords: false` for a mailbox where some folders can't keep custom keywords (an IMAP server
   * without them). There a placement may leave `stack` out, and a place op that asked for a stack says so
   * in `note`. `categoryWhileScreened` says whether a screened message still reports its category: true for
   * labels (Gmail), false where a message has one folder (IMAP, whose Screening folder keeps no category). It
   * defaults to false for IMAP and true otherwise.
   */
  supports?: { keywords?: boolean; categoryWhileScreened?: boolean };
  /**
   * Puts a raw message, unread, straight where a person's filter or server-side rule would file it on arrival:
   * the archive, a category's or Screening's folder or label, or spam. It never passed through the inbox as far as the provider can
   * tell. Answers false when this mailbox has no such place (no junk folder). Leave it out to skip those tests.
   */
  deliverFiled?(raw: string, to: FiledTo): Promise<boolean>;
  /**
   * Takes the message with this Message-ID out of spam and into the inbox, as a person marking it "not spam" in
   * another mail app would (Gmail's "Not spam", or a move from the junk folder to INBOX). Leave it out to skip that
   * test.
   */
  takeOutOfSpam?(messageId: string): Promise<void>;
  /** The secrets in the provider's credentials (passwords, client secret, refresh token), none of which `connection()` may show. */
  secrets?: string[];
}

/** Where a message is put: what `place` and `untrash` carry besides the ref. */
export interface Destination {
  inInbox: boolean;
  category: FiledCategory | null;
  screened: boolean;
  stack?: Stack;
}

/**
 * Every category (none, for a conversation or an undecided thread, and each filed one), screened or not, with every
 * stack and with none. With no category and not screened, both in the inbox (in Home) and out of it (done, stacked
 * or waiting); everything else is always out of the inbox, as the server writes it.
 */
export function destinations(): Destination[] {
  const out: Destination[] = [];
  for (const category of [null, ...FILED_CATEGORIES]) {
    for (const screened of [false, true]) {
      for (const stack of [undefined, ...STACKS]) {
        for (const inInbox of category === null && !screened ? [false, true] : [false]) {
          out.push(stack ? { inInbox, category, screened, stack } : { inInbox, category, screened });
        }
      }
    }
  }
  return out;
}

/** Whether a screened message still reports its category at this provider (labels do; IMAP's one folder doesn't). */
function keepsCategoryWhileScreened(h: ContractHarness): boolean {
  return h.supports?.categoryWhileScreened ?? h.provider.kind !== "imap";
}

/** The placement a provider reports for a message placed at `wanted`, apart from its stack. */
function expectedPlacement(h: ContractHarness, wanted: Omit<Destination, "stack">): Omit<ProviderPlacement, "stack"> {
  const base: Omit<ProviderPlacement, "stack"> = { inInbox: wanted.inInbox, screened: wanted.screened, trashed: false, spam: false };
  if (!wanted.screened || keepsCategoryWhileScreened(h)) base.category = wanted.category;
  return base;
}

function byMessageId(result: SyncResult, messageId: string): ProviderMessage | undefined {
  return [...result.view.values()].find((message) => message.messageId === messageId);
}

function checkSuccess(result: ProviderOpResult | undefined, what: string): asserts result is ProviderOpResult {
  assert.ok(result?.ok, `${what}: ${result?.error}`);
  assert.equal(result.error, undefined, `${what}: a change that worked carries no error`);
}

/**
 * The placement `apply` wrote, exactly: `category` as the filed category or null (left out while screened where the
 * mailbox can't keep it), `screened`, and `stack` as the stack or null.
 */
function checkPlacement(h: ContractHarness, placement: ProviderPlacement, wanted: Destination, note: string | undefined, what: string): void {
  const { stack, ...rest } = placement;
  assert.deepEqual(rest, expectedPlacement(h, wanted), `${what}: placement`);
  const want = wanted.stack ?? null;
  if (h.supports?.keywords !== false) {
    assert.equal(stack, want, `${what}: stack`);
    assert.equal(note, undefined, `${what}: nothing to say`);
  } else if (stack === undefined) {
    if (wanted.stack) assert.ok(note, `${what}: a stack the mailbox can't keep is explained in note`);
  } else {
    assert.equal(stack, want, `${what}: stack`);
    assert.equal(note, undefined, `${what}: a stack that was kept needs no note`);
  }
}

/**
 * After an op returned `after` for `before`, applied with `applyTracked` so the held copy was renamed as the
 * server renames it: the message comes back in `changed`, not fetched whole, since the provider moved it
 * itself; a new ref arrives before or with the removal of the old one. The contract lets a provider send
 * `changed` for refs the server doesn't hold (the server ignores them), but none arise in these tests.
 */
function checkRefs(state: SyncResult, before: string, after: string, what: string): void {
  assert.deepEqual(state.unknownChanged, [], `${what}: changed only names messages the server has`);
  assert.ok(!state.upserted.includes(after), `${what}: a message the provider moved or flagged itself comes back in changed, not fetched whole`);
  if (before === after) return;
  assert.ok(!state.view.has(before), `${what}: the old ref is gone`);
  const arrived = batchOf(state, after, "arrived");
  const removed = batchOf(state, before, "removed");
  assert.ok(arrived >= 0, `${what}: the new ref came back`);
  assert.ok(removed >= 0, `${what}: the old ref was reported removed`);
  assert.ok(arrived <= removed, `${what}: the new ref came before or with the old one's removal`);
}

/** Every batch keeps to the limit: `upserted` and `changed` together. Removals don't count. */
function checkLimit(state: SyncResult, limit: number, what: string): void {
  for (const [index, batch] of state.log.entries()) {
    assert.ok(batch.upserted.length + batch.changed.length <= limit, `${what}: batch ${index} sent ${batch.upserted.length} whole and ${batch.changed.length} changed with limit ${limit}`);
  }
}

export function providerContract(name: string, makeHarness: () => Promise<ContractHarness>): void {
  describe(`${name}: provider contract`, () => {
    let h: ContractHarness;
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
    // The optional search of the mailbox itself (contract-search.ts).
    searchContract(() => h, closeHarness);

    const deliver = async (subject: string, extra: Partial<Parameters<typeof plainMessage>[0]> = {}) => {
      const { raw, messageId } = plainMessage({ from: "Ann Example <ann@people.example>", to: h.address, subject, body: `Body of ${subject}`, ...extra });
      await h.deliver(raw);
      return messageId;
    };

    it("verify names the mailbox's address", async () => {
      const { address } = await h.provider.verify();
      assert.equal(address.toLowerCase(), h.address.toLowerCase());
    });

    it("connection says how it is connected, of its own kind, without a secret", async () => {
      const connection = h.provider.connection();
      assert.equal(connection.kind, h.provider.kind);
      if (connection.kind === "imap") {
        for (const login of [connection.imap, connection.smtp]) {
          assert.deepEqual(Object.keys(login).sort(), ["host", "port", "secure", "user"]);
          assert.ok(login.host && Number.isInteger(login.port) && typeof login.secure === "boolean" && login.user);
        }
        assert.deepEqual(Object.keys(connection).sort(), ["imap", "kind", "saveSent", "smtp"]);
        assert.equal(typeof connection.saveSent, "boolean");
      } else {
        assert.deepEqual(Object.keys(connection).sort(), ["clientId", "kind"]);
        assert.ok(connection.clientId);
      }
      const shown = JSON.stringify(connection);
      for (const secret of h.secrets ?? []) assert.ok(!shown.includes(secret), "no secret in the connection");
    });

    it("mail filed outside the inbox on arrival is reported where it was filed, in a first sync and later", async (t) => {
      if (!h.deliverFiled) {
        await closeHarness();
        t.skip("this harness can't file mail on arrival");
        return;
      }
      const filed = async (to: FiledTo, when: string) => {
        const { raw, messageId } = plainMessage({ from: "Filter <filter@people.example>", to: h.address, subject: `Filed to ${to} ${when}`, body: "Filed." });
        assert.ok(await h.deliverFiled!(raw, to), `${to}: the harness filed it`);
        return messageId;
      };
      const targets = ["archive", ...FILED_CATEGORIES, "screening"] as const;
      const first = new Map<string, string>();
      for (const to of targets) first.set(to, await filed(to, "before"));
      let state = await syncAll(h.provider, null);
      const later = new Map<string, string>();
      for (const to of targets) later.set(to, await filed(to, "after"));
      state = await syncAll(h.provider, state);
      for (const [when, ids] of [["first sync", first], ["later sync", later]] as const) {
        for (const to of targets) {
          const message = byMessageId(state, ids.get(to)!);
          assert.ok(message, `${to}, ${when}: came back`);
          assert.equal(message.seen, false);
          const { stack, ...rest } = message.placement;
          const want = expectedPlacement(h, {
            inInbox: false,
            category: to === "archive" || to === "screening" ? null : to,
            screened: to === "screening",
          });
          assert.deepEqual(rest, want, `${to}, ${when}: out of the inbox, in its category's or Screening's place or none`);
          assert.ok(stack === null || (stack === undefined && h.supports?.keywords === false), `${to}, ${when}: on no stack`);
        }
      }
    });

    it("mail delivered to spam is reported as spam, in a first sync and later", async (t) => {
      const { raw: before, messageId: beforeId } = plainMessage({ from: "Prize <win@prize.example>", to: h.address, subject: "You won", body: "Claim it." });
      if (!h.deliverFiled || !(await h.deliverFiled(before, "spam"))) {
        await closeHarness();
        t.skip("this mailbox has no spam folder the harness can deliver to");
        return;
      }
      let state = await syncAll(h.provider, null);
      const { raw: after, messageId: afterId } = plainMessage({ from: "Prize <win@prize.example>", to: h.address, subject: "You won again", body: "Claim it." });
      assert.ok(await h.deliverFiled(after, "spam"));
      state = await syncAll(h.provider, state);
      for (const id of [beforeId, afterId]) assert.equal(byMessageId(state, id)?.placement.spam, true, `${id} is in spam`);
    });

    // The server ignores new mail delivered to spam, so it doesn't hold such a message: a `changed` entry for it
    // would be dropped and the message would never arrive (docs/contract.md, "Providers").
    it("a message taken out of spam elsewhere comes back whole, never as changed", async (t) => {
      let state = await syncAll(h.provider, null);
      const { raw, messageId } = plainMessage({ from: "Ann Example <ann@people.example>", to: h.address, subject: "Not spam after all", body: "Real mail." });
      if (!h.deliverFiled || !h.takeOutOfSpam || !(await h.deliverFiled(raw, "spam"))) {
        await closeHarness();
        t.skip("this harness can't deliver to spam and take a message out of it");
        return;
      }
      state = await syncAll(h.provider, state);
      assert.equal(byMessageId(state, messageId)?.placement.spam, true, "delivered to spam");
      await h.takeOutOfSpam(messageId);
      state = await syncAll(h.provider, state);
      const message = byMessageId(state, messageId);
      assert.ok(message, "it came back");
      assert.ok(state.upserted.includes(message.ref), "sent whole, in upserted");
      assert.ok(!state.changed.includes(message.ref), "never as changed");
      checkPlacement(h, message.placement, { inInbox: true, category: null, screened: false }, undefined, "out of spam");
      assert.equal(message.subject, "Not spam after all");
    });

    it("the first sync returns delivered mail, parsed and in the inbox", async () => {
      const first = await deliver("First hello");
      const second = await deliver("Second hello");
      const result = await syncAll(h.provider, null);
      const a = byMessageId(result, first);
      const b = byMessageId(result, second);
      assert.ok(a && b, "both messages came back");
      assert.equal(a.subject, "First hello");
      assert.deepEqual(a.from, { name: "Ann Example", email: "ann@people.example" });
      assert.equal(a.to[0]?.email, h.address.toLowerCase());
      assert.match(a.text ?? "", /Body of First hello/);
      assert.equal(a.seen, false);
      assert.equal(a.outgoing, false);
      assert.equal(a.automated, false);
      checkPlacement(h, a.placement, { inInbox: true, category: null, screened: false }, undefined, "delivered");
      assert.ok(!Number.isNaN(Date.parse(a.date)) && a.date.endsWith("Z"), "date is ISO 8601 UTC");
      assert.notEqual(a.threadKey, b.threadKey, "unrelated messages are separate threads");
    });

    it("sync is safe to repeat with the same cursor", async () => {
      await deliver("One");
      await deliver("Two");
      await deliver("Three");
      const a = await h.provider.sync(null, { limit: 2 });
      const b = await h.provider.sync(null, { limit: 2 });
      assert.deepEqual(a.upserted.map((m) => m.ref), b.upserted.map((m) => m.ref));
      assert.equal(a.more, true);
      const c = await h.provider.sync(a.cursor, { limit: 2 });
      const d = await h.provider.sync(a.cursor, { limit: 2 });
      assert.deepEqual(c.upserted.map((m) => m.ref), d.upserted.map((m) => m.ref));
      const all = new Set([...a.upserted, ...c.upserted].map((m) => m.messageId));
      assert.equal(all.size, 3, "two batches covered all three messages once");
    });

    it("sync is incremental", async () => {
      await deliver("Before");
      const first = await syncAll(h.provider, null);
      const quiet = await syncAll(h.provider, first);
      assert.equal(quiet.messages.size, 0, "nothing new means nothing comes back");
      assert.equal(quiet.removed.length, 0);
      const later = await deliver("After");
      const next = await syncAll(h.provider, quiet);
      assert.deepEqual([...next.messages.values()].map((m) => m.messageId), [later]);
    });

    it("a small limit splits the work without losing or repeating messages", async () => {
      const ids = [await deliver("A"), await deliver("B"), await deliver("C")];
      const result = await syncAll(h.provider, null, 1);
      checkLimit(result, 1, "first sync");
      assert.ok(result.batches >= 3, "at least one batch per message");
      assert.deepEqual(result.upserted.length, 3, "each message sent once");
      assert.deepEqual([...result.view.values()].map((m) => m.messageId).sort(), [...ids].sort());
    });

    it("a placement comes back exactly as apply wrote it, for every category, gate, stack and done state", async () => {
      const id = await deliver("Place me");
      let state = await syncAll(h.provider, null);
      let ref = byMessageId(state, id)!.ref;
      for (const wanted of [...destinations().slice(1), destinations()[0]!]) {
        const what = `place ${JSON.stringify(wanted)}`;
        const [result] = await applyTracked(h.provider, state, [{ op: "place", ref, ...wanted }]);
        checkSuccess(result, what);
        const before = ref;
        ref = result.ref ?? ref;
        state = await syncAll(h.provider, state);
        checkRefs(state, before, ref, what);
        const message = state.view.get(ref);
        assert.ok(message, `${what}: held under the ref the op returned`);
        checkPlacement(h, message.placement, wanted, result.note, what);
      }
    });

    it("untrash puts a message where the op says, for every category, gate, stack and done state", async () => {
      const id = await deliver("Bin and restore");
      let state = await syncAll(h.provider, null);
      let ref = byMessageId(state, id)!.ref;
      for (const wanted of destinations()) {
        const what = `untrash to ${JSON.stringify(wanted)}`;
        const [trashed] = await applyTracked(h.provider, state, [{ op: "trash", ref }]);
        checkSuccess(trashed, `trash before ${what}`);
        ref = trashed.ref ?? ref;
        const [restored] = await applyTracked(h.provider, state, [{ op: "untrash", ref, ...wanted }]);
        checkSuccess(restored, what);
        ref = restored.ref ?? ref;
        state = await syncAll(h.provider, state);
        assert.deepEqual(state.unknownChanged, [], `${what}: changed only names messages the server has`);
        assert.ok(!state.upserted.includes(ref), `${what}: a message the provider moved itself comes back in changed, not fetched whole`);
        const message = state.view.get(ref);
        assert.ok(message, `${what}: held under the ref untrash returned`);
        checkPlacement(h, message.placement, wanted, restored.note, what);
      }
    });

    it("trash is reported as trashed", async () => {
      const id = await deliver("Bin me");
      let state = await syncAll(h.provider, null);
      const before = byMessageId(state, id)!.ref;
      const [trashed] = await applyTracked(h.provider, state, [{ op: "trash", ref: before }]);
      checkSuccess(trashed, "trash");
      const ref = trashed.ref ?? before;
      state = await syncAll(h.provider, state);
      checkRefs(state, before, ref, "trash");
      assert.equal(state.view.get(ref)?.placement.trashed, true);
    });

    it("seen round-trips as a change, without fetching the message again", async () => {
      const id = await deliver("Read me");
      let state = await syncAll(h.provider, null);
      const ref = byMessageId(state, id)!.ref;
      for (const seen of [true, false, true]) {
        const [result] = await h.provider.apply([{ op: "seen", ref, seen }]);
        checkSuccess(result, `seen=${seen}`);
        assert.equal(result.ref ?? ref, ref, "marking seen keeps the ref");
        state = await syncAll(h.provider, state);
        checkRefs(state, ref, ref, `seen=${seen}`);
        assert.ok(state.changed.includes(ref), `seen=${seen} came back in changed`);
        assert.equal(state.view.get(ref)?.seen, seen, `seen=${seen} came back`);
      }
    });

    it("limit counts upserted and changed together", async () => {
      const ids = [await deliver("Seen 1"), await deliver("Seen 2"), await deliver("Seen 3")];
      let state = await syncAll(h.provider, null);
      for (const id of ids) {
        const [result] = await applyTracked(h.provider, state, [{ op: "seen", ref: byMessageId(state, id)!.ref, seen: true }]);
        checkSuccess(result, "seen");
      }
      const fresh = [await deliver("New 1"), await deliver("New 2")];
      state = await syncAll(h.provider, state, 2);
      checkLimit(state, 2, "three changes and two new messages");
      assert.ok(state.batches >= 3, "five messages at two a batch take at least three batches");
      assert.deepEqual(state.upserted.map((ref) => state.view.get(ref)?.messageId).sort(), [...fresh].sort(), "the new mail came whole");
      assert.equal(state.changed.length, 3, "the flags came as changes");
      for (const id of ids) assert.equal(byMessageId(state, id)?.seen, true);
    });

    it("refuses inInbox with a category or Screening, and goes on with the rest", async () => {
      const id = await deliver("Not in two places");
      const state = await syncAll(h.provider, null);
      const ref = byMessageId(state, id)!.ref;
      const results = await applyTracked(h.provider, state, [
        { op: "place", ref, inInbox: true, category: "newsletter", screened: false },
        { op: "place", ref, inInbox: true, category: null, screened: true },
        { op: "untrash", ref, inInbox: true, category: "otp", screened: false },
        { op: "seen", ref, seen: true },
      ]);
      for (const index of [0, 1, 2]) {
        assert.equal(results[index]?.ok, false, `op ${index}: inInbox goes only with no category and no Screening`);
        assert.ok(results[index]?.error);
      }
      checkSuccess(results[3], "the op after them");
      const after = await syncAll(h.provider, state);
      const message = byMessageId(after, id);
      assert.ok(message, "still there");
      checkPlacement(h, message.placement, { inInbox: true, category: null, screened: false }, undefined, "where it was");
    });

    it("one failing op doesn't stop the rest, and results keep their order", async () => {
      const id = await deliver("Mixed ops");
      const state = await syncAll(h.provider, null);
      const ref = byMessageId(state, id)!.ref;
      const results = await h.provider.apply([
        { op: "seen", ref: "no-such-ref", seen: true },
        { op: "seen", ref, seen: true },
      ]);
      assert.equal(results.length, 2);
      assert.equal(results[0]?.ok, false);
      assert.ok(results[0]?.error);
      checkSuccess(results[1], "the second op");
    });

    it("a sent reply shows up in a later sync as outgoing, in its thread", async () => {
      const original = await deliver("Question");
      const state = await syncAll(h.provider, null);
      const parent = byMessageId(state, original)!;
      const sent = await h.provider.send({
        from: { email: h.address },
        to: [{ name: "Ann Example", email: "ann@people.example" }],
        cc: [],
        bcc: [{ email: "archive@people.example" }],
        subject: "Re: Question",
        text: "Here is the answer.",
        inReplyTo: original,
        references: [original],
        threadKey: parent.threadKey,
      });
      assert.ok(sent.messageId && !sent.messageId.includes("<"), "a bare Message-ID comes back");
      assert.equal(sent.note, undefined, "nothing to say about a send that went as usual");
      const after = await syncAll(h.provider, state);
      const reply = byMessageId(after, sent.messageId);
      assert.ok(reply, "the reply came back in a sync");
      assert.equal(reply.outgoing, true);
      assert.equal(reply.threadKey, parent.threadKey, "the reply joined its thread");
      assert.equal(reply.inReplyTo, original);
      assert.match(reply.text ?? "", /Here is the answer/);
    });

    it("removals are reported", async () => {
      const keep = await deliver("Keep");
      const gone = await deliver("Gone");
      const state = await syncAll(h.provider, null);
      const goneRef = byMessageId(state, gone)!.ref;
      await h.removeExternally(gone);
      const after = await syncAll(h.provider, state);
      assert.ok(after.removed.includes(goneRef), "the deleted message's ref was reported removed");
      assert.ok(!after.removed.includes(byMessageId(state, keep)!.ref), "the other message wasn't");
    });

    it("after losing its place, it lists its window again with reset, and what it leaves out is dropped", async (t) => {
      if (!h.loseSyncPlace) {
        await closeHarness();
        t.skip("this provider never loses its place");
        return;
      }
      const kept = await deliver("Kept");
      const gone = await deliver("Gone while away");
      let state = await syncAll(h.provider, null);
      const [placed] = await applyTracked(h.provider, state, [{ op: "place", ref: byMessageId(state, kept)!.ref, inInbox: false, category: "newsletter", screened: false, stack: "set_aside" }]);
      checkSuccess(placed, "place");
      await h.removeExternally(gone);
      await h.loseSyncPlace();
      const late = await deliver("Arrived while away");
      state = await syncAll(h.provider, state);
      assert.ok(state.resets >= 1, "a batch said reset");
      assert.deepEqual(state.unknownChanged, []);
      assert.equal(byMessageId(state, gone), undefined, "the message deleted meanwhile was dropped");
      assert.ok(byMessageId(state, late), "the message that arrived meanwhile is there");
      const message = byMessageId(state, kept);
      assert.ok(message, "the kept message is still there");
      checkPlacement(h, message.placement, { inInbox: false, category: "newsletter", screened: false, stack: "set_aside" }, placed.note, "after the reset");
    });

    it("attachments come back byte for byte, with inline pictures and Content-IDs", async () => {
      const binary = everyByte();
      const { raw, messageId } = messageWithAttachments({ from: "ann@people.example", to: h.address, subject: "Files" }, [
        { filename: "logo.png", mimeType: "image/png", content: TINY_PNG, contentId: "logo@people.example" },
        { filename: "data.bin", mimeType: "application/octet-stream", content: binary },
      ]);
      await h.deliver(raw);
      const state = await syncAll(h.provider, null);
      const message = byMessageId(state, messageId)!;
      assert.ok(message, "message came back");
      assert.equal(message.attachments.length, 2);
      const logo = message.attachments.find((a) => a.filename === "logo.png")!;
      const data = message.attachments.find((a) => a.filename === "data.bin")!;
      assert.deepEqual({ inline: logo.inline, contentId: logo.contentId, mimeType: logo.mimeType, size: logo.size }, {
        inline: true, contentId: "logo@people.example", mimeType: "image/png", size: TINY_PNG.byteLength,
      });
      assert.deepEqual({ inline: data.inline, size: data.size }, { inline: false, size: binary.byteLength });
      assert.match(message.html ?? "", /src="cid:logo@people\.example"/);
      assert.deepEqual(Buffer.from(await h.provider.fetchAttachment(message.ref, logo.id)), Buffer.from(TINY_PNG));
      assert.deepEqual(Buffer.from(await h.provider.fetchAttachment(message.ref, data.id)), Buffer.from(binary));
    });
  });
}
