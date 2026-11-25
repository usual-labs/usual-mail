/**
 * One IMAP connection, opened when first needed and opened again after it drops. ImapFlow can't reuse a
 * closed client, so each reconnect makes a new one. Closing never waits more than a few seconds.
 */
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from "imapflow";
import { SIGN_IN_REFUSED, type ImapCredentials } from "@usualmail/core";

export interface ConnectionTimeouts {
  /** TCP and TLS setup. */
  connectMs: number;
  /** Server greeting. */
  greetingMs: number;
  /** Silence on an open socket before giving up. */
  socketMs: number;
  /** How long close() waits for a polite LOGOUT. */
  logoutMs: number;
  /** After this long without a command, the connection is checked with NOOP before it is used again. */
  quietMs: number;
  /** How long that NOOP may take before the connection is given up and a new one opened. */
  probeMs: number;
}

export const DEFAULT_TIMEOUTS: ConnectionTimeouts = {
  connectMs: 30_000,
  greetingMs: 16_000,
  socketMs: 120_000,
  logoutMs: 3_000,
  quietMs: 60_000,
  probeMs: 10_000,
};

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function clientOptions(imap: ImapCredentials["imap"], timeouts: ConnectionTimeouts, extra: Partial<ImapFlowOptions> = {}): ImapFlowOptions {
  return {
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.password },
    // Without implicit TLS, insist on STARTTLS except on this machine, so a stripped STARTTLS can't leak the password.
    doSTARTTLS: imap.secure ? undefined : !isLoopback(imap.host),
    // Bridges on this machine (Proton Mail Bridge, DavMail) use self-signed certificates; traffic never leaves it.
    ...(isLoopback(imap.host) ? { tls: { rejectUnauthorized: false } } : {}),
    logger: false,
    disableAutoIdle: true,
    clientInfo: { name: "Usual Mail" },
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    ...extra,
  };
}

const CONNECTION_CODES = new Set([
  "NoConnection", "ETIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT", "ClosedAfterConnectTLS", "ClosedAfterConnectText", "EConnectionClosed",
]);

/** True when the error means the connection is gone, so trying again on a new one may work. */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && CONNECTION_CODES.has(code);
}

export class ImapConnection {
  readonly imap: ImapCredentials["imap"];
  readonly timeouts: ConnectionTimeouts;
  #client: ImapFlow | undefined;
  #connecting: Promise<ImapFlow> | undefined;

  constructor(imap: ImapCredentials["imap"], timeouts: ConnectionTimeouts) {
    this.imap = imap;
    this.timeouts = timeouts;
  }

  async client(): Promise<ImapFlow> {
    const current = this.#client;
    if (current?.usable) {
      // Servers drop quiet connections. After a pause, check with NOOP rather than fail the next real command.
      if (Date.now() - (current.lastClientWrite ?? 0) < this.timeouts.quietMs) return current;
      if (await answers(current, this.timeouts.probeMs)) return current;
      this.#drop();
    }
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<ImapFlow> {
    this.#drop();
    const client = new ImapFlow(clientOptions(this.imap, this.timeouts));
    // An unhandled 'error' event would end the process; the next call reconnects instead.
    client.on("error", () => {});
    client.on("close", () => {
      if (this.#client === client) this.#client = undefined;
    });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw readableError(error, this.imap.host);
    }
    this.#client = client;
    return client;
  }

  /**
   * Runs `fn` with `path` selected. Retries once on a fresh connection when the connection drops.
   * With `fresh`, the folder is selected again even if it already was, so UIDNEXT and HIGHESTMODSEQ are
   * current rather than whatever ImapFlow remembered from the last SELECT.
   */
  async withMailbox<T>(path: string, fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>, retry = true, fresh = false): Promise<T> {
    return this.run(async (client) => {
      const before = client.mailbox;
      const lock = await client.getMailboxLock(path);
      try {
        // ImapFlow skips SELECT when the folder is already open; select it again for current numbers.
        if (fresh && before && client.mailbox === before) await client.mailboxOpen(path);
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error(`Couldn't open ${path}.`);
        return await fn(client, mailbox);
      } finally {
        lock.release();
      }
    }, retry);
  }

  async run<T>(fn: (client: ImapFlow) => Promise<T>, retry = true): Promise<T> {
    const client = await this.client();
    try {
      return await fn(client);
    } catch (error) {
      if (!retry || !(isConnectionError(error) || !client.usable)) throw error;
      this.#drop();
      return fn(await this.client());
    }
  }

  #drop(): void {
    const client = this.#client;
    this.#client = undefined;
    if (client && !client.isClosed) client.close();
  }

  async close(): Promise<void> {
    const client = this.#client ?? (await this.#connecting?.catch(() => undefined));
    this.#client = undefined;
    if (!client) return;
    await closeClient(client, this.timeouts.logoutMs);
  }
}

async function answers(client: ImapFlow, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client.noop().then(() => client.usable),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** LOGOUT politely, but never wait longer than `ms`; then drop the socket. */
export async function closeClient(client: ImapFlow, ms: number): Promise<void> {
  if (!client.isClosed && client.usable) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.logout().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }
  if (!client.isClosed) client.close();
}

export function readableError(error: unknown, host: string): Error {
  const e = error as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string };
  if (e?.authenticationFailed || e?.code === "AUTHENTICATIONFAILED") {
    // Named so the server tells a refused sign-in from a failure that may pass (core's SIGN_IN_REFUSED).
    const refused = new Error(`The IMAP server at ${host} refused the user name or password.`);
    refused.name = SIGN_IN_REFUSED;
    return refused;
  }
  if (e?.code === "ECONNREFUSED") return new Error(`Nothing answers on the IMAP port at ${host}.`);
  if (e?.code === "ENOTFOUND") return new Error(`The IMAP host ${host} wasn't found.`);
  if (e?.code === "CONNECT_TIMEOUT" || e?.code === "ETIMEDOUT" || e?.code === "GREETING_TIMEOUT") {
    return new Error(`The IMAP server at ${host} didn't answer in time.`);
  }
  const detail = e?.responseText || e?.message || String(error);
  const wrapped = new Error(`IMAP connection to ${host} failed: ${detail}`);
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}
