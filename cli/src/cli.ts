// The entry point: the real terminal, network, programs and clock. Bundled into dist/usual-mail.mjs.

import { realpathSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import type { Context } from "./context.ts";
import { main } from "./main.ts";
import { exitQuietlyOnClosedPipe } from "./pipes.ts";
import { terminalPrompter } from "./prompt.ts";
import { systemRunner } from "./runner.ts";

const ctx: Context = {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  prompter: () => terminalPrompter(process.stdin, process.stdout),
  readStdin: () => readAll(process.stdin),
  fetch: globalThis.fetch,
  runner: systemRunner,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hostname: () => hostname().replace(/\.local$/, ""),
  networkAddresses: () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal && address.family === "IPv4")
      .map((address) => address!.address),
  userIds: () => (typeof process.getuid === "function" && typeof process.getgid === "function" ? { uid: process.getuid(), gid: process.getgid() } : null),
  cliFile: realpathSync(process.argv[1] ?? "."),
  nodePath: process.execPath,
};

/**
 * Everything on standard input, read as a stream. A synchronous read fails with EAGAIN when standard input is a
 * non-blocking pipe whose writer hasn't written yet (a program feeding the secrets a moment later).
 */
async function readAll(input: NodeJS.ReadStream): Promise<string> {
  if (input.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

// `usual-mail … | head`: once the reader has gone, exit quietly instead of printing a stack trace.
exitQuietlyOnClosedPipe([process.stdout, process.stderr], (code) => process.exit(code));

process.exitCode = await main(process.argv.slice(2), ctx);
