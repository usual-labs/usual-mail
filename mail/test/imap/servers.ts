/**
 * Test servers for the IMAP provider: hoodiecrow (a strict, in-process IMAP server made for testing IMAP
 * clients) in two shapes, and an SMTP sink that accepts anything and keeps nothing.
 */
import { createRequire } from "node:module";
import { ImapFlow } from "imapflow";
import { SMTPServer } from "smtp-server";
import type { ImapCredentials } from "@usualmail/core";
import type { ImapTestHarness } from "./scenarios.ts";
import { createImapProvider, type ImapProviderOptions } from "../../src/index.ts";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap") as (options: object) => HoodiecrowServer;

export interface HoodiecrowServer {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number };
  appendMessage(mailbox: string, flags: string[], internalDate: Date | false, raw: string): unknown;
  getMailbox(path: string): { messages: { uid: number }[] } | undefined;
  copyMessage(mailbox: object, source: object): unknown;
  getCommandHandler(command: string): CommandHandler;
  setCommandHandler(command: string, handler: CommandHandler): void;
}

export type CommandHandler = (connection: unknown, parsed: { attributes?: { value?: unknown }[] }, data: unknown, callback: unknown) => unknown;

export interface ServerProfile {
  name: string;
  plugins: string[];
  storage: object;
  /** Whether mailboxes accept custom keywords. */
  keywords: boolean;
  /** The junk folder's path, when the server has one. */
  junk?: string;
}

/** A current server: CONDSTORE, MOVE, UIDPLUS, SPECIAL-USE, IDLE, "/" as delimiter, no namespace prefix. */
export const MODERN: ServerProfile = {
  name: "CONDSTORE, MOVE, UIDPLUS, SPECIAL-USE, IDLE",
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
        Drafts: { "special-use": "\\Drafts" },
      },
    },
  },
  keywords: true,
  junk: "Junk",
};

/**
 * An older server: plain IMAP4rev1 with NAMESPACE only. No CONDSTORE, MOVE, UIDPLUS, SPECIAL-USE or IDLE;
 * folders live under "INBOX." with "." as delimiter and Outlook-style names, and there is no archive.
 */
export const BARE: ServerProfile = {
  name: "IMAP4rev1 only, INBOX. namespace, no archive",
  plugins: ["NAMESPACE"],
  storage: {
    INBOX: {},
    "INBOX.": { folders: { "Sent Items": {}, "Deleted Items": {}, "Junk E-mail": {} } },
  },
  keywords: true,
  junk: "INBOX.Junk E-mail",
};

/** Like BARE, but no mailbox takes custom keywords. */
export const NO_KEYWORDS: ServerProfile = {
  name: "no custom keywords",
  plugins: ["NAMESPACE", "UIDPLUS", "MOVE"],
  storage: {
    INBOX: { allowPermanentFlags: false },
    "": { separator: "/", folders: { Sent: { allowPermanentFlags: false }, Trash: { allowPermanentFlags: false } } },
  },
  keywords: false,
};

export const USER = "me@mail.example";
export const PASSWORD = "test-password";

export async function startHoodiecrow(profile: ServerProfile): Promise<{ server: HoodiecrowServer; port: number; close(): Promise<void> }> {
  const server = hoodiecrow({ plugins: profile.plugins, storage: profile.storage, users: { [USER]: { password: PASSWORD } } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export interface SmtpSink {
  port: number;
  received: Buffer[];
  close(): Promise<void>;
}

/** Accepts every message without TLS or a login check, and remembers what it got. */
export async function startSmtpSink(): Promise<SmtpSink> {
  const received: Buffer[] = [];
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    logger: false,
    onAuth(_auth, _session, callback) {
      callback(null, { user: "anyone" });
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push(Buffer.concat(chunks));
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as { port: number }).port;
  return { port, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Another mail app: finds the message by Message-ID in any folder and deletes it for good. */
export async function deleteByMessageId(imap: { host: string; port: number; user: string; password: string }, messageId: string): Promise<void> {
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: false, auth: { user: imap.user, pass: imap.password }, logger: false, disableAutoIdle: true });
  client.on("error", () => {});
  await client.connect();
  try {
    let deleted = 0;
    // Some servers (hoodiecrow with an "INBOX." namespace) don't list INBOX itself.
    const paths = new Set(["INBOX", ...(await client.list()).filter((f) => !f.flags.has("\\Noselect")).map((f) => f.path)]);
    for (const path of paths) {
      const lock = await client.getMailboxLock(path);
      try {
        const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
        if (uids && uids.length) {
          await client.messageDelete(uids, { uid: true });
          deleted += uids.length;
        }
      } finally {
        lock.release();
      }
    }
    if (!deleted) throw new Error(`No message ${messageId} to delete`);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function hoodiecrowHarness(
  profile: ServerProfile,
  options: ImapProviderOptions = {},
  extra: Pick<ImapCredentials, "saveSent"> = {},
): Promise<ImapTestHarness & { imapPort: number; server: HoodiecrowServer; smtp: SmtpSink }> {
  const imap = await startHoodiecrow(profile);
  const smtp = await startSmtpSink();
  const login = { host: "127.0.0.1", port: imap.port, user: USER, password: PASSWORD };
  const credentials: ImapCredentials = {
    imap: { ...login, secure: false },
    smtp: { host: "127.0.0.1", port: smtp.port, secure: false, user: USER, password: PASSWORD },
    ...extra,
  };
  const provider = createImapProvider(credentials, options);
  return {
    provider,
    address: USER,
    login,
    imapPort: imap.port,
    server: imap.server,
    smtp,
    deliver: async (raw) => {
      imap.server.appendMessage("INBOX", [], new Date(), Buffer.from(raw).toString("binary"));
    },
    appendAt: async (raw, at) => {
      imap.server.appendMessage("INBOX", [], at, Buffer.from(raw).toString("binary"));
    },
    reopen: (more) => createImapProvider(credentials, { ...options, ...more }),
    removeExternally: (messageId) => deleteByMessageId(login, messageId),
    // A server-side rule filing mail on arrival: into the junk folder, or (through a second provider, so this one
    // never sees it in INBOX and the folder is made as this provider would make it) into the archive or a pile's
    // folder.
    deliverFiled: async (raw, to) => {
      if (to === "spam") {
        if (!profile.junk) return false;
        imap.server.appendMessage(profile.junk, [], new Date(), Buffer.from(raw).toString("binary"));
        return true;
      }
      const messageId = /^Message-ID: <([^>]+)>/im.exec(raw)?.[1];
      imap.server.appendMessage("INBOX", [], new Date(), Buffer.from(raw).toString("binary"));
      const mover = createImapProvider(credentials, options);
      try {
        let found: string | undefined;
        for (let cursor: string | null = null, more = true; more && !found;) {
          const batch = await mover.sync(cursor, { limit: 500 });
          found = batch.upserted.find((m) => m.messageId === messageId && m.placement.inInbox)?.ref;
          cursor = batch.cursor;
          more = batch.more;
        }
        if (!found) throw new Error(`The filed message ${messageId} never showed up in INBOX`);
        const [result] = await mover.apply([{ op: "place", ref: found, inInbox: false, category: to === "archive" || to === "screening" ? null : to, screened: to === "screening" }]);
        if (!result?.ok) throw new Error(`Filing failed: ${result?.error}`);
      } finally {
        await mover.close();
      }
      return true;
    },
    // Another mail app moving the message from the junk folder to INBOX: it gets a new UID there.
    ...(profile.junk && {
      takeOutOfSpam: async (messageId: string) => {
        const client = new ImapFlow({ host: login.host, port: login.port, secure: false, auth: { user: login.user, pass: login.password }, logger: false, disableAutoIdle: true });
        client.on("error", () => {});
        await client.connect();
        try {
          const lock = await client.getMailboxLock(profile.junk!);
          try {
            const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
            if (!uids || uids.length === 0) throw new Error(`No message ${messageId} in ${profile.junk}`);
            if (!(await client.messageMove(uids, "INBOX", { uid: true }))) throw new Error(`Couldn't move ${messageId} to INBOX`);
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => client.close());
        }
      },
    }),
    secrets: [PASSWORD],
    close: async () => {
      await provider.close();
      await Promise.all([imap.close(), smtp.close()]);
    },
    supports: { keywords: profile.keywords },
  };
}
