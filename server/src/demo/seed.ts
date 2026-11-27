// Demo mode: a fresh store filled from core's sample.json, with each inbox backed by a MemoryMailbox that
// holds the sample's messages, and the server's AI on fake models that report the sample's own model ids. Times move
// by `shiftMs` so the sample's "now" is the moment the demo starts.

import type { ActionKind, Actor, AiCredentials, AiJob, InboxStatus, Message, NotificationEvent, ProviderPlacement, SampleData, Thread } from "@usualmail/core";
import { FakeModels } from "../ai/fake.ts";
import { actions, attachments, avatarSites, briefs, drafts, inboxes, messages, rules, senders, serverState, threads } from "../db/index.ts";
import { asciiHost } from "../avatars/host.ts";
import { encodePng } from "../avatars/png.ts";
import { toBase64 } from "../avatars/sites.ts";
import { SuffixList } from "../avatars/suffixes.ts";
import type { Host } from "../host.ts";
import { ProviderRegistry } from "../providers.ts";
import type { Before, ThreadState } from "../service/state.ts";
import { memoryFactory } from "../testing/memory-adapter.ts";
import { MemoryMailbox } from "../testing/memory-provider.ts";
import { belongsAt } from "../sync/writeback.ts";

export interface Demo {
  providers: ProviderRegistry;
  mailboxes: Map<string, MemoryMailbox>;
}

/** Fake models whose defaults are the sample's, so the settings say what the sample says. No real model is called. */
export function demoModels(sample: SampleData): FakeModels {
  const defaults = Object.fromEntries(sample.ai.jobs.map((job) => [job.job, job.defaultModel || `example/${job.job}`])) as Record<AiJob, string>;
  return new FakeModels({ label: "demo (fake models)", defaults });
}

/** Memory mailboxes for every provider kind, so any inbox connected in demo mode works too. */
export function demoProviders(now: () => number): Demo {
  const mailboxes = new Map<string, MemoryMailbox>();
  const providers = new ProviderRegistry();
  for (const kind of ["imap", "gmail"] as const) {
    providers.register(kind, memoryFactory(mailboxes, { kind, renameOnMove: kind === "imap", now }));
  }
  return { providers, mailboxes };
}

/** Writes the sample into an empty store and its messages into memory mailboxes. */
export async function seedSample(host: Host, demo: Demo, sample: SampleData, shiftMs = 0): Promise<void> {
  const db = host.db;
  const at = (time: string) => Date.parse(time) + shiftMs;
  const threadById = new Map(sample.threads.map((thread) => [thread.id, thread]));

  for (const inbox of sample.inboxes) {
    const mailbox = new MemoryMailbox({
      address: inbox.address,
      kind: inbox.provider,
      renameOnMove: inbox.provider === "imap",
      connection: inbox.connection,
      now: () => host.clock.now(),
    });
    demo.mailboxes.set(mailbox.address, mailbox);
    const inboxThreads = sample.threads.filter((thread) => thread.inboxId === inbox.id);
    for (const thread of inboxThreads) {
      const list = sample.messages.filter((m) => m.threadId === thread.id).sort((a, b) => a.date.localeCompare(b.date));
      list.forEach((message, index) => {
        mailbox.deliver({
          ref: message.id,
          threadKey: thread.id,
          messageId: `${message.id}@sample.example`,
          ...(index > 0 && { inReplyTo: `${list[index - 1]!.id}@sample.example` }),
          references: list.slice(0, index).map((m) => `${m.id}@sample.example`),
          from: message.from,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          date: new Date(at(message.date)).toISOString(),
          subject: message.subject,
          ...(message.text !== undefined && { text: message.text }),
          ...(message.html !== undefined && { html: message.html }),
          attachments: message.attachments.map((file) => ({ ...file, data: placeholder(file.filename, file.size) })),
          seen: !message.unread,
          outgoing: message.outgoing,
          automated: message.from.email.startsWith("news@") || message.listId !== undefined,
          ...(message.listId !== undefined && { listId: message.listId }),
          placement: message.outgoing ? { inInbox: false } : placementFor(thread, Date.parse(sample.now), inbox.provider),
        });
      });
    }
    // Older mail only the mailbox holds (before the first sync's window): demo mode's search of the mailbox finds it.
    for (const [index, older] of (sample.olderMail ?? []).filter((m) => m.inboxId === inbox.id).entries()) {
      mailbox.deliver({
        ref: `older_${index}`,
        threadKey: older.threadKey,
        messageId: `older-${index}@sample.example`,
        from: older.from,
        to: older.to,
        date: new Date(at(older.date)).toISOString(),
        subject: older.subject,
        text: older.text,
        attachments: (older.attachments ?? []).map((file) => ({ ...file, data: placeholder(file.filename, file.size) })),
        seen: true,
        outgoing: false,
        placement: { inInbox: !older.archived },
      });
    }
    if (inbox.status === "needs_attention" && inbox.statusDetail) {
      mailbox.failSync = inbox.statusDetail;
      // A refused login needs attention at every sync; another failure would wait out the grace (sync/health.ts).
      mailbox.signInRefused = inbox.statusReason === "needs_sign_in";
    }

    await db.insert(inboxes).values({
      id: inbox.id,
      name: inbox.name,
      address: inbox.address,
      color: inbox.color,
      icon: inbox.icon,
      position: inbox.position,
      provider: inbox.provider,
      trust: inbox.trust,
      guide: inbox.guide,
      agentAccess: inbox.agentAccess,
      status: connection(inbox.status),
      statusDetail: inbox.statusDetail ?? null,
      statusReason: inbox.status === "needs_attention" ? inbox.statusReason ?? null : null,
      paused: inbox.status === "paused",
      lastSyncedAt: inbox.lastSyncedAt ? at(inbox.lastSyncedAt) : null,
      createdAt: at(inbox.createdAt),
      credentials: await host.secrets.seal(JSON.stringify({ mailbox: inbox.address }), inbox.id),
      connection: inbox.connection,
      syncCursor: mailbox.cursor,
      // An inbox the sample shows with a first sync's count (Personal's, stopped when its password was refused) lists
      // it as the sample has it: its first sync isn't done. Its mailbox refuses every sync, so it stays that way.
      historyDone: inbox.firstSync === undefined,
      firstSyncFetched: inbox.firstSync?.fetched ?? null,
      firstSyncTotal: inbox.firstSync?.total ?? null,
      resetListing: null,
      version: inbox.version,
    });

    const known = new Set<string>();
    for (const thread of inboxThreads) {
      // A thread that skipped Screening lets nobody in (docs/contract.md, "Skipped Screening").
      if (thread.screened || thread.skippedScreening) continue;
      for (const person of thread.participants) known.add(person.email.toLowerCase());
    }
    for (const message of sample.messages.filter((m) => m.inboxId === inbox.id && m.outgoing)) {
      for (const person of [...message.to, ...message.cc, ...message.bcc]) known.add(person.email.toLowerCase());
    }
    known.delete(inbox.address.toLowerCase());
    // The sample's blocked senders are blocked since the sample says, not let in by their threads.
    const blocked = sample.blockedSenders.filter((sender) => sender.inboxId === inbox.id);
    for (const sender of blocked) known.delete(sender.address);
    if (known.size) {
      await db.insert(senders).values([...known].map((email) => ({ inboxId: inbox.id, email, status: "known" as const, updatedAt: host.clock.now() })));
    }
    if (blocked.length) {
      await db.insert(senders).values(blocked.map((sender) => ({ inboxId: inbox.id, email: sender.address, status: "blocked" as const, updatedAt: at(sender.blockedAt) })));
    }
  }

  for (const thread of sample.threads) {
    const inbox = sample.inboxes.find((i) => i.id === thread.inboxId)!;
    const list = sample.messages.filter((m) => m.threadId === thread.id);
    const firstIncoming = list.filter((m) => !m.outgoing).sort((a, b) => a.date.localeCompare(b.date))[0];
    const sender = firstIncoming?.from.email ?? thread.participants.find((p) => p.email !== inbox.address)?.email;
    await db.insert(threads).values({
      id: thread.id,
      inboxId: thread.inboxId,
      threadKey: thread.id,
      subject: thread.subject,
      snippet: thread.snippet,
      participants: thread.participants,
      lastMessageAt: at(thread.lastMessageAt),
      messageCount: thread.messageCount,
      unread: thread.unread,
      hasAttachments: thread.hasAttachments,
      category: thread.category,
      categorizedBy: thread.categorizedBy ?? null,
      categorizedByActor: thread.categorizedByActor ?? null,
      screened: thread.screened,
      screenedByMailbox: false,
      gatePending: false,
      skippedScreening: thread.skippedScreening ?? null,
      summary: thread.summary ?? null,
      payment: thread.payment ?? null,
      // An event's date is a calendar date: it moves by the whole days the sample's times move, so "today" stays today.
      event: thread.event ? shiftEvent(thread.event, Math.round(shiftMs / 86_400_000)) : null,
      avatar: thread.avatar ?? null,
      // What the AI would still do: decide what nobody has, summarize what has no summary (never a one-time code).
      categoryDue: thread.category === "unknown" && thread.categorizedBy === undefined,
      summaryDue: thread.summary === undefined && thread.category !== "otp",
      done: thread.done,
      stack: thread.stack ?? null,
      comeBackAt: thread.comeBackAt ? at(thread.comeBackAt) : null,
      comeBackIfNoReply: thread.comeBackIfNoReply ?? false,
      comeBackSetAt: thread.comeBackAt ? at(thread.lastMessageAt) : null,
      comeBackAnnounced: thread.comeBackAt !== undefined && Date.parse(thread.comeBackAt) <= Date.parse(sample.now),
      revision: 0,
      need: thread.need ?? null,
      reason: thread.reason ?? null,
      sender: sender?.toLowerCase() ?? null,
      trashed: thread.trashed,
      removed: false,
      version: thread.version,
      createdAt: at(thread.lastMessageAt),
    });
  }

  for (const message of sample.messages) {
    const mailbox = demo.mailboxes.get(sample.inboxes.find((i) => i.id === message.inboxId)!.address.toLowerCase())!;
    const stored = mailbox.get(message.id)!;
    await db.insert(messages).values({
      id: message.id,
      threadId: message.threadId,
      inboxId: message.inboxId,
      ref: stored.ref,
      messageId: stored.messageId ?? null,
      inReplyTo: stored.inReplyTo ?? null,
      references: stored.references,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: null,
      date: at(message.date),
      subject: message.subject,
      text: message.text ?? null,
      html: message.html ?? null,
      unread: message.unread,
      outgoing: message.outgoing,
      listId: message.listId ?? null,
      listUnsubscribe: null,
      listUnsubscribePost: null,
      signedUnsubscribe: null,
      automated: stored.automated,
      // A message the sample shows a sender picture for: its From domain counts as proved by the provider's checker.
      fromCheck: message.avatar ? "verified" : null,
      fromVerified: message.avatar ? asciiHost(message.from.email.split("@").pop() ?? "") : null,
      placement: stored.placement,
      seen: stored.seen,
      createdAt: at(message.date),
    });
    for (const [position, file] of message.attachments.entries()) {
      await db.insert(attachments).values({
        id: file.id,
        messageId: message.id,
        providerId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        inline: file.inline,
        contentId: file.contentId ?? null,
        position,
      });
    }
  }

  for (const record of sample.actions) {
    const thread = threadById.get(record.threadId)!;
    await db.insert(actions).values({
      id: record.id,
      threadId: record.threadId,
      inboxId: record.inboxId,
      action: record.action,
      kind: record.action.kind,
      actor: record.actor,
      actorKind: record.actor.kind,
      reason: record.reason ?? null,
      state: record.state,
      at: at(record.at),
      undoneAt: record.undoneAt ? at(record.undoneAt) : null,
      undoable: record.undoable,
      error: record.error ?? null,
      silent: record.silent,
      note: record.note ?? null,
      before: guessBefore(thread, sample.messages.filter((m) => m.threadId === thread.id), record.action.kind, record.actor, record.state),
      version: record.version,
    });
  }

  for (const rule of sample.rules) {
    await db.insert(rules).values({ ...rule, createdAt: at(rule.createdAt) });
  }
  for (const draft of sample.drafts) {
    await db.insert(drafts).values({
      id: draft.id,
      inboxId: draft.inboxId,
      threadId: draft.threadId ?? null,
      inReplyToMessageId: draft.inReplyToMessageId ?? null,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      createdBy: draft.createdBy,
      state: draft.state,
      error: draft.error ?? null,
      note: draft.note ?? null,
      createdAt: at(draft.updatedAt),
      updatedAt: at(draft.updatedAt),
      version: draft.version,
    });
  }
  await seedAi(host, sample, at);
  const brief = sample.brief;
  await db.insert(briefs).values({
    id: brief.id,
    createdAt: at(brief.createdAt),
    from: at(brief.from),
    to: at(brief.to),
    sections: brief.sections,
    writtenBy: brief.writtenBy,
  });
}

/**
 * The AI as the sample has it: its settings (credentials stand in for a key, sealed like a real one, and reach only
 * the fake models), its status and the counts' version.
 */
async function seedAi(host: Host, sample: SampleData, at: (time: string) => number): Promise<void> {
  const ai = sample.ai;
  const status = sample.aiStatus;
  const credentials: AiCredentials | null = ai.connection
    ? ai.connection.kind === "gateway"
      ? { kind: "gateway", gateway: ai.connection.gateway, apiKey: "demo-not-a-real-key" }
      : { kind: "direct", provider: ai.connection.provider, apiKey: "demo-not-a-real-key" }
    : null;
  // The store's own row is replaced whole by the sample's.
  await host.db.delete(serverState);
  await host.db.insert(serverState).values({
    id: 1,
    aiCredentials: credentials && ai.credentialsSet ? await host.secrets.seal(JSON.stringify(credentials), "ai-settings") : null,
    aiService: ai.connection ?? null,
    aiModels: Object.fromEntries(ai.jobs.filter((job) => job.model !== null).map((job) => [job.job, job.model])),
    aiPaused: ai.paused,
    settingsVersion: ai.version,
    aiState: status.state === "not_set_up" || status.state === "paused" ? null : status.state,
    aiDetail: status.detail ?? null,
    aiJob: status.job ?? null,
    aiLastRunAt: status.lastRunAt ? at(status.lastRunAt) : null,
    aiRetryAt: null,
    aiFailures: 0,
    statusVersion: status.version,
    countsVersion: sample.counts.version,
  });
}

function connection(status: InboxStatus): "connecting" | "ok" | "needs_attention" {
  return status === "paused" ? "ok" : status;
}

/**
 * Where the sample's thread would sit at the provider, as write-back would have put it: a conversation or undecided
 * thread in the inbox exactly when it shows in Home, under its category's and Screening's labels or folders (IMAP's
 * Screening folder keeps no category); a notification in Home stays under its label.
 */
function placementFor(thread: Thread, now: number, kind: "imap" | "gmail"): Partial<ProviderPlacement> {
  const belongs = belongsAt({
    category: thread.category,
    screened: thread.screened,
    done: thread.done,
    stack: thread.stack ?? null,
    comeBackAt: thread.comeBackAt ? Date.parse(thread.comeBackAt) : null,
  }, now);
  const placement: Partial<ProviderPlacement> = { inInbox: belongs.inInbox, category: belongs.category, screened: belongs.screened, stack: thread.stack ?? null };
  if (belongs.screened && kind === "imap") delete placement.category;
  if (thread.trashed) placement.trashed = true;
  return placement;
}

/**
 * The sample doesn't say what a thread looked like before each action, so this reverses the action on the
 * thread as it is now: a categorize came from undecided, done was not done, a stack was empty, trash was not
 * trashed.
 */
function guessBefore(thread: Thread, list: Message[], kind: ActionKind, actor: Actor, state: string): Before {
  const now: ThreadState = {
    category: thread.category,
    categorizedBy: thread.categorizedBy ?? null,
    categorizedByActor: thread.categorizedByActor ?? null,
    screened: thread.screened,
    screenedByMailbox: false,
    summary: thread.summary ?? null,
    done: thread.done,
    stack: thread.stack ?? null,
    comeBackAt: thread.comeBackAt ? Date.parse(thread.comeBackAt) : null,
    comeBackIfNoReply: thread.comeBackIfNoReply ?? false,
    comeBackSetAt: null,
    unread: thread.unread,
    unreadMessageIds: list.filter((m) => m.unread).map((m) => m.id),
    readMessageIds: list.filter((m) => !m.unread).map((m) => m.id),
    trashed: thread.trashed,
    need: thread.need ?? null,
    reason: thread.reason ?? null,
  };
  if (state !== "applied") return { threads: [{ id: thread.id, state: now }] };
  const before: ThreadState = { ...now };
  if (kind === "categorize") {
    before.category = "unknown";
    before.categorizedBy = null;
    before.categorizedByActor = null;
  }
  if (kind === "done") before.done = false;
  if (kind === "stack") before.stack = null;
  if (kind === "trash") before.trashed = false;
  if (actor.kind !== "person") before.reason = null;
  return { threads: [{ id: thread.id, state: before }] };
}

/** Bytes standing in for a sample attachment, of the size the sample gives. */
function placeholder(filename: string, size: number): Uint8Array {
  const text = new TextEncoder().encode(`Usual Mail demo attachment: ${filename}\n`);
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = text[i % text.length]!;
  return data;
}

/** The demo's own Public Suffix List: its mail is all at made-up `.example` domains. */
export const DEMO_SUFFIXES = new SuffixList({ icann: ["example"], private: [] });

const DEMO_COLOURS: Array<[number, number, number]> = [[47, 111, 237], [214, 96, 56], [52, 140, 98], [139, 92, 196]];

/**
 * The sample's sender pictures, kept as the server keeps fetched ones, under the sample's own ids: made-up pictures
 * drawn here (a full square for `fill`, a round mark on transparency for `inset`). Demo mode fetches nothing.
 */
export async function seedSamplePictures(host: Host, sample: SampleData): Promise<void> {
  const now = host.clock.now();
  const done = new Set<string>();
  for (const thread of sample.threads) {
    const avatar = thread.avatar;
    const domain = avatar && thread.sender ? DEMO_SUFFIXES.registrableDomain(thread.sender.split("@").pop() ?? "") : null;
    if (!avatar || !domain || done.has(domain)) continue;
    done.add(domain);
    const [r, g, b] = DEMO_COLOURS[done.size % DEMO_COLOURS.length]!;
    const size = avatar.size;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = avatar.fit === "fill" || (x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2 <= (size * 0.4) ** 2;
        if (inside) pixels.set([r, g, b, 255], (y * size + x) * 4);
      }
    }
    await host.db.insert(avatarSites).values({
      domain, state: "found", pictureId: avatar.picture.split("/").pop()!, mimeType: "image/png", data: toBase64(await encodePng(pixels, size, size)),
      width: size, height: size, fit: avatar.fit, checkedAt: now, wantedAt: now, createdAt: now,
    });
  }
}

/** An event with its date moved by whole days. */
function shiftEvent(event: NotificationEvent, days: number): NotificationEvent {
  if (!event.when || days === 0) return event;
  const [year, month, day] = event.when.date.split("-").map(Number);
  return { ...event, when: { ...event.when, date: new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10) } };
}
