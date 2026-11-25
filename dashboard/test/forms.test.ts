// Each form calls the right service method with the right input, and service errors come back as readable words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceError, type TeachPrompt } from "@usualmail/core";
import { PERSON_DEVICE } from "./fake-service.ts";
import { setup } from "./helpers.ts";

const IMAP_FORM = {
  provider: "imap",
  name: "Fernhill Books",
  color: "#714CBD",
  trust: "act_with_undo",
  imapHost: "imap.fernhill.example",
  imapPort: "993",
  imapSecure: "on",
  imapUser: "orders@fernhill.example",
  imapPassword: "correct horse battery",
  smtpHost: "smtp.fernhill.example",
  smtpPort: "587",
  smtpUser: "",
  smtpPassword: "",
  address: "",
  saveSent: "on",
};

const personCaller = (args: unknown[]) => args[0] as { actor: { kind: string; deviceId?: string } };

describe("connecting an inbox", () => {
  test("IMAP sends the credentials once, with SMTP falling back to the IMAP login", async () => {
    const app = setup();
    const res = await app.post("/inboxes", IMAP_FORM);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/inboxes/inb_new_1?done=connected");
    const [caller, input] = app.fake.callsTo("connectInbox")[0]!;
    assert.equal(personCaller([caller]).actor.deviceId, PERSON_DEVICE);
    assert.deepEqual(input, {
      name: "Fernhill Books",
      color: "#714cbd",
      provider: "imap",
      trust: "act_with_undo",
      credentials: {
        imap: { host: "imap.fernhill.example", port: 993, secure: true, user: "orders@fernhill.example", password: "correct horse battery" },
        smtp: { host: "smtp.fernhill.example", port: 587, secure: false, user: "orders@fernhill.example", password: "correct horse battery" },
        saveSent: true,
      },
    });
    const page = await app.page("/inboxes/inb_new_1?done=connected");
    assert.match(page.body, /Connected\. The first sync brings in the last 30 days/);
    assert.doesNotMatch(page.body, /correct horse battery/);
  });

  test("Gmail sends the client id, secret and refresh token", async () => {
    const app = setup();
    const res = await app.post("/inboxes", {
      provider: "gmail",
      name: "Studio",
      color: "#285fcd",
      trust: "suggest",
      clientId: "1234.apps.example",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value",
    });
    assert.equal(res.status, 303);
    const [, input] = app.fake.callsTo("connectInbox")[0]!;
    assert.deepEqual(input, {
      name: "Studio",
      color: "#285fcd",
      provider: "gmail",
      trust: "suggest",
      credentials: { clientId: "1234.apps.example", clientSecret: "client-secret-value", refreshToken: "refresh-token-value" },
    });
  });

  test("missing fields are named, nothing is sent, what was typed stays and the password doesn't", async () => {
    const app = setup();
    const res = await app.post("/inboxes", { ...IMAP_FORM, imapHost: "", imapPort: "99999", color: "#123456" });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.deepEqual(app.fake.callsTo("connectInbox"), []);
    assert.match(body, /Type the IMAP server&#39;s name\./);
    assert.match(body, /The port is a number from 1 to 65535\./);
    assert.match(body, /Choose a colour\./);
    assert.match(body, /value="orders@fernhill\.example"/);
    assert.match(body, /value="Fernhill Books"/);
    assert.doesNotMatch(body, /correct horse battery/);
    assert.match(body, /aria-invalid="true"/);
  });

  test("a refused connection shows the server's words without the password", async () => {
    const app = setup();
    app.fake.failNext("connectInbox", new ServiceError("provider_error", "The mailbox didn't accept the connection: login correct horse battery refused"));
    const res = await app.post("/inboxes", IMAP_FORM);
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.match(body, /The mailbox didn&#39;t accept the connection: login ••• refused/);
    assert.doesNotMatch(body, /correct horse battery/);
    assert.match(body, /role="alert"/);
  });

  test("a server error that isn't meant for people is not shown as it is", async () => {
    const app = setup();
    app.fake.failNext("connectInbox", new ServiceError("internal", "SQLITE_BUSY at store.ts:42"));
    const res = await app.post("/inboxes", IMAP_FORM);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.doesNotMatch(body, /SQLITE_BUSY/);
    assert.match(body, /Something went wrong on the server/);
  });
});

describe("an inbox's settings", () => {
  test("name and colour send only what changed", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/name", { name: "Northwind", color: "#285fcd" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/inboxes/inb_northwind?done=saved");
    assert.deepEqual(app.fake.callsTo("updateInbox").map((args) => args.slice(1)), [["inb_northwind", { name: "Northwind" }]]);
    await app.post("/inboxes/inb_northwind/name", { name: "Northwind", color: "#a9356c" });
    assert.deepEqual(app.fake.callsTo("updateInbox")[1]!.slice(1), ["inb_northwind", { color: "#a9356c" }]);
  });

  test("a colour that isn't one of the twelve is refused", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/name", { name: "Northwind", color: "#123456" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Choose one of the twelve colours\./);
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });

  test("trust, agent access, the guide, pause and resume each send their field", async () => {
    const app = setup();
    app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!.agentAccess = false;
    await app.post("/inboxes/inb_harbor/trust", { trust: "act_silently" });
    await app.post("/inboxes/inb_harbor/agents", { agentAccess: ["off"] });
    await app.post("/inboxes/inb_personal/agents", { agentAccess: ["off", "on"] });
    await app.post("/inboxes/inb_harbor/guide", { guide: "Line one\r\nLine two" });
    const paused = await app.post("/inboxes/inb_harbor/pause", { paused: "yes" });
    assert.equal(paused.headers.get("location"), "/inboxes/inb_harbor?done=paused");
    const resumed = await app.post("/inboxes/inb_harbor/pause", { paused: "no" });
    assert.equal(resumed.headers.get("location"), "/inboxes/inb_harbor?done=resumed");
    assert.deepEqual(app.fake.callsTo("updateInbox").map((args) => args.slice(1)), [
      ["inb_harbor", { trust: "act_silently" }],
      ["inb_harbor", { agentAccess: false }],
      ["inb_personal", { agentAccess: true }],
      ["inb_harbor", { guide: "Line one\nLine two" }],
      ["inb_harbor", { paused: true }],
      ["inb_harbor", { paused: false }],
    ]);
  });

  test("saving without a change calls nothing", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/trust", { trust: "act_with_undo" });
    assert.equal(res.status, 303);
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });

  test("a refused change is shown on the page with what was typed", async () => {
    const app = setup();
    app.fake.failNext("updateInbox", new ServiceError("invalid", "The guide is too long"));
    const res = await app.post("/inboxes/inb_northwind/guide", { guide: "New notes for the agent" });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /The guide is too long/);
    assert.match(body, /New notes for the agent<\/textarea>/);
  });

  test("Sync now asks for a sync, and a paused inbox's refusal is shown", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/sync");
    assert.equal(res.headers.get("location"), "/inboxes/inb_northwind?done=syncing");
    assert.deepEqual(app.fake.callsTo("syncInbox").map((args) => args[1]), ["inb_northwind"]);
    app.fake.inboxes.find((inbox) => inbox.id === "inb_northwind")!.status = "paused";
    const refused = await app.post("/inboxes/inb_northwind/sync");
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /This inbox is paused/);
  });

  test("removing calls removeInbox and returns to the list", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_harbor/remove");
    assert.equal(res.headers.get("location"), "/inboxes?done=removed");
    assert.deepEqual(app.fake.callsTo("removeInbox").map((args) => args[1]), ["inb_harbor"]);
    assert.match((await app.page("/inboxes?done=removed")).body, /The inbox was removed\./);
  });
});

describe("rules", () => {
  test("adding a rule sends a draft made by a person", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/rules", {
      text: "Invoices from Kestrel go to Receipts",
      domain: "@Kestrel.Example",
      subjectContains: "Invoice",
      automated: "on",
      category: "receipt",
      stack: "",
      read: "on",
    });
    assert.equal(res.headers.get("location"), "/inboxes/inb_northwind/rules?done=rule-added");
    const [, draft, source] = app.fake.callsTo("createRule")[0]!;
    assert.equal(source, "person");
    assert.deepEqual(draft, {
      inboxId: "inb_northwind",
      text: "Invoices from Kestrel go to Receipts",
      match: { domain: "kestrel.example", subjectContains: "Invoice", automated: true },
      then: [{ kind: "categorize", category: "receipt" }, { kind: "read" }],
    });
  });

  test("a rule with no condition, no action, or both a stack and done is explained, not sent", async () => {
    const app = setup();
    const empty = await app.post("/inboxes/inb_northwind/rules", { text: "Everything" });
    assert.equal(empty.status, 400);
    const body = await empty.text();
    assert.match(body, /or the rule would match every message/);
    assert.match(body, /Choose what the rule does\./);
    const both = await app.post("/inboxes/inb_northwind/rules", { text: "x", from: "a@b.example", stack: "set_aside", done: "on" });
    assert.match(await both.text(), /A thread on a stack is never done/);
    assert.deepEqual(app.fake.callsTo("createRule"), []);
  });

  test("turning a rule off and on, and deleting it", async () => {
    const app = setup();
    const off = await app.post("/rules/rul_1/enable", { enabled: "off", inbox: "inb_northwind", return: "/inboxes/inb_northwind/rules" });
    assert.equal(off.headers.get("location"), "/inboxes/inb_northwind/rules?done=rule-off");
    const on = await app.post("/rules/rul_1/enable", { enabled: "on", inbox: "inb_northwind" });
    assert.equal(on.headers.get("location"), "/inboxes/inb_northwind/rules?done=rule-on");
    const gone = await app.post("/rules/rul_1/delete", { inbox: "inb_northwind" });
    assert.equal(gone.headers.get("location"), "/inboxes/inb_northwind/rules?done=rule-deleted");
    assert.deepEqual(app.fake.callsTo("updateRule").map((args) => args.slice(1)), [["rul_1", { enabled: false }], ["rul_1", { enabled: true }]]);
    assert.deepEqual(app.fake.callsTo("deleteRule").map((args) => args[1]), ["rul_1"]);
  });

  test("accepting a suggestion from Home turns it on and returns Home", async () => {
    const app = setup();
    const res = await app.post("/rules/rul_4/enable", { enabled: "on", inbox: "inb_personal", return: "/" });
    assert.equal(res.headers.get("location"), "/?done=rule-on");
    assert.deepEqual(app.fake.callsTo("updateRule")[0]!.slice(1), ["rul_4", { enabled: true }]);
    assert.doesNotMatch((await app.page("/")).body, /Rules agents suggested/);
  });

  test("an id with odd characters goes out encoded and comes back to the service as it was", async () => {
    const app = setup();
    app.fake.rules[0]!.id = "rul/1 ?&#x";
    const { body } = await app.page("/inboxes/inb_northwind/rules");
    assert.match(body, /action="\/rules\/rul%2F1%20%3F%26%23x\/enable"/);
    await app.post("/rules/rul%2F1%20%3F%26%23x/enable", { enabled: "off", inbox: "inb_northwind" });
    assert.deepEqual(app.fake.callsTo("updateRule")[0]!.slice(1), ["rul/1 ?&#x", { enabled: false }]);
  });

  test("a refused rule change is shown where it came from", async () => {
    const app = setup();
    app.fake.failNext("deleteRule", new ServiceError("not_found", "That rule no longer exists"));
    const res = await app.post("/rules/rul_9/delete", { inbox: "inb_northwind" });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /That rule no longer exists/);
  });
});

describe("devices and agents", () => {
  test("a code for an app is shown once, with when it expires", async () => {
    const app = setup();
    const res = await app.post("/devices/pair-app");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.text();
    assert.match(body, /<p class="code">CODE-0003<\/p>/);
    assert.match(body, /expires at 09:45 UTC/);
    assert.deepEqual(app.fake.callsTo("createPairingCode").map((args) => args[1]), [{ kind: "person" }]);
  });

  test("a code for an agent names the inboxes it may see and warns where agent access is off", async () => {
    const app = setup();
    app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!.agentAccess = false;
    const res = await app.post("/devices/pair-agent", { inboxIds: ["inb_northwind", "inb_personal", "inb_unknown"] });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.deepEqual(app.fake.callsTo("createPairingCode").map((args) => args[1]), [{ kind: "agent", inboxIds: ["inb_northwind", "inb_personal"] }]);
    assert.match(body, /Agent access is off for Personal/);
  });

  test("an agent with no inboxes is not paired", async () => {
    const app = setup();
    const res = await app.post("/devices/pair-agent", {});
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Choose at least one inbox/);
    assert.deepEqual(app.fake.callsTo("createPairingCode"), []);
  });

  test("removing another device revokes it; removing this browser signs out", async () => {
    const app = setup();
    const res = await app.post("/devices/dev_agent_1/revoke");
    assert.equal(res.headers.get("location"), "/devices?done=revoked");
    const own = await app.post(`/devices/${PERSON_DEVICE}/revoke`);
    assert.equal(own.headers.get("location"), "/sign-in?done=signed-out");
    assert.match(own.headers.getSetCookie().join("\n"), /usual-mail-session=; Max-Age=0/);
    assert.deepEqual(app.fake.callsTo("revokeDevice").map((args) => args[1]), ["dev_agent_1", PERSON_DEVICE]);
  });
});

describe("Handled", () => {
  test("approve and reject send the record ids", async () => {
    const app = setup();
    const approved = await app.post("/handled/approve", { ids: "act_4", return: "/handled" });
    assert.equal(approved.headers.get("location"), "/handled?done=approved");
    app.fake.actions.find((record) => record.id === "act_4")!.state = "proposed";
    const rejected = await app.post("/handled/reject", { ids: "act_4", return: "/" });
    assert.equal(rejected.headers.get("location"), "/?done=rejected");
    assert.deepEqual(app.fake.callsTo("approve").map((args) => args[1]), [["act_4"]]);
    assert.deepEqual(app.fake.callsTo("reject").map((args) => args[1]), [["act_4"]]);
  });

  test("Approve all sends every waiting id in one call", async () => {
    const app = setup();
    app.fake.actions.push({ ...app.fake.actions.find((record) => record.id === "act_4")!, id: "act_9", threadId: "thr_6", at: "2026-11-16T06:00:00Z" });
    const { body } = await app.page("/handled");
    assert.match(body, /Approve all 2/);
    await app.post("/handled/approve", { ids: ["act_4", "act_9"], return: "/handled" });
    assert.deepEqual(app.fake.callsTo("approve").map((args) => args[1]), [["act_4", "act_9"]]);
  });

  test("a stale proposal's conflict is shown in words", async () => {
    const app = setup();
    app.fake.failNext("approve", new ServiceError("conflict", "The thread changed since this was proposed"));
    const res = await app.post("/handled/approve", { ids: "act_4", return: "/handled" });
    assert.equal(res.status, 409);
    const body = await res.text();
    assert.match(body, /The thread changed since this was proposed/);
    assert.match(body, /<h1>Handled<\/h1>/);
  });

  test("undo calls undo and, when the server asks, shows its teach question", async () => {
    const app = setup();
    const plain = await app.post("/handled/act_3/undo", { return: "/handled" });
    assert.equal(plain.headers.get("location"), "/handled?done=undone");
    const teach: TeachPrompt = {
      id: "tch_1",
      question: "Always keep mail from The Weekly Build in People?",
      rule: { inboxId: "inb_northwind", text: "The Weekly Build stays in People", match: { listId: "weekly-build.weeklybuild.example" }, then: [{ kind: "categorize", category: "conversation" }] },
      fromActionId: "act_1",
      expiresAt: "2026-11-17T09:30:00Z",
    };
    app.fake.teachOnUndo = teach;
    const asked = await app.post("/handled/act_1/undo", { return: "/handled" });
    assert.equal(asked.status, 200);
    const body = await asked.text();
    assert.match(body, /Always keep mail from The Weekly Build in People\?/);
    assert.match(body, /action="\/teach\/tch_1"/);
    assert.match(body, /Undone\./);
    assert.deepEqual(app.fake.callsTo("undo").map((args) => args[1]), ["act_3", "act_1"]);
    const yes = await app.post("/teach/tch_1", { accept: "yes", return: "/handled" });
    assert.equal(yes.headers.get("location"), "/handled?done=taught");
    const no = await app.post("/teach/tch_1", { accept: "no", return: "/handled" });
    assert.equal(no.headers.get("location"), "/handled?done=not-taught");
    assert.deepEqual(app.fake.callsTo("answerTeach").map((args) => args.slice(1)), [["tch_1", true], ["tch_1", false]]);
  });

  test("a form's return path can only be Home or Handled", async () => {
    const app = setup();
    const res = await app.post("/handled/approve", { ids: "act_4", return: "//evil.example/x" });
    assert.equal(res.headers.get("location"), "/handled?done=approved");
    app.fake.actions.find((record) => record.id === "act_4")!.state = "proposed";
    const other = await app.post("/handled/approve", { ids: "act_4", return: "/devices" });
    assert.equal(other.headers.get("location"), "/handled?done=approved");
  });
});

describe("changing a connected inbox's credentials", () => {
  const NEW_IMAP = {
    imapHost: "imap.home.example",
    imapPort: "993",
    imapSecure: "on",
    imapUser: "me@home.example",
    imapPassword: "a brand new password",
    smtpHost: "smtp.home.example",
    smtpPort: "465",
    smtpSecure: "on",
    smtpUser: "",
    smtpPassword: "",
    address: "me@home.example",
    saveSent: "on",
  };

  test("IMAP sends the new credentials in the shape used to connect, and the inbox syncs again", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_personal/reconnect", NEW_IMAP);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/inboxes/inb_personal?done=reconnected");
    assert.deepEqual(app.fake.callsTo("updateInbox").map((args) => args.slice(1)), [
      [
        "inb_personal",
        {
          credentials: {
            imap: { host: "imap.home.example", port: 993, secure: true, user: "me@home.example", password: "a brand new password" },
            smtp: { host: "smtp.home.example", port: 465, secure: true, user: "me@home.example", password: "a brand new password" },
            address: "me@home.example",
            saveSent: true,
          },
        },
      ],
    ]);
    const page = await app.page("/inboxes/inb_personal?done=reconnected");
    assert.match(page.body, /The provider accepted the new details and they are saved\. The inbox syncs again, unless it is paused\./);
    // What the server now stores is what the form starts with next time; never the password.
    assert.match(page.body, /id="new-imap-host" name="imapHost" value="imap\.home\.example"/);
    assert.doesNotMatch(page.body, /a brand new password/);
    assert.doesNotMatch(page.body, /refused the user name or password/, "it no longer needs attention");
  });

  test("Gmail sends a new client id, secret and refresh token", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/reconnect", { clientId: "new.apps.example", clientSecret: "new-secret", refreshToken: "new-refresh" });
    assert.equal(res.status, 303);
    assert.deepEqual(app.fake.callsTo("updateInbox")[0]!.slice(1), [
      "inb_northwind",
      { credentials: { clientId: "new.apps.example", clientSecret: "new-secret", refreshToken: "new-refresh" } },
    ]);
  });

  test("missing fields are named and nothing is sent; the form stays open with what was typed, never the password", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_personal/reconnect", { ...NEW_IMAP, imapHost: "", smtpPort: "x" });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
    assert.match(body, /Some fields need a look\./);
    assert.match(body, /Type the IMAP server&#39;s name\./);
    assert.match(body, /<details class="reconnect" open>/);
    assert.match(body, /id="new-smtp-host" name="smtpHost" value="smtp\.home\.example"/);
    assert.doesNotMatch(body, /a brand new password/);
  });

  test("when the provider refuses them, its words are shown without the secret, and nothing changes", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_personal/reconnect", { ...NEW_IMAP, imapPassword: "wrong-password" });
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.match(body, /The mail server refused the login: authentication failed/);
    assert.match(body, /<details class="reconnect" open>/);
    assert.equal(app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!.status, "needs_attention", "nothing changed");

    app.fake.failNext("updateInbox", new ServiceError("provider_error", "LOGIN a brand new password rejected"));
    const echoed = await (await app.post("/inboxes/inb_personal/reconnect", NEW_IMAP)).text();
    assert.match(echoed, /LOGIN ••• rejected/);
    assert.doesNotMatch(echoed, /a brand new password/);
  });

  test("details for another mailbox are refused as invalid, in the server's words", async () => {
    const app = setup();
    const personal = app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!;
    const version = personal.version;
    const res = await app.post("/inboxes/inb_personal/reconnect", { ...NEW_IMAP, imapUser: "someone@else.example", address: "" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /These details are for someone@else\.example, not me@home\.example/);
    assert.equal(personal.version, version);
  });

  test("a paused inbox stays paused", async () => {
    const app = setup();
    const personal = app.fake.inboxes.find((inbox) => inbox.id === "inb_personal")!;
    personal.status = "paused";
    await app.post("/inboxes/inb_personal/reconnect", NEW_IMAP);
    assert.equal(personal.status, "paused");
  });

  test("an inbox that isn't there is not found, and nothing is sent", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_nope/reconnect", NEW_IMAP);
    assert.equal(res.status, 404);
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });
});
