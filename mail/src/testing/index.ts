/**
 * @usualmail/mail/testing: the shared provider contract suite, `syncAll` (a server's view of a sync), a fake
 * of Gmail's API and of Google's sign-in, and test message builders. For tests only.
 */
export { destinations, providerContract, type ContractHarness, type Destination, type FiledTo } from "./contract.ts";
export { applyTracked, batchOf, syncAll, track, type BatchLog, type SyncResult } from "./sync-all.ts";
export { FakeGmail, type Fault, type FakeGmailOptions, type LoggedRequest } from "./fake-gmail/index.ts";
export { FakeGoogle, GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, type Consent, type FakeGoogleOptions } from "./fake-google.ts";
export { everyByte, messageWithAttachments, newMessageId, plainMessage, TINY_PNG, type TestAttachment, type TestMessage } from "./messages.ts";
