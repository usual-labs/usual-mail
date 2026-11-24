// Signing in with a pairing code, the session cookie, signing out, and who may see the pages.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceError } from "@usualmail/core";
import { AGENT_CODE, AGENT_TOKEN, GOOD_CODE, PERSON_DEVICE } from "./fake-service.ts";
import { cookies, hiddenValue, PAGES, PERSON_TOKEN, setup } from "./helpers.ts";

/** Opens the sign-in page and returns its form token and the cookie that carries it. */
async function signInForm(app: ReturnType<typeof setup>) {
  const res = await app.get("/sign-in", { token: null });
  const body = await res.text();
  const cookie = [...cookies(res).values()].find((line) => line.includes("usual-mail-sign-in="));
  assert.ok(cookie, "the sign-in page sets its form cookie");
  return { body, formToken: hiddenValue(body, "_csrf")!, cookie: cookie.slice(0, cookie.indexOf(";")) };
}

async function signIn(app: ReturnType<typeof setup>, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const form = await signInForm(app);
  return app.post("/sign-in", { _csrf: form.formToken, name: "Test browser", ...fields }, {
    token: null,
    headers: { cookie: form.cookie, ...headers },
  });
}

describe("signing in", () => {
  test("the sign-in page says where the owner's code waits, in the host's words when it gives them", async () => {
    const own = await signInForm(setup());
    assert.match(own.body, /the server makes an owner&#39;s code: it prints it in its log and writes it to owner-pairing-code in its data folder\./);
    const hosted = await signInForm(setup({ ownerCodeWhere: 'keeps it in the table "owner_pairing_code" <of its host>' }));
    assert.match(hosted.body, /the server makes an owner&#39;s code: it keeps it in the table &quot;owner_pairing_code&quot; &lt;of its host&gt;\./);
    assert.doesNotMatch(hosted.body, /owner-pairing-code in its data folder/);
  });

  test("the sign-in page has a labelled code field and a form token in an HttpOnly, Strict cookie", async () => {
    const app = setup();
    const form = await signInForm(app);
    assert.match(form.body, /<label for="code">Pairing code<\/label>/);
    assert.match(form.body, /<input type="text" id="code" name="code"/);
    assert.match(form.cookie, /^usual-mail-sign-in=[A-Za-z0-9_-]{32}$/);
    const line = [...cookies(await app.get("/sign-in", { token: null })).values()][0]!;
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Strict/);
    assert.match(line, /Path=\//);
    assert.equal(form.formToken, form.cookie.split("=")[1]);
  });

  test("a good code pairs this browser and keeps the token in a cookie scripts can't read", async () => {
    const app = setup();
    const res = await signIn(app, { code: ` ${GOOD_CODE} ` });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    assert.deepEqual(app.fake.callsTo("pair"), [[{ code: GOOD_CODE, name: "Test browser" }]]);
    const session = cookies(res).get("usual-mail-session");
    assert.ok(session, "sets the session cookie");
    const issued = [...app.fake.tokens.keys()].find((token) => token.startsWith("umt_issued_"))!;
    assert.match(session, new RegExp(`^usual-mail-session=${issued};`));
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Strict/);
    assert.match(session, /Path=\//);
    assert.match(session, /Max-Age=2592000/);
    assert.doesNotMatch(session, /Secure/, "plain HTTP on localhost has no Secure flag");
    assert.doesNotMatch(session, /Domain=/i, "host-only");
    // The sign-in form's own cookie is cleared.
    assert.match(cookies(res).get("usual-mail-sign-in")!, /Max-Age=0/);
    // The new session opens the pages.
    const home = await app.page("/", { token: issued });
    assert.equal(home.status, 200);
  });

  test("over HTTPS the cookie is Secure and takes the __Host- prefix", async () => {
    const app = setup({ origin: "https://mail.example" });
    const res = await signIn(app, { code: GOOD_CODE });
    assert.equal(res.status, 303);
    const session = cookies(res).get("__Host-usual-mail-session");
    assert.ok(session);
    assert.match(session, /; Secure/);
    assert.match(session, /Path=\//);
  });

  test("plain HTTP on another host still sets Secure, and the sign-in page says why signing in won't stick", async () => {
    const app = setup({ origin: "http://mail.example" });
    const form = await signInForm(app);
    assert.match(form.body, /isn&#39;t on HTTPS/);
    const res = await signIn(app, { code: GOOD_CODE });
    assert.match(cookies(res).get("__Host-usual-mail-session")!, /; Secure/);
  });

  test("a wrong code says so, sets no session and keeps the name typed", async () => {
    const app = setup();
    const res = await signIn(app, { code: "WRONG-CODE" });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /That code didn&#39;t work/);
    assert.match(body, /aria-invalid="true"/);
    assert.match(body, /value="Test browser"/);
    assert.equal(cookies(res).get("usual-mail-session"), undefined);
  });

  test("too many wrong codes is said in words, with the wait the server gives", async () => {
    const app = setup();
    app.fake.failNext("pair", new ServiceError("rate_limited", "Too many attempts", { retryAfter: 541 }));
    const res = await signIn(app, { code: "WRONG" });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /Too many wrong codes or passwords\. Wait 10 minutes, then try again\./);
    app.fake.failNext("pair", new ServiceError("rate_limited", "Too many attempts", { retryAfter: 45 }));
    assert.match(await (await signIn(app, { code: "WRONG" })).text(), /Wait 45 seconds, then try again\./);
    // Without a wait, the contract's longest: ten minutes.
    app.fake.failNext("pair", new ServiceError("rate_limited", "Too many attempts"));
    assert.match(await (await signIn(app, { code: "WRONG" })).text(), /Wait up to ten minutes, then try again\./);
    // A ServiceError from another copy of core keeps its wait.
    const foreign = Object.assign(new Error("Too many attempts"), { name: "ServiceError", code: "rate_limited", retryAfter: 60 });
    app.fake.failNext("pair", foreign as unknown as ServiceError);
    assert.match(await (await signIn(app, { code: "WRONG" })).text(), /Wait 1 minute, then try again\./);
  });

  test("an agent's code is refused and its new token is ended at once", async () => {
    const app = setup();
    const res = await signIn(app, { code: AGENT_CODE });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /made for an agent/);
    assert.equal(cookies(res).get("usual-mail-session"), undefined);
    const [revoke] = app.fake.callsTo("revokeDevice");
    assert.ok(revoke, "revokes the agent device it just created");
    assert.equal((revoke[0] as { actor: { kind: string } }).actor.kind, "agent");
    assert.ok(!app.fake.devices.some((device) => device.id === revoke[1]));
  });

  test("without the form's own token, nothing is paired", async () => {
    const app = setup();
    const res = await app.post("/sign-in", { _csrf: "", code: GOOD_CODE }, { token: null });
    assert.equal(res.status, 403);
    assert.deepEqual(app.fake.callsTo("pair"), []);
    const forged = await signIn(app, { code: GOOD_CODE, _csrf: "x".repeat(32) });
    assert.equal(forged.status, 403);
    assert.deepEqual(app.fake.callsTo("pair"), []);
  });

  test("a sign-in posted from another site is refused", async () => {
    const app = setup();
    const res = await signIn(app, { code: GOOD_CODE }, { "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 403);
    assert.deepEqual(app.fake.callsTo("pair"), []);
  });

  test("after signing in it returns to the page asked for, and only to a page on this site", async () => {
    const app = setup();
    const back = await signIn(app, { code: GOOD_CODE, next: "/devices" });
    assert.equal(back.headers.get("location"), "/devices");
    // Paths that become "//host" once dot segments are resolved would leave the site too.
    for (const [index, next] of ["//evil.example/steal", "/.//evil.example", "/..//evil.example", "/a/..//evil.example/x", "/%2e//evil.example"].entries()) {
      app.fake.codes.set(`AWAY${index}`, { kind: "person" });
      const away = await signIn(app, { code: `AWAY${index}`, next });
      assert.equal(away.headers.get("location"), "/", next);
    }
  });

  test("a signed-in person who opens the sign-in page goes home", async () => {
    const app = setup();
    const res = await app.get("/sign-in");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    const away = await app.get(`/sign-in?next=${encodeURIComponent("/.//evil.example")}`);
    assert.equal(away.headers.get("location"), "/");
  });
});

describe("who may see the pages", () => {
  test("every page sends a visitor without a session to sign in, and comes back after", async () => {
    const app = setup();
    for (const path of PAGES) {
      const res = await app.get(path, { token: null });
      assert.equal(res.status, 303, path);
      const location = res.headers.get("location")!;
      assert.ok(location.startsWith("/sign-in"), `${path} → ${location}`);
      if (path !== "/") assert.equal(new URL(location, "http://x").searchParams.get("next"), path);
    }
    assert.deepEqual(app.fake.methods(), [], "no service call without a session");
  });

  test("a form posted without a session goes to sign in and changes nothing", async () => {
    const app = setup();
    const res = await app.post("/inboxes/inb_northwind/sync", {}, { token: null });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location")!, /^\/sign-in/);
    assert.deepEqual(app.fake.methods(), []);
  });

  test("an unknown or revoked token is cleared and sent to sign in", async () => {
    const app = setup();
    const res = await app.get("/inboxes", { token: "umt_not_a_token" });
    assert.equal(res.status, 303);
    assert.match(cookies(res).get("usual-mail-session")!, /Max-Age=0/);
  });

  test("an agent's token is refused on every page", async () => {
    const app = setup();
    for (const path of PAGES) {
      const res = await app.get(path, { token: AGENT_TOKEN });
      assert.equal(res.status, 403, path);
      assert.match(await res.text(), /Agents can&#39;t sign in here/);
      assert.match(cookies(res).get("usual-mail-session")!, /Max-Age=0/);
    }
    const posted = await app.post("/inboxes/inb_northwind/trust", { trust: "act_silently" }, { token: AGENT_TOKEN });
    assert.equal(posted.status, 403);
    assert.deepEqual(app.fake.callsTo("updateInbox"), []);
  });
});

describe("signing out", () => {
  test("signing out revokes this browser's device and clears the cookie", async () => {
    const app = setup();
    const res = await app.post("/sign-out");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/sign-in?done=signed-out");
    const [[caller, id]] = app.fake.callsTo("revokeDevice") as [[{ actor: { kind: string } }, string]];
    assert.equal(caller.actor.kind, "person");
    assert.equal(id, PERSON_DEVICE);
    assert.match(cookies(res).get("usual-mail-session")!, /Max-Age=0/);
    assert.equal((await app.get("/", { token: PERSON_TOKEN })).status, 303, "the old token no longer works");
    const signedOut = await app.page("/sign-in?done=signed-out", { token: null });
    assert.match(signedOut.body, /Signed out\./);
  });
});

describe("mounted under a path", () => {
  test("links, forms and the cookie use the base path, with or without it on the request", async () => {
    const app = setup({ base: "/dashboard" });
    const home = await app.page("/");
    assert.equal(home.status, 200);
    assert.match(home.body, /href="\/dashboard\/inboxes"/);
    assert.match(home.body, /action="\/dashboard\/sign-out"/);
    assert.match(home.body, /href="\/dashboard\/assets\/app\.[0-9a-f]{10}\.css"/);
    // A server that strips the mount path before calling the handler.
    const stripped = await app.handler(new Request("http://localhost:8484/inboxes", { headers: { cookie: app.sessionCookie(PERSON_TOKEN) } }));
    assert.equal(stripped.status, 200);
    const css = home.body.match(/href="\/dashboard(\/assets\/app\.[0-9a-f]{10}\.css)"/)![1]!;
    assert.equal((await app.get(css, { token: null })).status, 200, "assets are served under the base");
    const signIn = await app.get("/sign-in", { token: null });
    assert.match([...cookies(signIn).values()][0]!, /Path=\/dashboard/);
    const away = await app.get("/devices", { token: null });
    assert.equal(away.headers.get("location"), "/dashboard/sign-in?next=%2Fdevices");
  });
});
