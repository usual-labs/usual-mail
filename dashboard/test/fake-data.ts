// What the dashboard's fake service starts from: the sample, the tokens and pairing codes it knows, and helpers that
// don't need its state. Split from fake-service.ts to keep that file to its behaviour.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GmailCredentials, ImapCredentials, Inbox, InboxConnection, SampleData } from "@usualmail/core";

export const SAMPLE: SampleData = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@usualmail/core/fixtures/sample.json")), "utf8"),
);

/** The browser signed in as a person. */
export const PERSON_TOKEN = "umt_person_web_dashboard_token";
export const PERSON_DEVICE = "dev_web_1";
/** An agent's token, which the dashboard must refuse. */
export const AGENT_TOKEN = "umt_agent_claude_code_token";
/** Pairing codes the fake knows from the start. */
export const GOOD_CODE = "K7Q2-9MPX";
export const AGENT_CODE = "AG3N-7C0D";

export interface Call {
  method: string;
  args: unknown[];
}

export const notUsed = (name: string) => (): never => {
  throw new Error(`FakeService.${name} is not used by the dashboard`);
};

/** What the server keeps of credentials to show again: never a password, secret or token. */
export function connectionOf(provider: Inbox["provider"], credentials: unknown): InboxConnection {
  if (provider === "gmail") return { kind: "gmail", clientId: (credentials as GmailCredentials).clientId };
  const imap = credentials as ImapCredentials;
  const login = ({ host, port, secure, user }: ImapCredentials["imap"]) => ({ host, port, secure, user });
  return { kind: "imap", imap: login(imap.imap), smtp: login(imap.smtp), saveSent: imap.saveSent ?? true };
}
