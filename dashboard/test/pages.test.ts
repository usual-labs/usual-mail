// Each page renders the sample's content.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setup } from "./helpers.ts";

/** The page's text with tags removed and entities decoded enough to read. */
const textOf = (body: string) =>
  body
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([:,.])/g, "$1");

describe("Home", () => {
  test("says what needs the person: a broken inbox, a proposal and a suggested rule", async () => {
    const { body, status } = await setup().page("/");
    assert.equal(status, 200);
    const text = textOf(body);
    assert.match(text, /1 inbox needs attention/);
    assert.match(text, /The IMAP server at imap\.home\.example refused the user name or password\./);
    assert.match(text, /Claude Code wants to mark it done: A monthly newsletter you read on the magazine's site/);
    assert.match(text, /Coffee Roasters Monthly: the November cupping notes/);
    assert.match(text, /Shipping notices are notifications/);
    assert.match(body, /action="\/rules\/rul_4\/enable"/);
    assert.match(body, /action="\/handled\/approve"/);
    assert.match(body, /<a href="\/" aria-current="page">/, "Home is the current section");
  });

  test("with nothing to do it says so, and with no inboxes it offers to connect one", async () => {
    const app = setup();
    app.fake.inboxes.forEach((inbox) => (inbox.status = "ok"));
    app.fake.actions = app.fake.actions.filter((record) => record.state !== "proposed");
    app.fake.rules = app.fake.rules.filter((rule) => rule.enabled);
    assert.match(textOf((await app.page("/")).body), /Nothing needs you right now\./);
    app.fake.inboxes = [];
    const empty = textOf((await app.page("/")).body);
    assert.match(empty, /Connect your first inbox/);
  });
});

describe("Inboxes", () => {
  test("lists each inbox with its hat, address, status and reason, trust and agent access", async () => {
    const app = setup();
    app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!.agentAccess = false;
    const { body } = await app.page("/inboxes");
    const text = textOf(body);
    for (const [name, hat] of [["Personal", "orange"], ["Northwind Studio", "blue"], ["Harbor & Pine", "green"]]) {
      assert.match(text, new RegExp(name!));
      assert.match(body, new RegExp(`data-hat="${hat}"`));
    }
    assert.match(text, /me@home\.example · IMAP/);
    assert.match(text, /hello@northwind\.example · Gmail/);
    assert.match(text, /Status Needs attention/);
    assert.match(text, /refused the user name or password/);
    assert.match(text, /Trust Act silently/);
    assert.match(text, /Trust Act with undo/);
    assert.match(text, /Trust Suggest/);
    assert.match(text, /Agents Can't read it/);
    assert.match(text, /Agents May read it/);
    assert.match(text, /Agents May read it Last sync/);
    assert.doesNotMatch(text, /AI (On|Off)/, "no per-inbox AI switch");
    assert.match(body, /href="\/inboxes\/new"/);
    assert.ok(text.indexOf("Northwind Studio") < text.indexOf("Harbor & Pine") && text.indexOf("Harbor & Pine") < text.indexOf("Personal"), "in the order of their places");
  });

  test("an inbox whose first sync runs says how far it has got, in the list and its settings", async () => {
    const app = setup();
    const northwind = app.fake.inboxes.find((inbox) => inbox.id === "inb_northwind")!;
    northwind.status = "connecting";
    northwind.firstSync = { fetched: 1200, total: 3400 };
    assert.match(textOf((await app.page("/inboxes")).body), /Northwind Studio.*Status Fetching your mail · 1,200 of 3,400/);
    assert.match(textOf((await app.page("/inboxes/inb_northwind")).body), /Status Fetching your mail · 1,200 of 3,400/);
    // Paused or needing attention, it says that instead.
    northwind.status = "paused";
    assert.match(textOf((await app.page("/inboxes/inb_northwind")).body), /Status Paused/);
  });

  test("one inbox's settings show its values and take its hat's tint", async () => {
    const { body } = await setup().page("/inboxes/inb_northwind");
    assert.match(body, /<body class="tinted" data-hat="blue">/);
    assert.match(body, /id="inbox-name" name="name" value="Northwind Studio"/);
    assert.match(body, /value="#285fcd" checked/, "the nearest hat is chosen");
    assert.match(body, /value="act_with_undo" checked/);
    assert.match(body, /id="agent-access" name="agentAccess" value="on" checked/);
    assert.match(body, /Clients come first\. Anything about contracts/);
    assert.match(textOf(body), /Agents paired with it: Claude Code\./);
    assert.equal((body.match(/name="color"/g) ?? []).length, 12, "only the twelve hat colours are offered");
  });

  test("a paused inbox offers Resume and no Sync now", async () => {
    const app = setup();
    app.fake.inboxes.find((inbox) => inbox.id === "inb_northwind")!.status = "paused";
    const { body } = await app.page("/inboxes/inb_northwind");
    assert.match(body, /name="paused" value="no"><button class="button" type="submit">Resume/);
    assert.match(body, /type="submit" disabled>.*Sync now/);
  });

  test("the connect forms ask for what each kind of mailbox needs", async () => {
    const app = setup();
    const imap = (await app.page("/inboxes/new")).body;
    for (const field of ["name", "color", "imapHost", "imapPort", "imapSecure", "imapUser", "imapPassword", "smtpHost", "smtpPort", "smtpSecure", "smtpUser", "smtpPassword", "address", "saveSent", "trust"]) {
      assert.match(imap, new RegExp(`name="${field}"`), field);
    }
    assert.match(imap, /type="password" id="imap-password" name="imapPassword" value=""/);
    assert.match(imap, /name="color" value="#b53031" checked/, "a hat no inbox wears yet is chosen");
    assert.match(imap, /value="suggest" checked/, "a new inbox starts at suggest");
    const gmail = (await app.page("/inboxes/new?provider=gmail")).body;
    for (const field of ["clientId", "clientSecret", "refreshToken"]) assert.match(gmail, new RegExp(`name="${field}"`), field);
    assert.doesNotMatch(gmail, /name="imapHost"/);
  });

  test("removing asks first and says exactly what is deleted and what is left alone", async () => {
    const { body } = await setup().page("/inboxes/inb_harbor/remove");
    const text = textOf(body);
    assert.match(text, /Remove Harbor & Pine\?/);
    // docs/contract.md, "Inboxes": mail, rules, history, drafts and guide go; agents lose it; briefs drop its section;
    // nothing changes at the provider, labels and folders included; it can't be undone.
    assert.match(text, /deletes everything it holds for founder@harborpine\.example: its copy of the mail, its rules, its history in Handled, its drafts and its guide\./);
    assert.match(text, /Agents lose access to it, and briefs no longer show its section\./);
    assert.match(text, /Nothing changes at the provider: your mail stays where it is, and the labels or folders Usual Mail made there \(under “Usual Mail\/”\) stay too\./);
    assert.match(text, /This can't be undone\./);
    assert.match(body, /action="\/inboxes\/inb_harbor\/remove"/);
  });

  test("an inbox that isn't there is not found", async () => {
    const app = setup();
    for (const path of ["/inboxes/inb_nope", "/inboxes/inb_nope/rules", "/inboxes/inb_nope/remove", "/no/such/page"]) {
      const { status, body } = await app.page(path);
      assert.equal(status, 404, path);
      assert.match(body, /<h1>Not found<\/h1>/);
    }
  });
});

describe("Rules", () => {
  test("show what the inbox learned, who made each rule and how often it fired", async () => {
    const { body } = await setup().page("/inboxes/inb_northwind/rules");
    const text = textOf(body);
    assert.match(text, /What Northwind Studio has learned/);
    assert.match(text, /Receipts from paperloop\.example are receipts and done You made it · Used 14 times · On/);
    assert.match(text, /The Weekly Build is a newsletter You taught it by correcting · Used 6 times · On/);
    assert.match(text, /When: From paperloop\.example or its subdomains Then: Put in Receipts, Mark done/);
    assert.match(body, /Turn off/);
    assert.match(body, /Delete…/);
    assert.match(body, /id="add-rule"/);
    assert.doesNotMatch(text, /Suggested by agents/);
  });

  test("a rule an agent suggested is shown as a suggestion to accept", async () => {
    const { body } = await setup().page("/inboxes/inb_personal/rules");
    const text = textOf(body);
    assert.match(text, /Suggested by agents/);
    // Who suggested it, by name, from the rule's createdBy.
    assert.match(text, /Shipping notices are notifications Claude Code suggested it · it is off until you accept it/);
    assert.match(text, /Then: Put in Notifications/);
    assert.match(body, /name="enabled" value="on">.*Accept/);
    assert.match(text, /No rules yet\./);
  });

  test("rules are listed in the order the server checks them", async () => {
    const app = setup();
    app.fake.rules.push(
      { id: "rul_a", inboxId: "inb_northwind", text: "Agent rule", match: { domain: "a.example" }, then: [{ kind: "read" }], source: "agent", enabled: true, hits: 1, createdBy: { kind: "agent", agentId: "dev_agent_2", name: "Hermes" }, createdAt: "2026-11-16T09:00:00Z", version: 3 },
      { id: "rul_p", inboxId: "inb_northwind", text: "Newest taught rule", match: { domain: "p.example" }, then: [{ kind: "read" }], source: "person", enabled: true, hits: 0, createdBy: { kind: "person", deviceId: "dev_mac_1" }, createdAt: "2026-11-15T09:00:00Z", version: 1 },
      { id: "rul_s", inboxId: "inb_northwind", text: "Rule from an older server", match: { domain: "s.example" }, then: [{ kind: "read" }], source: "agent", enabled: true, hits: 0, createdBy: { kind: "system" }, createdAt: "2026-11-14T09:00:00Z", version: 1 },
    );
    const text = textOf((await app.page("/inboxes/inb_northwind/rules")).body);
    const order = ["Newest taught rule", "The Weekly Build is a newsletter", "Receipts from paperloop", "Agent rule"].map((t) => text.indexOf(t));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(text, /Newest taught rule You made it · Not used yet/);
    assert.match(text, /Agent rule Hermes suggested it · /);
    assert.match(text, /Rule from an older server An agent suggested it · /, "who made an older rule wasn't recorded");
  });
});

describe("Devices and agents", () => {
  test("lists apps and agents, marks this browser, and shows what each agent may see", async () => {
    const app = setup();
    app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!.agentAccess = false;
    const { body } = await app.page("/devices");
    const text = textOf(body);
    assert.match(text, /Studio Mac/);
    assert.match(text, /iPhone/);
    assert.match(text, /Web dashboard This browser/);
    assert.match(text, /Claude Code Agent · paired/);
    assert.match(text, /Agent · paired 2 Oct 2026, 08:30 UTC · last seen 16 Nov 2026, 09:01 UTC/);
    assert.match(text, /Agent access is off for Personal, so it can't read that inbox yet\./);
    assert.match(body, /name="inboxIds" value="inb_northwind"/);
    assert.match(body, /action="\/devices\/pair-app"/);
    assert.match(body, /action="\/devices\/dev_agent_1\/revoke"/);
    assert.match(text, /Sign out and remove…/);
  });
});

describe("Handled", () => {
  test("shows proposals with Approve and Reject, and the rest with Undo or their state", async () => {
    const { body } = await setup().page("/handled");
    const text = textOf(body);
    assert.match(text, /Waiting for you/);
    assert.match(text, /Claude Code wants to mark it done: A monthly newsletter you read on the magazine's site · 05:02/);
    assert.match(text, /A rule put it in Receipts: Receipts from paperloop\.example are receipts and done · 06:01 Undo/);
    assert.match(text, /Claude Code put it on Reply later: A client asks you to confirm renewal terms by Friday · 08:55 Undone/);
    assert.doesNotMatch(text, /Hermes/, "a silent record is left out unless asked for");
    assert.doesNotMatch(text, /Usual Mail's AI put it in/, "the AI's records are silent, so left out unless asked for");
    assert.match(body, /<div class="reason proposed">/);
    assert.match(body, /action="\/handled\/act_1\/undo"/);
    assert.doesNotMatch(text, /You marked it done/, "a person's own actions aren't in Handled");
    assert.doesNotMatch(body, /action="\/handled\/act_15\/undo"/, "an undone record has no Undo");
  });

  test("narrows to one inbox with its hat chip current", async () => {
    const app = setup();
    const { body } = await app.page("/handled?inbox=inb_northwind");
    assert.match(body, /class="hat-chip" data-hat="blue" href="\/handled\?inbox=inb_northwind" aria-current="page"/);
    assert.doesNotMatch(body, /Coffee Roasters Monthly/);
    assert.ok(app.fake.callsTo("handled").every((args) => (args[1] as { inboxId?: string }).inboxId === "inb_northwind"));
  });

  test("pages through older history", async () => {
    const app = setup();
    for (let i = 0; i < 60; i++) {
      app.fake.actions.push({ id: `act_x${i}`, threadId: "thr_4", inboxId: "inb_northwind", action: { kind: "read" }, actor: { kind: "rule", ruleId: "rul_2" }, reason: `Old ${i}`, state: "applied", at: "2026-11-01T10:00:00Z", undoable: false, silent: false, version: 1 });
    }
    const first = await app.page("/handled");
    assert.match(first.body, /href="\/handled\?cursor=50">Older/);
    const second = await app.page("/handled?cursor=50");
    assert.match(second.body, />Newest</);
    assert.doesNotMatch(second.body, />Older</);
  });
});

describe("silent records, notes and failures (contract revision 3)", () => {
  test("Handled leaves silent records out until asked, and the control keeps the inbox filter", async () => {
    const app = setup();
    const hidden = await app.page("/handled?inbox=inb_personal");
    assert.doesNotMatch(textOf(hidden.body), /Hermes put it in Notifications/);
    assert.match(hidden.body, /<a href="\/handled\?inbox=inb_personal&amp;silent=1">Show silent changes too<\/a>/);
    assert.ok(app.fake.callsTo("handled").every((args) => (args[1] as { includeSilent?: boolean }).includeSilent === undefined));

    const shown = await app.page("/handled?inbox=inb_personal&silent=1");
    const text = textOf(shown.body);
    assert.match(text, /Your order has shipped Done silently Hermes put it in Notifications: A shipping notice for an order you placed · Yesterday Undo/);
    assert.match(shown.body, /<a href="\/handled\?inbox=inb_personal">Hide silent changes<\/a>/);
    assert.match(shown.body, /name="return" value="\/handled\?inbox=inb_personal&amp;silent=1"/, "forms come back to the same view");
    const history = app.fake.callsTo("handled").at(-1)![1] as { includeSilent?: boolean; states?: string[] };
    assert.equal(history.includeSilent, true);
    assert.match(shown.body, /class="hat-chip" data-hat="blue" href="\/handled\?inbox=inb_northwind&amp;silent=1"/);
  });

  test("a record that failed, whose undo was refused, or that has a note is shown with the provider's words", async () => {
    const app = setup();
    const act = (id: string) => app.fake.actions.find((record) => record.id === id)!;
    Object.assign(act("act_3"), { state: "failed", undoable: false, error: "The label Usual Mail/Newsletters doesn't exist" });
    Object.assign(act("act_1"), { error: "The provider refused the undo: message gone" });
    Object.assign(act("act_2"), { note: "This server can't keep stacks" });
    const text = textOf((await app.page("/handled")).body);
    assert.match(text, /A rule put it in Newsletters: The Weekly Build is a newsletter · Yesterday It didn't go through: The label Usual Mail\/Newsletters doesn't exist Failed/);
    assert.match(text, /A rule put it in Receipts: Receipts from paperloop\.example are receipts and done · 06:01 Undo didn't go through: The provider refused the undo: message gone Undo/);
    assert.match(text, /A rule marked it done: Receipts from paperloop\.example are receipts and done · 06:01 Note from the provider: This server can't keep stacks Undo/);
  });

  test("a record of a thread now in the trash stays listed, says so, and can be undone", async () => {
    const app = setup();
    app.fake.threads.find((thread) => thread.id === "thr_8")!.trashed = true;
    app.fake.actions.push({
      id: "act_trash", threadId: "thr_8", inboxId: "inb_harbor", action: { kind: "trash" }, actor: { kind: "rule", ruleId: "rul_3" },
      reason: "Old newsletters go to the trash", state: "applied", at: "2026-11-16T08:00:00Z", undoable: true, silent: false, version: 2,
    });
    const { body } = await app.page("/handled");
    assert.match(textOf(body), /Coffee Roasters Monthly: the November cupping notes In the trash A rule moved it to the trash: Old newsletters go to the trash · 08:00 Undo/);
    assert.match(body, /action="\/handled\/act_trash\/undo"/);
    const res = await app.post("/handled/act_trash/undo", { return: "/handled" });
    assert.equal(res.headers.get("location"), "/handled?done=undone");
    assert.equal(app.fake.threads.find((thread) => thread.id === "thr_8")!.trashed, false);
  });

  test("Home counts changes that went wrong or carry a note, and drafts that didn't send, and leaves silent ones out", async () => {
    const app = setup();
    Object.assign(app.fake.actions.find((record) => record.id === "act_3")!, { state: "failed", undoable: false, error: "The folder is gone" });
    Object.assign(app.fake.actions.find((record) => record.id === "act_2")!, { note: "This server can't keep stacks" });
    app.fake.drafts.push({
      ...app.fake.drafts[0]!, id: "drf_failed", state: "failed", error: "The SMTP server refused the recipient", updatedAt: "2026-11-16T09:10:00Z",
      subject: "Re: Lease renewal", inboxId: "inb_harbor", to: [{ name: "Quay Properties", email: "lettings@quayproperties.example" }],
    });
    const { body } = await app.page("/");
    const text = textOf(body);
    assert.match(text, /2 changes need a look 1 change didn't go through at the provider\. Each says what the provider said\./);
    assert.match(text, /It didn't go through: The folder is gone/);
    assert.match(text, /Note from the provider: This server can't keep stacks/);
    assert.match(text, /1 draft didn't send/);
    assert.match(text, /Re: Lease renewal To Quay Properties &lt;lettings@quayproperties\.example&gt; · 16 Nov 2026, 09:10 UTC It didn't send: The SMTP server refused the recipient/);
    assert.doesNotMatch(text, /Hermes/, "the silent record in Personal is not part of what needs you");
    assert.ok(app.fake.callsTo("handled").every((args) => !(args[1] as { includeSilent?: boolean }).includeSilent));
    // "What needs you" asks the server for exactly that, instead of scanning a page of history.
    assert.ok(app.fake.callsTo("handled").some((args) => (args[1] as { attentionOnly?: boolean }).attentionOnly === true));
    assert.doesNotMatch(text, /Nothing needs you right now/);
  });

  test("the person's own change the provider refused needs a look on Home, and stays out of Handled's history", async () => {
    const app = setup();
    Object.assign(app.fake.actions.find((record) => record.id === "act_6")!, { state: "failed", undoable: false, error: "The mail server refused to move it", version: 2 });
    const home = textOf((await app.page("/")).body);
    assert.match(home, /1 change needs a look 1 change didn't go through at the provider\./);
    assert.match(home, /Thanks for the workshop You marked it done · Sat It didn't go through: The mail server refused to move it Failed/);
    assert.doesNotMatch(textOf((await app.page("/handled")).body), /Thanks for the workshop/, "Handled lists what rules and agents did");
  });

  test("an undone record with a provider's note needs a look too", async () => {
    const app = setup();
    Object.assign(app.fake.actions.find((record) => record.id === "act_15")!, { note: "Moved back, but the label stayed" });
    assert.match(textOf((await app.page("/")).body), /1 change needs a look .*Note from the provider: Moved back, but the label stayed/);
  });

  test("with only silent records, Home says nothing needs the person", async () => {
    const app = setup();
    app.fake.inboxes.forEach((inbox) => (inbox.status = "ok"));
    app.fake.actions = app.fake.actions.filter((record) => record.state !== "proposed");
    app.fake.rules = app.fake.rules.filter((rule) => rule.enabled);
    assert.ok(app.fake.actions.some((record) => record.silent));
    assert.match(textOf((await app.page("/")).body), /Nothing needs you right now\./);
  });
});

describe("an inbox's connection and trust (contract revisions 3 and 4)", () => {
  test("an IMAP inbox that needs attention shows its stored connection and opens the form filled with it, asking only for the password", async () => {
    const { body } = await setup().page("/inboxes/inb_personal");
    const text = textOf(body);
    assert.match(text, /give the new ones under Connection below; the inbox keeps its rules and history/);
    assert.doesNotMatch(text, /remove the inbox and connect it again/);
    assert.match(text, /Incoming \(IMAP\) imap\.home\.example:993, TLS, as me@home\.example/);
    assert.match(text, /Outgoing \(SMTP\) smtp\.home\.example:465, TLS, as me@home\.example/);
    assert.match(text, /Sent mail A copy is saved in Sent/);
    assert.match(body, /<details class="reconnect" open><summary class="button">Give a new password…<\/summary>/);
    assert.match(body, /action="\/inboxes\/inb_personal\/reconnect"/);
    assert.match(body, /id="new-imap-host" name="imapHost" value="imap\.home\.example"/);
    assert.match(body, /id="new-imap-port" name="imapPort" value="993"/);
    assert.match(body, /id="new-imap-user" name="imapUser" value="me@home\.example"/);
    assert.match(body, /id="new-smtp-host" name="smtpHost" value="smtp\.home\.example"/);
    assert.match(body, /id="new-smtp-port" name="smtpPort" value="465"/);
    // The login is the address, so the address field stays empty, and the SMTP user is the IMAP one.
    assert.match(body, /id="new-address" name="address" value=""/);
    assert.match(body, /id="new-smtp-user" name="smtpUser" value=""/);
    assert.match(body, /type="password" id="new-imap-password" name="imapPassword" value=""/);
  });

  test("STARTTLS and a login that isn't the address are shown and filled in as stored", async () => {
    const app = setup();
    const harbor = app.fake.inboxes.find((inbox) => inbox.id === "inb_harbor")!;
    harbor.connection = {
      kind: "imap",
      imap: { host: "mail.harborpine.example", port: 993, secure: true, user: "founder" },
      smtp: { host: "relay.harborpine.example", port: 587, secure: false, user: "relay-user" },
      saveSent: false,
    };
    const { body } = await app.page("/inboxes/inb_harbor");
    assert.match(textOf(body), /Outgoing \(SMTP\) relay\.harborpine\.example:587, STARTTLS, as relay-user/);
    assert.match(textOf(body), /Sent mail No copy is saved \(the server does it\)/);
    assert.match(body, /id="new-address" name="address" value="founder@harborpine\.example"/);
    assert.match(body, /id="new-smtp-user" name="smtpUser" value="relay-user"/);
    assert.match(body, /id="new-smtp-secure" name="smtpSecure"(?! checked)/);
    assert.doesNotMatch(body, /id="new-save-sent" name="saveSent"[^>]* checked/);
  });

  test("a Gmail inbox that is fine shows its client ID and asks for a new secret and token, closed", async () => {
    const { body } = await setup().page("/inboxes/inb_northwind");
    assert.match(textOf(body), /Google client ID 000000000000-sample\.apps\.googleusercontent\.example/);
    assert.match(body, /<details class="reconnect"><summary class="button">Give a new client secret and token…<\/summary>/);
    assert.match(body, /id="new-client-id" name="clientId" value="000000000000-sample\.apps\.googleusercontent\.example"/);
    for (const field of ["clientId", "clientSecret", "refreshToken"]) assert.match(body, new RegExp(`name="${field}"`), field);
    assert.doesNotMatch(body, /name="imapHost"/);
  });

  test("the three trust levels are explained in words that differ", async () => {
    const { body } = await setup().page("/inboxes/inb_harbor");
    const text = textOf(body);
    assert.match(text, /Suggest Rules and agents only propose\. Nothing moves until you approve it in Handled\./);
    assert.match(text, /Act with undo Rules and agents act, and every change shows in Handled, where you can undo it\./);
    assert.match(text, /Act silently Rules and agents act quietly\. Handled lists their changes only when you ask, and you can still undo them\. Anything that goes wrong is always shown\./);
    assert.match(text, /A change applies from now on\. What was done before stays as it was recorded\./);
  });

  test("Outlook is not a provider: only IMAP and Gmail are offered", async () => {
    const app = setup();
    assert.match(textOf((await app.page("/inboxes/new")).body), /IMAP and SMTP Gmail/);
    assert.equal((await app.page("/inboxes/new?provider=outlook")).body.includes('name="imapHost"'), true, "anything else is IMAP");
    for (const path of ["/inboxes", "/inboxes/new"]) assert.doesNotMatch((await app.page(path)).body, /Outlook/i, path);
  });
});
