/**
 * @usualmail/mail/gmail: the Gmail provider alone, for hosts that don't run IMAP (the Cloudflare host). Nothing
 * reachable from here imports ImapFlow, the SMTP client or any IMAP code; sending composes with Nodemailer's
 * `MailComposer` only (message/compose.ts). `test/unit/gmail-entry.test.ts` checks the import graph.
 */
export {
  createGate,
  createGmailProvider,
  GMAIL_SMALL_MEMORY,
  type GmailProviderOptions,
  type MessageGate,
} from "./provider.ts";
export { GmailApiError, GoogleTokenError, type FetchLike } from "./client.ts";
