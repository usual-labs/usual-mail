/**
 * @usualmail/mail: the mail providers behind core's MailProvider interface.
 */
import type { ProviderFactory } from "@usualmail/core";
import { createGmailProvider } from "./gmail/provider.ts";
import { createImapProvider } from "./imap/provider.ts";

export {
  createGate,
  createGmailProvider,
  GMAIL_SMALL_MEMORY,
  GmailApiError,
  GoogleTokenError,
  type FetchLike,
  type GmailProviderOptions,
  type MessageGate,
} from "./gmail/index.ts";
export { createImapProvider, type ImapProviderOptions } from "./imap/provider.ts";
export { sanitizeHtml } from "./message/sanitize.ts";
export {
  canonicalPictureUrl,
  remotePictures,
  rewritePictures,
  type PictureDecision,
  type PictureHook,
  type PictureSite,
  type RemotePicture,
} from "./message/pictures.ts";
export { htmlToText } from "./message/html-to-text.ts";
export { attachmentContent, parseMessage, type ParsedMessage, type ParseContext } from "./message/parse.ts";
export {
  fromAuthentication,
  GMAIL_CHECKER,
  parseAuthenticationResults,
  type AuthenticationOptions,
  type FromAuthentication,
  type HeaderField,
} from "./message/auth-results.ts";
export { DEFAULT_NAMES, keywordFor } from "./names.ts";

/** Both factories, checked against core's ProviderFactory. */
export const providers = {
  imap: createImapProvider,
  gmail: createGmailProvider,
} satisfies Record<"imap" | "gmail", ProviderFactory>;
