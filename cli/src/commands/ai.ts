// `usual-mail ai`: the server's own AI, which categorizes and summarizes mail with the person's own key. Its status,
// each job's model, pausing and testing. Setting the key is in ai-set.ts. There is no history setting: the AI works
// through all synced mail that isn't done, and how far back that goes is the first sync's window (`sync-days`).

import { AI_JOBS, type AiJob, type AiSettings, type AiStatus, type FirstSyncWindow, type Inbox } from "@usualmail/core";
import { explainStatus, modelWords, pendingWords, reachWords, serviceName, STATE_WORDS } from "../ai-words.ts";
import { clientFor, type Client } from "../client.ts";
import { flag, needTerminal, text, type Command } from "../command.ts";
import { printJson, say, type Context } from "../context.ts";
import { ApiError, explain, Failure, UsageError } from "../errors.ts";
import { table, utc } from "../format.ts";
import { confirm } from "../prompt.ts";

const json = { json: { type: "boolean" } } as const;

export interface AiView {
  status: AiStatus;
  /** Absent for an agent's token: the settings are a person's. */
  settings?: AiSettings;
  /** The first sync's window, a person's to read too; absent for an agent's token or a server from before it. */
  firstSync?: FirstSyncWindow;
  inboxes: Inbox[];
}

/** A person's own reading: undefined for an agent's token (`needs_person`). */
function personOnly<T>(read: Promise<T>): Promise<T | undefined> {
  return read.catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "needs_person") return undefined;
    throw error instanceof ApiError ? explain(error) : error;
  });
}

/** The AI's status, its settings and the first sync's window when the token is a person's, and the inboxes. */
export async function loadAi(client: Client): Promise<AiView> {
  const [status, settings, firstSync, inboxes] = await Promise.all([
    client.call<AiStatus>("aiStatus"),
    personOnly(client.raw<AiSettings>("aiSettings")),
    // A server from before the window's route answers 404: the status then leaves the line out.
    personOnly(client.raw<FirstSyncWindow>("firstSyncWindow")).catch(() => undefined),
    client.call<Inbox[]>("listInboxes"),
  ]);
  return { status, ...(settings ? { settings } : {}), ...(firstSync ? { firstSync } : {}), inboxes };
}

/** The settings, which only a person may read. An agent's token gets the contract's `needs_person`, explained. */
async function settingsOf(client: Client): Promise<AiSettings> {
  return client.call<AiSettings>("aiSettings");
}

/** The status in lines: the state, then the settings, the inboxes, the counts, and why it isn't working. */
export function printStatus(ctx: Context, view: AiView): void {
  const { status, settings, firstSync, inboxes } = view;
  const rows: string[][] = [];
  if (settings) {
    rows.push(["Connection", settings.credentialsSet ? `${serviceName(settings.connection)}, key set` : "none: no key is set"]);
    if (settings.credentialsSet) for (const job of AI_JOBS) rows.push([job[0]!.toUpperCase() + job.slice(1), modelWords(settings, job)]);
  }
  if (!inboxes.length) rows.push(["Inboxes", "none connected yet"]);
  rows.push(["Last run", utc(status.lastRunAt)]);
  rows.push(["Waiting", pendingWords(status)]);
  if (firstSync) rows.push(["Works on", reachWords(firstSync)]);
  say(ctx, `Usual Mail's AI: ${STATE_WORDS[status.state] ?? status.state}`);
  const width = Math.max(...rows.map(([label]) => label!.length)) + 2;
  for (const [label, value] of rows) say(ctx, `  ${label!.padEnd(width)}${value}`);
  const { why, fix } = explainStatus(status, settings);
  if (why) {
    say(ctx);
    say(ctx, why);
    if (fix) say(ctx, fix);
  }
}

export const aiStatus: Command = {
  name: "ai status",
  summary: "say whether the server's AI works and what waits",
  usage: "usual-mail ai status [--json]",
  details: `
--json   print { status, settings } as the server gives them (settings is null for an agent's token)

The server categorizes and summarizes every inbox's mail itself, with your own AI key: all the mail it has synced
that isn't done, newest first. This says whether it works and, when it doesn't, why there are no summaries and what
to do; which service and models it uses; how many threads wait to be categorized or summarized; and how far back the
synced mail goes (the first sync's window, which \`usual-mail sync-days\` changes). The key itself is never shown:
the server doesn't give it back.`,
  options: json,
  maxPositionals: 0,
  async run(ctx, { values }) {
    const view = await loadAi(clientFor(ctx));
    if (flag(values, "json")) return printJson(ctx, { status: view.status, settings: view.settings ?? null });
    printStatus(ctx, view);
  },
};

export const aiTest: Command = {
  name: "ai test",
  summary: "test the AI key and each job's model now",
  usage: "usual-mail ai test [--json]",
  details: `
--json   print the status that follows, as the server gives it

The server sends one small request per job's model, with no mail in it, and answers with the status that
follows. A refused key, a missing model or an empty account stop processing until you change the settings or
test again; this is how to try again after fixing the account.`,
  options: json,
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const status = await client.call<AiStatus>("testAi", { timeoutMs: 120_000 });
    if (flag(values, "json")) return printJson(ctx, status);
    say(ctx, "Sent one small request per job's model, with no mail in it.");
    printStatus(ctx, await loadAi(client));
  },
};

function pauseCommand(paused: boolean): Command {
  const name = paused ? "ai pause" : "ai resume";
  return {
    name,
    summary: paused ? "stop the AI: nothing is sent, for any inbox" : "let a paused AI carry on",
    usage: `usual-mail ${name} [--json]`,
    details: paused
      ? `
--json   print { settings, status } afterwards

While paused, nothing is sent to the AI service for any inbox. New mail stays not sorted yet, without a summary,
in Home. The key, the models and each inbox's AI switch stay as they are. \`usual-mail ai resume\` carries on.`
      : `
--json   print { settings, status } afterwards

The AI carries on where it stopped: new mail first, then history.`,
    options: json,
    maxPositionals: 0,
    async run(ctx, { values }) {
      const client = clientFor(ctx);
      const settings = await client.call<AiSettings>("updateAiSettings", { body: { paused } });
      const view = await loadAi(client);
      if (flag(values, "json")) return printJson(ctx, { settings, status: view.status });
      say(
        ctx,
        paused
          ? "Paused Usual Mail's AI. Nothing is sent to the AI service for any inbox until `usual-mail ai resume`."
          : "Resumed Usual Mail's AI.",
      );
      say(ctx);
      printStatus(ctx, view);
    },
  };
}

export const aiPause = pauseCommand(true);
export const aiResume = pauseCommand(false);

export const aiModels: Command = {
  name: "ai models",
  summary: "show or choose the model each AI job uses",
  usage: "usual-mail ai models [--categorize MODEL|default] [--summarize MODEL|default] [--json]",
  details: `
Without flags, shows each job's model and the server's default for it.

--categorize MODEL   the model that sets each thread's category
--summarize MODEL    the model that writes each thread's summary
                     MODEL is the service's own id: provider/model through Vercel's AI Gateway, or the provider's
                     own id with its own key. "default" goes back to the server's default.
--json               print { settings, status }

The server tests a new model at once; the status afterwards says whether the service knows it.`,
  options: { categorize: { type: "string" }, summarize: { type: "string" }, ...json },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const models: Partial<Record<AiJob, string | null>> = {};
    for (const job of AI_JOBS) {
      const given = text(values, job);
      if (given === undefined) continue;
      const model = given.trim();
      if (!model || /\s/.test(model)) throw new UsageError(`--${job} takes a model id without spaces, or "default".`);
      models[job] = model === "default" ? null : model;
    }
    if (!Object.keys(models).length) {
      const settings = await settingsOf(client);
      if (flag(values, "json")) return printJson(ctx, { settings, status: await client.call<AiStatus>("aiStatus") });
      if (!settings.credentialsSet) say(ctx, "No AI key is set yet; `usual-mail ai set` sets one. The defaults depend on the service.");
      else say(ctx, `Through ${serviceName(settings.connection)}:`);
      ctx.stdout.write(table(["JOB", "MODEL"], AI_JOBS.map((job) => [job, modelWords(settings, job)])));
      return say(ctx, "`usual-mail ai models --<job> <model>` changes one; `--<job> default` goes back to the server's default.");
    }
    const settings = await client.call<AiSettings>("updateAiSettings", { body: { models }, timeoutMs: 120_000 });
    const view = await loadAi(client);
    if (flag(values, "json")) return printJson(ctx, { settings, status: view.status });
    for (const job of Object.keys(models) as AiJob[]) say(ctx, `${job[0]!.toUpperCase()}${job.slice(1)} now uses ${modelWords(settings, job)}.`);
    if (settings.credentialsSet) say(ctx, "The server tested it at once:");
    say(ctx);
    printStatus(ctx, view);
  },
};

export const aiRemove: Command = {
  name: "ai remove",
  summary: "remove the AI key: nothing more is sent, for any inbox (asks first)",
  usage: "usual-mail ai remove [--yes] [--json]",
  details: `
--yes    remove it without asking; needed without a terminal
--json   print { settings, status } afterwards

Removing the key is setting the server's AI credentials to nothing. It stops all processing: nothing more of any
inbox's mail is sent to the AI service, threads keep the categories and summaries they have, and new mail stays
not sorted yet, in Home. The server forgets the key; it remembers the service and the models you chose, so a new
key for the same service keeps them. To use AI again, set a key with \`usual-mail ai set\`. To stop sending for a
while instead, \`usual-mail ai pause\`.`,
  options: { yes: { type: "boolean", short: "y" }, ...json },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const settings = await settingsOf(client);
    if (!settings.credentialsSet) {
      if (flag(values, "json")) return printJson(ctx, { settings, status: await client.call<AiStatus>("aiStatus") });
      return say(ctx, "No AI key is set, so there is nothing to remove.");
    }
    const out = flag(values, "json") ? (line: string) => ctx.stderr.write(`${line}\n`) : (line: string) => say(ctx, line);
    out(
      `Removing the AI key stops all processing: nothing more of any inbox's mail is sent to ${serviceName(settings.connection)}. ` +
        "Threads keep the categories and summaries they have, and new mail stays not sorted yet, in Home.",
    );
    if (!flag(values, "yes")) {
      needTerminal(ctx, "--yes to remove the AI key");
      const prompter = ctx.prompter();
      try {
        if (!(await confirm(prompter, "Remove the AI key?", false))) return say(ctx, "Nothing changed. The key is still set.");
      } finally {
        prompter.close();
      }
    }
    // Removing the key is setting the credentials to nothing (docs/contract-ai.md, "Jobs and settings").
    const removed = await client.call<AiSettings>("updateAiSettings", { body: { credentials: null } });
    const view = await loadAi(client);
    if (flag(values, "json")) return printJson(ctx, { settings: removed, status: view.status });
    say(ctx, "Removed the AI key. Nothing more is sent, for any inbox; `usual-mail ai set` sets a key again.");
    say(ctx);
    printStatus(ctx, view);
  },
};
