// Other programs: Docker, and the server itself in Node mode. Tests replace this with fakes.

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface RunResult {
  /** The exit code; -1 when the program couldn't start or was stopped for taking too long. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when it took longer than `timeoutMs` and was stopped. */
  timedOut?: boolean;
  /** True when the program isn't installed. */
  missing?: boolean;
}

export interface Runner {
  /** Runs a program and collects its output. */
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<RunResult>;
  /**
   * Runs a program with its output going straight to this terminal. Returns its exit code. With `progress`, its
   * standard output goes to standard error, so a command's own output stays clean.
   */
  pass(command: string, args: string[], options?: { progress?: boolean }): Promise<number>;
  /** Starts a program that keeps running after this command ends, its output appended to `logFile`. */
  startDetached(command: string, args: string[], options: { cwd: string; logFile: string }): Promise<number>;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export const systemRunner: Runner = {
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message, missing: error.code === "ENOENT" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut });
      });
    });
  },

  pass(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["inherit", options.progress ? 2 : "inherit", "inherit"] });
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
  },

  startDetached(command, args, { cwd, logFile }) {
    return new Promise((resolve, reject) => {
      const log = openSync(logFile, "a", 0o600);
      const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", log, log] });
      closeSync(log);
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve(child.pid!);
      });
    });
  },

  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },

  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};
