/**
 * Usual Mail's own AI, as an agent may see it: its status, which anyone may read. Never its settings (the service,
 * the models, history days), which are a person's, and never anything about the key.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { AiState } from "@usualmail/core";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { guard, READ_ONLY, type ToolContext } from "./shared.ts";

const WAITS = "Meanwhile its unknown threads wait in take_triage_batch's queue, for you to sort.";

/** Fixed words for each state, chosen by the state: nothing the server or the AI service wrote goes outside the block. */
const STATE_WORDS: Record<AiState, { lead: string; next: string }> = {
  working: {
    lead: "Usual Mail's AI is working.",
    next:
      "It categorizes and summarizes every inbox's new mail. You sort only take_triage_batch's queue: threads " +
      "older than its history window, and those whose answer it dropped.",
  },
  not_set_up: { lead: "Usual Mail's AI is not set up: the person hasn't given it a key.", next: WAITS },
  paused: { lead: "Usual Mail's AI is paused by the person: it sends nothing.", next: WAITS },
  key_refused: {
    lead: "Usual Mail's AI is stopped: its service refused the person's key.",
    next: `Only the person can fix this, in Usual Mail; tell them if it matters. ${WAITS}`,
  },
  model_not_found: {
    lead: "Usual Mail's AI is stopped: its service doesn't know the model of one job (job says which).",
    next: `Only the person can fix this, in Usual Mail; tell them if it matters. ${WAITS}`,
  },
  out_of_credit: {
    lead: "Usual Mail's AI is stopped: the person's AI account has no credit left or reached its limit.",
    next: `Only the person can fix this, at their AI service; tell them if it matters. ${WAITS}`,
  },
  unavailable: {
    lead: "Usual Mail's AI can't reach its service for now. This usually passes by itself.",
    next: WAITS,
  },
};

export function registerAiTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "get_ai_status",
    {
      title: "Usual Mail's AI status",
      description:
        "Says whether Usual Mail's own AI works. It categorizes and summarizes mail itself, with the person's AI " +
        "account, for every inbox. Gives its state, which job's model its service " +
        "doesn't know (with model_not_found), when it last processed a thread, and how many threads wait for it " +
        "(pending): it works through all the mail the server has synced that isn't done, newest first. States: working; " +
        "not_set_up (no key); paused (the person paused it); key_refused, model_not_found and out_of_credit (only " +
        "the person can fix them); unavailable (its service is failing for a while, which usually passes). While " +
        "it isn't working, unknown threads wait in take_triage_batch's queue. Its settings and key are the " +
        `person's: this connector never shows them. ${DATA_NOTICE}`,
      annotations: READ_ONLY,
    },
    guard(async () => {
      const status = await service.aiStatus(caller);
      const words = STATE_WORDS[status.state] ?? { lead: "Usual Mail's AI reported a state this connector doesn't know.", next: WAITS };
      return toolResult({
        lead: words.lead,
        // `detail` is left out: it is the AI service's own message, which can repeat part of the person's key.
        data: [
          {
            state: status.state,
            ...(status.job ? { job: status.job } : {}),
            ...(status.lastRunAt ? { lastRunAt: status.lastRunAt } : {}),
            pending: status.pending,
          },
        ],
        next: words.next,
      });
    }),
  );
}
