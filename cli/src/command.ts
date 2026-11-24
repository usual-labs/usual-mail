// What a command is, and reading its arguments.

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Context } from "./context.ts";
import { Failure, UsageError } from "./errors.ts";

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Input {
  values: Values;
  positionals: string[];
}

export interface Command {
  /** For example "inbox add". */
  name: string;
  /** One line for the list of commands. */
  summary: string;
  /** The command line, for example "usual-mail inbox sync <inbox>". */
  usage: string;
  /** More about it: what it does, its flags. Shown by --help. */
  details: string;
  options: ParseArgsOptionsConfig;
  /** At most this many words after the command. */
  maxPositionals: number;
  run(ctx: Context, input: Input): Promise<void>;
}

export function helpFor(command: Command): string {
  return `${command.usage}\n\n${command.summary[0]!.toUpperCase()}${command.summary.slice(1)}.\n\n${command.details.trim()}\n`;
}

export function parseInput(command: Command, argv: string[]): Input {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = (error as Error).message.replace(/\. To specify a positional argument.*$/s, ".");
    throw new UsageError(`${message} \`usual-mail ${command.name} --help\` lists what it takes.`);
  }
  if (!parsed.values.help && parsed.positionals.length > command.maxPositionals) {
    throw new UsageError(
      `Too many words after \`usual-mail ${command.name}\`: ${parsed.positionals.slice(command.maxPositionals).join(" ")}. ` +
        `\`usual-mail ${command.name} --help\` lists what it takes.`,
    );
  }
  return { values: parsed.values as Values, positionals: parsed.positionals };
}

export const text = (values: Values, key: string): string | undefined => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};

export const list = (values: Values, key: string): string[] => {
  const value = values[key];
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
};

export const flag = (values: Values, key: string): boolean => values[key] === true;

/** A port number from a flag, or the fallback. */
export function portFrom(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--port takes a whole number from 1 to 65535, not "${value}".`);
  }
  return port;
}

/** Why nothing can be asked: --json, or no terminal. The start of a sentence that goes on "Pass …". */
export const noQuestions = (ctx: Context) =>
  ctx.json ? "With --json nothing is asked, so every answer must come from a flag." : "This isn't a terminal, so nothing can be asked.";

/** Fails when a person would have to answer a question but can't. `needed` names the flags that answer it. */
export function needTerminal(ctx: Context, needed: string): void {
  if (!ctx.interactive) throw new Failure(`${noQuestions(ctx)} Pass ${needed}.`, "not_a_terminal");
}
