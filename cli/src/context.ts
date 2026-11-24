// Everything the command touches outside itself: the environment, the terminal, the network, other programs and
// the clock. The real one is made in cli.ts; tests make their own with fakes and a scratch directory.

import type { Prompter } from "./prompt.ts";
import type { Runner } from "./runner.ts";

export interface Output {
  write(text: string): void;
}

export interface Context {
  env: Record<string, string | undefined>;
  stdout: Output;
  stderr: Output;
  /** True when a person can answer questions: standard input and output are both a terminal, and no --json. */
  interactive: boolean;
  /** True with --json: nothing is asked, so the JSON on standard output never mixes with questions. */
  json?: boolean;
  /** True when standard output is a terminal and colours are allowed (NO_COLOR is unset). */
  color: boolean;
  /** Asks a person. Only used when `interactive` is true. */
  prompter: () => Prompter;
  /** All of standard input, for `--secrets-stdin`. */
  readStdin: () => Promise<string>;
  fetch: typeof fetch;
  runner: Runner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  hostname: () => string;
  /** This machine's addresses other devices could use, for `doctor`'s reachability check. */
  networkAddresses: () => string[];
  /** The user and group to run the server's container as, so the data directory stays the person's own. */
  userIds: () => { uid: number; gid: number } | null;
  /** The file this command runs from, to find a checkout of Usual Mail around it. */
  cliFile: string;
  /** The Node.js that runs this command, used to run the server in Node mode. */
  nodePath: string;
}

export const say = (ctx: Context, text = "") => ctx.stdout.write(`${text}\n`);
export const warn = (ctx: Context, text: string) => ctx.stderr.write(`${text}\n`);
/** Progress while a command works. On standard error, so `--json` output stays clean. */
export const note = warn;
export const printJson = (ctx: Context, value: unknown) => ctx.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
