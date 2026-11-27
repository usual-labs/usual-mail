// A server on an in-memory store with a manual clock and memory mailboxes, plus shortcuts the tests share.

import type { Caller, FirstSyncSource, Inbox, MailEvent, Thread, TrustLevel } from "@usualmail/core";
import { FakeModels, MemoryEventBus, ProviderRegistry, webRandom, aesGcmSecrets, type Host, type Log, type PictureSource } from "../src/index.ts";
import type { AvatarOptions } from "../src/avatars/service.ts";
import type { HostLimits, SiteIconSource } from "../src/host.ts";
import { openDatabase } from "../src/node/db.ts";
import { MailServer } from "../src/service/server.ts";
import { ManualClock, MemoryMailbox, memoryFactory, type DeliverInput, type MemoryMailboxOptions } from "../src/testing/index.ts";

export const START = "2026-11-16T09:30:00Z";
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
/** A made-up AI key. Tests check it appears nowhere a person, an agent or a log could read it. */
export const TEST_KEY = "vck_test-key-1f5e9a7c3b2d4e6f8a0b";

export interface TestServer {
  server: MailServer;
  clock: ManualClock;
  host: Host;
  /** Memory mailboxes for "imap" and "gmail"; a test may register its own provider for either. */
  providers: ProviderRegistry;
  mailboxes: Map<string, MemoryMailbox>;
  errors: string[];
  /** What the server logged as information, such as notes from a provider. */
  infos: string[];
  person: Caller;
  personToken: string;
  /** The fake models the server's AI reaches. Nothing real is ever called. */
  models: FakeModels;
  close(): Promise<void>;
  /** Sets AI credentials (the test key, through Vercel's gateway) and turns AI processing on for these inboxes. */
  /** Sets an AI key: from then on every inbox's mail is processed. */
  aiOn(): Promise<void>;
  /** Moves the clock and waits for what that set off: timers, syncs, the AI, notices of changes. */
  tick(ms?: number): Promise<void>;
  connect(options: ConnectOptions): Promise<{ inbox: Inbox; mailbox: MemoryMailbox }>;
  agent(inboxIds: string[], name?: string): Promise<{ caller: Caller; token: string }>;
  /** Delivers mail to a mailbox and syncs its inbox. */
  receive(inbox: Inbox, input: DeliverInput): Promise<Thread>;
  sync(inbox: Inbox): Promise<void>;
  threadBySubject(subject: string): Promise<Thread>;
}

export interface ConnectOptions {
  address: string;
  name?: string;
  trust?: TrustLevel;
  agentAccess?: boolean;
  /** Mail already in the mailbox before it is connected: its history. */
  history?: DeliverInput[];
  mailbox?: Partial<MemoryMailboxOptions>;
}

export interface MakeOptions {
  /** The AI processes history in the background. Default true. */
  aiHistory?: boolean;
  syncWindowDays?: number;
  syncWindowSetBy?: FirstSyncSource;
  /** Where a new first-sync window is kept; absent, it can't be changed (as in demo mode). */
  saveSyncWindowDays?: (days: number) => Promise<void>;
  /** Pictures from the web; absent, the server has none (as in demo mode). */
  pictures?: PictureSource;
  /** Sender pictures: the suffix list and queue limits. Absent: the shipped list (none yet), so none. */
  avatars?: AvatarOptions;
  /** Where sender pictures are fetched from; absent, nothing is fetched. */
  siteIcons?: SiteIconSource;
  /** The host's limits on memory and stored size; absent, Node's. */
  limits?: HostLimits;
  /** Batches one sync takes before it queues the next; absent, the service's 10,000. */
  syncRounds?: number;
  /** Sends a sender's one-click unsubscribe; absent, none is sent (as in demo mode). */
  oneClick?: (url: string) => Promise<number>;
  /** The browser agent's service: a fake fetch in place of Browser Use's, or `off` as in demo mode. */
  browserAgent?: { fetch?: typeof fetch; base?: string; off?: boolean };
}

export async function makeServer(options: MakeOptions = {}): Promise<TestServer> {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(START);
  const errors: string[] = [];
  const infos: string[] = [];
  const log: Log = { info: (message) => infos.push(message), error: (message, error) => errors.push(`${message} ${error ?? ""}`.trim()) };
  const host: Host = {
    db: store.db,
    clock,
    scheduler: clock,
    random: webRandom,
    events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log,
    ...(options.pictures && { pictures: options.pictures }),
    ...(options.siteIcons && { siteIcons: options.siteIcons }),
    ...(options.limits && { limits: options.limits }),
    ...(options.oneClick && { oneClick: options.oneClick }),
  };
  const mailboxes = new Map<string, MemoryMailbox>();
  const providers = new ProviderRegistry();
  providers.register("imap", memoryFactory(mailboxes, { kind: "imap", now: () => clock.now() }));
  providers.register("gmail", memoryFactory(mailboxes, { kind: "gmail", now: () => clock.now() }));
  const models = new FakeModels();
  const server = await MailServer.create(host, {
    providers,
    models,
    pollIntervalMs: 60_000,
    ...(options.aiHistory !== undefined && { aiHistory: options.aiHistory }),
    ...(options.syncWindowDays !== undefined && { syncWindowDays: options.syncWindowDays }),
    ...(options.syncWindowSetBy !== undefined && { syncWindowSetBy: options.syncWindowSetBy }),
    ...(options.saveSyncWindowDays !== undefined && { saveSyncWindowDays: options.saveSyncWindowDays }),
    ...(options.avatars && { avatars: options.avatars }),
    ...(options.syncRounds !== undefined && { syncRounds: options.syncRounds }),
    ...(options.browserAgent && { browserAgent: options.browserAgent }),
  });
  await server.start();
  const code = await server.ownerPairingCode();
  const paired = await server.pair({ code: code!.code, name: "Test Mac" });
  const person = (await server.authenticate(paired.token))!;

  const t: TestServer = {
    server,
    clock,
    host,
    providers,
    mailboxes,
    errors,
    infos,
    person,
    personToken: paired.token,
    models,
    async aiOn() {
      await server.updateAiSettings(person, { credentials: { kind: "gateway", gateway: "vercel", apiKey: TEST_KEY } });
      await server.whenIdle();
      // What the settings' own test sent isn't mail; tests look at what the processing sends.
      models.requests.length = 0;
    },
    async tick(ms = 1_000) {
      clock.advance(ms);
      await server.whenIdle();
    },
    async close() {
      await server.stop();
      store.close();
    },
    async connect(options) {
      const mailbox = new MemoryMailbox({ address: options.address, now: () => clock.now(), ...options.mailbox });
      mailboxes.set(mailbox.address, mailbox);
      for (const message of options.history ?? []) mailbox.deliver(message);
      let inbox = await server.connectInbox(person, {
        name: options.name ?? options.address,
        color: "#2F6FED",
        provider: mailbox.kind,
        credentials: { mailbox: options.address },
        trust: options.trust ?? "act_with_undo",
      });
      if (options.agentAccess) inbox = await server.updateInbox(person, inbox.id, { agentAccess: true });
      await t.sync(inbox);
      return { inbox, mailbox };
    },
    async agent(inboxIds, name = "Test Agent") {
      const code = await server.createPairingCode(person, { kind: "agent", inboxIds });
      const { token } = await server.pair({ code: code.code, name });
      return { caller: (await server.authenticate(token))!, token };
    },
    async receive(inbox, input) {
      const mailbox = mailboxes.get(inbox.address)!;
      const message = mailbox.deliver(input);
      await t.sync(inbox);
      return t.threadBySubject(message.subject);
    },
    async sync(inbox) {
      await server.syncInbox(person, inbox.id);
      await server.whenIdle();
    },
    async threadBySubject(subject) {
      const page = await server.search(person, { q: subject, limit: 200 });
      const found = page.items.find((thread) => thread.subject === subject);
      if (!found) throw new Error(`No thread "${subject}"`);
      // The thread as lists give it, without where the search matched.
      const { match: _match, ...thread } = found;
      return thread;
    },
  };
  return t;
}

export function at(offsetMs: number): string {
  return new Date(Date.parse(START) + offsetMs).toISOString();
}

/** Someone the inbox already knows: their mail was in the mailbox before it was connected. */
export const KNOWN = { name: "Dana Whitfield", email: "dana@lumen.example" };
export const historyFromKnown: DeliverInput = {
  from: KNOWN,
  subject: "Earlier conversation",
  text: "From before the inbox was connected.",
  date: at(-30 * DAY),
  seen: true,
  placement: { inInbox: false },
};

/** A thread without its version, to compare what it says while the version is checked on its own. */
export function content(thread: Thread): Omit<Thread, "version"> {
  const { version: _version, ...rest } = thread;
  return rest;
}

/** Collects every event the caller hears until `stop()`. */
export function listen(t: TestServer, caller: Caller = t.person): { events: MailEvent[]; stop: () => void } {
  const events: MailEvent[] = [];
  const stop = t.server.subscribe(caller, (event) => events.push(event));
  return { events, stop };
}
