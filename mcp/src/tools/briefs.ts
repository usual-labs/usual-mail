/** Briefs: an agent writes one for a period, and shows the latest (or one by id) as text and as the brief card. */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Brief, Inbox } from "@usualmail/core";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { invalid } from "../errors.ts";
import { contractTime } from "../format.ts";
import { briefCard } from "../ui/structured.ts";
import { BRIEF_VIEW_URI } from "../ui/views.ts";
import { guard, id, READ_ONLY, WRITES, type ToolContext } from "./shared.ts";

export function registerBriefTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "write_brief",
    {
      title: "Write a brief",
      description:
        "Stores a brief for a period: for each inbox, a short summary of what happened and what needs the " +
        "person, and highlights (one sentence each, about one thread). Usual Mail fills in the counts (leaving out " +
        "what was done silently) and each highlight's subject itself. " +
        "Gather what you write from list_handled, list_threads and read_thread first. Write for the person: " +
        "plain, short, no guesses presented as facts.",
      inputSchema: z.object({
        from: z.string().max(40).describe("Start of the period, ISO 8601 in UTC."),
        to: z.string().max(40).describe("End of the period, ISO 8601 in UTC."),
        sections: z
          .array(
            z.object({
              inboxId: id("The inbox, from list_inboxes."),
              summary: z.string().max(2000).optional().describe("A few plain sentences."),
              highlights: z
                .array(
                  z.object({
                    threadId: id("The thread this highlight is about."),
                    line: z.string().min(1).max(300).describe("One sentence."),
                  }),
                )
                .max(10)
                .optional(),
            }),
          )
          .min(1)
          .max(20),
      }),
      annotations: WRITES,
    },
    guard(async ({ from, to, sections }) => {
      const start = contractTime(from);
      const end = contractTime(to);
      if (!start || !end) return invalid("from and to must be times such as 2026-11-16T09:00:00Z.");
      if (start >= end) return invalid("from must be before to.");
      const brief = await service.writeBrief(caller, {
        from: start,
        to: end,
        sections: sections.map((section) => ({
          inboxId: section.inboxId,
          ...(section.summary ? { summary: section.summary } : {}),
          highlights: section.highlights ?? [],
        })),
      });
      return toolResult({
        lead: "Brief saved. The person sees it in Usual Mail.",
        data: [briefData(brief)],
      });
    }),
  );

  registerAppTool(
    server,
    "get_brief",
    {
      title: "Show the brief",
      description:
        "Shows the latest brief (or one by id): per inbox, what happened and what needs the person, with counts " +
        "of where handled mail went. In chat apps that show interfaces it appears as the brief card. " +
        DATA_NOTICE,
      inputSchema: z.object({ briefId: id("A brief's id. Leave out for the latest.").optional() }),
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: BRIEF_VIEW_URI } },
    },
    guard(async ({ briefId }) => {
      const [brief, inboxes] = await Promise.all([
        briefId ? service.brief(caller, briefId) : service.latestBrief(caller),
        service.listInboxes(caller),
      ]);
      const byId = new Map<string, Inbox>(inboxes.map((inbox) => [inbox.id, inbox]));
      if (!brief) {
        return toolResult({
          lead: "No brief yet.",
          next: "Write one with write_brief.",
          structured: briefCard(null, byId),
        });
      }
      return toolResult({
        lead: `Brief with ${brief.sections.length} section${brief.sections.length === 1 ? "" : "s"}.`,
        data: [briefData(brief, byId)],
        structured: briefCard(brief, byId),
      });
    }),
  );
}

/** The brief as data. Each highlight carries its thread's subject as the server stored it when the brief was written. */
function briefData(brief: Brief, inboxes?: Map<string, Inbox>) {
  return {
    briefId: brief.id,
    from: brief.from,
    to: brief.to,
    createdAt: brief.createdAt,
    writtenBy: brief.writtenBy.kind === "agent" ? `agent ${brief.writtenBy.name}` : brief.writtenBy.kind,
    sections: brief.sections.map((section) => ({
      inboxId: section.inboxId,
      ...(inboxes?.get(section.inboxId) ? { inboxName: inboxes.get(section.inboxId)!.name } : {}),
      ...(section.summary ? { summary: section.summary } : {}),
      counts: section.counts,
      highlights: section.highlights.map((highlight) => ({
        threadId: highlight.threadId,
        subject: highlight.subject,
        line: highlight.line,
      })),
    })),
  };
}
