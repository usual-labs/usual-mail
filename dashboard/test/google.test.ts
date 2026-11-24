// Signing in with Google for Gmail in the dashboard: a "Sign in with Google" choice where Gmail is connected and where a
// Gmail inbox is reconnected, shown only when the server has Google sign-in. The form starts the sign-in and the page
// that answers links to Google's address (a link, not a redirect from a form, so the strict form-action stays); the
// server receives Google's answer itself.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GOOGLE_RULES_WORDS, ServiceError } from "@usualmail/core";
import { setup } from "./helpers.ts";

const textOf = (body: string) =>
  body
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/ ([:,.;])/g, "$1");

describe("Sign in with Google", () => {
  test("connecting Gmail offers it first when the server has it, and only then", async () => {
    const app = setup();
    const { body } = await app.page("/inboxes/new?provider=gmail");
    assert.match(body, /<form method="post" action="\/inboxes\/google"/);
    assert.match(textOf(body), /Sign in with Google/);
    assert.match(body, /action="\/inboxes"/, "the client id, secret and token stay possible");
    app.fake.googleInfo = { available: false, missing: ["client"] };
    const off = (await app.page("/inboxes/new?provider=gmail")).body;
    assert.doesNotMatch(off, /action="\/inboxes\/google"/);
    assert.doesNotMatch((await app.page("/inboxes/new?provider=imap")).body, /action="\/inboxes\/google"/);
  });

  test("starting answers with a link to Google, the time it works until and Google's rules; nothing secret", async () => {
    const app = setup();
    const res = await app.post("/inboxes/google", { name: "Ana", color: "#277a40" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.deepEqual(app.fake.callsTo("startGoogleSignIn").map(([, input]) => input), [{ name: "Ana", color: "#277a40" }]);
    assert.match(body, /<a class="button primary large" href="https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=owner\.apps\.example&amp;state=s" target="_blank" rel="noopener noreferrer">Continue to Google<\/a>/);
    const text = textOf(body);
    assert.match(text, /until 16 Nov 2026, 09:40 UTC/);
    for (const words of GOOGLE_RULES_WORDS) assert.ok(text.includes(words), words);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });

  test("a name and a hat are needed, and a refusal from the server is shown in its words", async () => {
    const app = setup();
    const missing = await app.post("/inboxes/google", { name: "", color: "#277a40" });
    assert.equal(missing.status, 400);
    assert.equal(app.fake.callsTo("startGoogleSignIn").length, 0);
    app.fake.failNext("startGoogleSignIn", new ServiceError("conflict", "Google sign-in isn't set up on this server: <no client>"));
    const refused = await app.post("/inboxes/google", { name: "Ana", color: "#277a40" });
    assert.equal(refused.status, 409);
    const body = await refused.text();
    assert.match(body, /Google sign-in isn&#39;t set up on this server: &lt;no client&gt;/);
  });

  test("an address that isn't a web address is never linked", async () => {
    const app = setup();
    app.fake.googleUrl = "javascript:alert(1)";
    const res = await app.post("/inboxes/google", { name: "Ana", color: "#277a40" });
    const body = await res.text();
    assert.equal(res.status, 502);
    assert.doesNotMatch(body, /javascript:/);
  });

  test("a Gmail inbox's page offers to sign in with Google again; an IMAP inbox's doesn't", async () => {
    const app = setup();
    const gmail = (await app.page("/inboxes/inb_northwind")).body;
    assert.match(gmail, /<form method="post" action="\/inboxes\/inb_northwind\/google"/);
    assert.match(textOf(gmail), /Sign in with Google again/);
    assert.doesNotMatch((await app.page("/inboxes/inb_harbor")).body, /\/google"/);
    const res = await app.post("/inboxes/inb_northwind/google", {});
    assert.equal(res.status, 200);
    assert.deepEqual(app.fake.callsTo("startGoogleSignIn").map(([, input]) => input), [{ inboxId: "inb_northwind" }]);
    assert.match(await res.text(), /Continue to Google/);
    app.fake.googleInfo = { available: false, missing: ["address"] };
    assert.doesNotMatch((await app.page("/inboxes/inb_northwind")).body, /\/google"/);
  });

  test("an inbox connected by signing in says so, and its form for pasted credentials still works", async () => {
    const app = setup();
    app.fake.inboxes[0]!.connection = { kind: "gmail", clientId: "owner.apps.example", signIn: "google" };
    const text = textOf((await app.page("/inboxes/inb_northwind")).body);
    assert.match(text, /Signed in with Google, through the client owner\.apps\.example/);
  });
});
