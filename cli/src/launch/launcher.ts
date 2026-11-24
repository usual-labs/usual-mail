// What running the server looks like, in Docker or directly with Node, and helpers both ways share.

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { note, type Context } from "../context.ts";
import { Failure } from "../errors.ts";

export type RunState = "running" | "stopped" | "missing" | "unknown";

/**
 * The `detail` of a server that is "running" but stopping: in Node mode, a `usual-mail stop` interrupted while the
 * server stores the mail in hand. Its port is closed already, yet it still holds the data folder, so it counts as
 * running everywhere, and `start` lets it finish before starting the server again.
 */
export const STOPPING = "stopping";

/**
 * How long the server gets to stop before it is killed, as the Compose files give it (`stop_grace_period: 3m`): its
 * stop waits for each inbox's batch in hand, up to about two and a half minutes during a Gmail first sync.
 */
export const STOP_SECONDS = 180;
const STOP_POLL_MS = 100;
/** Said when the server had to be killed, in either mode. */
export const KILLED_WORDS =
  `The server didn't stop within ${STOP_SECONDS / 60} minutes, so it was killed. It fetches the mail it was fetching again when it starts.`;
/** After this long the command says what it waits for. */
const STOP_NOTE_MS = 2_000;

/**
 * Waits up to `STOP_SECONDS` by the clock for `stopped()` to say the server has stopped, checking every tenth of a
 * second and saying once, after two seconds, what it waits for. True when it stopped in time. Timed by the clock, not
 * by counting checks, so slow checks don't stretch it: Docker's own deadline, counted from its SIGTERM, comes after
 * this one.
 */
export async function waitForStop(ctx: Context, stopped: () => boolean): Promise<boolean> {
  const began = ctx.now();
  let noted = false;
  while (!stopped()) {
    const waited = ctx.now() - began;
    if (waited >= STOP_SECONDS * 1000) return false;
    if (!noted && waited >= STOP_NOTE_MS) {
      noted = true;
      note(ctx, "Waiting for the server to store the mail it is fetching before it stops (up to 3 minutes during an inbox's first sync)…");
    }
    await ctx.sleep(STOP_POLL_MS);
  }
  return true;
}

export interface Launcher {
  /** "Docker" or "Node", for messages. */
  readonly label: string;
  /** Checks that what it needs is here, and builds the image when it can. Fails with what to do otherwise. */
  prepare(options?: { build?: boolean }): Promise<void>;
  /**
   * Whether the server runs. "unknown" comes with the reason, for example Docker not answering; "running" may come
   * with `STOPPING`, still a running server.
   */
  state(): Promise<{ state: RunState; detail?: string }>;
  /**
   * Starts the server unless it runs with these settings already. True when it started something. A server still
   * stopping is let finish first, then started again.
   */
  start(): Promise<boolean>;
  /** Stops the server. True when it was running. */
  stop(): Promise<boolean>;
  /** Prints the server's log, and keeps printing it with `follow`. */
  logs(options: { follow: boolean; lines: number }): Promise<void>;
  /** The last lines of the server's log, for explaining why it doesn't answer. */
  tail(lines: number): Promise<string>;
  /** Where the port is published, for example "127.0.0.1:8484", or null when unknown. */
  exposure(): Promise<string | null>;
}

/** A checkout of Usual Mail around this command's own file: it has the Dockerfile, `server/` and `core/`. */
export function findCheckout(ctx: Context): string | null {
  const given = ctx.env.USUAL_MAIL_SOURCE;
  if (given) return isCheckout(given) ? given : null;
  let dir = dirname(ctx.cliFile);
  for (let i = 0; i < 4; i++) {
    if (isCheckout(dir)) return dir;
    dir = dirname(dir);
  }
  return null;
}

const isCheckout = (dir: string) =>
  existsSync(join(dir, "Dockerfile")) && existsSync(join(dir, "server", "package.json")) && existsSync(join(dir, "core", "package.json"));

/** True when nothing listens on this port on this machine's loopback address. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** Asks the person to sort out a server that won't start, with the end of its log. */
export function notAnswering(label: string, server: string, log: string): Failure {
  const tail = log.trim() ? `\n\nThe end of its log:\n${indent(log.trim())}` : "";
  return new Failure(
    `The server (${label}) didn't answer at ${server}. \`usual-mail logs\` shows its whole log.${tail}`,
    "unreachable",
  );
}

export const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
