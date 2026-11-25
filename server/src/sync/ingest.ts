// Taking one sync batch into the store: new mail joins or starts threads, flag and placement changes made at
// the provider win, removed messages go, a reset listing drops what it didn't include, and new threads are
// sorted. Every thread that changed gets one event with its new version. Runs under `ctx.lock`.

import type { SyncBatch } from "@usualmail/core";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { inboxes, messages, threads, type InboxRow } from "../db/index.ts";
import type { Ctx } from "../service/context.ts";
import { sentByServer } from "../service/drafts.ts";
import { blockedMailArrived } from "../service/senders.ts";
import { blockedSenders, emitThread, getThread, markKnown } from "../service/store.ts";
import { settleThreadAvatars } from "../avatars/settle.ts";
import { takeProviderState } from "./placement.ts";
import { fitMessage } from "./fit.ts";
import { becameOwn, changeHeldCopy, dropHeldCopy, holdCopy, sameMessage, sentKey, takeHeldCopy } from "./identity.ts";
import { createThread, dateOf, deleteMessage, findByRef, insertMessage, refreshThread } from "./rows.ts";
import { letInOwnSender, serverAddresses } from "./let-in.ts";
import { classify, newMailInThread, skippedWhileUnknown } from "./sorting.ts";
import { emitRules } from "../service/rules.ts";

/**
 * The mark (`messages.listed`) of a message brought in from a search of the mailbox (docs/contract-search.md): no reset
 * listing includes it, since it is older than the window a listing covers, so none drops it. A listing's own marks are
 * times, so never this. A message a listing does include takes that listing's mark, as any other.
 */
export const IMPORTED = -1;

export interface IngestResult {
  /** Threads whose provider placement may need tidying. */
  tidy: string[];
  /** Threads with work for the server's AI that should start at once: new mail it may process now. */
  aiNow: string[];
}

/**
 * `history` is true until the inbox's first full sync is done: that mail is the mailbox as it was, so its
 * senders are known and it is placed as the provider has it, without rules or screening. `aiNow` says whether the
 * server's AI may process this inbox's mail at this moment, so new mail is processed as it arrives.
 */
export async function ingest(
  ctx: Ctx,
  inbox: InboxRow,
  batch: SyncBatch,
  history: boolean,
  aiNow: boolean,
  options: { imported?: boolean } = {},
): Promise<IngestResult> {
  // An old conversation a person opened from a search of the mailbox (docs/contract-search.md): history, placed as the
  // mailbox has it, but its senders aren't let in by being opened, and the sync's cursor isn't touched.
  const imported = options.imported === true;
  /** Each thread this batch touches, as it was before: its version (0 when new) and newest message's time. */
  const before = new Map<string, { version: number; lastMessageAt: number }>();
  const touch = async (threadId: string) => {
    if (before.has(threadId)) return;
    const row = await getThread(ctx, threadId);
    before.set(threadId, { version: row?.version ?? 0, lastMessageAt: row?.lastMessageAt ?? 0 });
  };
  const created = new Set<string>();
  const refresh = new Set<string>();
  const extraTidy = new Set<string>();
  const aiWork = new Set<string>();
  /** Threads new incoming mail joined: what may want a sender picture looked at again. */
  const arrived = new Set<string>();
  /** Who new incoming mail in this batch is from, lower case. */
  const wrote = new Set<string>();
  /** Every inbox's address on this server, read when first needed (`let-in.ts`). */
  const addresses = serverAddresses(ctx);
  // An opened old conversation is outside every listing (older than the window a listing covers): it takes no part in
  // one that is running, and carries a mark no listing drops.
  const listed = imported ? IMPORTED : await listingMark(ctx, inbox, batch);

  // Oldest first, whatever order the provider sent them in, so a thread starts with its oldest message; of two copies
  // at once, the one the provider says was sent first, so a copy of it in the inbox joins it (same Message-ID).
  const removedNow = new Set(batch.removed);
  const upserted = [...batch.upserted].sort((a, b) => dateOf(a, 0) - dateOf(b, 0) || Number(b.outgoing) - Number(a.outgoing));
  for (const original of upserted) {
    // The inbox's own mail only by evidence: the provider's (Sent), or a copy of exactly what the server itself sent,
    // compared as it came (what was sent was never cut). A copy known only by the server's record lets nobody in
    // (below): its recipients were let in when it was sent.
    const sentHere = !original.outgoing && original.messageId !== undefined
      && await sentByServer(ctx, inbox.id, await sentKey(original, original.messageId));
    // Then made to fit what the host stores (`HostLimits.storedMessageBytes`; Node: as it came), so no row is too large.
    const reported = fitMessage(original, ctx.limits.storedMessageBytes);
    const incoming = sentHere ? { ...reported, outgoing: true } : reported;
    const known = await sameMessage(ctx, inbox, incoming, removedNow);
    if (known?.by === "held") {
      // Another copy while the stored one is still where it was: held, changing nothing, until that one's removal
      // shows it was a move.
      await holdCopy(ctx, known.row, incoming);
      continue;
    }
    if (known) {
      const existing = known.row;
      await touch(existing.threadId);
      if (known.by === "ref") {
        // The same message at the provider, reported again: its state, and what a newer reading of it says.
        const content = {
          ...(existing.subject !== incoming.subject && { subject: incoming.subject }),
          ...((existing.text ?? undefined) !== incoming.text && { text: incoming.text ?? null }),
          ...((existing.html ?? undefined) !== incoming.html && { html: incoming.html ?? null }),
        };
        if (await takeProviderState(ctx, existing, incoming, listed, content)) refresh.add(existing.threadId);
      } else if (incoming.outgoing === existing.outgoing) {
        // The same message under a new ref, its old one gone (moved by another app, or a new UIDVALIDITY): it lives
        // there now.
        await dropHeldCopy(ctx, inbox.id, incoming.ref);
        if (await takeProviderState(ctx, existing, incoming, listed, { ref: incoming.ref })) refresh.add(existing.threadId);
      } else if (incoming.outgoing) {
        // Its Sent copy, for a message first stored from another copy: it is the inbox's own. The stored copy stays
        // the one placed; the Sent copy is held, so the message stays when the stored copy goes.
        if (await becameOwn(ctx, existing)) extraTidy.add(existing.threadId);
        refresh.add(existing.threadId);
        await holdCopy(ctx, existing, incoming);
      } else {
        // Another copy, without evidence, of a message stored as the inbox's own: held, nothing else changes.
        await holdCopy(ctx, existing, incoming);
      }
      continue;
    }
    if (incoming.placement.spam || incoming.placement.trashed) continue;
    let thread = await ctx.db.select().from(threads)
      .where(and(eq(threads.inboxId, inbox.id), eq(threads.threadKey, incoming.threadKey))).get();
    if (thread) {
      await touch(thread.id);
    } else {
      thread = await createThread(ctx, inbox, incoming);
      created.add(thread.id);
      before.set(thread.id, { version: 0, lastMessageAt: 0 });
    }
    await insertMessage(ctx, inbox, thread, incoming, listed);
    refresh.add(thread.id);
    if (!incoming.outgoing) {
      arrived.add(thread.id);
      wrote.add(incoming.from.email.toLowerCase());
      // One of the person's own, proved (another inbox here, a colleague at its own domain): let in, before sorting.
      if (!history) for (const id of await letInOwnSender(ctx, inbox, incoming, addresses)) extraTidy.add(id);
    }
    if (incoming.outgoing) {
      // The inbox sent them mail: they are let in, and their screened threads with them. Not for a copy known only
      // by the server's own record of sending: that let them in when it was sent.
      const recipients = [...incoming.to, ...incoming.cc, ...incoming.bcc].map((a) => a.email);
      if (!sentHere) for (const id of await markKnown(ctx, inbox.id, recipients, { unscreen: !history })) extraTidy.add(id);
    } else if (history) {
      // Everyone in the first sync's history is let in, except the senders of threads filed under Screening there.
      if (!incoming.placement.screened && !imported) await markKnown(ctx, inbox.id, [incoming.from.email], { unscreen: false });
    } else if (!created.has(thread.id)) {
      // Anyone writing into a thread that isn't screened is let in (someone copied on a conversation, say), except into
      // one that skipped Screening while its sender isn't let in: that lets nobody in, its own sender included.
      const current = await getThread(ctx, thread.id);
      if (current && !current.screened && !await skippedWhileUnknown(ctx, current)) {
        for (const id of await markKnown(ctx, inbox.id, [incoming.from.email])) extraTidy.add(id);
      }
      if (await newMailInThread(ctx, thread, incoming, before.get(thread.id)!.lastMessageAt)) aiWork.add(thread.id);
    }
  }

  // A change to a message the server never had can't be applied: there is nothing to apply it to.
  for (const change of batch.changed ?? []) {
    const existing = await findByRef(ctx, inbox.id, change.ref);
    if (!existing) {
      await changeHeldCopy(ctx, inbox.id, change);
      continue;
    }
    await touch(existing.threadId);
    if (await takeProviderState(ctx, existing, change, listed)) refresh.add(existing.threadId);
  }

  for (const ref of batch.removed) {
    const row = await findByRef(ctx, inbox.id, ref);
    if (!row) {
      await dropHeldCopy(ctx, inbox.id, ref);
      continue;
    }
    await touch(row.threadId);
    const held = await takeHeldCopy(ctx, row);
    // A copy held for it is the other half of a move whose new copy came in an earlier batch: it lives there now.
    if (held) await takeProviderState(ctx, row, held, listed, { ref: held.ref });
    else await deleteMessage(ctx, row.id);
    refresh.add(row.threadId);
  }

  let listingDone = false;
  if (listed !== null && !imported && !batch.more) {
    // The reset listing is complete: what it didn't include is gone from the mailbox. Not what a person opened from a
    // search of the mailbox: a listing covers the first sync's window, which never held it.
    const gone = await ctx.db.select({ id: messages.id, threadId: messages.threadId }).from(messages).where(and(
      eq(messages.inboxId, inbox.id),
      or(isNull(messages.listed), and(ne(messages.listed, listed), ne(messages.listed, IMPORTED))),
    ));
    for (const row of gone) {
      await touch(row.threadId);
      await deleteMessage(ctx, row.id);
      refresh.add(row.threadId);
    }
    listingDone = true;
  }

  for (const id of refresh) await refreshThread(ctx, id);
  const ruleHits: string[] = [];
  for (const id of created) {
    const sorted = await classify(ctx, inbox, id, history, aiNow, imported);
    if (sorted.ruleId) ruleHits.push(sorted.ruleId);
    if (sorted.aiNow) aiWork.add(id);
    for (const other of sorted.tidy) extraTidy.add(other);
  }
  if (!imported) {
    await ctx.db.update(inboxes)
      .set({ syncCursor: batch.cursor, ...(listingDone && { resetListing: null }) })
      .where(eq(inboxes.id, inbox.id));
  }

  // Sender pictures follow what the batch changed; new mail may want its domain's picture (looked at again).
  await settleThreadAvatars(ctx, before.keys(), { want: (id) => (arrived.has(id) ? "fresh" : false) });
  for (const [id, was] of before) {
    const row = await getThread(ctx, id);
    if (row && row.version !== was.version) emitThread(ctx, row);
  }
  // Mail from a blocked sender was stored: a person's list of blocked senders counts it (`sender.changed`).
  if (wrote.size) {
    const blocked = await blockedSenders(ctx, inbox.id);
    for (const email of wrote) if (blocked.has(email)) await blockedMailArrived(ctx, inbox.id, email);
  }
  // One event per rule for the batch, not one per thread it sorted.
  await emitRules(ctx, ruleHits);
  return { tidy: [...new Set([...before.keys(), ...extraTidy])], aiNow: aiNow ? [...aiWork] : [] };
}

/**
 * The mark of the reset listing this batch belongs to, or null when none is running. A batch with `reset`
 * starts a new listing with a new mark, also when one was already running.
 */
async function listingMark(ctx: Ctx, inbox: InboxRow, batch: SyncBatch): Promise<number | null> {
  if (!batch.reset) return inbox.resetListing;
  const mark = Math.max(ctx.now(), (inbox.resetListing ?? 0) + 1);
  await ctx.db.update(inboxes).set({ resetListing: mark }).where(eq(inboxes.id, inbox.id));
  return mark;
}
