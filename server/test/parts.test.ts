// Joining parts: providers registered by kind and interfaces mounted under a base path, through the same
// mechanism `src/node/parts.ts` feeds. Tested with a made-up interface and a made-up provider.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { InterfaceDeps } from "@usualmail/core";
import { checkInterfaces, FakeModels, MailServer, providerRegistry, type MountedInterface } from "../src/index.ts";
import { parts } from "../src/node/parts.ts";
import { createApp } from "../src/rest/app.ts";
import { MemoryMailbox } from "../src/testing/index.ts";
import { makeServer, type TestServer } from "./helpers.ts";

let t: TestServer;
beforeEach(async () => (t = await makeServer()));
afterEach(async () => t.close());

/** A made-up interface: says who it is, what it was given, and who the bearer token belongs to. */
function fakeInterface(name: string, seen: InterfaceDeps[]): MountedInterface["create"] {
  return (deps) => {
    seen.push(deps);
    return async (request) => {
      const url = new URL(request.url);
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const caller = token ? await deps.authenticate(token) : null;
      const inboxes = caller ? (await deps.service.listInboxes(caller)).length : null;
      const body = request.method === "POST" ? await request.text() : null;
      return Response.json({ name, basePath: deps.basePath, path: url.pathname, query: url.search, method: request.method, caller: caller?.actor.kind ?? null, inboxes, body });
    };
  };
}

describe("parts.ts", () => {
  test("joins the IMAP and Gmail providers, the connector at /mcp and the dashboard at the root, a valid set of parts", () => {
    assert.deepEqual(parts.interfaces.map((part) => part.basePath), ["/mcp", ""]);
    checkInterfaces(parts.interfaces);
    assert.deepEqual(providerRegistry(parts).kinds(), ["imap", "gmail"]);
    assert.equal(providerRegistry(parts).get("imap")!({ imap: { host: "127.0.0.1", port: 1, secure: false, user: "me@acme.example", password: "x" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "me@acme.example", password: "x" } }).kind, "imap");
    assert.equal(providerRegistry(parts).get("gmail")!({ clientId: "id", clientSecret: "secret", refreshToken: "token" }).kind, "gmail");
    assert.throws(() => providerRegistry(parts).get("imap")!({}), /IMAP credentials need imap.host/);
  });

  test("base paths are checked: no trailing slash, nothing under the REST routes, no two alike", () => {
    const create = fakeInterface("x", []);
    checkInterfaces([{ basePath: "", create }, { basePath: "/mcp", create }, { basePath: "/apps/chat", create }]);
    for (const basePath of ["/mcp/", "mcp", "/v1", "/v1/mcp", "/healthz", "/a b"]) {
      assert.throws(() => checkInterfaces([{ basePath, create }]), Error, basePath);
    }
    assert.throws(() => checkInterfaces([{ basePath: "/mcp", create }, { basePath: "/mcp", create }]), /Two interfaces/);
  });

  test("a provider registered by kind connects inboxes of that kind", async () => {
    const mailbox = new MemoryMailbox({ address: "me@made-up.example", kind: "gmail" });
    const registry = providerRegistry({ providers: { gmail: () => mailbox.provider() } });
    assert.deepEqual(registry.kinds(), ["gmail"]);
    const server = await MailServer.create(t.host, { providers: registry, models: new FakeModels() });
    const inbox = await server.connectInbox(t.person, { name: "Made up", color: "#123456", provider: "gmail", credentials: {} });
    assert.deepEqual([inbox.provider, inbox.address], ["gmail", "me@made-up.example"]);
    await assert.rejects(server.connectInbox(t.person, { name: "None", color: "#123456", provider: "imap", credentials: {} }), /no imap provider/);
    await server.stop();
  });
});

describe("mounted interfaces", () => {
  test("each gets the service, the server's authenticate and its base path, and every request under it unchanged", async () => {
    const seen: InterfaceDeps[] = [];
    const app = createApp(t.server, {
      scheduler: t.clock,
      log: t.host.log,
      interfaces: [
        { basePath: "", create: fakeInterface("dashboard", seen) },
        { basePath: "/mcp", create: fakeInterface("connector", seen) },
      ],
    });
    assert.deepEqual(seen.map((deps) => deps.basePath).sort(), ["", "/mcp"]);
    assert.ok(seen.every((deps) => deps.service === t.server));
    // Bodies are checked field by field, so they are loosely typed here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const get = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
      const res = await app.request(path, init);
      return { status: res.status, body: await res.json() };
    };
    const auth = { authorization: `Bearer ${t.personToken}` };

    const connector = await get("/mcp/tools/list?x=1", { headers: auth });
    assert.deepEqual(connector.body, { name: "connector", basePath: "/mcp", path: "/mcp/tools/list", query: "?x=1", method: "GET", caller: "person", inboxes: 0, body: null });
    assert.equal((await get("/mcp")).body.name, "connector");
    const posted = await get("/mcp", { method: "POST", body: '{"jsonrpc":"2.0"}', headers: { "content-type": "application/json" } });
    assert.deepEqual([posted.body.caller, posted.body.body], [null, '{"jsonrpc":"2.0"}']);
    assert.equal((await get("/mcp", { headers: { authorization: "Bearer umt_wrong" } })).body.caller, null);

    assert.equal((await get("/")).body.name, "dashboard");
    assert.equal((await get("/settings/devices")).body.path, "/settings/devices");
    assert.equal((await get("/mcpx")).body.name, "dashboard");

    // The REST routes keep their paths and their errors.
    assert.deepEqual(await get("/healthz"), { status: 200, body: { ok: true } });
    assert.equal((await get("/v1/home", { headers: auth })).status, 200);
    assert.deepEqual((await get("/v1/nowhere", { headers: auth })).body.error.code, "not_found");
    assert.deepEqual((await get("/v1/home", { method: "DELETE", headers: auth })).body.error.code, "not_found");
    // The fourth revision's Now is gone, and REST's not_found answers it, not the interface at the root.
    assert.deepEqual((await get("/v1/now", { headers: auth })).body.error.code, "not_found");
  });

  test("without a root interface, other paths are REST's not_found", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log, interfaces: [{ basePath: "/mcp", create: fakeInterface("connector", []) }] });
    const res = await app.request("/");
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "not_found");
  });
});

describe("the joined parts", () => {
  test("the app built from the real parts answers POST /mcp without a token with 401 and serves GET /sign-in", async () => {
    const app = createApp(t.server, { scheduler: t.clock, log: t.host.log, interfaces: parts.interfaces });
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(mcp.status, 401);
    const signIn = await app.request("/sign-in");
    assert.equal(signIn.status, 200);
    assert.match(signIn.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await signIn.text(), /<form/i);
    // REST keeps its own paths beside them.
    assert.equal((await app.request("/healthz")).status, 200);
    assert.equal((await app.request("/v1/me")).status, 401);
  });
});
