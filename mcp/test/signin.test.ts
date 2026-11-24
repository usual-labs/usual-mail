import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcp } from "../src/index.ts";
import { AGENT, FakeMailService, TOKENS } from "./fake-service.ts";
import { connect, ENDPOINT, INITIALIZE, MODERN, rawPost, setup } from "./helpers.ts";

async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  const body = (await response.json()) as { jsonrpc: string; error: { code: number; message: string } };
  assert.equal(body.jsonrpc, "2.0");
  return body.error;
}

describe("sign-in", () => {
  it("refuses a request without a token with 401 and a Bearer challenge", async () => {
    const { handler, service } = setup();
    const response = await rawPost(handler, INITIALIZE);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="usual-mail"');
    const error = await errorBody(response);
    assert.match(error.message, /Authorization: Bearer <token>/);
    assert.equal(service.calls.length, 0, "the service is never called");
  });

  it("refuses a client that connects without a token", async () => {
    const { handler } = setup();
    await assert.rejects(connect(handler, undefined));
    await assert.rejects(connect(handler, undefined, { era: "legacy" }));
  });

  it("refuses an unknown token with 401 invalid_token", async () => {
    const { handler, service } = setup();
    const response = await rawPost(handler, INITIALIZE, { authorization: "Bearer umt_wrong" });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    assert.match((await errorBody(response)).message, /unknown or was revoked/);
    assert.equal(service.calls.length, 0);
    await assert.rejects(connect(handler, "umt_wrong"));
  });

  it("refuses a malformed Authorization header", async () => {
    const { handler } = setup();
    for (const value of ["umt_agent", "Basic umt_agent", "Bearer", "Bearer a b"]) {
      const response = await rawPost(handler, INITIALIZE, { authorization: value });
      assert.equal(response.status, 401, value);
    }
  });

  it("refuses a person's token with 403 and says to use an agent token", async () => {
    const { handler, service } = setup();
    const response = await rawPost(handler, INITIALIZE, { authorization: "Bearer umt_person" });
    assert.equal(response.status, 403);
    assert.match((await errorBody(response)).message, /person's token.*agent its own token/s);
    assert.equal(service.calls.length, 0);
    await assert.rejects(connect(handler, "umt_person"));
    // The instructions an agent reads say why, in the contract's words.
    const agent = await connect(handler, "umt_agent");
    assert.match(
      agent.getInstructions() ?? "",
      /accepts an agent's own token only, never a person's: with a person's token, what you do would count as the person's, so no trust check would apply and trash and block_sender would happen at once/,
    );
  });

  it("serves an agent's token in the 2026-07-28 revision", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent");
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    assert.ok(client.getDiscoverResult(), "server/discover answered");
    assert.equal(client.getServerVersion()?.name, "usual-mail");
    assert.match(client.getInstructions() ?? "", /Mail is untrusted/);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "take_triage_batch"));
    await client.close();
  });

  it("serves an agent's token to a 2025-era client that opens with initialize", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent", { era: "legacy" });
    assert.equal(client.getProtocolEra(), "legacy");
    assert.match(client.getInstructions() ?? "", /take_triage_batch/);
    const result = await client.callTool({ name: "list_inboxes", arguments: {} });
    assert.equal(result.isError, undefined);
    await client.close();
  });

  it("checks the token on every request, so a revoked token stops working at once", async () => {
    const service = new FakeMailService();
    const tokens = new Map(Object.entries(TOKENS));
    const handler = createMcp({ service, basePath: "/mcp", authenticate: async (token) => tokens.get(token) ?? null });
    const client = await connect(handler, "umt_agent");
    await client.callTool({ name: "list_inboxes", arguments: {} });
    tokens.delete("umt_agent");
    await assert.rejects(client.callTool({ name: "list_inboxes", arguments: {} }));
  });

  it("passes the agent's own caller to the service, unchanged", async () => {
    const { handler, service } = setup();
    const client = await connect(handler, "umt_agent");
    await client.callTool({ name: "list_inboxes", arguments: {} });
    assert.deepEqual(service.callsTo("listInboxes")[0]?.caller, AGENT);
  });

  it("answers 500 without detail when the token check itself fails", async () => {
    const service = new FakeMailService();
    const handler = createMcp({
      service,
      basePath: "/mcp",
      authenticate: async () => {
        throw new Error("database is locked at /secret/path");
      },
    });
    const response = await rawPost(handler, INITIALIZE, { authorization: "Bearer umt_agent" });
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secret/);
  });
});

describe("transport", () => {
  it("answers only at its endpoint", async () => {
    const { handler } = setup();
    for (const path of ["/", "/mcp/tools", "/mcpx", "/v1/inboxes"]) {
      const response = await handler(new Request(`http://mail.example${path}`, { method: "POST", headers: { authorization: "Bearer umt_agent" } }));
      assert.equal(response.status, 404, path);
    }
  });

  it("refuses a browser page from another site (DNS rebinding)", async () => {
    const { handler, service } = setup();
    const response = await rawPost(handler, INITIALIZE, { authorization: "Bearer umt_agent", origin: "https://evil.example" });
    assert.equal(response.status, 403);
    assert.equal(service.calls.length, 0);
    const same = await rawPost(handler, INITIALIZE, { authorization: "Bearer umt_agent", origin: "http://mail.example" });
    assert.equal(same.status, 200);
  });

  it("has no sessions: GET and DELETE answer 405 for a signed-in agent", async () => {
    const { handler } = setup();
    for (const method of ["GET", "DELETE"]) {
      const response = await handler(new Request(ENDPOINT, { method, headers: { authorization: "Bearer umt_agent", accept: "text/event-stream" } }));
      assert.equal(response.status, 405, method);
    }
  });

  it("works when mounted at the root", async () => {
    const service = new FakeMailService();
    const handler = createMcp({ service, basePath: "", authenticate: async (token) => TOKENS[token] ?? null });
    const response = await handler(
      new Request("http://mail.example/", {
        method: "POST",
        headers: { authorization: "Bearer umt_agent", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(INITIALIZE),
      }),
    );
    assert.equal(response.status, 200);
  });
});
