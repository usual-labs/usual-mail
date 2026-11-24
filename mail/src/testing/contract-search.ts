/**
 * The optional part of the provider contract (docs/contract-sync.md, "What a provider must do"; docs/contract-search.md):
 * a provider either has both `search` and `fetchThread` or neither. With them it finds mail by the words, phrases,
 * exclusions and filters the server gives, newest first and a page at a time, leaves out spam and trash, says what is
 * archived, and reads a whole conversation as a sync would send it, changing nothing at the provider.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProviderSearchHit, ProviderSearchQuery } from "@usualmail/core";
import type { ContractHarness } from "./contract.ts";
import { messageWithAttachments, plainMessage, TINY_PNG } from "./messages.ts";
import { syncAll } from "./sync-all.ts";

const NOTHING: ProviderSearchQuery = { words: [], phrases: [], exclude: [] };

/**
 * Registers the search tests in the provider contract's suite; `harness` gives the current test's harness. `close`
 * closes it: node:test runs no afterEach for a test skipped while it runs, so a skipped test closes it itself.
 */
export function searchContract(harness: () => ContractHarness, close: () => Promise<void>): void {
  const skip = async (t: { skip(message: string): void }) => {
    await close();
    t.skip("no search here");
  };
  const send = async (h: ContractHarness, subject: string, body: string, from = "Ann Example <ann@people.example>") => {
    const { raw, messageId } = plainMessage({ from, to: h.address, subject, body });
    await h.deliver(raw);
    return messageId;
  };
  /** Every hit across pages of `limit`. */
  const everything = async (h: ContractHarness, query: ProviderSearchQuery, limit = 10): Promise<ProviderSearchHit[]> => {
    const out: ProviderSearchHit[] = [];
    let page: string | undefined;
    for (let i = 0; i < 20; i++) {
      const answer = await h.provider.search!(query, { limit, ...(page !== undefined && { page }) });
      out.push(...answer.hits);
      page = answer.next;
      if (page === undefined) break;
    }
    return out;
  };

  it("has both search and fetchThread, or neither", () => {
    const h = harness();
    assert.equal(typeof h.provider.search, typeof h.provider.fetchThread);
  });

  it("search finds by words, phrases, exclusions, sender and subject, newest first, without spam", async (t) => {
    const h = harness();
    if (!h.provider.search) return skip(t);
    await send(h, "Garden plans", "The tulips arrive on Friday.");
    await send(h, "Invoice 77", "Your invoice for the tulips.", "Billing <billing@shop.example>");
    await send(h, "Lunch", "Nothing about flowers.");
    if (h.deliverFiled) {
      const { raw } = plainMessage({ from: "Spam <spam@junk.example>", to: h.address, subject: "Tulips for free", body: "tulips tulips" });
      await h.deliverFiled(raw, "spam");
    }
    const subjects = async (query: Partial<ProviderSearchQuery>) => (await everything(h, { ...NOTHING, ...query })).map((hit) => hit.subject);
    assert.deepEqual(await subjects({ words: ["tulips"] }), ["Invoice 77", "Garden plans"], "newest first, spam left out");
    assert.deepEqual(await subjects({ phrases: ["arrive on friday"] }), ["Garden plans"]);
    assert.deepEqual(await subjects({ words: ["tulips"], exclude: ["invoice"] }), ["Garden plans"]);
    assert.deepEqual(await subjects({ from: "billing@shop.example" }), ["Invoice 77"]);
    assert.deepEqual(await subjects({ subject: "lunch" }), ["Lunch"]);
    const [hit] = await everything(h, { ...NOTHING, words: ["garden"] });
    assert.equal(hit!.from.email, "ann@people.example");
    assert.equal(hit!.messageCount, 1);
    assert.equal(hit!.inInbox, true);
    assert.ok(Date.parse(hit!.date) > 0);
    assert.equal(typeof hit!.snippet, "string");
  });

  it("search says what is archived and has an attachment, filters by them, and pages without repeats", async (t) => {
    const h = harness();
    if (!h.provider.search) return skip(t);
    const { raw } = messageWithAttachments({ from: "Ann <ann@people.example>", to: h.address, subject: "Scan attached", body: "Here it is." },
      [{ filename: "scan.png", mimeType: "image/png", content: TINY_PNG }]);
    await h.deliver(raw);
    if (h.deliverFiled) {
      const old = plainMessage({ from: "Ann <ann@people.example>", to: h.address, subject: "Archived scan", body: "An old one." });
      await h.deliverFiled(old.raw, "archive");
    }
    for (let i = 0; i < 3; i++) await send(h, `Scan number ${i}`, "Another scan.");
    const all = await everything(h, { ...NOTHING, words: ["scan"] });
    assert.equal(all.find((hit) => hit.subject === "Scan attached")?.hasAttachments, true);
    assert.equal(all.find((hit) => hit.subject === "Scan number 0")?.hasAttachments, false);
    const paged = await everything(h, { ...NOTHING, words: ["scan"] }, 1);
    assert.deepEqual(paged.map((hit) => hit.threadKey), all.map((hit) => hit.threadKey), "pages of one: nothing skipped or repeated");
    assert.deepEqual((await everything(h, { ...NOTHING, words: ["scan"], hasAttachment: true })).map((hit) => hit.subject), ["Scan attached"]);
    if (h.deliverFiled) {
      assert.equal(all.find((hit) => hit.subject === "Archived scan")?.inInbox, false);
      assert.deepEqual((await everything(h, { ...NOTHING, words: ["scan"], archived: true })).map((hit) => hit.subject), ["Archived scan"]);
    }
  });

  it("fetchThread reads a conversation as a sync sends it, oldest first, and changes nothing", async (t) => {
    const h = harness();
    if (!h.provider.fetchThread || !h.provider.search) return skip(t);
    const first = await send(h, "Long story", "Part one.");
    const { raw } = plainMessage({ from: "Ann Example <ann@people.example>", to: h.address, subject: "Re: Long story", body: "Part two.", inReplyTo: first, references: [first] });
    await h.deliver(raw);
    const synced = await syncAll(h.provider, null);
    const [hit] = await everything(h, { ...NOTHING, words: ["story"] });
    assert.equal(hit!.messageCount, 2);
    const thread = await h.provider.fetchThread(hit!.threadKey);
    assert.deepEqual(thread.map((m) => m.subject), ["Long story", "Re: Long story"]);
    for (const message of thread) {
      const seen = synced.view.get(message.ref);
      assert.ok(seen, "the same ref a sync reported");
      assert.equal(message.threadKey, seen.threadKey);
      assert.deepEqual(message.placement, seen.placement);
      assert.equal(message.text?.trim(), seen.text?.trim());
    }
    assert.deepEqual(await h.provider.fetchThread("no-such-conversation"), []);
    const after = await syncAll(h.provider, synced);
    assert.deepEqual([...after.upserted, ...after.changed, ...after.removed], [], "reading changed nothing at the provider");
  });
}
