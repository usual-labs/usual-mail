/**
 * Gmail labels for the filed categories, Screening and the stacks, created on demand under "Usual Mail/", and the
 * reverse mapping from a message's label ids to Usual Mail's placement.
 */
import { FILED_CATEGORIES, STACKS, type ProviderPlacement } from "@usualmail/core";
import { GmailApiError, type GmailClient } from "./client.ts";
import { COST } from "./limits.ts";
import { FILINGS, type Filing, type Names } from "../names.ts";

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export type LabelKey = Filing | (typeof STACKS)[number];

export class LabelBook {
  readonly client: GmailClient;
  readonly names: Names;
  #byName: Map<string, GmailLabel> | undefined;

  constructor(client: GmailClient, names: Names) {
    this.client = client;
    this.names = names;
  }

  /** Forget what was listed, so the next lookup asks Gmail again. */
  reset(): void {
    this.#byName = undefined;
  }

  async #load(): Promise<Map<string, GmailLabel>> {
    if (this.#byName) return this.#byName;
    const result = await this.client.request<{ labels?: GmailLabel[] }>("GET", "/labels", { cost: COST.labelsList });
    this.#byName = new Map((result.labels ?? []).map((label) => [label.name.toLowerCase(), label]));
    return this.#byName;
  }

  /** The label ids that exist for each category, Screening and stack. Missing ones are absent. */
  async ids(): Promise<Partial<Record<LabelKey, string>>> {
    const byName = await this.#load();
    const out: Partial<Record<LabelKey, string>> = {};
    for (const key of [...FILINGS, ...STACKS]) {
      const label = byName.get(this.names[key].toLowerCase());
      if (label) out[key] = label.id;
    }
    return out;
  }

  /** The label id for a category, Screening or a stack, creating the label when it doesn't exist yet. */
  async ensure(key: LabelKey): Promise<string> {
    const name = this.names[key];
    const existing = (await this.#load()).get(name.toLowerCase());
    if (existing) return existing.id;
    try {
      const created = await this.client.request<GmailLabel>("POST", "/labels", {
        cost: COST.labelsCreate,
        body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      });
      (await this.#load()).set(name.toLowerCase(), created);
      return created.id;
    } catch (error) {
      // Someone made it meanwhile (Gmail answers 409): list again and use theirs.
      if (!(error instanceof GmailApiError) || error.status !== 409) throw error;
      this.reset();
      const found = (await this.#load()).get(name.toLowerCase());
      if (!found) throw error;
      return found.id;
    }
  }
}

/**
 * What Usual Mail reads from a message's labels, as bits, so a reset can keep many messages' state in the
 * cursor compactly. Gmail can always keep stacks, so a placement from labels has `stack` set or null.
 */
export const STATE_BITS = {
  INBOX: 1,
  UNREAD: 2,
  TRASH: 4,
  SPAM: 8,
  newsletter: 16,
  invoice: 32,
  receipt: 64,
  notification: 128,
  otp: 256,
  screening: 512,
  reply_later: 1024,
  set_aside: 2048,
} as const;

export type StateKey = keyof typeof STATE_BITS;
export const STATE_KEYS = Object.keys(STATE_BITS) as StateKey[];

/** The label id behind each state bit: system labels by name, categories, Screening and stacks where their labels exist. */
export function stateLabelIds(ids: Partial<Record<LabelKey, string>>): Partial<Record<StateKey, string>> {
  return { INBOX: "INBOX", UNREAD: "UNREAD", TRASH: "TRASH", SPAM: "SPAM", ...ids };
}

export function stateBits(labelIds: readonly string[], ids: Partial<Record<LabelKey, string>>): number {
  const has = new Set(labelIds);
  const byKey = stateLabelIds(ids);
  let bits = 0;
  for (const key of STATE_KEYS) if (byKey[key] !== undefined && has.has(byKey[key]!)) bits |= STATE_BITS[key];
  return bits;
}

/**
 * A message's labels in Usual Mail's terms. Gmail keeps every label on a message, so `category` is the filed
 * category whose label it carries (the first in `FILED_CATEGORIES` order if a person added two) or null, also while
 * it is screened, and `stack` is the stack or null.
 */
export function placementFromBits(bits: number): ProviderPlacement {
  return {
    inInbox: (bits & STATE_BITS.INBOX) !== 0,
    category: FILED_CATEGORIES.find((c) => (bits & STATE_BITS[c]) !== 0) ?? null,
    screened: (bits & STATE_BITS.screening) !== 0,
    stack: STACKS.find((s) => (bits & STATE_BITS[s]) !== 0) ?? null,
    trashed: (bits & STATE_BITS.TRASH) !== 0,
    spam: (bits & STATE_BITS.SPAM) !== 0,
  };
}

export function seenFromBits(bits: number): boolean {
  return (bits & STATE_BITS.UNREAD) === 0;
}

export function placementFromLabels(labelIds: readonly string[], ids: Partial<Record<LabelKey, string>>): ProviderPlacement {
  return placementFromBits(stateBits(labelIds, ids));
}
