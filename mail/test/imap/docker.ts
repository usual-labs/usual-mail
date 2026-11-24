/**
 * Real mail servers in Docker for the IMAP tests: GreenMail (IMAP and SMTP in one, users made on first
 * login) and Dovecot (IMAP; sending goes to the in-process SMTP sink). Images are pinned. Containers bind
 * to 127.0.0.1 on random ports and are removed afterwards.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";
import { createImapProvider } from "../../src/index.ts";
import { deleteByMessageId, startSmtpSink } from "./servers.ts";
import type { ImapTestHarness } from "./scenarios.ts";

const exec = promisify(execFile);

export const GREENMAIL_IMAGE = "greenmail/standalone:2.1.15";
export const DOVECOT_IMAGE = "dovecot/dovecot:2.4.5";
const DOVECOT_PASSWORD = "test-password";

/** Why Docker can't be used, or undefined when it answers. */
export async function dockerProblem(): Promise<string | undefined> {
  if (process.env.USUAL_MAIL_SKIP_DOCKER) return "USUAL_MAIL_SKIP_DOCKER is set";
  const timeout = Number(process.env.USUAL_MAIL_DOCKER_TIMEOUT_MS ?? 10_000);
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout });
    return undefined;
  } catch (error) {
    const e = error as { code?: string; killed?: boolean; stderr?: string };
    if (e.code === "ENOENT") return "the docker command isn't installed";
    if (e.killed) return `the Docker daemon didn't answer within ${timeout / 1000} seconds`;
    return `docker version failed: ${(e.stderr ?? "").trim().split("\n")[0] || "no output"}`;
  }
}

export interface Container {
  id: string;
  port(containerPort: number): number;
  stop(): Promise<void>;
}

export async function runContainer(image: string, ports: number[], env: Record<string, string> = {}): Promise<Container> {
  try {
    await exec("docker", ["image", "inspect", image], { timeout: 30_000 });
  } catch {
    await exec("docker", ["pull", image], { timeout: 10 * 60_000 });
  }
  const args = ["run", "-d", "--rm"];
  for (const port of ports) args.push("-p", `127.0.0.1::${port}`);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  const { stdout } = await exec("docker", [...args, image], { timeout: 60_000 });
  const id = stdout.trim();
  const mapped = new Map<number, number>();
  try {
    for (const port of ports) {
      const out = (await exec("docker", ["port", id, `${port}/tcp`], { timeout: 30_000 })).stdout;
      const host = Number(/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
      if (!host) throw new Error(`docker port gave no host port for ${port}: ${out}`);
      mapped.set(port, host);
    }
  } catch (error) {
    await exec("docker", ["rm", "-f", id]).catch(() => undefined);
    throw error;
  }
  return {
    id,
    port: (p) => mapped.get(p)!,
    stop: async () => {
      await exec("docker", ["rm", "-f", id], { timeout: 60_000 }).catch(() => undefined);
    },
  };
}

/** Waits until the server lets this user log in. */
export async function waitForImap(port: number, user: string, password: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const client = new ImapFlow({ host: "127.0.0.1", port, secure: false, auth: { user, pass: password }, logger: false, tls: { rejectUnauthorized: false } });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.logout();
      return;
    } catch (error) {
      last = error;
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`The IMAP server on port ${port} wasn't ready in time: ${(last as Error)?.message}`);
}

async function appendAs(login: ImapTestHarness["login"], raw: string, at?: Date): Promise<void> {
  const client = new ImapFlow({ host: login.host, port: login.port, secure: false, auth: { user: login.user, pass: login.password }, logger: false, tls: { rejectUnauthorized: false } });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.append("INBOX", raw, [], at);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Whether INBOX takes custom keywords, so the contract knows whether to check stacks and trash origins. */
async function keywordsAllowed(login: ImapTestHarness["login"]): Promise<boolean> {
  const client = new ImapFlow({ host: login.host, port: login.port, secure: false, auth: { user: login.user, pass: login.password }, logger: false, tls: { rejectUnauthorized: false } });
  client.on("error", () => {});
  await client.connect();
  try {
    const mailbox = await client.mailboxOpen("INBOX");
    return !mailbox.permanentFlags || mailbox.permanentFlags.has("\\*");
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface DockerServer {
  name: string;
  start(): Promise<Container>;
  harness(container: Container, options?: { since?: string }): Promise<ImapTestHarness>;
}

export const GREENMAIL: DockerServer = {
  name: `IMAP on GreenMail (${GREENMAIL_IMAGE})`,
  async start() {
    const container = await runContainer(GREENMAIL_IMAGE, [3143, 3025]);
    await waitForImap(container.port(3143), "probe@mail.example", "probe");
    return container;
  },
  async harness(container, options = {}) {
    // GreenMail makes a fresh mailbox for every new user, so each test gets its own.
    const user = `u${randomUUID().slice(0, 8)}@mail.example`;
    const login = { host: "127.0.0.1", port: container.port(3143), user, password: "pw" };
    const provider = createImapProvider(
      { imap: { ...login, secure: false }, smtp: { host: "127.0.0.1", port: container.port(3025), secure: false, user, password: "pw" } },
      options,
    );
    return {
      provider,
      address: user,
      login,
      supports: { keywords: await keywordsAllowed(login) },
      deliver: (raw) => appendAs(login, raw),
      appendAt: (raw, at) => appendAs(login, raw, at),
      removeExternally: (messageId) => deleteByMessageId(login, messageId),
      close: () => provider.close(),
    };
  },
};

export const DOVECOT: DockerServer = {
  name: `IMAP on Dovecot (${DOVECOT_IMAGE})`,
  async start() {
    const container = await runContainer(DOVECOT_IMAGE, [31143], { USER_PASSWORD: DOVECOT_PASSWORD });
    await waitForImap(container.port(31143), "probe@mail.example", DOVECOT_PASSWORD);
    return container;
  },
  async harness(container, options = {}) {
    // The image's default passdb lets any user name in with USER_PASSWORD; each name is its own mailbox.
    const user = `u${randomUUID().slice(0, 8)}@mail.example`;
    const login = { host: "127.0.0.1", port: container.port(31143), user, password: DOVECOT_PASSWORD };
    const smtp = await startSmtpSink();
    const provider = createImapProvider(
      { imap: { ...login, secure: false }, smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user, password: DOVECOT_PASSWORD } },
      options,
    );
    return {
      provider,
      address: user,
      login,
      supports: { keywords: await keywordsAllowed(login) },
      deliver: (raw) => appendAs(login, raw),
      appendAt: (raw, at) => appendAs(login, raw, at),
      removeExternally: (messageId) => deleteByMessageId(login, messageId),
      close: async () => {
        await provider.close();
        await smtp.close();
      },
    };
  },
};
