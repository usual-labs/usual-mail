// What every part of the service shares: the host, the store, one lock for read-modify-write work, the hooks the
// sync engine fills in, the server's AI and what tells clients that counts and the AI's status changed.

import { FIRST_SYNC_DEFAULT_DAYS, type FirstSyncSource, type MailEvent, type MailProvider } from "@usualmail/core";
import type { AiModelAccess } from "../ai/models.ts";
import type { SuffixList } from "../avatars/suffixes.ts";
import type { GoogleOptions } from "../google/config.ts";
import { SignIns } from "../google/store.ts";
import type { Database } from "../db/index.ts";
import { NODE_LIMITS, type Host, type HostLimits } from "../host.ts";
import { PicturePlans, servedPlans } from "../pictures/present.ts";
import type { ProviderRegistry } from "../providers.ts";
import { Mutex, orderedId } from "../util.ts";
import type { OwnerCodeKeeper } from "./devices.ts";
import type { Before } from "./state.ts";

export interface ServiceOptions {
  /** How often to poll an inbox whose provider can't watch. Default one minute. */
  pollIntervalMs?: number;
  /**
   * How many days of mail a new inbox's first sync takes (`FirstSyncWindow`). Default 30 days. A person may change
   * it while the server runs when `saveSyncWindowDays` is given and the environment didn't set it.
   */
  syncWindowDays?: number;
  /** Where the host took `syncWindowDays` from. Default "default" without `syncWindowDays`, else "settings". */
  syncWindowSetBy?: FirstSyncSource;
  /** Keeps a new window where the host keeps its settings (Node: settings.json). Absent: it can't be changed here. */
  saveSyncWindowDays?: (days: number) => Promise<void>;
  /** How long a pairing code works. Default 15 minutes. */
  pairingCodeTtlMs?: number;
  /** How long the owner's first pairing code works. Default 24 hours. */
  ownerCodeTtlMs?: number;
  /** Reported by `info()`. */
  version?: string;
  /**
   * The owner's email the host named (`USUAL_MAIL_OWNER_EMAIL`): an unclaimed server is then claimed only by signing in
   * with Google as that address (docs/contract.md, "The owner's password"). Absent or null: by whoever comes first.
   */
  ownerEmail?: string | null;
  /**
   * Whether the AI processes history in the background. Default true. Demo mode turns it off, so the sample's
   * waiting thread stays as the sample has it; new mail is still processed as it arrives.
   */
  aiHistory?: boolean;
  /** Batches one sync of an inbox takes before it queues the next to go on. Default 10,000; tests lower it. */
  syncRounds?: number;
}

/** What the rest of the service asks of the AI's queue. */
export interface AiQueue {
  /** New work that should start at once: new mail the AI may process now. */
  enqueue(threadIds: string[]): void;
  /** Look again for work: settings, an inbox's AI processing or history changed. */
  wake(): void;
}

/** Tells clients, at most once a second, that counts, the AI's status or a triage queue changed. */
export interface Changes {
  /** Something that may change counts or the AI's status happened. */
  touch(): void;
}

export interface WriteBackTask {
  inboxId: string;
  threadIds: string[];
  /** Compare every thread of the inbox instead: the repair after a start or a reconnect. */
  wholeInbox?: boolean;
  /** The records this carries out, in the order they were applied. Empty when it only tidies the provider. */
  recordIds: string[];
  /** Set when this writes back an undo: the threads as they were before it, put back if the provider refuses. */
  undo?: { recordId: string; before: Before };
}

export interface Hooks {
  writeBack(task: WriteBackTask): void;
  requestSync(inboxId: string): void;
  timersChanged(): void;
  inboxOpened(inboxId: string): void;
  /**
   * Closes the inbox's connection in the background (paused, removed, new credentials): a sync running for it stops once
   * the batch in hand is stored, so the caller answers at once rather than after that batch. With `reopen` it is opened
   * again afterwards, unless it is paused or gone by then. The server's `whenIdle` and `stop` wait for it.
   */
  inboxClosed(inboxId: string, options?: { reopen?: boolean }): void;
  /** The open provider for an inbox. */
  provider(inboxId: string): Promise<MailProvider>;
}

/** Sender pictures, while the server shows them (docs/contract-avatars.md). */
export interface AvatarContext {
  /** The Public Suffix List the registrable domains come from. */
  suffixes: SuffixList;
  /** A site became due for fetching: the queue looks again. */
  wake(): void;
}

const noQueue: AiQueue = { enqueue: () => {}, wake: () => {} };
const noLookups = { wake: () => {} };
const noChanges: Changes = { touch: () => {} };

const noHooks: Hooks = {
  writeBack: () => {},
  requestSync: () => {},
  timersChanged: () => {},
  inboxOpened: () => {},
  inboxClosed: () => {},
  provider: async () => {
    throw new Error("No sync engine is attached");
  },
};

export class Ctx {
  readonly host: Host;
  readonly db: Database;
  readonly providers: ProviderRegistry;
  readonly options: Required<Omit<ServiceOptions, "syncWindowDays" | "syncWindowSetBy" | "saveSyncWindowDays">>;
  /**
   * The first sync's window: how many days a new inbox's first sync takes (a person may change it while the server
   * runs), where that came from, and how the host keeps a new one (null: it can't be changed here).
   */
  readonly firstSync: { days: number; setBy: FirstSyncSource; save: ((days: number) => Promise<void>) | null };
  /** The host's limits on memory and stored size, Node's where it set none. */
  readonly limits: Required<Omit<HostLimits, "keptPictureChars">>;
  /** The plans and served HTML of recently served messages: the process's shared ones unless the host set its own size. */
  readonly picturePlans: PicturePlans;
  /** How the AI's models are reached. */
  readonly models: AiModelAccess;
  /** Serializes every read-modify-write of the store. Provider calls happen outside it. */
  readonly lock = new Mutex();
  hooks: Hooks = noHooks;
  aiQueue: AiQueue = noQueue;
  /** The AI's cost lookups (`ai/costs.ts`): told when one is added or the settings change. */
  costLookups: { wake(): void } = noLookups;
  changes: Changes = noChanges;
  /** Sender pictures; null when the server carries no Public Suffix List, so it shows none and fetches nothing. */
  avatars: AvatarContext | null = null;
  /** Each inbox's `agentAccess`, so event filtering can stay synchronous. */
  readonly agentAccess = new Map<string, boolean>();
  /** Which inboxes each recent brief covers, for filtering `brief.ready`. */
  readonly briefInboxes = new Map<string, string[]>();
  /** When recent wrong pairing codes were tried, oldest first. Kept in memory, so a restart clears it. */
  readonly pairingFailures: number[] = [];
  /** The owner's code the host asked the service to keep (see `keepOwnerCode`). */
  ownerCode: OwnerCodeKeeper | null = null;
  /** Google sign-in, as the host set it up; null when it gave nothing. */
  google: GoogleOptions | null = null;
  /** Google sign-ins started and not yet forgotten. */
  readonly signIns = new SignIns();
  /** Runs work in the background that `whenIdle` waits for (set by the server to the engine's tracking). */
  background: (work: Promise<unknown>) => void = (work) => void work.catch(() => undefined);
  #idTime = 0;
  #idCounter = 0;

  constructor(host: Host, providers: ProviderRegistry, models: AiModelAccess, options: ServiceOptions) {
    this.host = host;
    this.db = host.db;
    this.providers = providers;
    this.models = models;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 60_000,
      pairingCodeTtlMs: options.pairingCodeTtlMs ?? 15 * 60_000,
      ownerCodeTtlMs: options.ownerCodeTtlMs ?? 24 * 60 * 60_000,
      version: options.version ?? "0.0.0",
      ownerEmail: options.ownerEmail?.trim().toLowerCase() || null,
      aiHistory: options.aiHistory ?? true,
      syncRounds: options.syncRounds ?? 10_000,
    };
    const { keptPictureChars, ...limits } = host.limits ?? {};
    this.limits = { ...NODE_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)) };
    this.picturePlans = keptPictureChars === undefined ? servedPlans : new PicturePlans(undefined, { maxKeptChars: keptPictureChars });
    this.firstSync = {
      days: options.syncWindowDays ?? FIRST_SYNC_DEFAULT_DAYS,
      setBy: options.syncWindowSetBy ?? (options.syncWindowDays === undefined ? "default" : "settings"),
      save: options.saveSyncWindowDays ?? null,
    };
  }

  now(): number {
    return this.host.clock.now();
  }

  /** A new id. Ids made later sort after ids made earlier, also within one millisecond or a stopped clock. */
  id(prefix: string): string {
    const now = this.now();
    if (now > this.#idTime) {
      this.#idTime = now;
      this.#idCounter = 0;
    } else {
      this.#idCounter++;
    }
    return orderedId(this.host.random, prefix, this.#idTime, this.#idCounter);
  }

  /**
   * Sends an event. Anything that may change counts or the AI's status is noticed, and told at most once a second.
   * `countsUnchanged` says this one can't (a first sync's count alone, every two seconds per inbox while it runs): it
   * goes to the same receivers, without working out every count and the AI's status again.
   */
  emit(event: MailEvent, { countsUnchanged = false }: { countsUnchanged?: boolean } = {}): void {
    this.host.events.publish(event);
    if (countsUnchanged) return;
    if (event.type !== "counts.changed" && event.type !== "ai.status.changed" && event.type !== "triage.pending") this.changes.touch();
  }
}
