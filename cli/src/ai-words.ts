// The server's AI in words: its services, its states and what to do about each, and what leaves the server when a
// person saves a key (docs/contract-ai.md, "What leaves the server"), which must be shown before it is saved.

import { aiServiceName, type AiConnection, type AiDisclosure, type AiJob, type AiSettings, type AiState, type AiStatus, type FirstSyncWindow } from "@usualmail/core";

/** "Vercel's AI Gateway", "OpenAI", "Anthropic": core's names. */
export function serviceName(connection: AiConnection | undefined): string {
  return connection ? aiServiceName(connection) : "no service";
}

export const STATE_WORDS: Record<AiState, string> = {
  not_set_up: "not set up",
  paused: "paused",
  working: "working",
  key_refused: "key refused",
  model_not_found: "model not found",
  out_of_credit: "out of credit",
  unavailable: "unavailable",
};

/** States that stop processing until a person acts (or an hour passes): what needs you. */
export const NEEDS_PERSON_STATES: readonly AiState[] = ["key_refused", "model_not_found", "out_of_credit"];

/**
 * Text a service or the server wrote, without control characters, so it can't move the terminal's cursor or change
 * its colours when printed.
 */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

/** The model a job uses: the person's choice, or the server's default. */
export function modelOf(settings: AiSettings, job: AiJob): string {
  const setting = settings.jobs.find((item) => item.job === job);
  return setting?.model ?? setting?.defaultModel ?? "";
}

/** "example/text-small-2 (the server's default is example/text-small-1)" or "example/decision-1 (the server's default)". */
export function modelWords(settings: AiSettings, job: AiJob): string {
  const setting = settings.jobs.find((item) => item.job === job);
  if (!setting) return "unknown";
  if (setting.model === null) return setting.defaultModel ? `${setting.defaultModel} (the server's default)` : "the server's default";
  return setting.defaultModel ? `${setting.model} (the server's default is ${setting.defaultModel})` : setting.model;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why the AI isn't categorizing or summarizing, and what to do, by its state. `settings` is absent for an agent's
 * token (the settings are a person's).
 */
export function explainStatus(status: AiStatus, settings: AiSettings | undefined): { why?: string; fix?: string } {
  const service = settings?.connection ? serviceName(settings.connection) : "The AI service";
  const said = status.detail ? ` It said: ${plain(status.detail)}` : "";
  switch (status.state) {
    case "not_set_up":
      return {
        why: "No AI key is set, so the server doesn't categorize or summarize mail: new mail stays not sorted yet, in Home, with its snippet in place of a summary.",
        fix: "Set a key with `usual-mail ai set`.",
      };
    case "paused":
      return {
        why: `You paused it: nothing is sent to ${service === "The AI service" ? "the AI service" : service}, and new mail stays not sorted yet, without a summary, in Home.`,
        fix: "`usual-mail ai resume` carries on.",
      };
    case "working":
      return {};
    case "key_refused":
      return {
        why: `${service} refused the key, so nothing is categorized or summarized until you change the settings or test it, or an hour passes and the server tries once more.${said}`,
        fix: "Set a new key with `usual-mail ai set`; `usual-mail ai test` tries the stored one again.",
      };
    case "model_not_found": {
      const job = status.job;
      const model = job && settings ? ` (${modelOf(settings, job)})` : "";
      return {
        why: `${service} doesn't know the model ${job ? `for ${job}` : "of a job"}${model}, so nothing is processed until you change it or test again.${said}`,
        fix: job
          ? `\`usual-mail ai models --${job} <model>\` picks another; \`usual-mail ai models --${job} default\` goes back to the server's default.`
          : "`usual-mail ai models` shows each job's model and lets you change it.",
      };
    }
    case "out_of_credit":
      return {
        why: `The account at ${service === "The AI service" ? "the AI service" : service} has no credit left or reached its limit, so nothing is processed until it has.${said}`,
        fix: "Add credit or raise the limit there, then run `usual-mail ai test`.",
      };
    case "unavailable":
      return {
        why: `${service} couldn't be reached or kept failing. This usually passes by itself: the server tries again, from a minute up to 15 minutes apart.${said}`,
        fix: "`usual-mail ai test` tries now.",
      };
  }
}

/** "1 thread waits to be categorized or summarized", or "held up" when the AI isn't working. */
export function pendingWords(status: AiStatus): string {
  if (status.pending === 0) return "nothing waits to be categorized or summarized";
  const verb = status.pending === 1 ? "waits" : "wait";
  return status.state === "working"
    ? `${count(status.pending, "thread")} ${verb} to be categorized or summarized`
    : `${count(status.pending, "thread")} ${verb} to be categorized or summarized, held up while it isn't working`;
}

/** What the AI works through: all synced mail that isn't done, newest first, and how far back the first sync goes. */
export function reachWords(window: FirstSyncWindow): string {
  const days = count(window.days, "day");
  const how = window.changeable
    ? "`usual-mail sync-days` changes it"
    : window.setBy === "environment" ? "USUAL_MAIL_SYNC_DAYS sets it where the server starts" : "this server can't change it";
  return `all synced mail that isn't done, newest first; a new inbox's first sync takes the last ${days} (${how})`;
}

/** Text wrapped to lines of at most `width` characters, each line after the first indented by `indent`. */
function wrap(text: string, width: number, indent = ""): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = `${indent}${word}`;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * What saving a key sends out of the server, for every inbox now and later, to which service, and that the service's
 * own terms then apply: the server's words (`GET /v1/ai/disclosure`, built by core's `aiDisclosure`), wrapped for a
 * terminal and otherwise unchanged. Shown before the key is saved, as docs/contract-ai.md requires.
 */
export function disclosureLines(words: AiDisclosure): string[] {
  return [
    ...wrap(words.destination, 112),
    words.terms,
    "",
    words.lead,
    ...words.sent.flatMap((item) => wrap(`  ${item.label}: ${item.words}`, 112, "    ")),
    "",
    words.history,
  ];
}
