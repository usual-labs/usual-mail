/** One MCP server per request, holding the tools an agent may use, bound to that request's caller. */
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Caller, MailService } from "@usualmail/core";
import { INSTRUCTIONS } from "./instructions.ts";
import { registerActionTools } from "./tools/actions.ts";
import { registerAiTools } from "./tools/ai.ts";
import { registerBriefTools } from "./tools/briefs.ts";
import { registerDraftTools } from "./tools/drafts.ts";
import { registerInboxTools } from "./tools/inboxes.ts";
import { registerRuleTools } from "./tools/rules.ts";
import type { ToolContext } from "./tools/shared.ts";
import { registerThreadTools } from "./tools/threads.ts";
import { registerTriageTools } from "./tools/triage.ts";
import { registerViews } from "./ui/views.ts";

export const SERVER_INFO = { name: "usual-mail", title: "Usual Mail", version: "0.1.5" } as const;

/**
 * Every tool an agent may use. Nothing that needs a person is registered at all (sending, approving and
 * rejecting, answering a teach prompt, turning rules on, inbox settings other than the guide, the AI's settings and
 * testing it, devices), so it can't be called by name.
 */
export function buildServer(service: MailService, caller: Caller): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { extensions: { [EXTENSION_ID]: {} } },
  });
  const context: ToolContext = { service, caller };
  registerInboxTools(server, context);
  registerRuleTools(server, context);
  registerTriageTools(server, context);
  registerAiTools(server, context);
  registerThreadTools(server, context);
  registerActionTools(server, context);
  registerDraftTools(server, context);
  registerBriefTools(server, context);
  registerViews(server);
  return server;
}
