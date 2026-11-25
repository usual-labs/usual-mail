// Demo mode: after seeding from sample.json, every list, count and the AI's settings and status say what the sample
// and the contract's list rules imply, with the server's AI on fake models that report the sample's model ids.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import sampleJson from "@usualmail/core/fixtures/sample.json" with { type: "json" };
import { CATEGORIES, HOME_CATEGORIES, STACKS, type ActionRecord, type Caller, type SampleData, type Thread } from "@usualmail/core";
import { aesGcmSecrets, DEMO_SUFFIXES, demoModels, demoProviders, MailServer, MemoryEventBus, seedSample, seedSamplePictures, webRandom, type Demo, type FakeModels, type Host } from "../src/index.ts";
import { openDatabase } from "../src/node/db.ts";
import { ManualClock } from "../src/testing/index.ts";

const sample = sampleJson as SampleData;
const now = Date.parse(sample.now);
let server: MailServer;
let person: Caller;
let demo: Demo;
let models: FakeModels;
let clock: ManualClock;
let close: () => void;

/** Newest first, equal times by id, descending: the order every list uses. */
const newestFirst = (a: Thread, b: Thread) => b.lastMessageAt.localeCompare(a.lastMessageAt) || (a.id < b.id ? 1 : -1);
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);
const live = sample.threads.filter((t) => !t.trashed);

before(async () => {
  const store = await openDatabase(":memory:");
  close = store.close;
  clock = new ManualClock(now);
  const host: Host = {
    db: store.db,
    clock,
    scheduler: clock,
    random: webRandom,
    events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log: { info: () => {}, error: () => {} },
  };
  demo = demoProviders(() => clock.now());
  models = demoModels(sample);
  server = await MailServer.create(host, { providers: demo.providers, models, aiHistory: false, avatars: { suffixes: DEMO_SUFFIXES } });
  await seedSample(host, demo, sample, 0);
  await seedSamplePictures(host, sample);
  await server.reload();
  const code = await server.ownerPairingCode();
  person = (await server.authenticate((await server.pair({ code: code!.code, name: "Demo Mac" })).token))!;
});
after(async () => {
  await server.stop();
  close();
});

describe("demo mode", () => {
  test("inboxes, the AI's settings, its status and the counts are the sample's", async () => {
    assert.deepEqual(await server.listInboxes(person), sample.inboxes);
    assert.deepEqual(await server.aiSettings(person), sample.ai);
    assert.deepEqual(await server.aiStatus(person), sample.aiStatus);
    assert.deepEqual(await server.counts(person), sample.counts);
  });

  test("starting syncs and repairs: only the reachable inboxes' lastSyncedAt moves, nothing is written, and the AI sends nothing", async () => {
    await server.start();
    await server.whenIdle();
    for (const mailbox of demo.mailboxes.values()) assert.deepEqual(mailbox.applied, [], mailbox.address);
    const synced = sample.inboxes.map((inbox) => inbox.status === "ok" ? { ...inbox, lastSyncedAt: sample.now } : inbox);
    assert.deepEqual(await server.listInboxes(person), synced);
    assert.equal(models.requests.length, 0, "the sample's waiting thread stays waiting: demo mode processes no history");
    assert.deepEqual(await server.aiStatus(person), sample.aiStatus);
    assert.deepEqual(await server.counts(person), sample.counts);
  });

  test("Home is conversations and undecided threads not screened, done, stacked or waiting, by the later of the newest mail and a passed come-back", async () => {
    const order = (t: Thread) => [t.lastMessageAt, t.comeBackAt ?? ""].sort().at(-1)!;
    const expected = live
      .filter((t) => (HOME_CATEGORIES as readonly string[]).includes(t.category) && !t.screened && !t.done && !t.stack && (!t.comeBackAt || Date.parse(t.comeBackAt) <= now))
      .sort((a, b) => order(b).localeCompare(order(a)) || (a.id < b.id ? 1 : -1));
    assert.deepEqual(ids(expected), ["thr_14", "thr_1", "thr_2", "thr_12", "thr_16"], "no notification (the owner's decision of 2026-11-19)");
    assert.deepEqual((await server.home(person, {})).items, expected);
  });

  test("the blocked senders are the sample's: who blocked them, since when, and the mail counted since", async () => {
    assert.deepEqual((await server.senders(person, { state: "blocked" })).items, sample.blockedSenders);
    assert.deepEqual((await server.senders(person, { inboxId: "inb_personal" })).items.map((item) => [item.address, item.messagesSinceBlocked]), [["deals@brightbuy.example", 3]]);
  });

  test("the sample's notifications tell one parcel's story and one appointment's in groups; the others have none", async () => {
    const notices = (await server.category(person, "notification", {})).items;
    const groupOf = (id: string) => notices.find((t) => t.id === id)?.event?.group ?? null;
    const parcel = groupOf("thr_21");
    const appointment = groupOf("thr_20");
    assert.ok(parcel && appointment && parcel !== appointment);
    assert.deepEqual(["thr_23", "thr_24", "thr_21"].map(groupOf), [parcel, parcel, parcel], "arriving, out for delivery, delivered");
    assert.deepEqual(["thr_20", "thr_25"].map(groupOf), [appointment, appointment], "confirmed, then moved the same day");
    assert.deepEqual(["thr_19", "thr_22"].map(groupOf), [null, null]);
    assert.ok(!notices.some((t) => t.category !== "notification"));
  });

  test("each category is its threads not screened, done or waiting, stacked ones included; screening and waiting too", async () => {
    const waitingNow = (t: Thread) => t.comeBackAt !== undefined && Date.parse(t.comeBackAt) > Date.parse(sample.now);
    for (const category of CATEGORIES) {
      const expected = live.filter((t) => t.category === category && !t.screened && !t.done && !waitingNow(t)).sort(newestFirst);
      assert.deepEqual((await server.category(person, category, {})).items, expected, category);
    }
    assert.deepEqual(ids((await server.category(person, "conversation", {})).items), ["thr_1", "thr_2", "thr_7"], "thr_9 waits: out of sight");
    assert.deepEqual(ids((await server.screening(person, {})).items), ["thr_5"]);
    assert.deepEqual(ids((await server.waiting(person, {})).items), ["thr_9"]);
  });

  test("each stack is its threads, newest first", async () => {
    for (const stack of STACKS) {
      const expected = live.filter((t) => t.stack === stack && !t.screened).sort(newestFirst);
      assert.deepEqual((await server.stack(person, stack, {})).items, expected, stack);
    }
  });

  test("Handled is what rules, agents and the AI did or propose, newest first, equal times by id; silent ones only when asked", async () => {
    const theirs = sample.actions
      .filter((a) => ["rule", "agent", "ai"].includes(a.actor.kind) && (a.state === "proposed" || a.state === "applied"))
      .sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : -1));
    const page = await server.handled(person, {});
    assert.deepEqual(page.items.map((i) => i.record), theirs.filter((a) => !a.silent) as ActionRecord[]);
    assert.deepEqual(ids(page.items.map((i) => i.record)), ["act_2", "act_1", "act_4", "act_3", "act_21"], "the agent's block the person approved is the oldest");
    const all = await server.handled(person, { includeSilent: true, limit: 200 });
    assert.deepEqual(all.items.map((i) => i.record), theirs as ActionRecord[]);
    for (const item of all.items) assert.deepEqual(item.thread, sample.threads.find((t) => t.id === item.record.threadId));
  });

  test("the sample's sender pictures are served: made-up PNGs of the sizes the sample says", async () => {
    const shown = sample.threads.filter((thread) => thread.avatar);
    assert.ok(shown.length > 0);
    for (const thread of shown) {
      const picture = await server.fetchAvatar(person, thread.avatar!.picture.split("/").pop()!);
      assert.equal(picture.mimeType, "image/png", thread.id);
      assert.equal(new DataView(picture.data.buffer, picture.data.byteOffset).getUint32(16), thread.avatar!.size, thread.id);
    }
  });

  test("a thread's detail, the rules, the drafts, the brief and the triage queue are the sample's", async () => {
    const detail = await server.thread(person, "thr_1");
    assert.deepEqual(detail.thread, sample.threads.find((t) => t.id === "thr_1"));
    assert.deepEqual(detail.drafts, sample.drafts.filter((d) => d.threadId === "thr_1"));
    // A sent draft with a note is in its thread for a day, not in the drafts list.
    assert.deepEqual((await server.thread(person, "thr_7")).drafts, sample.drafts.filter((d) => d.threadId === "thr_7"));
    for (const thread of sample.threads) {
      assert.deepEqual((await server.thread(person, thread.id)).messages, sample.messages.filter((m) => m.threadId === thread.id), thread.id);
    }
    for (const inbox of sample.inboxes) {
      assert.deepEqual(await server.listRules(person, inbox.id), sample.rules.filter((r) => r.inboxId === inbox.id));
    }
    assert.deepEqual((await server.listDrafts(person, {})).items, sample.drafts.filter((d) => d.state === "draft" || d.state === "failed"));
    assert.deepEqual(await server.latestBrief(person), sample.brief);
    // Undecided, not screened or done, that the AI won't process: none. Every inbox's synced mail goes to the AI once
    // a key is set, however old (since 2026-11-18), so thr_16, nine days old, is the AI's, not the queue's.
    assert.deepEqual((await server.triageQueue(person, {})).map((i) => i.thread.id), []);
  });

  test("search answers from the sample: ranked, with where it matched, the people, and older mail in the mailbox", async () => {
    const contract = await server.search(person, { q: "contract" });
    assert.deepEqual(ids(contract.items), ["thr_1"]);
    assert.deepEqual(contract.items[0]!.match!.subject, [{ text: "Contract", match: true }, { text: " renewal for 2027", match: false }]);
    assert.deepEqual((await server.search(person, { q: "paperloop" })).people?.map((p) => p.email), ["billing@paperloop.example"]);
    assert.deepEqual(ids((await server.search(person, { kinds: ["done"], from: "lumen.example" })).items), ["thr_13"]);
    const older = await server.searchRemote(person, { q: "contract" });
    assert.deepEqual(older.inboxes.map((i) => [i.inboxId, i.state]), [["inb_northwind", "ok"], ["inb_harbor", "unsupported"], ["inb_personal", "unsupported"]]);
    assert.deepEqual(older.items.map((hit) => [hit.subject, hit.messageCount, hit.archived, hit.hasAttachments]), [["Contract renewal for 2026", 2, true, true]]);
    const opened = await server.openRemote(person, older.items[0]!.id);
    assert.deepEqual([opened.thread.done, opened.messages.length], [true, 2]);
    assert.deepEqual((await server.search(person, { q: "contract" })).items.map((t) => t.subject), ["Contract renewal for 2027", "Contract renewal for 2026"]);
    assert.deepEqual((await server.searchRemote(person, { q: "portfolio" })).items.map((hit) => [hit.subject, hit.archived]), [["Portfolio for the design role", false]]);
  });

  test("search finds threads by subject, snippet, summary or participant, done or not", async () => {
    assert.deepEqual(ids((await server.search(person, { q: "lotte" })).items), ["thr_7"]);
    assert.deepEqual(ids((await server.search(person, { q: "paperloop" })).items), ["thr_3"]);
    assert.deepEqual(ids((await server.search(person, { q: "slides you pointed" })).items), ["thr_13"]);
    assert.deepEqual((await server.search(person, { q: "email" })).items, [], "the participants' JSON keys aren't text a person wrote");
  });

  test("an agent sees only inboxes with agentAccess, and their counts", async () => {
    const code = await server.createPairingCode(person, { kind: "agent", inboxIds: sample.inboxes.map((i) => i.id) });
    const agent = (await server.authenticate((await server.pair({ code: code.code, name: "Claude Code" })).token))!;
    const open = sample.inboxes.filter((i) => i.agentAccess).map((i) => i.id);
    assert.deepEqual(ids(await server.listInboxes(agent)), open);
    await server.updateInbox(person, "inb_personal", { agentAccess: false });
    assert.deepEqual(ids(await server.listInboxes(agent)), open.filter((id) => id !== "inb_personal"));
    assert.ok((await server.home(agent, {})).items.every((t) => t.inboxId !== "inb_personal"));
    const counts = await server.counts(agent);
    assert.deepEqual(counts.inboxes, sample.counts.inboxes.filter((entry) => entry.inboxId !== "inb_personal"));
    assert.equal(counts.all.home, 4);
    await server.updateInbox(person, "inb_personal", { agentAccess: true });
    assert.deepEqual(await server.aiStatus(agent), sample.aiStatus);
  });

  test("syncing changes nothing; the personal inbox still needs attention", async () => {
    const before = await server.home(person, {});
    for (const inbox of sample.inboxes) await server.syncInbox(person, inbox.id);
    await server.whenIdle();
    assert.deepEqual(await server.home(person, {}), before);
    const personal = (await server.listInboxes(person)).find((i) => i.id === "inb_personal")!;
    assert.deepEqual([personal.status, personal.statusDetail], ["needs_attention", "The IMAP server at imap.home.example refused the user name or password."]);
  });

  test("letting the screened sender in brings their conversation into Home and writes it back", async () => {
    const result = await server.act(person, { threadIds: ["thr_5"], action: { kind: "allow_sender" } });
    assert.equal(result.records[0]!.state, "applied");
    assert.deepEqual(result.threads.map((t) => [t.id, t.category, t.screened, t.version]), [["thr_5", "conversation", false, 4]]);
    await server.whenIdle();
    assert.ok((await server.home(person, {})).items.some((t) => t.id === "thr_5"));
    assert.deepEqual((await server.handled(person, { states: ["failed"] })).items, []);
    const northwind = demo.mailboxes.get("hello@northwind.example")!;
    assert.deepEqual(northwind.applied.map((op) => op.op), ["place"]);
  });

  test("new mail is categorized and summarized by the fake models, under the sample's model ids", async () => {
    const northwind = demo.mailboxes.get("hello@northwind.example")!;
    northwind.deliver({ from: { name: "Dana Whitfield", email: "dana@lumen.example" }, subject: "Invoice for November", text: "Please find the invoice attached. Amount due by 30 November." });
    await server.syncInbox(person, "inb_northwind");
    await server.whenIdle();
    const thread = (await server.search(person, { q: "Invoice for November" })).items[0]!;
    assert.deepEqual([thread.category, thread.categorizedBy], ["invoice", "ai"]);
    // An invoice: the summarize job asks for its details, and their `what` is its summary (the fake's: the subject).
    assert.deepEqual(thread.payment, { party: "Dana Whitfield", amount: null, refund: false, state: "due", dueDate: null, what: "Invoice for November" });
    assert.equal(thread.summary, "Invoice for November");
    const record = (await server.handled(person, { includeSilent: true })).items.find((item) => item.thread.id === thread.id)!.record;
    assert.deepEqual(record.actor, { kind: "ai", job: "categorize", model: "example/decision-1" });
    assert.deepEqual(models.requests.map((r) => r.request.model), ["example/decision-1", "example/text-small-2"]);
    void clock;
  });

  test("a search asked in a sentence is answered as the sample says, and what it answers finds the sample's mail", async () => {
    assert.ok(sample.searchAsks.length >= 4);
    for (const asked of sample.searchAsks) {
      assert.deepEqual(await server.askSearch(person, { question: asked.question, tz: asked.tz }), asked.answer, asked.question);
    }
    const found = async (question: string) => {
      const asked = sample.searchAsks.find((each) => each.question === question)!.answer;
      const { text: _text, exclude: _exclude, ...filters } = asked.understood;
      return (await server.search(person, { q: asked.text, ...filters, tz: "Europe/Berlin" })).items.map((t) => t.subject);
    };
    assert.equal((await found("the mail where Dana sent the contract pdf"))[0], "Contract renewal for 2027");
    assert.deepEqual(await found("invoices from Kestrel this month"), ["Invoice 2026-118, due 30 November"]);
    assert.deepEqual(await found("dinner on saturday"), ["Dinner on Saturday?"]);
    assert.deepEqual(await found("receipts over 100 euros since March"), [], "an amount has no filter yet: its words stay in the text");
  });
});
