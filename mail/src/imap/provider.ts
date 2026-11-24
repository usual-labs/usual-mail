/**
 * The IMAP with SMTP provider. Holds one IMAP connection for sync, moves and attachments, one more per
 * watcher, and opens SMTP only to send. Everything else (store, cursor, decisions) belongs to the server.
 */
import type { ImapCredentials, MailProvider, ProviderOptions } from "@usualmail/core";
import { applyImap } from "./apply.ts";
import { DEFAULT_TIMEOUTS, ImapConnection, type ConnectionTimeouts } from "./connection.ts";
import { decodeRef } from "./cursor.ts";
import { OwnMoves } from "./own-moves.ts";
import { sendImap, smtpTransport } from "./send.ts";
import { DEFAULT_LIMIT, syncImap } from "./sync.ts";
import { watchInbox } from "./watch.ts";
import { attachmentContent } from "../message/parse.ts";
import { resolveNames } from "../names.ts";
import { checkLimit, checkSince } from "../options.ts";

export interface ImapProviderOptions extends ProviderOptions {
  timeouts?: Partial<ConnectionTimeouts>;
}

export function createImapProvider(credentials: unknown, options: ImapProviderOptions = {}): MailProvider {
  const creds = checkImapCredentials(credentials);
  checkSince(options.since);
  const names = resolveNames(options);
  const timeouts: ConnectionTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const connection = new ImapConnection(creds.imap, timeouts);
  const address = (creds.address ?? (creds.imap.user.includes("@") ? creds.imap.user : "")).trim().toLowerCase();
  const ownAddresses = address ? [address] : [];
  const watchers = new Set<() => Promise<void>>();
  const own = new OwnMoves();

  return {
    kind: "imap",

    connection() {
      const login = (server: ImapCredentials["imap"]) => ({ host: server.host, port: server.port, secure: server.secure, user: server.user });
      return { kind: "imap", imap: login(creds.imap), smtp: login(creds.smtp), saveSent: creds.saveSent ?? true };
    },

    async verify() {
      await connection.client();
      const transport = smtpTransport(creds.smtp, timeouts);
      try {
        await transport.verify();
      } catch (error) {
        throw new Error(`The SMTP server at ${creds.smtp.host} refused the connection or login: ${(error as Error).message}`);
      } finally {
        transport.close();
      }
      if (!address) throw new Error("The IMAP login isn't an email address. Give the mailbox's address as well.");
      return { address };
    },

    sync(cursor, syncOptions) {
      return syncImap(connection, cursor, checkLimit(syncOptions?.limit, DEFAULT_LIMIT), { names, ownAddresses, since: options.since, own });
    },

    async fetchAttachment(ref, attachmentId) {
      const location = decodeRef(ref);
      if (!location) throw new Error("This isn't a ref from this IMAP mailbox.");
      const source = await connection.withMailbox(location.path, async (client, mailbox) => {
        if (mailbox.uidValidity.toString() !== location.uidValidity) return undefined;
        const item = await client.fetchOne(String(location.uid), { uid: true, source: true }, { uid: true });
        return item ? item.source : undefined;
      });
      if (!source) throw new Error("The message is no longer where Usual Mail last saw it. Sync again.");
      const content = await attachmentContent(source, attachmentId);
      if (!content) throw new Error("The message has no such attachment.");
      return content;
    },

    apply(ops) {
      return applyImap(connection, ops, names, own);
    },

    send(message) {
      return sendImap(connection, creds.smtp, message, names, { saveSent: creds.saveSent ?? true, timeouts });
    },

    async watch(onChange) {
      const stop = await watchInbox(creds.imap, timeouts, onChange);
      const stopOnce = async () => {
        if (!watchers.delete(stopOnce)) return;
        await stop();
      };
      watchers.add(stopOnce);
      return stopOnce;
    },

    async close() {
      await Promise.all([...watchers].map((stop) => stop()));
      await connection.close();
    },
  };
}

function checkImapCredentials(value: unknown): ImapCredentials {
  const creds = value as Partial<ImapCredentials> | undefined;
  const server = (name: "imap" | "smtp") => {
    const s = creds?.[name] as Partial<ImapCredentials["imap"]> | undefined;
    if (!s || typeof s.host !== "string" || !s.host) throw new Error(`IMAP credentials need ${name}.host.`);
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`IMAP credentials need a valid ${name}.port.`);
    if (typeof s.secure !== "boolean") throw new Error(`IMAP credentials need ${name}.secure.`);
    if (typeof s.user !== "string" || typeof s.password !== "string") throw new Error(`IMAP credentials need ${name}.user and ${name}.password.`);
  };
  server("imap");
  server("smtp");
  if (creds!.address !== undefined && (typeof creds!.address !== "string" || !creds!.address.includes("@"))) {
    throw new Error("The mailbox address must be an email address.");
  }
  if (creds!.saveSent !== undefined && typeof creds!.saveSent !== "boolean") throw new Error("IMAP credentials' saveSent must be true or false.");
  return creds as ImapCredentials;
}
