// The command's settings: the server's address, the command's own token, and how `init` set the server up.
// One JSON file in the user's config directory, readable only by its owner.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "./context.ts";
import { Failure } from "./errors.ts";

export const DEFAULT_PORT = 8484;
/** The port the server listens on inside its container. */
export const CONTAINER_PORT = 8484;
export const DEFAULT_IMAGE = "usual-mail";
export const DEFAULT_CONTAINER = "usual-mail";

export type RunMode = "docker" | "node";

/** How `init` runs the server on this machine. */
export interface RunSettings {
  mode: RunMode;
  /** Absolute path of the server's data directory. */
  dataDir: string;
  port: number;
  /** Docker: the image to run and the container's name. */
  image?: string;
  container?: string;
  /** Node: the server's built file, `server/dist/server.mjs`. */
  serverFile?: string;
}

export interface Config {
  /** For example "http://127.0.0.1:8484". No trailing slash. */
  server?: string;
  /** This command's own token, a person's device. Never printed. */
  token?: string;
  deviceId?: string;
  deviceName?: string;
  /** Absent when the server runs elsewhere and this command only talks to it. */
  run?: RunSettings;
}

const home = (ctx: Context) => ctx.env.HOME || homedir();

export const configDir = (ctx: Context) => join(ctx.env.XDG_CONFIG_HOME || join(home(ctx), ".config"), "usual-mail");
export const configFile = (ctx: Context) => join(configDir(ctx), "config.json");
/** Node mode's process id and log. */
export const stateDir = (ctx: Context) => join(ctx.env.XDG_STATE_HOME || join(home(ctx), ".local", "state"), "usual-mail");
export const defaultDataDir = (ctx: Context) =>
  join(ctx.env.XDG_DATA_HOME || join(home(ctx), ".local", "share"), "usual-mail");

/** An absolute path from what a person typed, with a leading `~` as the home directory. */
export function absolute(ctx: Context, path: string): string {
  if (path === "~") return home(ctx);
  return resolve(path.startsWith("~/") ? join(home(ctx), path.slice(2)) : path);
}

/** A path with the home directory written as `~`, for messages. */
export function shown(ctx: Context, path: string): string {
  const prefix = home(ctx);
  return path === prefix ? "~" : path.startsWith(`${prefix}/`) ? `~${path.slice(prefix.length)}` : path;
}

export function readConfig(ctx: Context): Config {
  let text: string;
  try {
    text = readFileSync(configFile(ctx), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Failure(`Can't read ${configFile(ctx)}: ${(error as Error).message}`);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Config;
  } catch {
    // Reported below.
  }
  throw new Failure(`${configFile(ctx)} isn't valid JSON. Fix it or remove it, then run \`usual-mail init\` again.`);
}

/** Writes the whole file at once, owner-only, in an owner-only directory. */
export function writeConfig(ctx: Context, config: Config): void {
  const file = configFile(ctx);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** The same settings, compared field by field, so `init` can tell whether anything would change. */
export function sameConfig<T extends object>(a: T, b: T): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

export function serverUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
