/**
 * Sending through SMTP, then saving the same message in the Sent folder so it shows up in the next sync
 * as outgoing and in its thread. Most IMAP servers don't save sent mail themselves; for those that do
 * (Gmail, Outlook.com, some hosted servers), the credentials say `saveSent: false` to avoid a second copy.
 */
import { createTransport } from "nodemailer";
import type { ImapCredentials, OutgoingMessage, SendResult } from "@usualmail/core";
import { isLoopback, type ConnectionTimeouts, type ImapConnection } from "./connection.ts";
import { CREATE_NAMES, createFolder, discoverFolders } from "./folders.ts";
import { composeMessage } from "../message/compose.ts";
import type { Names } from "../names.ts";

export function smtpTransport(smtp: ImapCredentials["smtp"], timeouts: ConnectionTimeouts) {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Without implicit TLS, insist on STARTTLS except on this machine.
    requireTLS: !smtp.secure && !isLoopback(smtp.host),
    // Bridges on this machine use self-signed certificates; traffic never leaves it.
    ...(isLoopback(smtp.host) ? { tls: { rejectUnauthorized: false } } : {}),
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
  });
}

export async function sendImap(
  connection: ImapConnection,
  smtp: ImapCredentials["smtp"],
  message: OutgoingMessage,
  names: Names,
  options: { saveSent: boolean; timeouts: ConnectionTimeouts },
): Promise<SendResult> {
  const composed = await composeMessage(message);
  const transport = smtpTransport(smtp, options.timeouts);
  try {
    await transport.sendMail({ envelope: { from: message.from.email, to: composed.recipients }, raw: composed.raw });
  } catch (error) {
    throw new Error(`The SMTP server at ${smtp.host} didn't take the message: ${(error as Error).message}`);
  } finally {
    transport.close();
  }
  if (options.saveSent) {
    try {
      // No retry: an APPEND cut off by a dropped connection may already have landed.
      await connection.run(async (client) => {
        const map = await discoverFolders(client, names);
        const sent = map.byRole.sent ?? (await createFolder(client, CREATE_NAMES.sent!));
        await client.append(sent, composed.rawWithBcc, ["\\Seen"]);
      }, false);
    } catch (error) {
      // The message went out; failing here would invite sending it twice. Say that its Sent copy is missing.
      const reason = (error as { responseText?: string; message?: string })?.responseText || (error as Error)?.message || String(error);
      return { messageId: composed.messageId, note: `Sent, but no copy was saved to the Sent folder: ${reason}` };
    }
  }
  return { messageId: composed.messageId };
}
