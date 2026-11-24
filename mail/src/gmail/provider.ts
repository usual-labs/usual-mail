/**
 * The Gmail provider, over Gmail's REST API. It has no `watch`: Gmail's push needs a Google Cloud Pub/Sub
 * topic the self-hoster would have to set up, so the server polls `sync` instead. It has `search` and `fetchThread`
 * (search.ts): the mailbox itself searched with Gmail's operators, read-only.
 */
import type { GmailCredentials, MailProvider, ProviderOptions } from "@usualmail/core";
import { applyGmail, sendGmail } from "./apply.ts";
import { GmailClient, type FetchLike } from "./client.ts";
import { LabelBook } from "./labels.ts";
import { COST, Gate, QuotaBucket, realClock, type Clock } from "./limits.ts";
import { gmailAttachment } from "./attachments.ts";
import { fetchFromChecks, type MessageLimits } from "./messages.ts";
import { GMAIL_CHECKER, type AuthenticationOptions } from "../message/auth-results.ts";
import { DEFAULT_GMAIL_LIMIT, syncGmail } from "./sync.ts";
import { resolveNames } from "../names.ts";
import { fetchGmailThread, searchGmail } from "./search.ts";
import { checkLimit, checkSince } from "../options.ts";

export interface GmailProviderOptions extends ProviderOptions {
  /** Defaults to the global fetch. Tests pass a fake of Gmail's API. */
  fetch?: FetchLike;
  /** Time and waiting, replaceable in tests. */
  clock?: Clock;
  /** Quota units per second this provider may spend. Default 80 (Gmail allows 6,000 a minute per user). */
  quotaPerSecond?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** Retries after a rate limit or server error. Default 6. */
  maxRetries?: number;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /**
   * After Gmail's history expired, messages that arrived from this long before the last good sync on are
   * fetched again whole; older ones are sent as `changed`. Default 2 days.
   */
  resyncWindowMs?: number;
  /**
   * Messages whose `sizeEstimate` is over this many bytes are read in Gmail's full form without their attachments'
   * bytes, and stored as their raw form would be. Each message's size is then read first (the minimal form, 20 quota
   * units on top of the raw form's 60). Default `Infinity`: every message is read raw without the check, as before,
   * since Node has the memory and the check costs a third more quota per message. A host with little memory lowers
   * it (`GMAIL_SMALL_MEMORY`: 2 MiB).
   */
  largeMessageBytes?: number;
  /**
   * Messages fetched and converted at once, across sync, opening a conversation and attachments; each holds at most
   * one message (or attachment) in memory. Default 4, as many as requests in flight by default; a host with little
   * memory lowers it (`GMAIL_SMALL_MEMORY`: 2). Ignored when `gate` is given.
   */
  messageConcurrency?: number;
  /**
   * The slots this provider takes turns in, from `createGate`. A host that runs many inboxes in one memory (the
   * Cloudflare host's one Durable Object) passes the same gate to every Gmail provider, so the bound holds for all of
   * them together, not per inbox. Without it, each provider has its own `messageConcurrency` slots.
   */
  gate?: MessageGate;
}

/** Turns for messages and attachments, to share between providers: see `GmailProviderOptions.gate`. */
export interface MessageGate {
  readonly slots: number;
}

/** A gate of `slots` turns for every Gmail provider given it. */
export function createGate(slots: number): MessageGate {
  const gate = new Gate(checkPositive(slots, "slots", true));
  return Object.assign(gate, { slots: gate.size });
}

/**
 * The limits for a host with little memory, such as a Cloudflare Worker's 128 MB isolate. The raw form peaks at
 * roughly eight times a message's size while it is parsed (the spike: a 30 MB message took local workerd from 101 to
 * 350 MB), so two raw messages of at most 2 MiB stay near 32 MB. Mail over 2 MiB is nearly always mail with
 * attachments, which the server never stores, so reading it without their bytes loses nothing it keeps.
 */
export const GMAIL_SMALL_MEMORY = { largeMessageBytes: 2 * 1024 * 1024, messageConcurrency: 2 } as const satisfies GmailProviderOptions;

export function createGmailProvider(credentials: unknown, options: GmailProviderOptions = {}): MailProvider {
  const creds = checkGmailCredentials(credentials);
  checkSince(options.since);
  const clock = options.clock ?? realClock;
  const perSecond = options.quotaPerSecond ?? 80;
  const client = new GmailClient(creds, {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    clock,
    quota: new QuotaBucket(perSecond, Math.max(COST.messagesSend, perSecond * 7.5), clock),
    gate: new Gate(options.concurrency ?? 4),
    maxRetries: options.maxRetries ?? 6,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const limits: MessageLimits = {
    largeMessageBytes: checkPositive(options.largeMessageBytes ?? Number.POSITIVE_INFINITY, "largeMessageBytes"),
    gate: options.gate ? gateOf(options.gate) : new Gate(checkPositive(options.messageConcurrency ?? 4, "messageConcurrency", true)),
  };
  const names = resolveNames(options);
  const labels = new LabelBook(client, names);
  // Gmail's own checker stamps every message it receives; the server asks for what it proved when it shows pictures.
  const authentication: AuthenticationOptions | undefined = options.authentication
    ? { checker: GMAIL_CHECKER, organisationalDomain: (domain) => options.authentication!.organisationalDomain(domain) }
    : undefined;
  let address: Promise<string> | undefined;
  const ownAddress = () => {
    address ??= client
      .request<{ emailAddress: string }>("GET", "/profile", { cost: COST.getProfile })
      .then((profile) => profile.emailAddress.toLowerCase())
      .catch((error) => {
        address = undefined;
        throw error;
      });
    return address;
  };

  return {
    kind: "gmail",

    connection() {
      return { kind: "gmail", clientId: creds.clientId };
    },

    async verify() {
      await client.accessToken(true);
      return { address: await ownAddress() };
    },

    sync(cursor, syncOptions) {
      return syncGmail(client, cursor, checkLimit(syncOptions?.limit, DEFAULT_GMAIL_LIMIT), {
        labels,
        ownAddresses: async () => [await ownAddress()],
        since: options.since,
        clock,
        resyncWindowMs: options.resyncWindowMs ?? 2 * 24 * 60 * 60 * 1000,
        limits,
        ...(authentication && { authentication }),
        ...(syncOptions?.onProgress && { onProgress: syncOptions.onProgress }),
      });
    },

    fetchAttachment(ref, attachmentId) {
      return gmailAttachment(client, ref, attachmentId, limits);
    },

    apply(ops) {
      return applyGmail(client, labels, ops);
    },

    send(message) {
      return sendGmail(client, message);
    },

    search(query, searchOptions) {
      return searchGmail(client, query, names, { limit: checkLimit(searchOptions.limit, 10), ...(searchOptions.page !== undefined && { page: searchOptions.page }) });
    },

    async fetchThread(threadKey) {
      return fetchGmailThread(client, threadKey, {
        ownAddresses: [await ownAddress()],
        labelIds: await labels.ids(),
        limits,
        ...(authentication && { authentication }),
      });
    },

    ...(authentication && {
      fromChecks(refs: readonly string[]) {
        return fetchFromChecks(client, refs, authentication);
      },
    }),

    async close() {
      // Nothing is held open between calls.
    },
  };
}

function gateOf(gate: MessageGate): Gate {
  if (!(gate instanceof Gate)) throw new Error("gate must come from createGate.");
  return gate;
}

function checkPositive(value: number, name: string, integer = false): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "whole number" : "number"}.`);
  }
  return value;
}

function checkGmailCredentials(value: unknown): GmailCredentials {
  const creds = value as Partial<GmailCredentials> | undefined;
  for (const key of ["clientId", "clientSecret", "refreshToken"] as const) {
    if (typeof creds?.[key] !== "string" || !creds[key]) throw new Error(`Gmail credentials need ${key}.`);
  }
  return creds as GmailCredentials;
}
