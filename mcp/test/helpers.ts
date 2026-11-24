/** Drives the connector through a real MCP client in the same process. */
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport, type ClientCapabilities } from "@modelcontextprotocol/client";
import type { FetchHandler } from "@usualmail/core";
import { BOUNDARY_TAG } from "../src/boundary.ts";
import { createMcp } from "../src/index.ts";
import { authenticate, FakeMailService } from "./fake-service.ts";

export const ENDPOINT = "http://mail.example/mcp";
export const MODERN = "2026-07-28";

export function setup(service = new FakeMailService()): { service: FakeMailService; handler: FetchHandler } {
  return { service, handler: createMcp({ service, authenticate, basePath: "/mcp" }) };
}

export interface ConnectOptions {
  era?: "modern" | "legacy";
  capabilities?: ClientCapabilities;
}

export async function connect(handler: FetchHandler, token: string | undefined, options: ConnectOptions = {}): Promise<Client> {
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    {
      versionNegotiation: { mode: (options.era ?? "modern") === "modern" ? { pin: MODERN } : "legacy" },
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: async (input, init) => handler(new Request(input, init)),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(transport);
  return client;
}

export interface ToolText {
  text: string;
  isError: boolean;
  lead: string;
  /** The JSON values inside the data block, one per line. */
  data: unknown[];
  /** Everything after the data block (or after the lead when there is none). */
  next: string;
  structured: Record<string, unknown> | undefined;
}

/** Calls a tool and splits its text into the connector's words and the data block, checking the block's shape. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const result = await client.callTool({ name, arguments: args });
  return readResult(result as { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> });
}

export function readResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }): ToolText {
  assert.equal(result.content.length, 1);
  const text = result.content[0]!.text ?? "";
  const { lead, data, next } = splitBlock(text);
  return { text, isError: result.isError === true, lead, data, next, structured: result.structuredContent };
}

/** Splits a result text at its one data block. Fails if there is more than one opening or closing marker. */
export function splitBlock(text: string): { lead: string; data: unknown[]; next: string } {
  const open = [...text.matchAll(new RegExp(`<${BOUNDARY_TAG} id="([0-9a-f]+)">`, "g"))];
  const close = [...text.matchAll(new RegExp(`</${BOUNDARY_TAG} id="([0-9a-f]+)">`, "g"))];
  if (open.length === 0 && close.length === 0) {
    const [lead, ...rest] = text.split("\n\n");
    return { lead: lead ?? "", data: [], next: rest.join("\n\n") };
  }
  assert.equal(open.length, 1, "exactly one opening marker");
  assert.equal(close.length, 1, "exactly one closing marker");
  assert.equal(open[0]![1], close[0]![1], "markers share an id");
  const start = open[0]!.index!;
  const end = close[0]!.index!;
  const inside = text.slice(start + open[0]![0].length, end).replace(/^\n/, "").replace(/\n$/, "");
  assert.ok(!/[<>]/.test(inside), "no < or > inside the block");
  const data = inside === "" ? [] : inside.split("\n").map((line) => JSON.parse(line) as unknown);
  return {
    lead: text.slice(0, start).trim(),
    data,
    next: text.slice(end + close[0]![0].length).trim(),
  };
}

export async function rawPost(handler: FetchHandler, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handler(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};
