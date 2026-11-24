// Keeping search's index right (docs/contract-search.md, "Keeping the index right"). A thread is looked at again
// whenever its version moved since it was indexed: every change to what a person sees of a thread raises it (new mail,
// a summary, payment details or an event landing, a snippet remade, removal). When what the index reads of the thread's
// own columns is the same, only the version is noted; otherwise its messages are read again. A thread gone from the
// mailbox leaves the index; a thread or an inbox deleted takes its entries along (cascade and trigger). The first start
// with an empty index builds it this way from what is stored: no provider read, no AI request, counts only in the log.
// Events tell it something changed; a search first looks for anything stale and waits until it is indexed.
// How many threads are read and written together is the host's (`HostLimits.searchChunk`; Node 100), and a chunk ends
// sooner once its threads hold MESSAGES_PER_CHUNK messages. Only what a thread's entry keeps is read whole: messages
// without their text and HTML (who, when), attachment names, then the text and HTML of the shown messages, newest
// first, a round of at most `HostLimits.searchReadChars` characters at a time and only as far as the thread's body can
// still grow (BODY_PER_THREAD), so a long thread of large mail never sits in memory at once. Text and HTML are read
// whole, never cut: a cut could change the reading text (an unclosed style block, a tag or a link across it). On Node
// the catch-up at start runs inside `start()`; a host with `searchInBackground` (Cloudflare) starts it in the background
// instead, giving the event loop a turn between chunks, so requests are answered while it runs.

import { and, eq, sql } from "drizzle-orm";
import { attachments, inboxes, messages, searchDocs, searchPeople, threads, type ThreadRow } from "../db/index.ts";
import { inList, insertChunks } from "../db/params.ts";
import type { Ctx } from "../service/context.ts";
import { toThread } from "../service/rows.ts";
import { blockedSenders, runBatch } from "../service/store.ts";
import { errorMessage } from "../util.ts";
import { readingText } from "../ai/text.ts";
import { BODY_PER_THREAD, buildDoc, MAX_ADDED_PER_MESSAGE, shownNewestFirst, sourceOf, ThreadBody, type MessageHead, type ThreadDoc } from "./doc.ts";
import { COLUMNS } from "./fts.ts";

interface Stale {
  id: string;
  removed: number;
  doc: number | null;
  source: string | null;
  /** The thread's message count, for sizing chunks. */
  messages: number;
}

/** A chunk ends before its threads pass this many messages (at least one thread a chunk): their heads are read at once. */
export const MESSAGES_PER_CHUNK = 2_000;

/**
 * What a message's text and HTML take, for sizing a round: their UTF-8 bytes, never fewer than their characters. Not
 * `length(text)`: SQLite's counts characters only up to the first U+0000, so a text starting with one counts 0 (seen in
 * a Durable Object's SQLite, where the text itself reads back whole) and a round could take any number of them.
 */
export const BODY_SIZE_SQL = 'coalesce(length(CAST("messages"."text" AS BLOB)), 0) + coalesce(length(CAST("messages"."html" AS BLOB)), 0)';

/** A message as the index reads it before its bodies: its head, its thread and the size of its text and HTML. */
type Head = MessageHead & { threadId: string; chars: number };

export class SearchIndex {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  #dirty = true;
  #running: Promise<void> | null = null;
  #stop: (() => void) | null = null;
  /** The first catch-up after a start says what it built. */
  #first = true;

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /**
   * Brings the index up to date with what is stored (at a first start: builds it, and logs counts), before anything new
   * arrives, then listens for changes and follows them in the background.
   */
  async start(): Promise<void> {
    this.#first = true;
    const background = this.#ctx.limits.searchInBackground;
    if (!background) {
      await this.fresh();
      this.#first = false;
    }
    this.#stop = this.#ctx.host.events.subscribe((event) => {
      if (event.type === "thread.changed" || event.type === "thread.removed" || event.type === "inbox.removed") this.touch();
    });
    // In the background: what is stale is indexed chunk by chunk; a search meanwhile waits for it (`fresh`).
    if (background) this.touch();
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /** Something a person can find may have changed: the index looks again, in the background. */
  touch(): void {
    this.#dirty = true;
    if (!this.#running) this.#track(this.current());
  }

  /**
   * Resolves once every thread changed before the call is indexed, also by a change no event told of (the look for
   * what is stale costs about a millisecond for thousands of threads). A failure is logged; the index stays as it was.
   */
  async fresh(): Promise<void> {
    this.#dirty = true;
    await this.current();
  }

  /** Resolves once what events told of is indexed. */
  async current(): Promise<void> {
    if (!this.#running && this.#dirty) {
      this.#running = this.#loop().finally(() => {
        this.#running = null;
      });
    }
    await this.#running?.catch(() => undefined);
  }

  async #loop(): Promise<void> {
    while (this.#dirty) {
      this.#dirty = false;
      try {
        await this.#catchUp();
      } catch (error) {
        this.#ctx.host.log.error(`Search index: couldn't bring it up to date: ${errorMessage(error)}`);
        return;
      }
    }
  }

  async #catchUp(): Promise<void> {
    const ctx = this.#ctx;
    const started = Date.now();
    const stale = await ctx.db.all<Stale>(sql`
      SELECT t.id AS id, t.removed AS removed, d.id AS doc, d.source AS source, t.message_count AS messages
      FROM threads t LEFT JOIN search_docs d ON d.thread_id = t.id
      WHERE (t.removed = 0 AND (d.id IS NULL OR d.version <> t.version)) OR (t.removed = 1 AND d.id IS NOT NULL)`);
    const counts = { read: 0, noted: 0, dropped: 0, messages: 0 };
    const { searchChunk: chunk, searchInBackground: yields } = ctx.limits;
    for (let i = 0, end = 0; i < stale.length; i = end) {
      // A turn of the event loop between chunks, so a long catch-up doesn't hold back every request meanwhile (the
      // store's driver answers at once there, so its awaits alone never yield). Not a timer the service waits on, so
      // not the host's scheduler.
      if (yields && i > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // At most `chunk` threads, and fewer once their messages would pass MESSAGES_PER_CHUNK.
      let messagesIn = stale[i]!.messages;
      for (end = i + 1; end < stale.length && end - i < chunk && messagesIn + stale[end]!.messages <= MESSAGES_PER_CHUNK; end++) {
        messagesIn += stale[end]!.messages;
      }
      const done = await this.#index(stale.slice(i, end));
      counts.read += done.read;
      counts.noted += done.noted;
      counts.dropped += done.dropped;
      counts.messages += done.messages;
    }
    if (this.#first && counts.read > 0) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      ctx.host.log.info(`Search index: ${counts.read} threads (${counts.messages} messages) indexed in ${seconds} s`);
    }
    this.#first = false;
  }

  /** Indexes one chunk: reads outside the lock, writes under it, each thread only if its version didn't move meanwhile. */
  async #index(chunk: Stale[]): Promise<{ read: number; noted: number; dropped: number; messages: number }> {
    const ctx = this.#ctx;
    const out = { read: 0, noted: 0, dropped: 0, messages: 0 };
    const gone = chunk.filter((s) => s.removed).map((s) => s.id);
    const ids = chunk.filter((s) => !s.removed).map((s) => s.id);
    const rows = ids.length ? await ctx.db.select().from(threads).where(inList(threads.id, ids)) : [];
    const byId = new Map(chunk.map((s) => [s.id, s]));
    const plans: Array<{ row: ThreadRow; source: string; doc: ThreadDoc | null; known: number | null }> = [];
    const toRead: ThreadRow[] = [];
    for (const row of rows) {
      const source = sourceOf(row, toThread(row));
      const known = byId.get(row.id)!;
      if (known.doc !== null && known.source === source) plans.push({ row, source, doc: null, known: known.doc });
      else toRead.push(row);
    }
    if (toRead.length) {
      // Messages without their text and HTML, and attachment names: small, read for the whole chunk.
      const list: Head[] = await ctx.db.select({
        id: messages.id, threadId: messages.threadId, date: messages.date, from: messages.from, to: messages.to, cc: messages.cc,
        outgoing: messages.outgoing, chars: sql<number>`${sql.raw(BODY_SIZE_SQL)}`,
      }).from(messages).where(inList(messages.threadId, toRead.map((r) => r.id)));
      const files = list.length
        ? await ctx.db.select({ messageId: attachments.messageId, inline: attachments.inline, filename: attachments.filename })
          .from(attachments).where(inList(attachments.messageId, list.map((m) => m.id)))
        : [];
      const own = new Map((await ctx.db.select({ id: inboxes.id, address: inboxes.address }).from(inboxes)).map((i) => [i.id, i.address]));
      const blocked = new Map<string, Set<string>>();
      for (const row of toRead) if (!blocked.has(row.inboxId)) blocked.set(row.inboxId, await blockedSenders(ctx, row.inboxId));
      const byThread = new Map<string, Head[]>();
      for (const message of list) {
        const group = byThread.get(message.threadId);
        if (group) group.push(message);
        else byThread.set(message.threadId, [message]);
      }
      const bodies = await this.#bodies(toRead.map((row) => ({ row, shown: shownNewestFirst(row, blocked.get(row.inboxId)!, byThread.get(row.id) ?? []) })));
      for (const row of toRead) {
        const mine = byThread.get(row.id) ?? [];
        const ids = new Set(mine.map((m) => m.id));
        const doc = buildDoc(row, toThread(row), own.get(row.inboxId) ?? "", blocked.get(row.inboxId)!, mine, files.filter((f) => ids.has(f.messageId)), bodies.get(row.id)!);
        plans.push({ row, source: sourceOf(row, toThread(row)), doc, known: byId.get(row.id)!.doc });
        out.messages += mine.length;
      }
    }
    await ctx.lock.run(async () => {
      const now = new Map((ids.length ? await ctx.db.select({ id: threads.id, version: threads.version }).from(threads)
        .where(inList(threads.id, ids)) : []).map((r) => [r.id, r.version]));
      const statements = [];
      for (const plan of plans) {
        // Changed while it was read: the next look takes it.
        if (now.get(plan.row.id) !== plan.row.version) {
          this.#dirty = true;
          continue;
        }
        if (!plan.doc) {
          statements.push(ctx.db.update(searchDocs).set({ version: plan.row.version }).where(eq(searchDocs.threadId, plan.row.id)));
          out.noted++;
          continue;
        }
        statements.push(...this.#write(plan.row, plan.source, plan.doc, plan.known));
        out.read++;
      }
      for (const id of gone) {
        statements.push(ctx.db.delete(searchPeople).where(eq(searchPeople.threadId, id)));
        statements.push(ctx.db.delete(searchDocs).where(and(eq(searchDocs.threadId, id))));
        out.dropped++;
      }
      await runBatch(ctx, statements);
    });
    return out;
  }

  /**
   * Each thread's body: its shown messages' text and HTML read newest first, in rounds of at most
   * `HostLimits.searchReadChars` characters (always at least one message), and only as far as the body can still grow. A
   * round takes a thread's next messages until what they could add at most (MAX_ADDED_PER_MESSAGE each, and no more
   * than a few times their own length) covers what its body still lacks; a thread whose body is full, or whose messages
   * are all read, takes no more. So no message is read that the body wouldn't use, and memory holds one round.
   */
  async #bodies(threads: Array<{ row: ThreadRow; shown: Head[] }>): Promise<Map<string, ThreadBody>> {
    const ctx = this.#ctx;
    const queues = threads.map(({ row, shown }) => ({ id: row.id, shown, next: 0, body: new ThreadBody() }));
    for (;;) {
      const round: Array<{ queue: (typeof queues)[number]; message: Head }> = [];
      let chars = 0;
      fill: for (const queue of queues) {
        // At most what the queued messages could add; a reading text is never longer than about twice its source.
        let could = 0;
        while (queue.next < queue.shown.length && !queue.body.full && queue.body.length + could < BODY_PER_THREAD) {
          const message = queue.shown[queue.next]!;
          if (round.length > 0 && chars + message.chars > ctx.limits.searchReadChars) break fill;
          round.push({ queue, message });
          chars += message.chars;
          queue.next++;
          could += Math.min(MAX_ADDED_PER_MESSAGE, 3 * message.chars + 3);
        }
      }
      if (round.length === 0) break;
      const read = await ctx.db.select({ id: messages.id, text: messages.text, html: messages.html }).from(messages)
        .where(inList(messages.id, round.map(({ message }) => message.id)));
      const byId = new Map(read.map((row) => [row.id, row]));
      for (const { queue, message } of round) {
        if (queue.body.full) continue;
        const bodies = byId.get(message.id);
        // A message gone since its head was read reads as nothing; its thread's version moved, so the plan is dropped.
        queue.body.add(bodies ? readingText(bodies.text, bodies.html) : "");
      }
    }
    return new Map(queues.map((queue) => [queue.id, queue.body]));
  }

  #write(row: ThreadRow, source: string, doc: ThreadDoc, known: number | null) {
    const ctx = this.#ctx;
    const values = sql.join(COLUMNS.map((column) => sql`${doc.columns[column]}`), sql`, `);
    const names = sql.raw(COLUMNS.join(", "));
    const docRow = known === null
      ? ctx.db.insert(searchDocs).values({ threadId: row.id, version: row.version, source })
      : ctx.db.update(searchDocs).set({ version: row.version, source }).where(eq(searchDocs.id, known));
    const rowid = known === null ? sql`(SELECT id FROM search_docs WHERE thread_id = ${row.id})` : sql`${known}`;
    return [
      ...(known === null ? [] : [ctx.db.run(sql`DELETE FROM search_index WHERE rowid = ${known}`)]),
      docRow,
      ctx.db.run(sql`INSERT INTO search_index (rowid, ${names}) VALUES (${rowid}, ${values})`),
      ctx.db.delete(searchPeople).where(eq(searchPeople.threadId, row.id)),
      // Who is in a thread has no bound; in chunks, so no statement binds more than 100 parameters.
      ...insertChunks(searchPeople, doc.people).map((people) =>
        ctx.db.insert(searchPeople).values(people.map((p) => ({ ...p, threadId: row.id, inboxId: row.inboxId })))),
    ];
  }
}
