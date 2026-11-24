// Running the command in-process with a scratch home directory, a scripted terminal and fakes.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../src/context.ts";
import { main } from "../src/main.ts";
import type { Prompter } from "../src/prompt.ts";
import type { Runner } from "../src/runner.ts";

/** A scratch directory under the system's temporary folder, removed by `remove()`. */
export function scratch(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "usual-mail-cli-test-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A runner that fails loudly: commands that shouldn't run other programs get this. */
export const noRunner: Runner = {
  run: async (command, args) => {
    throw new Error(`Unexpected program: ${command} ${args.join(" ")}`);
  },
  pass: async (command, args) => {
    throw new Error(`Unexpected program: ${command} ${args.join(" ")}`);
  },
  startDetached: async (command) => {
    throw new Error(`Unexpected program: ${command}`);
  },
  isAlive: () => false,
  signal: () => {},
  commandLine: async () => null,
};

export interface Options {
  home: string;
  interactive?: boolean;
  /** Answers to questions, in order. Running out fails the test. */
  answers?: string[];
  stdin?: string;
  runner?: Runner;
  env?: Record<string, string>;
  cliFile?: string;
  networkAddresses?: string[];
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** Every question asked, with "(secret)" before the hidden ones. */
  questions: string[];
}

export function context(options: Options): { ctx: Context; stdout: string[]; stderr: string[]; questions: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const answer = (question: string) => {
    if (!answers.length) throw new Error(`No answer scripted for: ${question}`);
    return answers.shift()!;
  };
  const prompter: Prompter = {
    ask: async (question) => {
      questions.push(question);
      return answer(question);
    },
    secret: async (question) => {
      questions.push(`(secret) ${question}`);
      return answer(question);
    },
    close: () => {},
  };
  const home = options.home;
  // A clock that jumps forward when the command sleeps, so waiting for a file or a server takes no real time.
  let skipped = 0;
  const ctx: Context = {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ...options.env,
    },
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
    interactive: options.interactive ?? false,
    color: false,
    prompter: () => {
      if (!options.interactive) throw new Error("Asked a question without a terminal");
      return prompter;
    },
    readStdin: async () => options.stdin ?? "",
    fetch: globalThis.fetch,
    runner: options.runner ?? noRunner,
    now: () => Date.now() + skipped,
    sleep: (ms) => {
      skipped += ms;
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
    hostname: () => "test-machine",
    networkAddresses: () => options.networkAddresses ?? [],
    userIds: () => ({ uid: 501, gid: 20 }),
    cliFile: options.cliFile ?? join(home, "no-checkout", "cli", "dist", "usual-mail.mjs"),
    nodePath: "/usr/local/bin/node",
  };
  return { ctx, stdout, stderr, questions };
}

export async function run(argv: string[], options: Options): Promise<Ran> {
  const { ctx, stdout, stderr, questions } = context(options);
  const code = await main(argv, ctx);
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), questions };
}

/** Saves a config as `init` would have, for commands that need a paired server. */
export function savedConfig(home: string, config: Record<string, unknown>): string {
  const dir = join(home, ".config", "usual-mail");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export const configPath = (home: string) => join(home, ".config", "usual-mail", "config.json");

export const mode = (path: string) => statSync(path).mode & 0o777;

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Every file under a directory with its contents, to search for secrets. */
export function allFiles(dir: string): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.push({ path, text: readFileSync(path, "utf8") });
  }
  return found;
}
