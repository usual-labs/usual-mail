// The server's AI in words (docs/contract-ai.md): its services, its states, and what leaves the server when a person
// saves a key, which an interface must show before the key is saved, with the service and its terms.
import { aiServiceName, type AiConnection, type AiDisclosure, type AiJob, type AiSettings, type AiState, type AiStatus, type FirstSyncWindow } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { count } from "./words.ts";


/** The choices for the key form: a gateway's key or one provider's own. The value names the connection. */
export const SERVICE_CHOICES: Array<[value: string, label: string, connection: AiConnection]> = [
  ["gateway:vercel", "Vercel's AI Gateway: one key reaches several companies' models", { kind: "gateway", gateway: "vercel" }],
  ["direct:openai", "OpenAI: OpenAI's own key", { kind: "direct", provider: "openai" }],
  ["direct:anthropic", "Anthropic: Anthropic's own key", { kind: "direct", provider: "anthropic" }],
];

/** "gateway:vercel", as the key form and the inbox's AI form name a connection. */
export const serviceKey = (connection: AiConnection | undefined): string =>
  connection ? (connection.kind === "gateway" ? `gateway:${connection.gateway}` : `direct:${connection.provider}`) : "";

/** "Vercel's AI Gateway", "OpenAI", "Anthropic": core's names. */
export function serviceName(connection: AiConnection | undefined): string {
  return connection ? aiServiceName(connection) : "no service";
}

export const JOB_NAMES: Record<AiJob, string> = { categorize: "Categorize", summarize: "Summarize" };

export const STATE_NAMES: Record<AiState, string> = {
  not_set_up: "Not set up",
  paused: "Paused",
  working: "Working",
  key_refused: "Key refused",
  model_not_found: "Model not found",
  out_of_credit: "Out of credit",
  unavailable: "Unavailable",
};

/** States that stop the AI until a person acts (or an hour passes): part of "what needs you". */
export const NEEDS_PERSON_STATES: readonly AiState[] = ["key_refused", "model_not_found", "out_of_credit"];

/** The model a job uses: the person's choice, or the server's default. */
export function modelOf(settings: AiSettings, job: AiJob): string {
  const setting = settings.jobs.find((item) => item.job === job);
  return setting?.model ?? setting?.defaultModel ?? "";
}

/** Why the AI isn't categorizing or summarizing, and what to do, in words. Nothing for a working AI. */
export function stateWords(status: AiStatus, settings?: AiSettings): string {
  const service = settings?.connection ? serviceName(settings.connection) : "The AI service";
  switch (status.state) {
    case "not_set_up":
      return "No AI key is set, so the server doesn't categorize or summarize mail. New mail stays not sorted yet, in Home, with its snippet in place of a summary.";
    case "paused":
      return "You paused it: nothing is sent for any inbox, and new mail stays not sorted yet, without a summary.";
    case "working":
      return "";
    case "key_refused":
      return `${service} refused the key. Nothing is categorized or summarized until you give a new key or test it again, or an hour passes and the server tries once more.`;
    case "model_not_found":
      return `${service} doesn't know the model for ${status.job ? JOB_NAMES[status.job].toLowerCase() : "a job"}. Nothing is processed until you choose another model or test again.`;
    case "out_of_credit":
      return `The account at ${service === "The AI service" ? "the AI service" : service} has no credit left or reached its limit. Add credit there, then test again.`;
    case "unavailable":
      return `${service} couldn't be reached or kept failing. This usually passes by itself: the server tries again, from a minute up to 15 minutes apart.`;
  }
}

/** "1 thread waits", "3 threads wait". */
export const waitingWords = (n: number) => `${count(n, "thread waits", "threads wait")}`;

/**
 * What the AI works through, in one line: all synced mail that isn't done, newest first. How much older mail there is
 * is decided only by the first sync's window (`GET /v1/first-sync`), so that is what the line names.
 */
export function reachWords(window: FirstSyncWindow): string {
  const reach = `The AI works through all the mail the server has synced that isn't done, newest first; a new inbox's first sync takes the last ${count(window.days, "day", "days")} of mail`;
  if (window.changeable) return `${reach} (\`usual-mail sync-days\` changes that).`;
  return window.setBy === "environment" ? `${reach} (USUAL_MAIL_SYNC_DAYS sets that where the server starts).` : `${reach}.`;
}

/**
 * Exactly what saving a key sends out of the server, for every inbox now and later, to which service, and that the
 * service's own terms then apply: the server's words (`aiDisclosure`, built by core's builder, as
 * `GET /v1/ai/disclosure` answers them), unchanged. Shown above the key field and its button.
 */
export function disclosure(words: AiDisclosure): Html {
  // The service stands out where the mail goes.
  const at = words.destination.indexOf(words.service);
  const destination = at < 0
    ? words.destination
    : html`${words.destination.slice(0, at)}<strong>${words.service}</strong>${words.destination.slice(at + words.service.length)}`;
  return html`<div class="disclosure">
<p>${destination} ${words.terms}</p>
<p>${words.lead}</p>
<ul class="sent">
${words.sent.map((item) => html`<li><b>${item.label}:</b> ${item.words}</li>`)}
</ul>
<p>${words.history}</p>
</div>`;
}
