/**
 * The triage loop: take a batch of threads nobody has categorized and Usual Mail's own AI won't, decide each with a
 * reason, repeat. Usual Mail categorizes and summarizes everything else itself.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { CATEGORIES, type ActResult, type DecidedCategory } from "@usualmail/core";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { messageItem, recordItem, TEXT_LIMITS, threadState, threadSummary } from "../format.ts";
import { guard, id, limit, READ_ONLY, WRITES, type ToolContext } from "./shared.ts";

/** The categories an agent may choose: every one but `unknown`, which nobody chooses. */
export const DECIDED_CATEGORIES = CATEGORIES.filter((category) => category !== "unknown") as [DecidedCategory, ...DecidedCategory[]];

/** What each category means, for tool descriptions. Constant text. */
export const CATEGORY_NOTE =
  "Categories: conversation (mail between people that may need the person; it stays in Home), newsletter, " +
  "invoice, receipt, notification (automatic notices: shipping, sign-ins, alerts; they have their own list, not Home), otp (a " +
  "one-time code). " +
  "unknown means nobody has decided yet, and can't be chosen.";

/** Explains proposals in results. Constant text. */
export const PROPOSED_NOTE =
  "\"proposed\" means it waits for the person's yes in Usual Mail and nothing has moved yet: in a \"suggest\" " +
  "inbox everything you do is proposed, and trash and block_sender always are. Don't repeat a proposal.";

/** Lead line for anything that answers with an ActResult. */
export function actLead(verb: string, result: ActResult): string {
  const proposed = result.records.filter((record) => record.state === "proposed").length;
  const applied = result.records.filter((record) => record.state === "applied").length;
  const silent = result.records.filter((record) => record.state === "applied" && record.silent).length;
  const other = result.records.length - proposed - applied;
  const parts = [`${applied} applied${silent ? ` (${silent} silently)` : ""}`, `${proposed} proposed for the person to approve`];
  if (other) parts.push(`${other} in another state`);
  return `${verb} ${result.threads.length} thread${result.threads.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

export function actData(result: ActResult) {
  return {
    records: result.records.map(recordItem),
    threads: result.threads.map(threadState),
  };
}

export function registerTriageTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "take_triage_batch",
    {
      title: "Take threads to sort",
      description:
        "Takes the next threads in the triage queue, oldest first, each with its newest message, which is usually " +
        "enough to decide. Usual Mail's own AI categorizes and summarizes mail by itself; the queue holds only the " +
        "threads in category unknown that nobody has decided and that its AI won't process: the AI isn't working " +
        "(get_ai_status), or they are older than its history window. Screened threads are never in it. Decide every thread in the batch with " +
        "sort_threads, then take the next batch. When it returns none, the work is done: stop. Threads stay in the " +
        `queue until they are decided, so taking a batch twice returns the same threads. ${DATA_NOTICE}`,
      inputSchema: z.object({
        inboxId: id("Only this inbox. Leave out for all of this agent's inboxes.").optional(),
        limit: limit(10, 25),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ inboxId, limit: count }) => {
      const items = await service.triageQueue(caller, { ...(inboxId ? { inboxId } : {}), limit: count ?? 10 });
      if (items.length === 0) {
        return toolResult({ lead: "Nothing waits to be sorted.", next: "The triage work is done. Stop here." });
      }
      return toolResult({
        lead: `${items.length} thread${items.length === 1 ? "" : "s"} to sort, oldest first.`,
        data: items.map((item) => ({ ...threadSummary(item.thread), latest: messageItem(item.latest, TEXT_LIMITS.triage) })),
        next:
          "Next: decide each with sort_threads: its category, whether it is done, what it needs from the person, and " +
          "one line of reason. read_thread shows the whole thread when the newest message isn't enough.",
      });
    }),
  );

  server.registerTool(
    "sort_threads",
    {
      title: "Sort threads",
      description:
        "Decides the category of threads from the triage queue, one decision per thread, each with a reason the " +
        `person will read in Handled. ${CATEGORY_NOTE} \`done\` true means the person needn't see it in Home. ` +
        "`need` says what the thread asks of the person. A category lets no sender in: a screened thread stays " +
        "screened. Follow the inbox's guide. Use only thread ids from take_triage_batch or other Usual Mail " +
        `results. ${PROPOSED_NOTE}`,
      inputSchema: z.object({
        decisions: z
          .array(
            z.object({
              threadId: id("The thread, from take_triage_batch."),
              category: z.enum(DECIDED_CATEGORIES),
              done: z.boolean().optional().describe("True when the person needn't see it in Home."),
              need: z.enum(["reply", "decide", "pay", "read"]).optional().describe("What it asks of the person."),
              reason: z
                .string()
                .min(1)
                .max(200)
                .describe("One plain line the person reads, for example \"Receipt from a shop you buy from\"."),
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: WRITES,
    },
    guard(async ({ decisions }) => {
      const result = await service.decide(caller, decisions);
      return toolResult({ lead: actLead("Sorted", result), data: [actData(result)], next: PROPOSED_NOTE });
    }),
  );
}
