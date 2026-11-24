/**
 * `syncAll` runs a provider's `sync` until it has nothing more, and keeps what a server would hold, applying
 * each batch the way docs/contract.md says: upserts, then changes to known messages, then removals; and
 * after a `reset` listing ends, everything the listing didn't include (in `upserted` or `changed`) is
 * dropped. Tests read both what came back in the run and what is held after it.
 */
import type { MailProvider, ProviderMessage, ProviderOp, ProviderOpResult, SyncProgress } from "@usualmail/core";

export interface BatchLog {
  upserted: string[];
  changed: string[];
  removed: string[];
  reset: boolean;
  /** How far a first sync had got, when the batch said. */
  progress?: SyncProgress;
}

export interface SyncResult {
  /** What a server would hold after the run, by ref. */
  view: Map<string, ProviderMessage>;
  /** Messages that came back in this run (sent whole or changed), as they are after it, by ref. */
  messages: Map<string, ProviderMessage>;
  /** Refs sent whole in this run. */
  upserted: string[];
  /** Refs sent as `changed` in this run. */
  changed: string[];
  /** Refs reported removed in this run. */
  removed: string[];
  /** Refs dropped because a reset listing left them out. */
  dropped: string[];
  /** Refs in `changed` that weren't held, so a server could do nothing with them. */
  unknownChanged: string[];
  /** How many batches said `reset`. */
  resets: number;
  /** Every batch, in order. */
  log: BatchLog[];
  cursor: string;
  batches: number;
}

/**
 * Calls sync until `more` is false, or for at most `batches` calls. `from` is a cursor (or null for a first sync),
 * which starts with nothing held, or an earlier result, whose cursor and held messages it continues from.
 */
export async function syncAll(
  provider: MailProvider,
  from: string | null | SyncResult,
  options: number | { limit?: number; batches?: number } = {},
): Promise<SyncResult> {
  const limit = typeof options === "number" ? options : options.limit;
  const most = typeof options === "number" ? undefined : options.batches;
  const previous = from !== null && typeof from === "object" ? from : undefined;
  const result: SyncResult = {
    view: new Map(previous?.view ?? []),
    messages: new Map(),
    upserted: [],
    changed: [],
    removed: [],
    dropped: [],
    unknownChanged: [],
    resets: 0,
    log: [],
    cursor: previous ? previous.cursor : (from as string | null) ?? "",
    batches: 0,
  };
  let current: string | null = previous ? previous.cursor : (from as string | null);
  let listing: Set<string> | undefined;
  for (let batches = 1; batches <= 500; batches++) {
    const batch = await provider.sync(current, limit === undefined ? undefined : { limit });
    const changes = batch.changed ?? [];
    result.log.push({
      upserted: batch.upserted.map((m) => m.ref),
      changed: changes.map((c) => c.ref),
      removed: [...batch.removed],
      reset: batch.reset === true,
      ...(batch.progress && { progress: { ...batch.progress } }),
    });
    if (batch.reset) {
      result.resets++;
      listing = new Set();
    }
    for (const message of batch.upserted) {
      result.view.set(message.ref, message);
      result.messages.set(message.ref, message);
      result.upserted.push(message.ref);
      listing?.add(message.ref);
    }
    for (const change of changes) {
      result.changed.push(change.ref);
      listing?.add(change.ref);
      const known = result.view.get(change.ref);
      if (!known) {
        result.unknownChanged.push(change.ref);
        continue;
      }
      const updated: ProviderMessage = { ...known, seen: change.seen, placement: change.placement };
      result.view.set(change.ref, updated);
      result.messages.set(change.ref, updated);
    }
    for (const ref of batch.removed) {
      result.view.delete(ref);
      result.messages.delete(ref);
      result.removed.push(ref);
    }
    if (!batch.more && listing) {
      for (const ref of [...result.view.keys()]) {
        if (listing.has(ref)) continue;
        result.view.delete(ref);
        result.messages.delete(ref);
        result.dropped.push(ref);
      }
      listing = undefined;
    }
    current = batch.cursor;
    result.cursor = batch.cursor;
    result.batches = batches;
    if (!batch.more || batches === most) return result;
  }
  throw new Error("sync kept saying there was more after 500 batches");
}

/**
 * Applies ops the way the server does: when `apply` gives a message a new ref, what is held under the old ref is
 * held under the new one from then on. A provider may then report that message in `changed` instead of sending
 * it whole again (docs/contract.md, "Providers").
 */
export async function applyTracked(provider: MailProvider, state: SyncResult, ops: ProviderOp[]): Promise<ProviderOpResult[]> {
  const results = await provider.apply(ops);
  track(state, ops, results);
  return results;
}

/** Renames held messages after `apply` moved them, as the server stores a ref `apply` returns. */
export function track(state: SyncResult, ops: readonly ProviderOp[], results: readonly ProviderOpResult[]): void {
  ops.forEach((op, index) => {
    const result = results[index];
    if (!result?.ok || !result.ref || result.ref === op.ref) return;
    const held = state.view.get(op.ref);
    if (!held) return;
    state.view.delete(op.ref);
    state.view.set(result.ref, { ...held, ref: result.ref });
  });
}

/** The batch in which a ref first came back (whole or changed), or -1. */
export function batchOf(result: SyncResult, ref: string, kind: "arrived" | "removed"): number {
  return result.log.findIndex((batch) => (kind === "removed" ? batch.removed.includes(ref) : batch.upserted.includes(ref) || batch.changed.includes(ref)));
}
