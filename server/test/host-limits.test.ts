// A host's limits on memory and stored size (`HostLimits`, src/host.ts): Node's values when a host sets none, and what a
// smaller host (Cloudflare) gets: the sync batch it asks for, messages made to fit its rows, its own picture plans and
// search's catch-up in the background.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MailProvider, ProviderMessage } from "@usualmail/core";
import { eq, sql } from "drizzle-orm";
import { messages } from "../src/db/index.ts";
import { NODE_LIMITS } from "../src/host.ts";
import { servedPlans } from "../src/pictures/present.ts";
import { SearchIndex } from "../src/search/indexer.ts";
import { Ctx } from "../src/service/context.ts";
import { fitMessage, HTML_LEFT_OUT, storedBytes, TEXT_CUT, utf8Length } from "../src/sync/fit.ts";
import { makeServer, type TestServer } from "./helpers.ts";

const ME = "me@limits.example";

/** Records the `limit` each sync asks the memory provider for. */
function recordLimits(t: TestServer): number[] {
  const asked: number[] = [];
  for (const kind of ["imap", "gmail"] as const) {
    const factory = t.providers.get(kind)!;
    t.providers.register(kind, (credentials, options) => {
      const provider = factory(credentials, options) as MailProvider;
      const sync = provider.sync.bind(provider);
      provider.sync = (cursor, syncOptions) => {
        asked.push(syncOptions?.limit ?? -1);
        return sync(cursor, syncOptions);
      };
      return provider;
    });
  }
  return asked;
}

async function stored(t: TestServer, subject: string) {
  const row = await t.host.db.select().from(messages).where(eq(messages.subject, subject)).get();
  assert.ok(row, `"${subject}" is stored`);
  return row;
}

const history = (count: number) => Array.from({ length: count }, (_, i) => ({ from: { email: `p${i}@people.example` }, subject: `Old ${i}`, text: `Note ${i}` }));

describe("Node's limits, when a host sets none", () => {
  test("batches of 200, no limit on a stored message, the process's shared picture plans", async () => {
    assert.deepEqual(NODE_LIMITS, { syncBatch: 200, storedMessageBytes: Number.POSITIVE_INFINITY, searchChunk: 100, searchInBackground: false, searchReadChars: 4_000_000 });
    const t = await makeServer();
    try {
      const asked = recordLimits(t);
      const html = `<p>${"word ".repeat(200_000)}</p>`;
      const { inbox } = await t.connect({ address: ME, history: [{ from: { email: "big@people.example" }, subject: "Big", text: "Short.", html }] });
      assert.ok(asked.length > 0 && asked.every((limit) => limit === 200), `asked ${asked.join(", ")}`);
      const row = await stored(t, "Big");
      assert.equal(row.html, html, "stored as it came");
      assert.equal(row.text, "Short.");
      assert.ok(inbox);
    } finally {
      await t.close();
    }
  });

  test("a message is fitted only on a host with a limit", () => {
    const m = { text: "x".repeat(10_000) } as ProviderMessage;
    assert.equal(fitMessage(m, Number.POSITIVE_INFINITY), m);
  });

  test("the picture plans are the process's shared ones unless the host sizes its own", async () => {
    const t = await makeServer();
    try {
      const node = new Ctx(t.host, t.providers, t.models, {});
      assert.equal(node.picturePlans, servedPlans);
      assert.deepEqual(node.limits, NODE_LIMITS);
      const small = new Ctx({ ...t.host, limits: { keptPictureChars: 1_000, syncBatch: 9 } }, t.providers, t.models, {});
      assert.notEqual(small.picturePlans, servedPlans);
      assert.deepEqual(small.limits, { ...NODE_LIMITS, syncBatch: 9 });
    } finally {
      await t.close();
    }
  });
});

describe("a host with smaller limits", () => {
  test("asks each sync for its batch, and takes in all the mail over several", async () => {
    const t = await makeServer({ limits: { syncBatch: 7 } });
    try {
      const asked = recordLimits(t);
      await t.connect({ address: ME, history: history(20) });
      assert.ok(asked.filter((limit) => limit === 7).length >= 3, `asked ${asked.join(", ")}`);
      assert.ok(asked.every((limit) => limit === 7));
      for (let i = 0; i < 20; i++) await stored(t, `Old ${i}`);
    } finally {
      await t.close();
    }
  });

  test("a message over the stored size keeps its text without its HTML; one with too much text is cut; each says so", async () => {
    const limit = 60_000;
    const t = await makeServer({ limits: { storedMessageBytes: limit } });
    try {
      const html = `<p>${"Ünïcode wörds ".repeat(20_000)}</p>`;
      const text = "Long text line.\n".repeat(20_000);
      const ownText = "The newsletter's own text version. ".repeat(20);
      await t.connect({
        address: ME,
        history: [
          { from: { email: "a@people.example" }, subject: "Large newsletter", text: ownText, html },
          { from: { email: "b@people.example" }, subject: "Only HTML", html },
          { from: { email: "c@people.example" }, subject: "Long log", text },
          { from: { email: "d@people.example" }, subject: "Small", text: "Fits.", html: "<p>Fits.</p>" },
        ],
      });
      const newsletter = await stored(t, "Large newsletter");
      assert.equal(newsletter.html, null);
      assert.equal(newsletter.text, `${ownText}\n\n${HTML_LEFT_OUT}`, "its own text, which is more than a stub");
      const onlyHtml = await stored(t, "Only HTML");
      assert.equal(onlyHtml.html, null);
      assert.match(onlyHtml.text!, /^Ünïcode wörds/, "the text made from the HTML");
      assert.ok(onlyHtml.text!.endsWith(TEXT_CUT), "and cut");
      const log = await stored(t, "Long log");
      assert.ok(log.text!.startsWith("Long text line.\n"));
      assert.ok(log.text!.endsWith(TEXT_CUT));
      for (const row of [newsletter, onlyHtml, log]) assert.ok(utf8Length(row.text ?? "") + utf8Length(row.html ?? "") < limit);
      const small = await stored(t, "Small");
      assert.equal(small.html, "<p>Fits.</p>", "a message that fits is kept whole");

      // Read again by the next sync, the fitted message is the same: nothing is written again.
      const versions = (await t.server.search(t.person, { q: "Large newsletter" })).items.map((thread) => thread.version);
      await t.sync((await t.server.listInboxes(t.person))[0]!);
      assert.deepEqual((await t.server.search(t.person, { q: "Large newsletter" })).items.map((thread) => thread.version), versions);
    } finally {
      await t.close();
    }
  });

  test("headers no message needs that long are cut, so the whole row fits", async () => {
    const limit = 40_000;
    const to = Array.from({ length: 5_000 }, (_, i) => ({ name: `Recipient ${i}`, email: `r${i}@crowd.example` }));
    const m = {
      ref: "1", threadKey: "t", references: Array.from({ length: 500 }, (_, i) => `ref-${i}@x.example`), from: { email: "a@x.example" },
      to, cc: to, bcc: [], date: new Date().toISOString(), subject: "S".repeat(50_000), text: "Body.", attachments: [], seen: false,
      outgoing: false, placement: { inbox: true, archived: false, spam: false, trashed: false, labels: [] }, automated: false,
    } as unknown as ProviderMessage;
    assert.ok(storedBytes(m) > 10 * limit);
    const fitted = fitMessage(m, limit);
    assert.ok(storedBytes(fitted) <= limit, `${storedBytes(fitted)} bytes`);
    assert.equal(fitted.text, "Body.");
    assert.equal(fitted.subject.length, 2_000);
    assert.equal(fitted.references.length, 50);
    assert.equal(fitted.references[0], "ref-0@x.example", "the thread's root is kept");
    assert.equal(fitted.references[1], "ref-451@x.example");
    assert.equal(fitted.references.at(-1), "ref-499@x.example", "and the closest parents");
    assert.ok(fitted.to.length > 0 && fitted.to.length < to.length);
    assert.deepEqual(fitted.to[0], to[0]);
    assert.deepEqual(fitMessage(m, limit), fitted, "the same message fits the same way");
  });

  test("text is cut on a character, never inside one", () => {
    const m = { ref: "1", threadKey: "t", references: [], from: { email: "a@x.example" }, to: [], cc: [], bcc: [], subject: "", text: "😀".repeat(10_000), attachments: [], placement: {} } as unknown as ProviderMessage;
    const fitted = fitMessage(m, 20_000);
    assert.ok(storedBytes(fitted) <= 20_000);
    const kept = fitted.text!.slice(0, fitted.text!.indexOf("\n\n"));
    assert.equal(kept, "😀".repeat(kept.length / 2));
  });

  test("search's catch-up at start runs in the background, chunk by chunk, after start() returns; on Node, inside it", async () => {
    const t = await makeServer();
    try {
      await t.connect({ address: ME, history: history(10) });
      const docs = async () => (await t.host.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM search_docs`))[0]!.n;
      for (const background of [false, true]) {
        // As a store whose index is behind: emptied, then an index started on it.
        await t.host.db.run(sql`DELETE FROM search_docs`);
        const infos: string[] = [];
        const log = { info: (message: string) => void infos.push(message), error: (message: string) => void infos.push(message) };
        const ctx = new Ctx({ ...t.host, log, limits: { searchInBackground: background, searchChunk: 3 } }, t.providers, t.models, {});
        const index = new SearchIndex(ctx, () => {});
        await index.start();
        if (background) {
          // When start() returns, the catch-up has at most begun (on Node libSQL's own queries give the event loop its
          // turns; on Cloudflare the turn between chunks does: limits.test.ts in test/cloudflare).
          assert.ok((await docs()) <= 3, `${await docs()} threads indexed when start() returned`);
          assert.deepEqual(infos, []);
        } else {
          assert.equal(await docs(), 10);
          assert.match(infos[0] ?? "", /^Search index: 10 threads \(10 messages\) indexed/);
        }
        // What a search waits for.
        await index.fresh();
        assert.equal(await docs(), 10);
        assert.deepEqual(infos.filter((line) => line.startsWith("Search index:")).length, 1, infos.join("\n"));
        index.stop();
      }
      assert.equal((await t.server.search(t.person, { q: "Note", limit: 50 })).items.length, 10);
    } finally {
      await t.close();
    }
  });
});
