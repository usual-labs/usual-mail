// The server as a Node process on this machine: the server's built file, run in the background with its output
// in a log file. Its process id and log live in the command's state directory, both owner-only.

import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir, type RunSettings } from "../config.ts";
import { note, type Context } from "../context.ts";
import { Failure } from "../errors.ts";
import { findCheckout, KILLED_WORDS, STOPPING, waitForStop, type Launcher } from "./launcher.ts";
import { readRecord, removeRecord, replaceRecord, writeRecord, type Recorded } from "./pid-file.ts";

export const pidFile = (ctx: Context) => join(stateDir(ctx), "server.pid");
export const logFile = (ctx: Context) => join(stateDir(ctx), "server.log");

/** The server's built file in a checkout around this command, if there is one. */
export function defaultServerFile(ctx: Context): string | null {
  const checkout = findCheckout(ctx);
  return checkout ? join(checkout, "server", "dist", "server.mjs") : null;
}

/** How long to wait for a killed process to be gone, in checks every tenth of a second. */
const KILL_CHECKS = 50;

/**
 * The pid file (`pid-file.ts`) is removed only when the server's process has exited or been killed, so a stop
 * interrupted with Ctrl-C (the server still storing the mail in hand, its port already closed) leaves it in place: the
 * process still counts as the server, and nothing starts a second one on the same data folder.
 */
export function nodeLauncher(ctx: Context, run: RunSettings): Launcher {
  const file = () => pidFile(ctx);

  /**
   * Whether `pid` is this data folder's server: alive, this user's to signal, and run with `--data-dir <dataDir>`, as
   * the launcher starts it (0.1.0's did too). The id in the file may belong to another process by now (the server
   * ended without a command seeing it, and the id was reused), and that one must never be signalled. A command line
   * that can't be read counts as not the server, and so does this command's own process, whose command line may hold
   * the same `--data-dir` (its id taken over from a server that ended).
   */
  async function isServer(pid: number): Promise<boolean> {
    if (pid === process.pid || !ctx.runner.isAlive(pid)) return false;
    const command = await ctx.runner.commandLine(pid);
    return command !== null && ` ${command} `.includes(` --data-dir ${run.dataDir} `);
  }

  /** The server's record while its process runs, also while it stops. */
  async function running(): Promise<Recorded | null> {
    const found = readRecord(file());
    return found && (await isServer(found.pid)) ? found : null;
  }

  /**
   * Stops the server's process, giving it as long as the Compose files give the server to store the mail in hand, and
   * kills it after that. First the file is marked with this command's own process, and only while it still names this
   * server: another command may have finished the stop and recorded the next server meanwhile. The server ignores a
   * second SIGTERM, so finishing a stop that was interrupted (or one interrupted between the mark and the signal)
   * sends it again safely. At the end the file goes only if it still names this server.
   */
  async function stopProcess(pid: number): Promise<void> {
    if (!replaceRecord(file(), pid, { pid, stoppedBy: process.pid })) return;
    ctx.runner.signal(pid, "SIGTERM");
    // Killed only while it is still the server, not a process that took its id after it exited.
    if (!(await waitForStop(ctx, () => !ctx.runner.isAlive(pid))) && (await isServer(pid))) {
      ctx.runner.signal(pid, "SIGKILL");
      for (let check = 0; check < KILL_CHECKS && ctx.runner.isAlive(pid); check++) await ctx.sleep(100);
      note(ctx, KILLED_WORDS);
    }
    removeRecord(file(), pid);
  }

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
      const found = await running();
      if (!found) return { state: "stopped" };
      return found.stoppedBy === undefined ? { state: "running" } : { state: "running", detail: STOPPING };
    },

    async start() {
      const found = await running();
      if (found && found.stoppedBy === undefined) return false;
      if (found) {
        // A stop that hasn't finished: the server still stores the mail in hand. Let it finish, so two servers never
        // share the data folder. The command that marked it may still be waiting for it in another terminal.
        const by = found.stoppedBy;
        const elsewhere = Boolean(by) && by !== process.pid && ctx.runner.isAlive(by!);
        note(
          ctx,
          elsewhere
            ? "The server is still stopping: another `usual-mail` command is stopping it, so this waits until it has stopped…"
            : "The server is still stopping after an interrupted `usual-mail stop`, so it finishes first…",
        );
        await stopProcess(found.pid);
        // Another command may have finished the same stop first and started the server again: that one stays.
        if (await running()) return false;
      }
      const server = run.serverFile!;
      mkdirSync(stateDir(ctx), { recursive: true, mode: 0o700 });
      const args = [server, "--data-dir", run.dataDir, "--port", String(run.port), "--host", "127.0.0.1"];
      const pid = await ctx.runner.startDetached(ctx.nodePath, args, { cwd: dirname(server), logFile: logFile(ctx) });
      writeRecord(file(), { pid });
      return true;
    },

    async stop() {
      const found = readRecord(file());
      if (!found || !(await isServer(found.pid))) {
        // A record of a server that has gone, or of a process that isn't it: removed if it is still that record.
        if (found) removeRecord(file(), found.pid);
        return false;
      }
      await stopProcess(found.pid);
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
