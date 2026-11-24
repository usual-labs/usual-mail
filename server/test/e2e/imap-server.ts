// A real IMAP server and SMTP server for the end-to-end tests, both in this process on 127.0.0.1: hoodiecrow (an
// IMAP server made for testing clients, the one mail's own tests use) with CONDSTORE, MOVE, UIDPLUS,
// SPECIAL-USE and IDLE, and an SMTP sink that keeps what it receives. Plus "another mail app": an ImapFlow
// client that looks at and changes the mailbox behind the server's back.

import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { SMTPServer } from "smtp-server";
import type { ImapCredentials } from "@usualmail/core";

const require = createRequire(import.meta.url);
interface Hoodiecrow {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number };
  appendMessage(mailbox: string, flags: string[], internalDate: Date | false, raw: string): unknown;
  users: Record<string, { password: string }>;
  getCommandHandler(command: string): CommandHandler;
  setCommandHandler(command: string, handler: CommandHandler): void;
}
type CommandHandler = (
  connection: { send(response: object, description: string, parsed: unknown, data: unknown): void },
  parsed: { tag: string },
  data: unknown,
  callback: () => void,
) => unknown;
const hoodiecrow = require("hoodiecrow-imap") as (options: object) => Hoodiecrow;

export const USER = "me@mail.example";
export const PASSWORD = "test-password";

export interface MailHost {
  imapPort: number;
  smtpPort: number;
  /** Raw messages the SMTP server received. */
  received: Buffer[];
  /** Credentials as a person would type them. */
  credentials(password?: string, address?: string): ImapCredentials;
  /** Puts a raw message into INBOX, unread, as if it had just arrived. */
  deliver(raw: string): void;
  /** Puts a raw message into a folder with these flags, as mail that was already there (arrived `at`, default now). */
  append(folder: string, raw: string, flags?: string[], at?: Date): void;
  /** Changes the account's password at the server. */
  setPassword(password: string): void;
  /**
   * The next time a client sends this command (for example "UID MOVE"), the server answers NO with this text, but
   * only once `release` is called. `reached` resolves when the command arrives.
   */
  refuseOnce(command: string, text: string): { reached: Promise<void>; release(): void };
  /** Another mail app, connected while `fn` runs. */
  otherApp<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  /** Every message in every folder: its folder, subject, Message-ID and flags (keywords included). */
  folders(): Promise<Array<{ folder: string; subject: string; messageId: string; flags: string[]; uid: number }>>;
  close(): Promise<void>;
}

export async function startMailHost(): Promise<MailHost> {
  const imap = hoodiecrow({
    plugins: ["ENABLE", "CONDSTORE", "IDLE", "SPECIAL-USE", "NAMESPACE", "UIDPLUS", "MOVE", "ID", "UNSELECT", "LITERALPLUS"],
    storage: {
      INBOX: {},
      "": {
        separator: "/",
        folders: {
          Archive: { "special-use": "\\Archive" },
          Sent: { "special-use": "\\Sent" },
          Trash: { "special-use": "\\Trash" },
          Junk: { "special-use": "\\Junk" },
        },
      },
    },
    users: { [USER]: { password: PASSWORD } },
  });
  await new Promise<void>((resolve) => imap.listen(0, "127.0.0.1", resolve));
  const received: Buffer[] = [];
  const smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    logger: false,
    onAuth: (_auth, _session, callback) => callback(null, { user: USER }),
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push(Buffer.concat(chunks));
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const imapPort = imap.address().port;
  const smtpPort = (smtp.server.address() as { port: number }).port;
  let password = PASSWORD;

  const host: MailHost = {
    imapPort,
    smtpPort,
    received,
    credentials: (pass = password, address) => ({
      imap: { host: "127.0.0.1", port: imapPort, secure: false, user: USER, password: pass },
      smtp: { host: "127.0.0.1", port: smtpPort, secure: false, user: USER, password: pass },
      ...(address && { address }),
    }),
    deliver: (raw) => void imap.appendMessage("INBOX", [], new Date(), Buffer.from(raw).toString("binary")),
    append: (folder, raw, flags = [], at = new Date()) => void imap.appendMessage(folder, flags, at, Buffer.from(raw).toString("binary")),
    setPassword(next) {
      password = next;
      imap.users[USER]!.password = next;
    },
    refuseOnce(command, text) {
      const handler = imap.getCommandHandler(command);
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      imap.setCommandHandler(command, (connection, parsed, data, callback) => {
        imap.setCommandHandler(command, handler);
        arrived();
        void released.then(() => {
          connection.send({ tag: parsed.tag, command: "NO", attributes: [{ type: "TEXT", value: text }] }, `${command} REFUSED`, parsed, data);
          callback();
        });
      });
      return { reached, release };
    },
    async otherApp(fn) {
      const client = new ImapFlow({ host: "127.0.0.1", port: imapPort, secure: false, auth: { user: USER, pass: password }, logger: false, disableAutoIdle: true });
      client.on("error", () => {});
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
    folders: () => host.otherApp(async (client) => {
      const out: Awaited<ReturnType<MailHost["folders"]>> = [];
      const paths = new Set(["INBOX", ...(await client.list()).filter((f) => !f.flags.has("\\Noselect")).map((f) => f.path)]);
      for (const folder of paths) {
        const lock = await client.getMailboxLock(folder);
        try {
          if (!client.mailbox || client.mailbox.exists === 0) continue;
          for await (const item of client.fetch("1:*", { uid: true, flags: true, envelope: true })) {
            out.push({
              folder,
              uid: item.uid,
              subject: item.envelope?.subject ?? "",
              messageId: (item.envelope?.messageId ?? "").replace(/^<|>$/g, ""),
              flags: [...(item.flags ?? [])].sort(),
            });
          }
        } finally {
          lock.release();
        }
      }
      return out;
    }),
    async close() {
      await new Promise<void>((resolve) => imap.close(() => resolve()));
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    },
  };
  return host;
}

/** A raw message. Addresses end in .example. */
export function rawMail(input: { from: string; to?: string; subject: string; body?: string; messageId: string; inReplyTo?: string; headers?: Record<string, string>; date?: Date }): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to ?? USER}`,
    `Subject: ${input.subject}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
  ];
  if (input.inReplyTo) lines.push(`In-Reply-To: <${input.inReplyTo}>`, `References: <${input.inReplyTo}>`);
  for (const [name, value] of Object.entries(input.headers ?? {})) lines.push(`${name}: ${value}`);
  lines.push("Content-Type: text/plain; charset=utf-8", "", input.body ?? `Body of ${input.subject}`, "");
  return lines.join("\r\n");
}
