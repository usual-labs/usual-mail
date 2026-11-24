// What running the server looks like, in Docker or directly with Node, and helpers both ways share.

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Context } from "../context.ts";
import { Failure } from "../errors.ts";

export type RunState = "running" | "stopped" | "missing" | "unknown";

export interface Launcher {
  /** "Docker" or "Node", for messages. */
  readonly label: string;
  /** Checks that what it needs is here, and builds the image when it can. Fails with what to do otherwise. */
  prepare(options?: { build?: boolean }): Promise<void>;
  /** Whether the server runs. "unknown" comes with the reason, for example Docker not answering. */
  state(): Promise<{ state: RunState; detail?: string }>;
  /** Starts the server unless it runs with these settings already. True when it started something. */
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
