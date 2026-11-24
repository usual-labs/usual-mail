// Shared by the sender picture tests: a made-up Public Suffix List, a fake site source, made-up icons and mail from
// a made-up brand whose From domain Gmail's checker proved. Nothing here reaches the network.

import type { Caller, Inbox } from "@usualmail/core";
import { FakeModels, MemoryEventBus, ProviderRegistry, webRandom, aesGcmSecrets, type Host, type SiteIconSource } from "../src/index.ts";
import type { AvatarOptions } from "../src/avatars/service.ts";
import { openDatabase } from "../src/node/db.ts";
import { MailServer } from "../src/service/server.ts";
import { ManualClock, MemoryMailbox, memoryFactory } from "../src/testing/index.ts";
import { START } from "./helpers.ts";
import type { SiteIcon } from "../src/avatars/sites.ts";
import { rulesFromList, SuffixList } from "../src/avatars/suffixes.ts";
import type { DeliverInput } from "../src/testing/index.ts";
import { pngFile } from "./avatar-pictures.ts";

export const TEST_SUFFIXES = new SuffixList(rulesFromList(
  "// ===BEGIN ICANN DOMAINS===\nexample\nco.example\ncom\n// ===END ICANN DOMAINS===\n// ===BEGIN PRIVATE DOMAINS===\npages.example\n// ===END PRIVATE DOMAINS===\n",
));

/** A site source that answers from a table, and says what it was asked and whether two fetches ever overlapped. */
export class FakeSites implements SiteIconSource {
  readonly asked: string[] = [];
  readonly icons = new Map<string, SiteIcon>();
  running = 0;
  most = 0;

  async fetch(domain: string): Promise<SiteIcon> {
    this.asked.push(domain);
    this.running++;
    this.most = Math.max(this.most, this.running);
    await new Promise((resolve) => setImmediate(resolve));
    this.running--;
    return this.icons.get(domain) ?? { found: false, kind: "none", reason: "its site has no icon the server shows" };
  }
}

export const icon = (size = 64, fit: "fill" | "inset" = "inset", color: [number, number, number, number] = [10, 20, 30, 255]): SiteIcon =>
  ({ found: true, mimeType: "image/png", data: pngFile(size, size, { color }), width: size, height: size, fit });

/** Mail from the brand's newsletter, as Gmail's checker proved it. */
export const brandMail = (subject: string, extra: Partial<DeliverInput> = {}): DeliverInput => ({
  from: { name: "Brand", email: "news@mail.brand.example" },
  subject,
  text: "This week at Brand.",
  automated: true,
  listId: "<weekly.brand.example>",
  fromCheck: { result: "verified", domain: "mail.brand.example" },
  ...extra,
});

/** A store, clock, host and memory providers a test can start servers on, one after another. */
export async function world() {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(START);
  const infos: string[] = [];
  const errors: string[] = [];
  const host: Host = {
    db: store.db, clock, scheduler: clock, random: webRandom, events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
  };
  const mailboxes = new Map<string, MemoryMailbox>();
  const providers = new ProviderRegistry();
  providers.register("gmail", memoryFactory(mailboxes, { kind: "gmail", now: () => clock.now() }));
  providers.register("imap", memoryFactory(mailboxes, { kind: "imap", now: () => clock.now() }));
  return { store, clock, host, infos, errors, mailboxes, providers };
}

export type World = Awaited<ReturnType<typeof world>>;

export async function serve(w: World, avatars: AvatarOptions, syncWindowDays?: number) {
  const server = await MailServer.create(w.host, {
    providers: w.providers, models: new FakeModels(), pollIntervalMs: 60_000, avatars, ...(syncWindowDays && { syncWindowDays }),
  });
  await server.start();
  return server;
}

export async function personOf(server: MailServer): Promise<{ person: Caller; token: string }> {
  const code = await server.ownerPairingCode();
  const paired = await server.pair({ code: code!.code, name: "Test Mac" });
  return { person: (await server.authenticate(paired.token))!, token: paired.token };
}

export async function connect(server: MailServer, person: Caller, w: World, address: string, kind: "gmail" | "imap"): Promise<{ inbox: Inbox; mailbox: MemoryMailbox }> {
  const mailbox = new MemoryMailbox({ address, kind, now: () => w.clock.now() });
  w.mailboxes.set(mailbox.address, mailbox);
  return { mailbox, inbox: await server.connectInbox(person, { name: address, color: "#2F6FED", provider: kind, credentials: { mailbox: address }, trust: "act_with_undo" }) };
}
