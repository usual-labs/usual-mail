// The server as a Node process on this machine: the server's built file, run in the background with its output
// in a log file. Its process id and log live in the command's state directory, both owner-only.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir, type RunSettings } from "../config.ts";
import type { Context } from "../context.ts";
import { Failure } from "../errors.ts";
import { findCheckout, type Launcher } from "./launcher.ts";

export const pidFile = (ctx: Context) => join(stateDir(ctx), "server.pid");
export const logFile = (ctx: Context) => join(stateDir(ctx), "server.log");

/** The server's built file in a checkout around this command, if there is one. */
export function defaultServerFile(ctx: Context): string | null {
  const checkout = findCheckout(ctx);
  return checkout ? join(checkout, "server", "dist", "server.mjs") : null;
}

export function nodeLauncher(ctx: Context, run: RunSettings): Launcher {
  const readPid = (): number | null => {
    try {
      const pid = Number(readFileSync(pidFile(ctx), "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
  const running = (): number | null => {
    const pid = readPid();
    return pid && ctx.runner.isAlive(pid) ? pid : null;
  };

  return {
    label: "Node",

    async prepare() {
      const file = run.serverFile;
      if (!file || !existsSync(file)) {
        const where = file ?? "server/dist/server.mjs";
        throw new Failure(
          `The server's built file isn't at ${where}. In a checkout of Usual Mail, run \`npm ci && npm run build\` ` +
            "in server/, then pass its dist/server.mjs with --server-file, or use Docker (`--mode docker`).",
        );
      }
    },

    async state() {
      return { state: running() ? "running" : "stopped" };
    },

    async start() {
      if (running()) return false;
      const file = run.serverFile!;
      mkdirSync(stateDir(ctx), { recursive: true, mode: 0o700 });
      const args = [file, "--data-dir", run.dataDir, "--port", String(run.port), "--host", "127.0.0.1"];
      const pid = await ctx.runner.startDetached(ctx.nodePath, args, { cwd: dirname(file), logFile: logFile(ctx) });
      writeFileSync(pidFile(ctx), `${pid}\n`, { mode: 0o600 });
      return true;
    },

    async stop() {
      const pid = running();
      rmSync(pidFile(ctx), { force: true });
      if (!pid) return false;
      ctx.runner.signal(pid, "SIGTERM");
      for (let waited = 0; waited < 10_000 && ctx.runner.isAlive(pid); waited += 100) await ctx.sleep(100);
      if (ctx.runner.isAlive(pid)) ctx.runner.signal(pid, "SIGKILL");
      return true;
    },

    async logs({ follow, lines }) {
      const file = logFile(ctx);
      if (!existsSync(file)) {
        ctx.stdout.write("The server has written no log yet.\n");
        if (!follow) return;
      } else {
        ctx.stdout.write(lastLines(readFileSync(file, "utf8"), lines));
      }
      if (!follow) return;
      let offset = existsSync(file) ? statSync(file).size : 0;
      for (;;) {
        await ctx.sleep(500);
        if (!existsSync(file)) continue;
        const size = statSync(file).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          ctx.stdout.write(readRange(file, offset, size));
          offset = size;
        }
      }
    },

    async tail(lines) {
      return existsSync(logFile(ctx)) ? lastLines(readFileSync(logFile(ctx), "utf8"), lines) : "";
    },

    async exposure() {
      return `127.0.0.1:${run.port}`;
    },
  };
}

function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const picked = lines.slice(-count);
  return picked.length ? `${picked.join("\n")}\n` : "";
}

function readRange(file: string, from: number, to: number): string {
  const buffer = Buffer.alloc(to - from);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}
