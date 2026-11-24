// A store from the fourth revision (piles) upgrades to the fifth (docs/contract-sync.md, "Earlier revisions' piles"):
// piles become categories and screening a gate, the triage state becomes who decided, moves become categorizes (a
// move into screening goes, from records and rules alike), inboxes get an icon, a position and AI processing off, and
// what the server keeps for undo still undoes.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { asc } from "drizzle-orm";
import { actions, messages } from "../src/db/index.ts";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock, MemoryMailbox, memoryFactory } from "../src/testing/index.ts";
import { HOUR, START } from "./helpers.ts";

const state = (pile: string, triage: string, extra: Record<string, unknown> = {}) => ({
  pile, done: false, stack: null, comeBackAt: null, comeBackIfNoReply: false, comeBackSetAt: null, unread: false,
  unreadMessageIds: [], readMessageIds: ["msg_a"], trashed: false, triage, need: null, reason: null, ...extra,
});

test("a fourth-revision store upgrades, and the server reads it, undoes its records and keeps its rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-fifth-"));
  try {
    const source = fileURLToPath(new URL("../migrations", import.meta.url));
    const older = join(dir, "migrations");
    await cp(source, older, { recursive: true });
    const journal = JSON.parse(await readFile(join(older, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    // The store as the fourth revision left it: every migration up to 0003, none after.
    journal.entries = journal.entries.filter((entry) => entry.tag <= "0003_fourth_revision");
    assert.equal(journal.entries.at(-1)!.tag, "0003_fourth_revision");
    await writeFile(join(older, "meta/_journal.json"), JSON.stringify(journal));
    const file = join(dir, "fourth.db");
    const client = createClient({ url: `file:${file}` });
    await migrate(drizzle(client), { migrationsFolder: older });

    const now = Date.parse(START);
    const secrets = await aesGcmSecrets(webRandom.bytes(32), webRandom);
    const sealed = (id: string, address: string) => secrets.seal(JSON.stringify({ mailbox: address }), id);
    const thread = (id: string, inbox: string, pile: string, triage: string, sender: string) => ({
      sql: "INSERT INTO threads (id, inbox_id, thread_key, subject, snippet, participants, last_message_at, message_count, unread, has_attachments, pile, done, triage, sender, created_at, version, revision) VALUES (?, ?, ?, ?, '', '[]', ?, 1, 0, 0, ?, 0, ?, ?, ?, 4, 2)",
      args: [id, inbox, id, `Subject ${id}`, now - HOUR, pile, triage, sender, now],
    });
    const message = (id: string, threadId: string, inbox: string, from: string, placement: object) => ({
      sql: "INSERT INTO messages (id, thread_id, inbox_id, ref, message_id, \"references\", from_address, to_addresses, cc_addresses, bcc_addresses, date, subject, unread, outgoing, automated, placement, seen, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', ?, 'S', 0, 0, 0, ?, 1, ?)",
      args: [id, threadId, inbox, `ref-${id}`, `${id}@old.example`, JSON.stringify({ email: from }), now - HOUR, JSON.stringify(placement), now],
    });
    await client.batch([
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor) VALUES ('inb_a', 'A', 'a@old.example', '#000000', 'imap', 'act_with_undo', 'ok', ?, ?, 3, 1, '0')", args: [now, await sealed("inb_a", "a@old.example")] },
      { sql: "INSERT INTO inboxes (id, name, address, color, provider, trust, status, created_at, credentials, version, history_done, sync_cursor) VALUES ('inb_b', 'B', 'b@old.example', '#000000', 'gmail', 'suggest', 'ok', ?, ?, 1, 1, '0')", args: [now, await sealed("inb_b", "b@old.example")] },
      thread("thr_people", "inb_a", "people", "by_person", "dana@old.example"),
      thread("thr_reads", "inb_a", "reads", "by_rule", "news@old.example"),
      thread("thr_receipts", "inb_a", "receipts", "by_agent", "shop@old.example"),
      thread("thr_screen", "inb_a", "screening", "pending", "who@old.example"),
      thread("thr_pending", "inb_a", "people", "pending", "pat@old.example"),
      message("msg_a", "thr_people", "inb_a", "dana@old.example", { inInbox: true, trashed: false, spam: false, stack: null }),
      message("msg_b", "thr_reads", "inb_a", "news@old.example", { inInbox: false, pile: "reads", trashed: false, spam: false, stack: null }),
      message("msg_c", "thr_screen", "inb_a", "who@old.example", { inInbox: false, pile: "screening", trashed: false, spam: false, stack: null }),
      { sql: "INSERT INTO senders (inbox_id, email, status, updated_at) VALUES ('inb_a', 'dana@old.example', 'known', ?)", args: [now] },
      // A person's move to Reads, undoable, with the before-state the fourth revision kept.
      {
        sql: "INSERT INTO actions (id, thread_id, inbox_id, action, kind, actor, actor_kind, state, at, undoable, before, version) VALUES ('act_move', 'thr_reads', 'inb_a', '{\"kind\":\"move\",\"pile\":\"reads\"}', 'move', '{\"kind\":\"person\",\"deviceId\":\"dev_p\"}', 'person', 'applied', ?, 1, ?, 1)",
        args: [now - HOUR, JSON.stringify({ threads: [{ id: "thr_reads", state: state("people", "by_person"), revision: 2, after: state("reads", "by_person") }] })],
      },
      // A move into screening has no counterpart: it goes.
      { sql: "INSERT INTO actions (id, thread_id, inbox_id, action, kind, actor, actor_kind, state, at, undoable, before, version) VALUES ('act_screen', 'thr_screen', 'inb_a', '{\"kind\":\"move\",\"pile\":\"screening\"}', 'move', '{\"kind\":\"agent\",\"agentId\":\"dev_a\",\"name\":\"A\"}', 'agent', 'applied', ?, 1, ?, 1)", args: [now - HOUR, JSON.stringify({ threads: [{ id: "thr_screen", state: state("people", "pending") }] })] },
      { sql: "INSERT INTO rules (id, inbox_id, text, \"match\", \"then\", source, enabled, hits, created_at, created_by, version) VALUES ('rul_reads', 'inb_a', 'News is reading', '{\"domain\":\"news2.example\"}', '[{\"kind\":\"move\",\"pile\":\"reads\"},{\"kind\":\"read\"}]', 'person', 1, 2, ?, '{\"kind\":\"person\",\"deviceId\":\"dev_p\"}', 3)", args: [now - 2 * HOUR] },
      { sql: "INSERT INTO rules (id, inbox_id, text, \"match\", \"then\", source, enabled, hits, created_at, created_by, version) VALUES ('rul_screen', 'inb_a', 'Screen them', '{\"domain\":\"spammy.example\"}', '[{\"kind\":\"move\",\"pile\":\"screening\"}]', 'agent', 1, 0, ?, '{\"kind\":\"agent\",\"agentId\":\"dev_a\",\"name\":\"A\"}', 1)", args: [now - 3 * HOUR] },
    ], "write");
    client.close();

    const store = await openDatabase(`file:${file}`);
    const clock = new ManualClock(START);
    const mailboxes = new Map<string, MemoryMailbox>();
    const mailbox = new MemoryMailbox({ address: "a@old.example", now: () => clock.now() });
    mailboxes.set(mailbox.address, mailbox);
    const providers = new ProviderRegistry();
    providers.register("imap", memoryFactory(mailboxes, { now: () => clock.now() }));
    providers.register("gmail", memoryFactory(mailboxes, { kind: "gmail", now: () => clock.now() }));
    const host = { db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(), secrets, log: { info: () => {}, error: () => {} } };
    const server = await MailServer.create(host, { providers, models: new FakeModels() });
    const owner = (await server.ownerPairingCode())!;
    const person = (await server.authenticate((await server.pair({ code: owner.code, name: "Mac" })).token))!;
    try {
      const inboxes = await server.listInboxes(person);
      assert.deepEqual(inboxes.map((inbox) => [inbox.id, inbox.position, inbox.icon, "aiProcessing" in inbox, inbox.version]),
        [["inb_a", 0, "person", false, 4], ["inb_b", 1, "building", false, 2]], "in connection order, icons in turn, no AI switch, changed for clients");
      const seen = async (id: string) => (await server.thread(person, id)).thread;
      const people = await seen("thr_people");
      assert.deepEqual([people.category, people.categorizedBy, people.screened, people.version], ["conversation", "person", false, 5]);
      const reads = await seen("thr_reads");
      assert.deepEqual([reads.category, reads.categorizedBy], ["newsletter", "rule"]);
      assert.deepEqual([(await seen("thr_receipts")).category, (await seen("thr_receipts")).categorizedBy], ["receipt", "agent"]);
      const screened = await seen("thr_screen");
      assert.deepEqual([screened.category, screened.categorizedBy, screened.screened], ["unknown", undefined, true]);
      const pending = await seen("thr_pending");
      assert.deepEqual([pending.category, pending.categorizedBy], ["unknown", undefined], "nobody had decided it: undecided, not a conversation");

      const records = (await server.handled(person, { attentionOnly: false, states: ["applied"], includeSilent: true })).items;
      assert.deepEqual(records.map((item) => item.record.id), [], "Handled's ordinary list is rules', agents' and the AI's");
      const everything = await store.db.select({ id: actions.id, kind: actions.kind, action: actions.action }).from(actions).orderBy(asc(actions.id));
      assert.deepEqual(everything.map((row) => [row.id, row.kind, row.action]), [["act_move", "categorize", { kind: "categorize", category: "newsletter" }]], "the move into screening is gone");

      const undone = await server.undo(person, "act_move");
      assert.deepEqual([undone.threads[0]!.category, undone.threads[0]!.categorizedBy], ["conversation", "person"], "undo from the upgraded before-state");

      const rules = await server.listRules(person, "inb_a");
      const byId = Object.fromEntries(rules.map((rule) => [rule.id, rule]));
      assert.deepEqual(byId.rul_reads!.then, [{ kind: "categorize", category: "newsletter" }, { kind: "read" }]);
      assert.equal(byId.rul_reads!.enabled, true);
      assert.deepEqual([byId.rul_screen!.then, byId.rul_screen!.enabled], [[], false], "left with no action, switched off");
      assert.ok(byId.rul_reads!.version > 3);

      const placements = await store.db.select({ id: messages.id, placement: messages.placement }).from(messages).orderBy(asc(messages.id));
      assert.deepEqual(placements.map((row) => [row.id, row.placement]), [
        ["msg_a", { inInbox: true, trashed: false, spam: false, stack: null, category: null, screened: false }],
        ["msg_b", { inInbox: false, trashed: false, spam: false, stack: null, category: "newsletter", screened: false }],
        ["msg_c", { inInbox: false, trashed: false, spam: false, stack: null, screened: true }],
      ], "as the providers now report them; IMAP's Screening folder keeps no category");

      assert.deepEqual((await server.aiSettings(person)).credentialsSet, false);
      assert.equal((await server.aiStatus(person)).state, "not_set_up");
      const counts = await server.counts(person);
      assert.equal(counts.all.screened, 1);
      assert.equal(counts.all.home, 3, "the conversation, the undecided thread and the one the undo brought back");

      // A second start finds nothing left to upgrade.
      await server.stop();
      const again = await MailServer.create(host, { providers, models: new FakeModels() });
      assert.deepEqual((await again.listRules(person, "inb_a")).find((rule) => rule.id === "rul_reads")!.version, byId.rul_reads!.version);
    } finally {
      await server.stop();
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
