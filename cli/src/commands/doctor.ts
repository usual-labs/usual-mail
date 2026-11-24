// `usual-mail doctor`: checks the setup and says in plain words what to fix.

import { API_VERSION, type AiSettings, type AiStatus, type Device, type Inbox, type ServerInfo } from "@usualmail/core";
import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { explainStatus, NEEDS_PERSON_STATES, pendingWords, serviceName, STATE_WORDS } from "../ai-words.ts";
import { Client } from "../client.ts";
import { flag, type Command } from "../command.ts";
import { configDir, configFile, readConfig, shown, type Config } from "../config.ts";
import { printJson, say, type Context } from "../context.ts";
import { ApiError, Failure } from "../errors.ts";
import { firstSyncLine, isLoopback, STATUS_WORDS } from "../format.ts";
import { launcherFor } from "../launch/index.ts";
import { clientFileHint, GOOGLE_CLIENT_FILE } from "./google.ts";
import { OWNER_CODE_FILE } from "../launch/wait.ts";
import { savedSyncDays } from "../server-settings.ts";
import { mismatchWords, serverSyncDays } from "./sync-days.ts";

type Level = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: Level;
  /** What was found. */
  text: string;
  /** What to do about it, when something is wrong. */
  fix?: string;
  /** Something worth knowing that isn't wrong, such as a hint. Shown like a fix; it never changes the level. */
  note?: string;
}

export const doctor: Command = {
  name: "doctor",
  summary: "check the setup and say what to fix",
  usage: "usual-mail doctor [--json]",
  details: `
--json   print the checks as JSON

Checks the settings file, that the server answers and its version, this command's pairing, how the server runs,
the data directory's permissions, each inbox's status, the server's AI (whether a key is set and works, and
what waits for it), whether Gmail can be connected by signing in with Google (and the client file is
readable only by you), and whether the server is reachable only from this machine. Exits with 1 when a
check fails; warnings alone don't.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const checks = await runChecks(ctx);
    if (flag(values, "json")) printJson(ctx, { ok: !checks.some((c) => c.level === "fail"), checks });
    else {
      for (const check of checks) {
        say(ctx, `${check.level.padEnd(4)}  ${check.name}: ${check.text}`);
        if (check.fix) say(ctx, `      ${check.fix}`);
        if (check.note) say(ctx, `      ${check.note}`);
      }
      const failed = checks.filter((c) => c.level === "fail").length;
      const warned = checks.filter((c) => c.level === "warn").length;
      say(ctx, "");
      say(ctx, failed ? `${failed} to fix${warned ? `, ${warned} to look at` : ""}.` : warned ? `Working; ${warned} to look at.` : "All good.");
    }
    if (checks.some((c) => c.level === "fail")) throw new Failure("", "failed");
  },
};

export async function runChecks(ctx: Context): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  const config = readConfig(ctx);
  const server = ctx.env.USUAL_MAIL_SERVER || config.server;

  add(settingsCheck(ctx, config));
  if (!server) return checks;

  const token = ctx.env.USUAL_MAIL_TOKEN || (config.server === server ? config.token : undefined);
  const client = new Client(server, token, ctx.fetch);
  const run = config.run && config.server === server ? config.run : undefined;

  if (run) {
    const { state, detail } = await launcherFor(ctx, run).state();
    add(
      state === "running"
        ? { name: "process", level: "ok", text: `runs with ${run.mode === "docker" ? "Docker" : "Node"}${detail ? ` (${detail})` : ""}` }
        : {
            name: "process",
            level: "fail",
            text: state === "unknown" ? (detail ?? "unknown") : `not running (${run.mode === "docker" ? "Docker" : "Node"})`,
            fix: state === "unknown" ? "Start Docker, then run `usual-mail start`." : "Run `usual-mail start`; `usual-mail logs` shows why it stopped.",
          },
    );
  }

  const answers = await client.healthy(3_000);
  if (!answers) {
    add({ name: "server", level: "fail", text: `nothing answers at ${server}`, fix: run ? "Run `usual-mail start`." : "Check the server where it runs." });
  } else {
    add({ name: "server", level: "ok", text: `answers at ${server}` });
    add(await versionCheck(client));
    add(await googleCheck(ctx, client, run?.dataDir));
  }
  const pairing = answers ? await pairingCheck(ctx, client, server, run?.dataDir) : null;
  if (pairing) add(pairing);

  if (run) add(dataCheck(ctx, run.dataDir));
  const owner = run ? ownerCodeCheck(ctx, run.dataDir, pairing?.level === "ok") : null;
  if (owner) add(owner);
  if (answers && token) checks.push(...(await inboxChecks(client)));
  if (answers && token) {
    const firstSync = await syncDaysCheck(client, run?.dataDir);
    if (firstSync) add(firstSync);
    const ai = await aiCheck(client);
    if (ai) add(ai);
  }
  add(await exposureCheck(ctx, server, run ? await launcherFor(ctx, run).exposure() : null));
  return checks;
}

function settingsCheck(ctx: Context, config: Config): Check {
  const file = configFile(ctx);
  if (!existsSync(file)) {
    return ctx.env.USUAL_MAIL_SERVER
      ? { name: "settings", level: "ok", text: "none saved; USUAL_MAIL_SERVER is set" }
      : { name: "settings", level: "fail", text: "nothing is set up", fix: "Run `usual-mail init`." };
  }
  const loose = [file, configDir(ctx)].filter((path) => (statSync(path).mode & 0o077) !== 0);
  if (loose.length) {
    return {
      name: "settings",
      level: "fail",
      text: `${loose.map((path) => shown(ctx, path)).join(" and ")} can be read by other users, and the file holds this command's token`,
      fix: `Run \`chmod 700 ${shown(ctx, configDir(ctx))} && chmod 600 ${shown(ctx, file)}\`.`,
    };
  }
  if (!config.server && !ctx.env.USUAL_MAIL_SERVER) {
    return { name: "settings", level: "fail", text: "no server address saved", fix: "Run `usual-mail init`." };
  }
  return { name: "settings", level: "ok", text: `${shown(ctx, file)}, readable only by you` };
}

async function versionCheck(client: Client): Promise<Check> {
  try {
    const info = await client.call<ServerInfo>("info");
    if (info.name !== "usual-mail") return { name: "version", level: "fail", text: "the server isn't a Usual Mail server" };
    if (info.apiVersion !== API_VERSION) {
      return {
        name: "version",
        level: "fail",
        text: `the server speaks API ${info.apiVersion} and this command speaks API ${API_VERSION}`,
        fix: "Update the server or this command so both match.",
      };
    }
    return { name: "version", level: "ok", text: `Usual Mail ${info.version}, API ${info.apiVersion}` };
  } catch (error) {
    return { name: "version", level: "fail", text: (error as Error).message };
  }
}

/**
 * Google sign-in for Gmail: whether the server has it, and if not exactly what the host must do. A client file other
 * users can read fails: it holds the client secret.
 */
async function googleCheck(ctx: Context, client: Client, dataDir: string | undefined): Promise<Check> {
  const file = dataDir ? join(dataDir, GOOGLE_CLIENT_FILE) : null;
  if (file && existsSync(file) && (statSync(file).mode & 0o077) !== 0) {
    return {
      name: "google",
      level: "fail",
      text: `other users on this machine can read the Google client in ${shown(ctx, file)}, so the server doesn't use it`,
      fix: `Run \`chmod 600 ${shown(ctx, file)}\`; the server reads it again at once. It holds the client's secret.`,
    };
  }
  let google;
  try {
    google = (await client.call<ServerInfo>("info")).googleSignIn;
  } catch (error) {
    return { name: "google", level: "warn", text: `the server didn't say: ${(error as Error).message}` };
  }
  if (!google) return { name: "google", level: "warn", text: "this server can't connect Gmail by signing in with Google", fix: "Update the server." };
  const redirect = google.redirectUri ?? "<its address>/v1/google/callback";
  if (google.available) {
    // A client file that doesn't list the address is a hint, not a fault: it may be older than a change made at Google.
    const hint = file ? clientFileHint(ctx, file, google) : null;
    return {
      name: "google",
      level: "ok",
      text: `Gmail can be connected by signing in with Google; Google sends people back to ${redirect}. While the client's consent screen is in Testing, each sign-in lasts seven days`,
      ...(hint ? { note: hint } : {}),
    };
  }
  const fixes: string[] = [];
  if (google.missing?.includes("client")) {
    fixes.push(
      `Create an OAuth client of type Web application at Google Cloud (Gmail API on; consent screen External, in Testing, you as a test user; scope gmail.modify) whose authorized redirect URI is exactly ${redirect}. ` +
        "Download its JSON and run `usual-mail google set --file <it>`" + (file ? ` (it goes to ${shown(ctx, file)}, readable only by you)` : "") + ".",
    );
  }
  if (google.missing?.includes("address")) {
    fixes.push("Set USUAL_MAIL_PUBLIC_URL (or --public-url) to the HTTPS address people reach the server at, restart it, and register that address followed by /v1/google/callback at Google.");
  }
  return {
    name: "google",
    level: "warn",
    text: `Gmail can't be connected by signing in with Google: the server has no ${google.missing?.map((part) => (part === "client" ? "Google client" : "address of its own")).join(" and ") ?? "setup"}`,
    fix: `${fixes.join(" ")} docs/google-setup.md in Usual Mail says each step.`,
  };
}

/** The owner's pairing code file in a data directory this command can read, or null when there is none. */
function ownerCodeFile(dataDir: string | undefined): string | null {
  if (!dataDir) return null;
  const file = join(dataDir, OWNER_CODE_FILE);
  return existsSync(file) ? file : null;
}

/**
 * How to pair again when the server refuses this command's token. The server writes an owner's code whenever no
 * person's device is paired, so the file tells which way it is (docs/contract.md, "Pairing and sign-in").
 */
function pairAgainFix(ctx: Context, server: string, dataDir: string | undefined): string {
  if (!dataDir) {
    return (
      `Run \`usual-mail init --server ${server} --code <code>\` with a code from an app or browser that is paired, or ` +
      "with the owner's code, which waits in the file owner-pairing-code in the server's data directory while no person's device is paired."
    );
  }
  const file = ownerCodeFile(dataDir);
  if (file) return `Run \`usual-mail init\`: no person's device is paired, so the server wrote a new owner's code to ${shown(ctx, file)}, and init pairs with it.`;
  return (
    "Another app or browser is still paired, so the server has no owner's code. Make a pairing code there (Devices in " +
    "the dashboard, or `usual-mail pair` where this command is paired) and run `usual-mail init --code <code>`."
  );
}

/** Which device the token in use belongs to, as `GET /v1/me` says. */
async function pairingCheck(ctx: Context, client: Client, server: string, dataDir: string | undefined): Promise<Check> {
  if (!client.hasToken) return { name: "pairing", level: "fail", text: "this command isn't paired", fix: pairAgainFix(ctx, server, dataDir) };
  const fromEnv = Boolean(ctx.env.USUAL_MAIL_TOKEN);
  try {
    const device = await client.raw<Device>("me");
    if (device.kind === "agent") {
      return { name: "pairing", level: "warn", text: `the token in use belongs to the agent "${device.name}"`, fix: "Unset USUAL_MAIL_TOKEN to act as yourself." };
    }
    return { name: "pairing", level: "ok", text: `paired as "${device.name}"${fromEnv ? " (the token in USUAL_MAIL_TOKEN)" : ""}` };
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      return {
        name: "pairing",
        level: "fail",
        text: fromEnv ? "the server refuses the token in USUAL_MAIL_TOKEN" : "the server refuses this command's token",
        fix: fromEnv ? "Check USUAL_MAIL_TOKEN, or unset it to use this command's own token." : pairAgainFix(ctx, server, dataDir),
      };
    }
    return { name: "pairing", level: "fail", text: (error as Error).message };
  }
}

/**
 * The owner's pairing code file. The server writes it whenever no person's device is paired, writes a new one when
 * the old one expires, and removes it once it is used. It holds a code that makes a person's device: owner-only.
 */
function ownerCodeCheck(ctx: Context, dataDir: string, paired: boolean): Check | null {
  const file = ownerCodeFile(dataDir);
  if (!file) return null;
  if ((statSync(file).mode & 0o077) !== 0) {
    return {
      name: "owner code",
      level: "fail",
      text: `other users on this machine can read the owner's pairing code in ${shown(ctx, file)}`,
      fix: `Run \`chmod 600 ${shown(ctx, file)}\`. Anyone with that code can pair a device as you.`,
    };
  }
  if (paired) return { name: "owner code", level: "ok", text: `an owner's pairing code waits in ${shown(ctx, file)}, readable only by you` };
  return {
    name: "owner code",
    level: "warn",
    text: `no app or browser is paired, and the owner's pairing code waits in ${shown(ctx, file)}`,
    fix: "Run `usual-mail init` to pair this command with it. The server makes a new one when it expires.",
  };
}

function dataCheck(ctx: Context, dataDir: string): Check {
  if (!existsSync(dataDir)) {
    return { name: "data", level: "fail", text: `${shown(ctx, dataDir)} doesn't exist`, fix: "Run `usual-mail init` to make it." };
  }
  const loose = [dataDir, ...["usual-mail.db", "secret.key"].map((name) => join(dataDir, name)).filter(existsSync)].filter(
    (path) => (statSync(path).mode & 0o077) !== 0,
  );
  if (loose.length) {
    return {
      name: "data",
      level: "fail",
      text: `other users on this machine can read ${loose.map((path) => shown(ctx, path)).join(", ")}`,
      fix: `Run \`chmod -R go-rwx ${shown(ctx, dataDir)}\`. The data directory holds your mail and the key that seals your mailbox passwords and AI key.`,
    };
  }
  return { name: "data", level: "ok", text: `${shown(ctx, dataDir)}, readable only by you` };
}

async function inboxChecks(client: Client): Promise<Check[]> {
  let inboxes: Inbox[];
  try {
    inboxes = await client.raw<Inbox[]>("listInboxes");
  } catch {
    return [];
  }
  if (!inboxes.length) return [{ name: "inboxes", level: "warn", text: "none yet", fix: "Run `usual-mail inbox add`." }];
  return inboxes.map((inbox): Check => {
    const name = `inbox ${inbox.name}`;
    const words = STATUS_WORDS[inbox.status] ?? inbox.status;
    if (inbox.status === "needs_attention") {
      return {
        name,
        level: "fail",
        text: `needs attention: ${inbox.statusDetail ?? "no reason given"}`,
        fix:
          `Fix what it says, then run \`usual-mail inbox sync ${JSON.stringify(inbox.name)}\`. ` +
          `A changed password: \`usual-mail inbox reconnect ${JSON.stringify(inbox.name)}\`.`,
      };
    }
    if (inbox.status === "paused") {
      return { name, level: "warn", text: "paused", fix: `Run \`usual-mail inbox resume ${JSON.stringify(inbox.name)}\` to sync it again.` };
    }
    return { name, level: "ok", text: firstSyncLine(inbox) ?? words };
  });
}

/**
 * How many days of mail a new inbox's first sync takes, as the server uses it. When the data directory here saves
 * another number, the server was started with USUAL_MAIL_SYNC_DAYS (which wins) or before the number was saved.
 */
async function syncDaysCheck(client: Client, dataDir: string | undefined): Promise<Check | null> {
  const days = await serverSyncDays(client);
  const saved = dataDir && existsSync(dataDir) ? savedSyncDays(dataDir) : undefined;
  if (days === null) return saved === undefined ? null : { name: "first sync", level: "ok", text: `saved as the last ${saved} days of mail for a new inbox` };
  if (saved !== undefined && saved !== days) {
    return {
      name: "first sync",
      level: "warn",
      text: `the server takes the last ${days} days of mail, but the saved setting is ${saved}`,
      fix: mismatchWords(days, saved),
    };
  }
  return { name: "first sync", level: "ok", text: `a new inbox's first sync takes the last ${days} days of mail (\`usual-mail sync-days\` changes it)` };
}

/**
 * The server's AI: a refused key, a missing model or an empty account stop it until a person acts, so they fail; not
 * set up, paused or unavailable (which usually passes) are worth a look. Once a key is set it processes every inbox.
 */
async function aiCheck(client: Client): Promise<Check | null> {
  let status: AiStatus;
  try {
    status = await client.raw<AiStatus>("aiStatus");
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") return null;
    return { name: "ai", level: "fail", text: `the server didn't say how its AI is: ${(error as Error).message}` };
  }
  // The settings are a person's: with an agent's token, only the status.
  const settings = await client.raw<AiSettings>("aiSettings").catch(() => undefined);
  const { why, fix } = explainStatus(status, settings);
  const service = settings?.connection ? ` (${serviceName(settings.connection)})` : "";
  if (status.state === "working") return { name: "ai", level: "ok", text: `working${service}, for every inbox; ${pendingWords(status)}` };
  const level = NEEDS_PERSON_STATES.includes(status.state) ? "fail" : "warn";
  return { name: "ai", level, text: `${STATE_WORDS[status.state] ?? status.state}${service}: ${why ?? ""}`.replace(/: $/, ""), ...(fix ? { fix } : {}) };
}

/** Whether only this machine can reach the server: its address, how its port is published, and a probe. */
async function exposureCheck(ctx: Context, server: string, published: string | null): Promise<Check> {
  const name = "reach";
  if (!isLoopback(server)) {
    return {
      name,
      level: "warn",
      text: `this command uses ${server}, which other machines can reach too`,
      fix: new URL(server).protocol === "https:" ? undefined : "Use HTTPS, or a private network such as a VPN, for any address other than 127.0.0.1.",
    };
  }
  if (published && !/^(127\.|\[::1\]|::1)/.test(published)) {
    return {
      name,
      level: "warn",
      text: `the port is published on ${published}, so other devices on your network can reach it`,
      fix: "Publish it on 127.0.0.1 only, as `usual-mail init` does, unless you mean to.",
    };
  }
  const port = Number(new URL(server).port || 80);
  const open: string[] = [];
  for (const address of ctx.networkAddresses()) if (await reachable(address, port)) open.push(address);
  if (open.length) {
    return {
      name,
      level: "warn",
      text: `other devices can reach port ${port} at ${open.join(", ")}`,
      fix: "If you didn't mean that, bind the server to 127.0.0.1 only. compose.yaml's comments say how to reach it from other devices safely.",
    };
  }
  return { name, level: "ok", text: "only this machine can reach it" };
}

function reachable(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port, timeout: 500 });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
