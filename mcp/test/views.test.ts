/** The MCP Apps interface pieces: offered as the extension requires, built from the design system, safe with mail. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { Client } from "@modelcontextprotocol/client";
import { TOKENS_CSS } from "../src/ui/design.generated.ts";
import { hatFor } from "../src/ui/hats.ts";
import { VIEW_SCRIPT } from "../src/ui/view-script.ts";
import { BRIEF_VIEW_URI, THREADS_VIEW_URI, VIEW_CSS, viewHtml } from "../src/ui/views.ts";
import { FakeElement, runView, settle, type Page } from "./fake-dom.ts";
import { HOSTILE, hostileService } from "./hostile-fixture.ts";
import { connect, setup } from "./helpers.ts";

const UI = "io.modelcontextprotocol/ui";
const ALLOWED_TAGS = new Set(["article", "header", "h2", "p", "section", "ul", "li", "a", "div", "span", "button", "svg", "use"]);

async function agent(): Promise<Client> {
  const { handler } = setup(hostileService());
  return connect(handler, "umt_agent", { capabilities: { extensions: { [UI]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
}

/** A host that answers ui/initialize and forwards tools/call to the real connector, as a chat app would. */
function mount(view: string, client: Client, hostCapabilities: Record<string, unknown> = { message: {}, serverTools: {} }): Page {
  const page: Page = runView(VIEW_SCRIPT, view, (message) => {
    const answer = (reply: Record<string, unknown>) => setImmediate(() => page.deliver({ jsonrpc: "2.0", id: message.id, ...reply }));
    if (message.method === "ui/initialize") {
      answer({
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "test-host", version: "1" },
          hostCapabilities,
          hostContext: { theme: "dark", timeZone: "UTC" },
        },
      });
    } else if (message.method === "tools/call") {
      client.callTool(message.params as { name: string; arguments: Record<string, unknown> }).then(
        (result) => answer({ result }),
        (error: unknown) => answer({ error: { code: -32603, message: String(error) } }),
      );
    } else if (message.method === "ui/message") {
      answer({ result: {} });
    }
  });
  return page;
}

async function show(page: Page, client: Client, tool: string, args: Record<string, unknown> = {}): Promise<void> {
  await settle();
  page.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
  page.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: await client.callTool({ name: tool, arguments: args }) });
  await settle();
}

const methods = (page: Page) => page.sent.map((message) => message.method);
const toolCalls = (page: Page) =>
  page.sent.filter((message) => message.method === "tools/call").map((message) => message.params as { name: string; arguments: Record<string, unknown> });
const text = (element: FakeElement | undefined) => element?.textContent ?? "";

describe("offered as MCP Apps requires", () => {
  it("links each UI tool to a ui:// resource of type text/html;profile=mcp-app", async () => {
    const client = await agent();
    const tools = (await client.listTools()).tools;
    const meta = (name: string) => tools.find((tool) => tool.name === name)!._meta as Record<string, unknown>;
    assert.deepEqual(meta("list_threads").ui, { resourceUri: THREADS_VIEW_URI });
    assert.equal(meta("list_threads")["ui/resourceUri"], THREADS_VIEW_URI, "the older key, for older hosts");
    assert.deepEqual(meta("get_brief").ui, { resourceUri: BRIEF_VIEW_URI });
    const resources = (await client.listResources()).resources;
    for (const uri of [THREADS_VIEW_URI, BRIEF_VIEW_URI]) {
      const listed = resources.find((resource) => resource.uri === uri)!;
      assert.equal(listed.mimeType, RESOURCE_MIME_TYPE);
      const read = await client.readResource({ uri });
      const content = read.contents[0] as { uri: string; mimeType: string; text: string; _meta: { ui: Record<string, unknown> } };
      assert.equal(content.uri, uri);
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.match(content.text, /^<!doctype html>\n<html lang="en">/);
      assert.deepEqual(content._meta.ui, { csp: {}, prefersBorder: false }, "no network, fonts or frames");
    }
    assert.deepEqual(client.getServerCapabilities()?.extensions, { [UI]: {} });
  });

  it("still answers in text for hosts without the extension", async () => {
    const { handler } = setup();
    const client = await connect(handler, "umt_agent");
    const result = (await client.callTool({ name: "get_brief", arguments: {} })) as { content: Array<{ type: string; text: string }> };
    assert.match(result.content[0]!.text, /Dana asks for 60 days' notice/);
  });

  it("loads nothing from outside the page", () => {
    for (const view of ["brief", "threads"] as const) {
      const html = viewHtml(view);
      assert.deepEqual([...new Set(html.match(/https?:\/\/[^"\s)]+/g))], ["http://www.w3.org/2000/svg"], "only the SVG namespace");
      assert.doesNotMatch(html, /<link|<iframe|\ssrc=|@import|@font-face|url\(/i);
      assert.equal(html.split("<script>").length - 1, 1);
      assert.equal(html.split("</script>").length - 1, 1);
      assert.equal(html.split("</style>").length - 1, 2);
    }
  });
});

describe("built from the design system", () => {
  const defined = new Set([...TOKENS_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));

  it("uses only variables that design/dist/web/tokens.css defines", () => {
    const used = new Set([...VIEW_CSS.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
    assert.ok(used.size > 30);
    assert.deepEqual([...used].filter((name) => !defined.has(name)), []);
  });

  it("writes no colour, font or custom property of its own", () => {
    assert.doesNotMatch(VIEW_CSS, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|(?<![-\w])(white|black|red|blue|green|gray|grey|transparent)(?![-\w])/i);
    assert.doesNotMatch(VIEW_CSS, /font-family|font-size|--[a-z0-9-]+\s*:/);
    for (const declaration of VIEW_CSS.matchAll(/(?:^|[;{]\s*)(color|background|font|border(?:-top)?|box-shadow|outline):\s*([^;}]+)/g)) {
      const value = declaration[2]!.trim();
      assert.ok(/var\(--/.test(value) || /^(inherit|none|0)$/.test(value), `${declaration[1]}: ${value}`);
    }
  });

  it("inlines tokens.css unchanged and matches hats like the design package", () => {
    assert.ok(viewHtml("brief").includes(TOKENS_CSS));
    assert.deepEqual(["#2F6FED", "#1F8A5B", "#C2541D", "#285fcd", "nonsense"].map(hatFor), ["blue", "green", "orange", "blue", "slate"]);
  });
});

describe("the view script", () => {
  it("never writes markup and only calls tools an agent may call", () => {
    assert.doesNotMatch(VIEW_SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|<\/script/i);
    const called = new Set([...VIEW_SCRIPT.matchAll(/callTool\("([a-z_]+)"/g)].map((match) => match[1]));
    assert.deepEqual([...called].sort(), ["act_on_threads", "undo_action"]);
    assert.equal(VIEW_SCRIPT.split('"tools/call"').length - 1, 1, "tools/call is sent from one place");
  });

  it("does the MCP Apps handshake, follows the host's theme and reports its size", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await settle();
    const init = page.sent[0]!;
    assert.equal(init.method, "ui/initialize");
    assert.equal((init.params as { protocolVersion: string }).protocolVersion, "2026-01-26");
    assert.deepEqual(methods(page).slice(1), ["ui/notifications/initialized"]);
    assert.equal(page.html.getAttribute("data-theme"), "dark");
    await show(page, client, "list_threads");
    assert.ok(methods(page).includes("ui/notifications/size-changed"));
  });

  it("ignores messages that don't come from its host, and answers teardown", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await settle();
    const result = await client.callTool({ name: "list_threads", arguments: {} });
    page.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, { postMessage() {} });
    assert.equal(page.root.childNodes.length, 0);
    page.deliver({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} });
    assert.deepEqual(page.sent.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
  });
});

describe("the thread list", () => {
  it("draws rows from the tool result, with mail only as text", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await show(page, client, "list_threads");
    const rows = page.root.byClass("row");
    assert.equal(rows.length, 5);
    assert.deepEqual(page.root.all().filter((element) => !ALLOWED_TAGS.has(element.tagName)).map((element) => element.tagName), []);
    assert.ok(page.root.all().every((element) => [...element.attributes.keys()].every((name) => !/^on/i.test(name))));
    const evil = rows[4]!;
    assert.equal(text(evil.byClass("subject")[0]), HOSTILE.subject);
    assert.equal(text(evil.byClass("sender")[0]), HOSTILE.fromName);
    // The summary Usual Mail's AI wrote from hostile mail is shown in place of the snippet, as text only.
    assert.equal(text(evil.byClass("snippet")[0]), HOSTILE.aiSummary);
    assert.equal(evil.getAttribute("class"), "row unread");
    assert.equal(text(rows[1]!.byClass("sender")[0]), "Dana Whitfield");
    assert.equal(text(rows[1]!.byClass("time")[0]), "08:52");
    assert.equal(text(rows[1]!.byClass("snippet")[0]), "Asks you to confirm the 2027 renewal by Friday, with 60 days' notice instead of 30.");
    assert.equal(text(rows[0]!.byClass("snippet")[0]), "Something came up on our side. Would Friday at the same time work for you?", "the snippet while there is no summary");
    assert.deepEqual(rows[1]!.byClass("hat-label").map((label) => [label.getAttribute("data-hat"), text(label)]), [["blue", "Northwind Studio"]]);
    assert.equal(page.root.all().find((element) => element.tagName === "ul")!.getAttribute("aria-label"), "Home");
  });

  it("marks a thread done through act_on_threads, then undoes it through undo_action", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await show(page, client, "list_threads");
    const row = page.root.byClass("row")[1]!;
    const [done, later] = row.byClass("button");
    assert.deepEqual([text(done), text(later)], ["Done", "Reply later"]);
    done!.click();
    await settle();
    assert.deepEqual(toolCalls(page)[0], {
      name: "act_on_threads",
      arguments: { threadIds: ["thr_1"], action: "done", reason: "Marked done from a Usual Mail list in a chat app" },
    });
    const actions = row.byClass("actions")[0]!;
    assert.equal(text(actions.byClass("note")[0]), "Marked done.");
    actions.byClass("button")[0]!.click();
    await settle();
    assert.equal(toolCalls(page)[1]!.name, "undo_action");
    assert.match(String(toolCalls(page)[1]!.arguments.actionId), /^act_/);
    assert.equal(text(actions), "Undone.");
  });

  it("shows a proposal in a suggest inbox and puts a thread on Reply later", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await show(page, client, "list_threads", { view: "newsletter" });
    const rows = page.root.byClass("row");
    assert.deepEqual(rows.map((row) => text(row.byClass("sender")[0])), ["Coffee Roasters Monthly", "The Weekly Build"]);
    assert.equal(page.root.all().find((element) => element.tagName === "ul")!.getAttribute("aria-label"), "Newsletters");
    rows[0]!.byClass("button")[0]!.click();
    rows[1]!.byClass("button")[1]!.click();
    await settle();
    assert.equal(text(rows[0]!.byClass("actions")[0]), "Proposed: waiting for your yes in Usual Mail.");
    assert.equal(toolCalls(page)[1]!.arguments.stack, "reply_later");
    assert.equal(text(rows[1]!.byClass("note")[0]), "On Reply later.");
  });

  it("marks a screened thread in the screening list", async () => {
    const client = await agent();
    const page = mount("threads", client);
    await show(page, client, "list_threads", { view: "screening" });
    const rows = page.root.byClass("row");
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.byClass("tag").some((tag) => text(tag) === "Screened"));
  });
});

describe("the brief card", () => {
  it("draws the brief with hats, highlights and counts", async () => {
    const client = await agent();
    const page = mount("brief", client);
    await show(page, client, "get_brief");
    const card = page.root.byClass("brief")[0]!;
    assert.equal(card.tagName, "article");
    assert.equal(text(card.all().find((element) => element.tagName === "h2")), "Brief");
    assert.equal(text(card.byClass("meta")[0]), "15 Nov 15:00 to 16 Nov 09:00 \u00b7 Written by Claude Code");
    const sections = card.byClass("section");
    assert.deepEqual(sections.map((section) => section.byClass("hat-label")[0]!.getAttribute("data-hat")), ["blue", "green"]);
    assert.equal(text(sections[0]!.byClass("summary")[0]), HOSTILE.summary);
    assert.equal(text(sections[0]!.byClass("counts")[0]), "Newsletters 1 \u00b7 Receipts 1 \u00b7 Done 1");
    assert.equal(sections[1]!.byClass("counts").length, 0, "no counts line when nothing was counted");
    const highlight = sections[0]!.byClass("highlight")[0]!;
    assert.equal(highlight.tagName, "a");
    assert.equal(text(highlight.byClass("hl-subject")[0]), "Contract renewal for 2027");
    assert.deepEqual(page.root.all().filter((element) => !ALLOWED_TAGS.has(element.tagName)).map((element) => element.tagName), []);
  });

  it("asks the host to open a highlighted thread, by id only", async () => {
    const client = await agent();
    const page = mount("brief", client);
    await show(page, client, "get_brief");
    page.root.byClass("highlight")[0]!.click();
    await settle();
    const message = page.sent.find((entry) => entry.method === "ui/message")!;
    assert.deepEqual(message.params, { role: "user", content: [{ type: "text", text: "Open the thread thr_1 from the Usual Mail brief." }] });
    assert.deepEqual(toolCalls(page), []);
  });

  it("leaves highlights as plain text when the host can't take messages", async () => {
    const client = await agent();
    const page = mount("brief", client, {});
    await show(page, client, "get_brief");
    assert.ok(page.root.byClass("highlight").every((element) => element.tagName === "div"));
  });

  it("says when there is no brief", async () => {
    const service = hostileService();
    service.briefs = [];
    const { handler } = setup(service);
    const client = await connect(handler, "umt_agent");
    const page = mount("brief", client);
    await show(page, client, "get_brief");
    assert.equal(text(page.root.byClass("meta")[0]), "No brief yet.");
  });
});
