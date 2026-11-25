// The sync engine: one work queue per inbox for syncing and writing back, providers opened on demand,
// watching (where the provider can) and polling for new mail, how far a first sync has got (progress.ts), when an inbox
// needs attention (health.ts) or has stopped syncing (watch.ts), repairing the provider after a start or a reconnect,
// holding write-backs while an inbox is paused, and the timer for come-back times and sent drafts no longer kept.

import { notSyncingAfterMs, type MailProvider, type ProviderOpResult, type SyncProgress } from "@usualmail/core";
import { eq, inArray } from "drizzle-orm";
import { mayProcess } from "../ai/state.ts";
import { providerCredentials } from "../google/credentials.ts";
import { actions, inboxes, type InboxRow } from "../db/index.ts";
import { failRecords, failUndo } from "../service/actions.ts";
import { expireSentDrafts, nextSentExpiry } from "../service/drafts.ts";
import type { Ctx, Hooks, WriteBackTask } from "../service/context.ts";
import { syncSince } from "../service/inboxes.ts";
import { noteRecord } from "../service/records.ts";
import { toInbox } from "../service/rows.ts";
import { getInbox } from "../service/store.ts";
import { errorMessage, Mutex, WorkQueues } from "../util.ts";
import { announceComeBacks, nextComeBack } from "./comeback.ts";
import { ingest } from "./ingest.ts";
import { afterFailure, afterSuccess, classifyFailure, settled } from "./health.ts";
import { FirstSyncCounts } from "./progress.ts";
import { markNotSyncing, storeHealth } from "./status.ts";
import { SyncWatch } from "./watch.ts";
import { planOps, recordResults } from "./writeback.ts";

/** Timers longer than this are re-armed, so a sleeping laptop or a far-off time can't drift too far. */
const MAX_TIMER_MS = 6 * 60 * 60_000;

interface Loop {
  pollCancel: (() => void) | null;
  stopWatch: (() => Promise<void>) | null;
}

export class SyncEngine {
  readonly #ctx: Ctx;
  readonly #queues: WorkQueues;
  readonly #providers = new Map<string, Promise<MailProvider>>();
  readonly #loops = new Map<string, Loop>();
  readonly #syncQueued = new Set<string>();
  /** Inboxes to repair after their next good sync: just opened, or their last sync failed. */
  readonly #repairDue = new Set<string>();
  /**
   * Write-backs held while their inbox is paused, in order. They run after the inbox's first good sync once it is
   * resumed, so a refusal then still fails their records. Kept in memory: after a restart the repair sends the
   * differences instead.
   */
  readonly #held = new Map<string, WriteBackTask[]>();
  readonly #armLock = new Mutex();
  /** The host's client secret each open provider of a signed-in inbox was opened with. */
  readonly #openedWith = new Map<string, string>();
  /** The first sync's window (its start) each open provider was opened with. */
  readonly #openedSince = new Map<string, string>();
  readonly #firstSync: FirstSyncCounts;
  /**
   * Inboxes being closed (paused, removed, given new credentials, the server stopping), each with how many closes are
   * under way: a sync running for one stops once the batch in hand is stored, and one queued before the close doesn't
   * start.
   */
  readonly #closing = new Map<string, number>();
  /** Per inbox, the last close asked for that runs in the background: the next one of the inbox runs after it. */
  readonly #closes = new Map<string, Promise<void>>();
  #started = false;
  #comeBackCancel: (() => void) | null = null;
  /** Whether syncs still finish (watch.ts): looks every `everyMs` while the engine runs. */
  readonly #liveness: SyncWatch;
  /** The host's monotonic clock (`Clock.monotonic`), or the wall clock where it has none. */
  readonly #monotonic: () => number;

  constructor(ctx: Ctx) {
    this.#ctx = ctx;
    this.#queues = new WorkQueues((error) => ctx.host.log.error("Background mail work failed", error));
    this.#firstSync = new FirstSyncCounts(ctx, (work) => this.#queues.track(work));
    const clock = ctx.host.clock;
    this.#monotonic = () => clock.monotonic?.() ?? clock.now();
    this.#liveness = new SyncWatch(this.#monotonic, notSyncingAfterMs(ctx.options.pollIntervalMs));
    this.#liveness.onSilent = (inboxIds) => markNotSyncing(ctx, inboxIds, this.#liveness);
    // Life again after `not_syncing` (a batch stored mid-sync, a write-back done): settled at once.
    this.#liveness.onRevived = (inboxId) =>
      this.#queues.track(storeHealth(ctx, inboxId, (r) => (r.statusReason === "not_syncing" ? settled(r) : null)));
  }

  hooks(): Hooks {
    return {
      writeBack: (task) => this.#writeBack(task),
      requestSync: (inboxId) => this.requestSync(inboxId),
      timersChanged: () => this.#armTimer(),
      inboxOpened: (inboxId) => this.#open(inboxId),
      inboxClosed: (inboxId, options) => this.#closeInBackground(inboxId, options?.reopen ?? false),
      provider: (inboxId) => this.provider(inboxId),
    };
  }

  /**
   * Starts watching or polling every inbox that isn't paused, the come-back timer and the watch on syncs. Come-back
   * times that passed while the server was stopped are announced at once. An inbox an earlier run said had stopped
   * syncing is settled first: that was the earlier run's, and this one begins afresh. Nothing starts if `signal` was
   * aborted while the inboxes were read (the Node host asked to stop during its start-up).
   */
  async start(signal?: AbortSignal): Promise<void> {
    this.#started = true;
    const rows = await this.#ctx.db.select({ id: inboxes.id, paused: inboxes.paused, reason: inboxes.statusReason }).from(inboxes);
    if (signal?.aborted) {
      this.#started = false;
      return;
    }
    for (const row of rows) {
      if (row.reason === "not_syncing") await storeHealth(this.#ctx, row.id, (r) => (r.statusReason === "not_syncing" ? settled(r) : null));
    }
    for (const row of rows) if (!row.paused) this.#open(row.id);
    this.#queues.track(this.#fireTimer());
    this.#liveness.start(this.#ctx.host.scheduler, (work) => this.#queues.track(work));
  }

  /**
   * Closes every inbox together: each is marked closing before any close waits, so none starts another batch while
   * another's batch in hand is stored, and the stop waits for the longest batch in hand, not one after another.
   */
  async stop(): Promise<void> {
    this.#started = false;
    this.#comeBackCancel?.();
    this.#comeBackCancel = null;
    this.#liveness.stop();
    // `#close` marks its inbox closing before its first wait, so mapping marks them all at once.
    await Promise.all([...this.#loops.keys()].map((id) => this.#close(id)));
    await this.#queues.idle();
    for (const [id, provider] of this.#providers) {
      this.#providers.delete(id);
      await provider.then((p) => p.close()).catch(() => undefined);
    }
  }

  /** Resolves once no sync, write-back, come-back, AI or notice work is queued or running. */
  idle(): Promise<void> {
    return this.#queues.idle();
  }

  /** Background work `idle` should wait for (the AI's queue, the notices of counts and status). */
  track(work: Promise<unknown>): void {
    this.#queues.track(work);
  }

  provider(inboxId: string): Promise<MailProvider> {
    let provider = this.#providers.get(inboxId);
    if (!provider) {
      provider = this.#createProvider(inboxId);
      this.#providers.set(inboxId, provider);
      provider.catch(() => this.#providers.delete(inboxId));
    }
    return provider;
  }

  async #createProvider(inboxId: string): Promise<MailProvider> {
    const inbox = await getInbox(this.#ctx, inboxId);
    if (!inbox) throw new Error("This inbox no longer exists");
    const factory = this.#ctx.providers.get(inbox.provider);
    if (!factory) throw new Error(`This server has no ${inbox.provider} provider installed`);
    const since = syncSince(this.#ctx, inbox.createdAt);
    this.#openedSince.set(inboxId, since);
    // With sender pictures on, a provider whose checker the server trusts says what it proved about each From domain.
    const suffixes = this.#ctx.avatars?.suffixes;
    const authentication = suffixes && { organisationalDomain: (domain: string) => suffixes.registrableDomain(domain) };
    return factory(await providerCredentials(this.#ctx, inbox), { since, ...(authentication && { authentication }) });
  }

  // --- Sync ----------------------------------------------------------------------------------------------

  /** Queues a sync of the inbox, unless one is already waiting to start. */
  requestSync(inboxId: string): void {
    if (this.#syncQueued.has(inboxId)) return;
    this.#syncQueued.add(inboxId);
    void this.#queues.enqueue(inboxId, async () => {
      this.#syncQueued.delete(inboxId);
      await this.#sync(inboxId);
    });
  }

  async #sync(inboxId: string): Promise<void> {
    // Not started, or stopping: a sync asked for once its inbox's close is done ("sync now", a watch, a sent draft)
    // would open the provider again while the stop waits for another inbox's batch in hand.
    if (!this.#started) return;
    const ctx = this.#ctx;
    const inbox = await getInbox(ctx, inboxId);
    if (!inbox || inbox.paused || this.#closing.has(inboxId)) return;
    // A failure's run counts from here, so a long hang before it is failing time, not a gap (health.ts). Its length is
    // on the monotonic clock: a machine asleep mid-attempt (a Mac's lid closed) is a gap, never failing time.
    const began = this.#monotonic();
    try {
      await this.#checkGoogleClient(inbox);
      await this.#checkWindow(inbox);
      const provider = await this.provider(inboxId);
      const history = !inbox.historyDone;
      let cursor = inbox.syncCursor;
      // Whether the provider said nothing more is left; else the rounds ran out and the next sync goes on.
      let finished = false;
      // How far the first sync has got, from each batch and while a slow one runs (progress.ts).
      const firstSync = this.#firstSync;
      if (history) firstSync.begin(inboxId);
      // Each word of how far it got is a sign of life too, while one long batch runs (watch.ts).
      const onProgress = history
        ? (progress: SyncProgress) => {
          this.#liveness.alive(inboxId);
          firstSync.heard(inboxId, progress);
        }
        : undefined;
      // At most `syncRounds` batches (10,000 unless set), so one inbox's long first sync lets the other work in.
      for (let round = 0; round < ctx.options.syncRounds; round++) {
        // Being closed since the sync began (while its provider opened, say), or the engine stopping: no batch starts.
        if (!this.#started || this.#closing.has(inboxId)) return;
        // The host bounds the batch (`HostLimits.syncBatch`): it is held converted until stored.
        const batch = await provider.sync(cursor, { limit: ctx.limits.syncBatch, ...(onProgress && { onProgress }) });
        const result = await ctx.lock.run(async () => {
          const fresh = await getInbox(ctx, inboxId);
          if (!fresh) return null;
          // Whether new mail is processed as it arrives: the AI may run, and this inbox's mail goes to it.
          return { ...await ingest(ctx, fresh, batch, history, !history && await mayProcess(ctx)), paused: fresh.paused };
        });
        if (!result) return;
        this.#liveness.alive(inboxId);
        if (result.tidy.length) this.#writeBack({ inboxId, threadIds: result.tidy, recordIds: [] });
        if (result.aiNow.length) ctx.aiQueue.enqueue(result.aiNow);
        cursor = batch.cursor;
        if (!batch.more) {
          finished = true;
          break;
        }
        // Paused or being closed meanwhile: stop here, the batch in hand stored with its cursor, so the pause (or the
        // removal, or the stop) waits for one batch, not the whole sync. A first sync isn't done: its count stays and
        // the next sync, once the inbox is resumed or opened again, goes on from the cursor.
        if (result.paused || this.#closing.has(inboxId)) return;
        if (history && batch.progress) firstSync.heard(inboxId, batch.progress);
      }
      // The first sync's mail is history for the AI.
      if (history && finished) ctx.aiQueue.wake();
      // The first sync is done only once the provider has sent all of it: until then its mail stays history (not
      // screened as new), and its count stays.
      const now = ctx.now();
      await storeHealth(ctx, inboxId, () => afterSuccess(now), { lastSyncedAt: now, ...(history && finished && { historyDone: true }) });
      this.#liveness.alive(inboxId);
      if (history && finished) firstSync.forget(inboxId);
      // Once the provider's own changes are in: what was held while the inbox was paused, in order.
      const held = this.#held.get(inboxId) ?? [];
      this.#held.delete(inboxId);
      for (const task of held) this.#writeBack(task);
      // After a start or a reconnect: send whatever a write-back lost while the process was stopped or the mailbox
      // unreachable.
      if (this.#repairDue.delete(inboxId)) this.#writeBack({ inboxId, threadIds: [], wholeInbox: true, recordIds: [] });
      // The rounds ran out: the next sync goes on at once, queued after those write-backs so they don't wait for it.
      if (!finished) this.requestSync(inboxId);
    } catch (error) {
      // Removed meanwhile: the batch in hand may fail (a Google sign-in is revoked at once), and nothing is left to tell.
      if (!await getInbox(ctx, inboxId)) return;
      // Being closed (paused, given new credentials, the server stopping): the batch in hand may fail with the old
      // provider. The status stays as the change left it ("connecting" for new credentials), and the next sync once
      // the inbox is opened again says how it goes.
      if (this.#closing.has(inboxId)) {
        ctx.host.log.info(`Syncing ${inboxId} stopped as it was closed: ${errorMessage(error)}`);
        return;
      }
      ctx.host.log.error(`Syncing ${inboxId} failed: ${errorMessage(error)}`);
      this.#repairDue.add(inboxId);
      // A refused sign-in or the host's setup needs the person at once; a failure that may pass only after the grace.
      const failure = classifyFailure(inbox, error, ctx.google?.clientFix);
      const endedAt = ctx.now();
      const attempt = { startedAt: endedAt - (this.#monotonic() - began), endedAt };
      await storeHealth(ctx, inboxId, (row) => afterFailure(row, failure, attempt, this.#liveness.afterMs));
      // After storing, so a `not_syncing` this attempt ends goes to what it found, not to `ok` first.
      this.#liveness.alive(inboxId);
    } finally {
      this.#schedulePoll(inboxId);
    }
  }

  #open(inboxId: string): void {
    if (!this.#started || this.#loops.has(inboxId)) return;
    const loop: Loop = { pollCancel: null, stopWatch: null };
    this.#loops.set(inboxId, loop);
    this.#liveness.opened(inboxId);
    this.#repairDue.add(inboxId);
    this.#queues.track(this.#watch(inboxId, loop));
    this.requestSync(inboxId);
  }

  async #watch(inboxId: string, loop: Loop): Promise<void> {
    try {
      const provider = await this.provider(inboxId);
      if (!provider.watch) return;
      const stop = await provider.watch(() => this.requestSync(inboxId));
      if (this.#loops.get(inboxId) !== loop) {
        await stop();
        return;
      }
      // The poll goes on: a watch may not see every folder (IMAP watches only INBOX), so mail a server-side rule
      // filed elsewhere, and changes made there, still arrive within the poll interval.
      loop.stopWatch = stop;
    } catch (error) {
      this.#ctx.host.log.error(`Watching ${inboxId} failed, so it is polled instead: ${errorMessage(error)}`);
    }
  }

  #schedulePoll(inboxId: string): void {
    const loop = this.#loops.get(inboxId);
    if (!this.#started || !loop) return;
    loop.pollCancel?.();
    loop.pollCancel = this.#ctx.host.scheduler.setTimer(this.#ctx.options.pollIntervalMs, () => {
      loop.pollCancel = null;
      this.requestSync(inboxId);
    });
  }

  /**
   * An inbox connected by signing in with Google uses the host's client secret, which the host may change or take
   * away while the server runs. Before each sync: no client, or another one, fails it with words to act on; a changed
   * secret opens the provider again.
   */
  async #checkGoogleClient(inbox: InboxRow): Promise<void> {
    if (inbox.connection?.kind !== "gmail" || inbox.connection.signIn !== "google") return;
    const credentials = await providerCredentials(this.#ctx, inbox) as { clientSecret?: string };
    const secret = credentials.clientSecret ?? "";
    if (this.#openedWith.get(inbox.id) === secret) return;
    if (this.#openedWith.has(inbox.id)) await this.#dropProvider(inbox.id);
    this.#openedWith.set(inbox.id, secret);
  }

  /**
   * A person may change the first sync's window while the server runs. Before each sync of an inbox whose first sync
   * is still in progress: a provider opened with another window is opened again, so a smaller one narrows what is
   * still to fetch (a provider never widens a first sync). A finished first sync doesn't read the window again.
   */
  async #checkWindow(inbox: InboxRow): Promise<void> {
    if (inbox.historyDone || !this.#providers.has(inbox.id)) return;
    if (this.#openedSince.get(inbox.id) !== syncSince(this.#ctx, inbox.createdAt)) await this.#dropProvider(inbox.id);
  }

  async #dropProvider(inboxId: string): Promise<void> {
    const provider = this.#providers.get(inboxId);
    this.#providers.delete(inboxId);
    await provider?.then((p) => p.close()).catch(() => undefined);
  }

  /**
   * A pause, a removal or new credentials: the inbox is closed while the caller answers (`Hooks.inboxClosed`). The
   * first close starts at once, so a running sync stops after its batch in hand and none queued starts; closes of one
   * inbox run in the order asked, so a quick pause and resume can't open it while an earlier close still drops its
   * provider. With `reopen` it is opened again once closed, unless by then it is paused or gone (or the engine
   * stopped). Tracked, so `idle` and `stop` wait for it. On Cloudflare the Durable Object stays up while the batch's
   * fetches and the server's timers are pending, as for any sync; were it evicted, nothing is lost: the change is
   * stored first.
   */
  #closeInBackground(inboxId: string, reopen: boolean): void {
    const run = async () => {
      await this.#close(inboxId);
      if (!reopen) return;
      const row = await getInbox(this.#ctx, inboxId);
      if (row && !row.paused) this.#open(inboxId);
    };
    const previous = this.#closes.get(inboxId);
    const done = previous ? previous.then(run, run) : run();
    this.#closes.set(inboxId, done);
    this.#queues.track(done.finally(() => {
      if (this.#closes.get(inboxId) === done) this.#closes.delete(inboxId);
    }));
  }

  /** Counts a close of the inbox under way (1) or done (-1): two at once don't clear it early. */
  #markClosing(inboxId: string, change: 1 | -1): void {
    const closes = (this.#closing.get(inboxId) ?? 0) + change;
    if (closes > 0) this.#closing.set(inboxId, closes);
    else this.#closing.delete(inboxId);
  }

  /** Marks the inbox closing before its first wait (`stop` relies on it), then waits for its batch in hand. */
  async #close(inboxId: string): Promise<void> {
    this.#markClosing(inboxId, 1);
    this.#liveness.forget(inboxId);
    const loop = this.#loops.get(inboxId);
    this.#loops.delete(inboxId);
    try {
      if (loop) {
        loop.pollCancel?.();
        await loop.stopWatch?.().catch(() => undefined);
      }
      // Let queued work for this inbox finish before its connection closes: a running sync stops after its batch in hand.
      await this.#queues.enqueue(inboxId, async () => {});
    } finally {
      this.#markClosing(inboxId, -1);
    }
    this.#firstSync.forget(inboxId);
    this.#openedWith.delete(inboxId);
    await this.#dropProvider(inboxId);
  }

  // --- Writing back --------------------------------------------------------------------------------------

  /** Queued with the inbox's syncs; one done is a sign of life, since a long backlog delays them (watch.ts). */
  #writeBack(task: WriteBackTask): void {
    void this.#queues.enqueue(task.inboxId, () => this.#runWriteBack(task).finally(() => this.#liveness.alive(task.inboxId)));
  }

  async #runWriteBack(task: WriteBackTask): Promise<void> {
    const ctx = this.#ctx;
    const inbox = await getInbox(ctx, task.inboxId);
    if (!inbox) {
      this.#held.delete(task.inboxId);
      return;
    }
    if (inbox.paused) {
      // A paused inbox is written nothing. Its actions still apply here and go out once it is resumed.
      this.#held.set(task.inboxId, [...(this.#held.get(task.inboxId) ?? []), task]);
      return;
    }
    const scope = task.wholeInbox ? { inboxId: task.inboxId } : { threadIds: task.threadIds };
    let refusal: string | null = null;
    for (const phase of ["trash", "place"] as const) {
      const planned = await ctx.lock.run(() => planOps(ctx, scope, phase));
      if (planned.length === 0) continue;
      let results: ProviderOpResult[];
      try {
        results = await (await this.provider(task.inboxId)).apply(planned.map((p) => p.op));
      } catch (error) {
        results = planned.map(() => ({ ok: false, error: errorMessage(error) }));
      }
      const recorded = await ctx.lock.run(async () => {
        const out = await recordResults(ctx, planned, results);
        await this.#notes(task, out.notes);
        return out;
      });
      refusal = recorded.refusal;
      if (refusal) break;
    }
    if (!refusal) return;
    // Removed meanwhile: its records went with it, and a refusal (a Google sign-in is revoked at once) is nothing to tell.
    if (!await getInbox(ctx, task.inboxId)) return;
    if (!task.undo && task.recordIds.length === 0) {
      ctx.host.log.error(`Couldn't update ${task.inboxId} at the provider: ${refusal}`);
      return;
    }
    const error = refusal;
    await ctx.lock.run(async () => {
      if (task.undo) await failUndo(ctx, task.undo.recordId, task.undo.before, error);
      else await failRecords(ctx, task.recordIds, error);
    });
    // Put back at the provider whatever did go through. A refusal here is only logged.
    this.#writeBack({ inboxId: task.inboxId, threadIds: task.threadIds, recordIds: [] });
  }

  /**
   * A provider's notes on changes that worked go on the record that caused the write-back: the undone record
   * for an undo, else the latest record that touched the note's thread. A note on a tidy-up that no record
   * caused is only logged.
   */
  async #notes(task: WriteBackTask, notes: Array<{ threadId: string; note: string }>): Promise<void> {
    if (notes.length === 0) return;
    const ctx = this.#ctx;
    const records = task.recordIds.length
      ? await ctx.db.select({ id: actions.id, before: actions.before }).from(actions).where(inArray(actions.id, task.recordIds))
      : [];
    for (const { threadId, note } of notes) {
      const touching = task.undo
        ? task.undo.recordId
        : [...task.recordIds].reverse().find((id) => records.find((r) => r.id === id)?.before.threads.some((t) => t.id === threadId));
      if (touching) await noteRecord(ctx, touching, note);
      else ctx.host.log.info(`Note from inbox ${task.inboxId}: ${note}`);
    }
  }

  // --- Come back, and sent drafts no longer kept ---------------------------------------------------------

  #armTimer(): void {
    if (!this.#started) return;
    this.#queues.track(this.#armLock.run(async () => {
      const times = [await nextComeBack(this.#ctx), await nextSentExpiry(this.#ctx)].filter((t): t is number => t !== null);
      this.#comeBackCancel?.();
      this.#comeBackCancel = null;
      if (times.length === 0 || !this.#started) return;
      const delay = Math.min(Math.max(0, Math.min(...times) - this.#ctx.now()), MAX_TIMER_MS);
      this.#comeBackCancel = this.#ctx.host.scheduler.setTimer(delay, () => {
        this.#comeBackCancel = null;
        this.#queues.track(this.#fireTimer());
      });
    }));
  }

  /**
   * Announces the threads whose come-back time has passed, puts those that now show in Home back into the
   * provider's inbox, removes sent drafts whose day has passed, then waits for the next time.
   */
  async #fireTimer(): Promise<void> {
    const ctx = this.#ctx;
    // Read once the work runs, so everything that has passed by then is announced.
    const due = await ctx.lock.run(async () => {
      await expireSentDrafts(ctx);
      return announceComeBacks(ctx, ctx.now());
    });
    const byInbox = new Map<string, string[]>();
    for (const row of due) byInbox.set(row.inboxId, [...(byInbox.get(row.inboxId) ?? []), row.id]);
    for (const [inboxId, threadIds] of byInbox) this.#writeBack({ inboxId, threadIds, recordIds: [] });
    this.#armTimer();
  }
}
