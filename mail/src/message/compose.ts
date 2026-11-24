/**
 * Builds the raw RFC 5322 form of an outgoing message with Nodemailer's MailComposer, so SMTP, the IMAP
 * Sent folder and Gmail all get the same bytes and the same Message-ID.
 */
import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Address, OutgoingMessage } from "@usualmail/core";

export interface ComposedMessage {
  /** Without Bcc: what recipients get over SMTP. */
  raw: Buffer;
  /** With Bcc: for the sender's own Sent copy, and for Gmail, which removes Bcc before delivery. */
  rawWithBcc: Buffer;
  /** Without angle brackets. */
  messageId: string;
  /** Every recipient, for the SMTP envelope. */
  recipients: string[];
}

export async function composeMessage(message: OutgoingMessage, date = new Date()): Promise<ComposedMessage> {
  const domain = message.from.email.split("@")[1]?.trim() || "usual-mail.invalid";
  const messageId = `${randomUUID()}@${domain}`;
  const references = [...(message.references ?? [])];
  if (message.inReplyTo && !references.includes(message.inReplyTo)) references.push(message.inReplyTo);
  const build = async (keepBcc: boolean) => {
    const node = new MailComposer({
      from: toNodemailer(message.from),
      to: message.to.map(toNodemailer),
      cc: message.cc.map(toNodemailer),
      bcc: message.bcc.map(toNodemailer),
      subject: message.subject,
      text: message.text,
      messageId: `<${messageId}>`,
      date,
      inReplyTo: message.inReplyTo ? `<${message.inReplyTo}>` : undefined,
      references: references.length ? references.map((id) => `<${id}>`) : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
      newline: "\r\n",
    }).compile();
    node.keepBcc = keepBcc;
    return node.build();
  };
  const recipients = [...message.to, ...message.cc, ...message.bcc].map((address) => address.email);
  if (!recipients.length) throw new Error("The message has no recipients.");
  return { raw: await build(false), rawWithBcc: await build(true), messageId, recipients };
}

function toNodemailer(address: Address): { name: string; address: string } {
  return { name: address.name ?? "", address: address.email };
}
