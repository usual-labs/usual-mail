// What the first-sync tests share: history to connect with, a slow mailbox, and what the inbox's events and row said.

import type { Inbox, MailEvent, MailProvider, SyncOptions } from "@usualmail/core";
import { sql } from "drizzle-orm";
import { MemoryMailbox, type MemoryMailboxOptions, type MemoryProvider } from "../src/testing/index.ts";
import { at, HOUR, type TestServer } from "./helpers.ts";

/** `n` messages already in the mailbox, from different people, the newest an hour before the test's start. */
export const history = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ from: { email: `p${i}@people.example` }, subject: `Old ${i}`, text: `Note ${i}.`, date: at(-(n - i) * HOUR) }));

/**
 * Every provider the server opens runs `before` at the start of each sync call: a slow mailbox moves the clock, and may
 * say how far it got meanwhile through `onProgress`. `call` counts every provider's calls together; `address` is the
 * mailbox this call is for.
 */
export function slow(s: TestServer, before: (call: number, options: SyncOptions | undefined, address: string) => void | Promise<void>): void {
  let calls = 0;
  for (const kind of ["imap", "gmail"] as const) {
    const factory = s.providers.get(kind)!;
    s.providers.register(kind, (credentials, options) => {
      const provider = factory(credentials, options) as MailProvider;
      const address = (credentials as { mailbox: string }).mailbox;
      const sync = provider.sync.bind(provider);
      provider.sync = async (cursor, syncOptions) => {
        await before(++calls, syncOptions, address);
        return sync(cursor, syncOptions);
      };
      return provider;
    });
  }
}

/** A provider the server opened for a sync: its mailbox, the cursor of each sync call, and whether it was closed. */
export interface Opened {
  address: string;
  provider: MemoryProvider;
  cursors: Array<string | null>;
}

/**
 * Records every provider the server opens and syncs with (a provider opened only to check credentials asks nothing).
 * Call after `slow`, so each call is recorded before the slow mailbox runs.
 */
export function syncedProviders(s: TestServer): Opened[] {
  const opened: Opened[] = [];
  for (const kind of ["imap", "gmail"] as const) {
    const factory = s.providers.get(kind)!;
    s.providers.register(kind, (credentials, options) => {
      const provider = factory(credentials, options) as MemoryProvider;
      const record: Opened = { address: (credentials as { mailbox: string }).mailbox, provider, cursors: [] };
      const sync = provider.sync.bind(provider);
      provider.sync = (cursor, syncOptions) => {
        if (record.cursors.length === 0) opened.push(record);
        record.cursors.push(cursor);
        return sync(cursor, syncOptions);
      };
      return provider;
    });
  }
  return opened;
}

/** Whether `work` settles within `ms` of real time (the tests' clock moves only when a test moves it). */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connects a memory mailbox holding `messages` of history and returns at once, while its first sync runs: unlike the
 * helpers' `connect`, it asks for no sync of its own, which a pause or removal meanwhile would refuse.
 */
export async function connectNow(s: TestServer, address: string, messages: number, options: Partial<MemoryMailboxOptions> = {}): Promise<Inbox> {
  const mailbox = new MemoryMailbox({ address, now: () => s.clock.now(), ...options });
  s.mailboxes.set(mailbox.address, mailbox);
  for (const message of history(messages)) mailbox.deliver(message);
  return s.server.connectInbox(s.person, { name: address, color: "#2F6FED", provider: mailbox.kind, credentials: { mailbox: address }, trust: "act_with_undo" });
}

/** What `inbox.changed` events said, of every inbox or only `inboxId`: version, status and count. */
export const said = (events: MailEvent[], inboxId?: string) =>
  events.flatMap((e) => (e.type === "inbox.changed" && (inboxId === undefined || e.inbox.id === inboxId) ? [[e.inbox.version, e.inbox.status, e.inbox.firstSync ?? null]] : []));

/** The count kept on the inbox's row (the only inbox, or `inboxId`'s). */
export const stored = async (s: TestServer, inboxId?: string) =>
  (await s.host.db.all<{ fetched: number | null; total: number | null }>(
    inboxId === undefined
      ? sql`SELECT first_sync_fetched AS fetched, first_sync_total AS total FROM inboxes`
      : sql`SELECT first_sync_fetched AS fetched, first_sync_total AS total FROM inboxes WHERE id = ${inboxId}`,
  ))[0];
