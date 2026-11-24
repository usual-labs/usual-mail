// Reads the command line, runs one command, and turns failures into a message and an exit code.

import { helpFor, parseInput, type Command } from "./command.ts";
import { agentAdd, agentList, agentRemove } from "./commands/agent.ts";
import { aiModels, aiPause, aiRemove, aiResume, aiStatus, aiTest } from "./commands/ai.ts";
import { aiSet } from "./commands/ai-set.ts";
import { devicesList, devicesRevoke, pair } from "./commands/devices.ts";
import { doctor } from "./commands/doctor.ts";
import { googlePrompt, googleSet, googleStatus } from "./commands/google.ts";
import { inboxAdd } from "./commands/inbox-add.ts";
import { inboxIcon, inboxMove } from "./commands/inbox-ai.ts";
import { inboxReconnect } from "./commands/inbox-reconnect.ts";
import { inboxList, inboxPause, inboxRemove, inboxResume, inboxSync } from "./commands/inbox.ts";
import { init } from "./commands/init.ts";
import { logs, start, status, stop } from "./commands/server.ts";
import { syncDaysCommand } from "./commands/sync-days.ts";
import type { Context } from "./context.ts";
import { Failure } from "./errors.ts";
import { VERSION } from "./version.ts";

const SECTIONS: Array<[string, Command[]]> = [
  ["Your server", [init, start, stop, status, logs, doctor, syncDaysCommand]],
  ["Apps and agents", [pair, agentAdd, agentList, agentRemove, devicesList, devicesRevoke]],
  ["Inboxes", [inboxAdd, inboxList, inboxReconnect, inboxIcon, inboxMove, inboxSync, inboxPause, inboxResume, inboxRemove]],
  ["The server's AI", [aiStatus, aiSet, aiModels, aiTest, aiPause, aiResume, aiRemove]],
  ["Signing in with Google, for Gmail", [googleStatus, googleSet, googlePrompt]],
];

export const COMMANDS: Command[] = SECTIONS.flatMap(([, commands]) => commands);

/** Commands that are gone, with the one line that says what to use instead. They exit with 2, as a usage error does. */
const RETIRED: Record<string, string> = {
  "ai history":
    "`usual-mail ai history` is gone: the server's AI works through all the mail it has synced that isn't done, newest " +
    "first. How far back that goes is the first sync's window: `usual-mail sync-days`.",
};

/** A group's name alone runs this command. */
const DEFAULTS: Record<string, Command> = { inbox: inboxList, agent: agentList, devices: devicesList, ai: aiStatus };

export function overview(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  const sections = SECTIONS.map(
    ([title, commands]) =>
      `${title}:\n${commands.map((command) => `  usual-mail ${command.name.padEnd(width)}${command.summary}`).join("\n")}`,
  );
  return `usual-mail ${VERSION}: run your own Usual Mail server, then connect your apps, your agent and your inboxes.

${sections.join("\n\n")}

\`usual-mail <command> --help\` says more about a command. --json makes most commands print JSON.
USUAL_MAIL_SERVER and USUAL_MAIL_TOKEN, when set, are used instead of the saved server and token.
`;
}

/** The command the words name, and the words after it. */
function find(argv: string[]): { command: Command; rest: string[] } | null {
  const [first = "", second = ""] = argv;
  const two = COMMANDS.find((command) => command.name === `${first} ${second}`);
  if (two) return { command: two, rest: argv.slice(2) };
  const one = COMMANDS.find((command) => command.name === first) ?? DEFAULTS[first];
  if (!one) return null;
  // `usual-mail inbox frob` names no command; `usual-mail inbox --json` is the group's default.
  if (DEFAULTS[first] && second && !second.startsWith("-")) return null;
  return { command: one, rest: argv.slice(1) };
}

/** Runs the command line and returns the exit code. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  const [first] = argv;
  if (!first || first === "--help" || first === "-h") return out(ctx, overview());
  if (first === "--version" || first === "version") return out(ctx, `usual-mail ${VERSION}\n`);
  if (first === "help") {
    const found = argv.length > 1 ? find(argv.slice(1)) : null;
    return out(ctx, found ? helpFor(found.command) : overview());
  }
  const retired = RETIRED[argv.slice(0, 2).join(" ")];
  if (retired) {
    ctx.stderr.write(`${retired}\n`);
    return 2;
  }
  const found = find(argv);
  if (!found) {
    // Only words that look like command names are repeated: a mistyped line could hold a key or a password.
    const words = argv
      .filter((word) => !word.startsWith("-"))
      .slice(0, 2)
      .map((word) => (/^[a-z][a-z-]{0,23}$/.test(word) ? word : "…"))
      .join(" ");
    ctx.stderr.write(`Unknown command: usual-mail ${words}. \`usual-mail --help\` lists the commands.\n`);
    return 2;
  }
  const json = found.rest.includes("--json");
  try {
    const input = parseInput(found.command, found.rest);
    if (input.values.help) return out(ctx, helpFor(found.command));
    // With --json nothing is asked, even in a terminal, so questions never mix with the JSON on standard output.
    await found.command.run(json ? { ...ctx, interactive: false, json: true } : ctx, input);
    return 0;
  } catch (error) {
    return report(ctx, error, json);
  }
}

function out(ctx: Context, text: string): number {
  ctx.stdout.write(text);
  return 0;
}

/** Prints a failure on standard error: a sentence, or with --json `{ "error": { "code", "message" } }`. */
function report(ctx: Context, error: unknown, json: boolean): number {
  if (error instanceof Failure) {
    if (error.message) {
      const body = { code: error.code, message: error.message, ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) };
      ctx.stderr.write(json ? `${JSON.stringify({ error: body })}\n` : `${error.message}\n`);
    }
    return error.exitCode;
  }
  const message = `Something went wrong: ${(error as Error)?.message ?? String(error)}`;
  ctx.stderr.write(json ? `${JSON.stringify({ error: { code: "internal", message } })}\n` : `${message}\n`);
  if (ctx.env.USUAL_MAIL_DEBUG && error instanceof Error && error.stack) ctx.stderr.write(`${error.stack}\n`);
  return 1;
}
