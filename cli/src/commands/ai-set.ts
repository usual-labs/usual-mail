// `usual-mail ai set`: the key the server's AI uses, for a gateway or one provider. Saving a key is the person's yes to
// every inbox's mail, now and later, going to that service, so the command first shows what is sent and to whom, and
// asks (or takes --yes); only then is the key asked unseen or read from standard input, sent to the server once in
// `PATCH /v1/ai`, and never echoed, stored or logged here (docs/contract-ai.md, "Jobs and settings").

import { AI_GATEWAYS, AI_PROVIDERS, type AiConnection, type AiCredentials, type AiDisclosure, type AiSettings } from "@usualmail/core";
import { disclosureLines, serviceName } from "../ai-words.ts";
import { clientFor } from "../client.ts";
import { flag, noQuestions, text, type Command, type Values } from "../command.ts";
import { printJson, say, type Context } from "../context.ts";
import { Failure, UsageError } from "../errors.ts";
import { askSecret, choose, confirm } from "../prompt.ts";
import { withoutSecrets } from "./credentials.ts";
import { loadAi, printStatus } from "./ai.ts";

const CHOICES: Array<{ label: string; value: AiConnection }> = [
  { label: "Vercel's AI Gateway: one key reaches several companies' models", value: { kind: "gateway", gateway: "vercel" } },
  { label: "OpenAI: OpenAI's own key", value: { kind: "direct", provider: "openai" } },
  { label: "Anthropic: Anthropic's own key", value: { kind: "direct", provider: "anthropic" } },
];

export const aiSet: Command = {
  name: "ai set",
  summary: "give the server the AI key it uses, for every inbox's mail (shows what is sent and asks first)",
  usage: "usual-mail ai set [--gateway vercel | --provider openai|anthropic] [--key-stdin] [--yes] [--json]",
  details: `
--gateway vercel              a key for Vercel's AI Gateway, which reaches several companies' models
--provider openai|anthropic   a key for one provider's own models
--key-stdin                   read the key from standard input (its first line) instead of asking
--yes                         save it without asking; needed without a terminal. What is sent and to whom is
                              shown anyway
--json                        print { settings, status } afterwards (the words go to standard error)

Saving a key sends the mail of every inbox connected to the server, now and later, to that service: there is no
switch per inbox. So the command first shows exactly what is sent, to which service, and that the service's own
terms then apply, and asks. In a terminal it asks which service the key is for, shows those words, asks for your
yes, then asks for the key, which isn't shown while you type it.
The key is sent to your server once, which stores it sealed; this command never shows, stores or logs it, and
never takes it from the command line, where other users of this machine could see it. The server tests it at once
with one small request per job, with no mail in it, and the status afterwards says how that went.

A new key for the same service keeps the models you chose; a key for another service shows that service's words
and puts each job back on the server's default model. \`usual-mail ai pause\` stops sending for a while;
\`usual-mail ai remove\` removes the key.

Example without a terminal:
  printf '%s\\n' "$AI_KEY" | usual-mail ai set --gateway vercel --key-stdin --yes`,
  options: {
    gateway: { type: "string" },
    provider: { type: "string" },
    "key-stdin": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    json: { type: "boolean" },
  },
  // Words after the command are refused in `run`, without repeating them: one of them could be the key.
  maxPositionals: Number.MAX_SAFE_INTEGER,
  async run(ctx, { values, positionals }) {
    if (positionals.length) {
      throw new UsageError(
        "`usual-mail ai set` takes no words after it. The key is never taken from the command line, where other users of " +
          "this machine can see it: it is asked unseen, or read from standard input with --key-stdin.",
      );
    }
    const given = connectionFrom(values);
    if (!ctx.interactive) {
      const missing = [given ? "" : "--gateway vercel or --provider openai|anthropic", flag(values, "key-stdin") ? "" : "--key-stdin"].filter(Boolean);
      if (missing.length) {
        if (!flag(values, "yes")) missing.push("--yes");
        throw new Failure(`${noQuestions(ctx)} Pass ${andList(missing)}. \`usual-mail ai set --help\` shows an example.`, "not_a_terminal");
      }
    }
    const client = clientFor(ctx);
    const before = await client.call<AiSettings>("aiSettings");
    const prompter = ctx.interactive ? ctx.prompter() : null;
    let connection: AiConnection;
    let key: string;
    try {
      if (prompter) say(ctx, "The key is sent to your server once, which stores it sealed. This command never shows or stores it.");
      const current = CHOICES.findIndex((choice) => sameService(choice.value, before.connection));
      connection = given ?? (await choose(prompter!, (line) => ctx.stdout.write(line), "Which service is the key for?", CHOICES, Math.max(0, current)));
      // What saving the key sends, and to whom, in the server's words, before the key is typed or sent. On standard
      // error with --json.
      const words = await client.call<AiDisclosure>("aiDisclosure", { query: serviceQuery(connection) });
      const write = ctx.json ? (line: string) => ctx.stderr.write(`${line}\n`) : (line: string) => say(ctx, line);
      if (prompter) say(ctx);
      for (const line of disclosureLines(words)) write(line);
      if (!flag(values, "yes")) {
        if (!prompter) {
          throw new Failure(
            `${noQuestions(ctx)} Pass --yes to save the key and send every inbox's mail to ${serviceName(connection)}; what is sent and to whom is shown above.`,
            "not_a_terminal",
          );
        }
        say(ctx);
        if (!(await confirm(prompter, `Save a key for ${serviceName(connection)} and send every inbox's mail there?`, false))) {
          return say(ctx, "Nothing was changed.");
        }
      }
      key = flag(values, "key-stdin") || !prompter ? await keyFromStdin(ctx) : (await askSecret(prompter, `${serviceName(connection)} API key`)).trim();
    } finally {
      prompter?.close();
    }
    if (!key) throw new UsageError("The key is empty. Nothing was changed.");

    // Everything this command prints from here on has the key taken out, should the server or the service repeat it.
    const safe = redacting(ctx, key);
    const credentials = { ...connection, apiKey: key } as AiCredentials;
    let settings: AiSettings;
    try {
      settings = await client.call<AiSettings>("updateAiSettings", { body: { credentials }, timeoutMs: 120_000 });
    } catch (error) {
      throw withoutSecrets(error, [key]);
    }
    const view = await loadAi(client);
    if (flag(values, "json")) return printJson(safe, { settings, status: view.status });

    const service = serviceName(settings.connection ?? connection);
    say(safe, `Saved the key for ${service}. The server keeps it sealed; this command kept no copy.`);
    if (before.connection && !sameService(connection, before.connection)) {
      say(safe, `Moving from ${serviceName(before.connection)} to ${service} put each job back on the server's default model.`);
    } else if (before.connection) {
      say(safe, "A new key for the same service keeps the models you chose.");
    }
    say(safe, `From now on every inbox's mail goes to ${service}: new mail as it arrives, then all the synced mail that isn't done, newest first.`);
    say(safe);
    say(safe, "The server tested the key at once:");
    printStatus(safe, view);
  },
};

function connectionFrom(values: Values): AiConnection | undefined {
  const gateway = text(values, "gateway");
  const provider = text(values, "provider");
  if (gateway !== undefined && provider !== undefined) throw new UsageError("Pass --gateway or --provider, not both.");
  if (gateway !== undefined) {
    if (!(AI_GATEWAYS as readonly string[]).includes(gateway)) throw new UsageError(`--gateway takes ${AI_GATEWAYS.join(", ")}, not "${gateway}".`);
    return { kind: "gateway", gateway: gateway as (typeof AI_GATEWAYS)[number] };
  }
  if (provider !== undefined) {
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) throw new UsageError(`--provider takes ${AI_PROVIDERS.join(" or ")}, not "${provider}".`);
    return { kind: "direct", provider: provider as (typeof AI_PROVIDERS)[number] };
  }
  return undefined;
}

/** The disclosure route's query for a service: `gateway=vercel`, `provider=openai`. */
function serviceQuery(connection: AiConnection): Record<string, string> {
  return connection.kind === "gateway" ? { gateway: connection.gateway } : { provider: connection.provider };
}

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const sameService = (a: AiConnection, b: AiConnection | undefined) =>
  !!b && a.kind === b.kind && (a.kind === "gateway" ? a.gateway === (b as typeof a).gateway : a.provider === (b as typeof a).provider);

/** The key from standard input: its first line that isn't empty, without surrounding spaces. */
async function keyFromStdin(ctx: Context): Promise<string> {
  const line = (await ctx.readStdin()).split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) throw new UsageError("--key-stdin found nothing on standard input. Nothing was changed.");
  return line;
}

/** The same context, with `secret` replaced by ••• in everything it prints. */
function redacting(ctx: Context, secret: string): Context {
  const clean = (text: string) => text.split(secret).join("•••");
  return {
    ...ctx,
    stdout: { write: (text) => ctx.stdout.write(clean(text)) },
    stderr: { write: (text) => ctx.stderr.write(clean(text)) },
  };
}
