/** Inboxes and their guides. Rules are in rules.ts. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { inboxItem } from "../format.ts";
import { guard, id, READ_ONLY, WRITES, type ToolContext } from "./shared.ts";

/** What each trust level means for what an agent does, as the contract's trust table says. Constant text. */
export const TRUST_NOTE =
  "Trust says what your actions do: in a \"suggest\" inbox they are only proposed, for the person to approve; in " +
  "\"act_with_undo\" they apply and the person sees each in Handled, with undo; in \"act_silently\" they apply and " +
  "are recorded as silent: the person sees them only when they ask, still with undo, and anything that goes wrong " +
  "is always shown.";

export function registerInboxTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "list_inboxes",
    {
      title: "List inboxes",
      description:
        "Start here. Lists the inboxes this agent was given, each with its trust level and its guide. Read every " +
        "guide before sorting: it is the person's own notes on how mail in that inbox should be handled. An inbox " +
        "whose first sync is still running says how far it has got (firstSync: messages fetched of the total), so " +
        "more of its older mail is still to come. " +
        `${TRUST_NOTE} ${DATA_NOTICE}`,
      annotations: READ_ONLY,
    },
    guard(async () => {
      const inboxes = await service.listInboxes(caller);
      return toolResult({
        lead: `${inboxes.length} inbox${inboxes.length === 1 ? "" : "es"} this agent may see.`,
        data: inboxes.map(inboxItem),
        next: inboxes.length
          ? "Next: take_triage_batch to get threads nobody has sorted yet."
          : "No inboxes: a person has to give this agent an inbox and turn on its agent access.",
      });
    }),
  );

  server.registerTool(
    "update_guide",
    {
      title: "Update an inbox's guide",
      description:
        "Replaces an inbox's guide with new text (Markdown). Use it to write down what you learned about how " +
        "the person wants mail handled, or when the person asks you to. Keep what the person wrote unless they " +
        "asked you to change it: read the current guide with list_inboxes first. Only the guide can be changed " +
        "here; everything else about an inbox needs a person.",
      inputSchema: z.object({
        inboxId: id("The inbox, from list_inboxes."),
        guide: z.string().max(10_000).describe("The whole new guide. Plain language, Markdown allowed."),
      }),
      annotations: { ...WRITES, idempotentHint: true },
    },
    guard(async ({ inboxId, guide }) => {
      const inbox = await service.updateInbox(caller, inboxId, { guide });
      return toolResult({ lead: "Guide saved.", data: [{ inboxId: inbox.id, guide: inbox.guide }] });
    }),
  );
}
