// Waiting for a server that was just started, and reading the owner's first pairing code.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "../client.ts";
import type { Context } from "../context.ts";
import { notAnswering, type Launcher } from "./launcher.ts";

/** The file the server writes the owner's first pairing code to, owner-only, and deletes once it is used. */
export const OWNER_CODE_FILE = "owner-pairing-code";

/** Waits until `GET /healthz` answers. Gives up early when the server stopped, with the end of its log. */
export async function waitUntilAnswering(ctx: Context, client: Client, launcher: Launcher, seconds: number): Promise<void> {
  const deadline = ctx.now() + seconds * 1000;
  let checks = 0;
  for (;;) {
    if (await client.healthy(1_000)) return;
    // Every second or so, see whether it is still running at all.
    if (++checks % 4 === 0) {
      const { state } = await launcher.state();
      if (state === "stopped" || state === "missing") throw notAnswering(launcher.label, client.server, await launcher.tail(20));
    }
    if (ctx.now() >= deadline) throw notAnswering(launcher.label, client.server, await launcher.tail(20));
    await ctx.sleep(250);
  }
}

/**
 * The owner's pairing code from the data directory, waiting up to `seconds` for the server to write it. The file
 * holds the code, alone or as JSON with a `code` field. Null when there is none: the code was used already.
 */
export async function readOwnerCode(ctx: Context, dataDir: string, seconds: number): Promise<string | null> {
  const deadline = ctx.now() + seconds * 1000;
  for (;;) {
    const code = ownerCode(join(dataDir, OWNER_CODE_FILE));
    if (code || ctx.now() >= deadline) return code;
    await ctx.sleep(250);
  }
}

function ownerCode(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (text.startsWith("{")) {
    try {
      const code = (JSON.parse(text) as { code?: unknown }).code;
      return typeof code === "string" && code ? code : null;
    } catch {
      return null;
    }
  }
  return text.split(/\s+/)[0] || null;
}
