// The server's AI: whether it works and why not, what it works through (all synced mail that isn't done; how far
// back that goes is the first sync's window), the key (a form that never shows it, with what saving it sends and to
// whom shown first: the person's consent, for every inbox), the model for each job with the server's default, pause,
// and Test. There is no per-inbox switch and no history setting.
import type { AiConnection, AiDisclosure, AiSettings, AiStatus, FirstSyncWindow, Inbox } from "@usualmail/core";
import { AI_JOBS } from "@usualmail/core";
import { flag, html, type Html } from "../html.ts";
import { disclosure, JOB_NAMES, reachWords, SERVICE_CHOICES, serviceKey, serviceName, STATE_NAMES, stateWords, waitingWords } from "../view/ai.ts";
import { alert, href, icon, notice, page, pageHead, postForm, type View } from "../view/layout.ts";
import { hidden, textField } from "../view/parts.ts";
import { count, fullTime } from "../view/words.ts";

export interface AiPageData {
  settings: AiSettings;
  status: AiStatus;
  inboxes: Inbox[];
  /** The server's words for the service the key form is for (`GET /v1/ai/disclosure`). */
  words: AiDisclosure;
  /** How many days of mail a new inbox's first sync takes (`GET /v1/first-sync`). */
  firstSync: FirstSyncWindow;
}

export interface AiPageOptions {
  done?: string;
  /** The service the key form is for (`gateway:vercel`): its words are shown above the key. Default: the one set. */
  service?: string;
  error?: string;
  /** What went wrong with the key form, shown inside it. The key itself is never kept. */
  keyError?: string;
  /** What went wrong with the models form, and what was typed there. */
  models?: { values: Partial<Record<string, string>>; error: string };
}

function statusSection(view: View, data: AiPageData): Html {
  const { settings, status } = data;
  const why = stateWords(status, settings);
  const stateClass = status.state === "working" ? "status-ok" : status.state === "not_set_up" || status.state === "paused" ? "" : "status-attention";
  return html`<section class="card" aria-labelledby="ai-status-title">
<h2 id="ai-status-title">Status</h2>
<dl class="facts">
<div><dt>State</dt><dd class="${stateClass}">${STATE_NAMES[status.state] ?? status.state}</dd></div>
<div><dt>Last run</dt><dd>${status.lastRunAt ? fullTime(status.lastRunAt) : "Never"}</dd></div>
<div><dt>Waiting</dt><dd>${waitingWords(status.pending)}</dd></div>
</dl>
<p>${reachWords(data.firstSync)}</p>
${why ? html`<p>${why}</p>` : ""}
${status.detail ? html`<p class="hat-attention">It said: ${status.detail}</p>` : ""}
<p class="note">Once a key is set, the server processes every inbox's mail, those you connect later too.</p>
${settings.credentialsSet
  ? html`<div class="actions">
${postForm(view, "/ai/test", html`<button class="button" type="submit">Test now</button>`, "inline-form")}
${postForm(
  view,
  "/ai/pause",
  html`<input type="hidden" name="paused" value="${settings.paused ? "no" : "yes"}"><button class="button" type="submit">${settings.paused ? "Resume" : "Pause"}</button>`,
  "inline-form",
)}
</div>
<p class="hint">Test sends one small request per job's model, with no mail in it. ${settings.paused
    ? "Paused: nothing is sent for any inbox until you resume."
    : "Pause stops all processing, for every inbox, until you resume."}</p>`
  : ""}
</section>`;
}

/** The service the key form is for: the one asked for, else the one set, else the first. */
export function chosenService(settings: AiSettings, asked: string | undefined): [string, string, AiConnection] {
  return SERVICE_CHOICES.find(([value]) => value === asked)
    ?? SERVICE_CHOICES.find(([value]) => value === serviceKey(settings.connection))
    ?? SERVICE_CHOICES[0]!;
}

function keySection(view: View, settings: AiSettings, words: AiDisclosure, o: { service?: string; error?: string }): Html {
  const [value, , connection] = chosenService(settings, o.service);
  const name = serviceName(connection);
  return html`<section class="card" aria-labelledby="ai-key-title">
<h2 id="ai-key-title">Connection</h2>
<dl class="facts"><div><dt>Service</dt><dd>${settings.credentialsSet ? `${serviceName(settings.connection)}, key set` : "No key is set"}</dd></div></dl>
<nav class="chips" aria-label="Which service the key is for">${SERVICE_CHOICES.map(
    ([key, label]) => html`<a class="chip-all" href="${href(view, `/ai?service=${key}`)}"${key === value ? html` aria-current="page"` : ""}>${label.split(":")[0]}</a>`,
  )}</nav>
<p class="note">Saving a key is your yes to the mail of every inbox going to that service. Read what is sent first. A key for another service puts each job back on the server's default model; a new key for the same service keeps the models you chose.</p>
${disclosure(words)}
${o.error ? alert(view, "error", o.error) : ""}
${postForm(
  view,
  "/ai/key",
  html`${hidden("service", value)}
${textField({
  id: "ai-key",
  name: "apiKey",
  label: settings.credentialsSet ? "New API key" : "API key",
  type: "password",
  required: true,
  autocomplete: "off",
  hint: "Sent to this server once, which stores it sealed. It is never shown again, here or anywhere.",
})}
<div class="actions"><button class="button primary" type="submit">Save the key and send every inbox's mail to ${name}</button></div>
<p class="hint">The server tests the key at once, with no mail in it.</p>`,
  "form",
)}
${settings.credentialsSet
  ? html`<p class="note">Removing the key stops all processing. You'll be asked to confirm.</p>
<div class="actions"><a class="button danger" href="${href(view, "/ai/remove")}">${icon(view, "trash")}Remove the key</a></div>`
  : ""}
</section>`;
}

function modelsSection(view: View, settings: AiSettings, o?: AiPageOptions["models"]): Html {
  return html`<section class="card" aria-labelledby="ai-models-title">
<h2 id="ai-models-title">Models</h2>
<p class="note">Each job uses the model you choose, or the server's default for ${serviceName(settings.connection)}. Use the service's own model id${settings.connection?.kind === "gateway" ? " (provider/model through the gateway)" : ""}. A new model is tested at once.</p>
${o?.error ? alert(view, "error", o.error) : ""}
${postForm(
  view,
  "/ai/models",
  html`${AI_JOBS.map((job) => {
    const setting = settings.jobs.find((item) => item.job === job);
    return textField({
      id: `ai-model-${job}`,
      name: job,
      label: JOB_NAMES[job],
      value: o?.values[job] ?? setting?.model ?? "",
      autocomplete: "off",
      hint: setting?.defaultModel ? `Empty uses the server's default: ${setting.defaultModel}.` : "Empty uses the server's default.",
      maxlength: 200,
    });
  })}
<div class="actions"><button class="button primary" type="submit">Save models</button></div>`,
  "form",
)}
</section>`;
}

export function aiPage(view: View, data: AiPageData, o: AiPageOptions = {}): Html {
  return page(view, {
    title: "AI",
    section: "ai",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "Usual Mail's AI",
      lede: "The server categorizes and summarizes every inbox's mail itself, with your own AI key. Every device shows what it wrote.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${statusSection(view, data)}
${keySection(view, data.settings, data.words, { ...(o.service !== undefined && { service: o.service }), ...(o.keyError !== undefined && { error: o.keyError }) })}
${data.settings.credentialsSet ? modelsSection(view, data.settings, o.models) : ""}
`,
  });
}

/** Asks before removing the AI key: what it does, and the button that does it. */
export function removeKeyPage(view: View, data: Pick<AiPageData, "settings" | "inboxes">, error?: string): Html {
  return page(view, {
    title: "Remove the AI key",
    section: "ai",
    signedIn: true,
    narrow: true,
    body: html`${pageHead(view, { title: "Remove the AI key?", back: { path: "/ai", label: "AI" } })}
${error ? alert(view, "error", error) : ""}
<div class="card prose">
<p>Removing the key stops all processing: nothing more of any inbox's mail is sent to ${serviceName(data.settings.connection)}. Threads keep the categories and summaries they have, and new mail stays not sorted yet, in Home.</p>
<p>This server forgets the key. It remembers the service and the models you chose, so a new key for the same service keeps them. To use AI again, set a key again.</p>
<p>To stop sending for a while instead, pause the AI.</p>
${postForm(
  view,
  "/ai/remove",
  html`<div class="actions"><button class="button danger large" type="submit">${icon(view, "trash")}Remove the key</button><a class="button large" href="${href(view, "/ai")}">Keep it</a></div>`,
)}
</div>`,
  });
}
