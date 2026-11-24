/**
 * Reading Gmail messages and turning them into ProviderMessages with the same MIME parser IMAP uses. Gmail's own
 * thread id is the thread key.
 *
 * Memory stays bounded per message: messages are fetched and converted a few at a time (`MessageLimits.gate`, shared
 * by sync, opening a conversation and attachments, and by every provider a host gives the same gate), each dropped
 * once converted. With a finite `largeMessageBytes`, each message's `sizeEstimate` is read first (the minimal form, 20
 * quota units); one at or under the limit is fetched whole in the raw form (60), as always; one over it, or one whose
 * minimal form carries no `sizeEstimate`, in the full form (60) without its attachments' bytes, and the stored message
 * is built from that (full.ts), matching what the raw form would give.
 *
 * A failure that would come back with every try never fails the batch (the server would retry the same cursor
 * forever and the inbox would stop): only `failsTheBatch` errors are thrown; anything else on the full form's way
 * makes the message the usual short note, as the raw form's parser refusing it does.
 */
import type { FromCheck, ProviderMessage } from "@usualmail/core";
import { failsTheBatch, GmailApiError, type GmailClient } from "./client.ts";
import { getFull, rebuildFull, type FullGmailMessage } from "./full.ts";
import { placementFromLabels, type LabelKey } from "./labels.ts";
import { COST, type Gate } from "./limits.ts";
import { firstFromAddress, fromCheckOf, type AuthenticationOptions } from "../message/auth-results.ts";
import { parseOrNote, unreadable, type ParseContext, type ParsedMessage } from "../message/parse.ts";

export interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
  raw?: string;
}

/** Messages that aren't mail for this purpose: drafts live on the server, chats aren't mail. */
export function isSkipped(labelIds: readonly string[] | undefined): boolean {
  return Boolean(labelIds?.includes("DRAFT") || labelIds?.includes("CHAT"));
}

export async function getRaw(client: GmailClient, id: string): Promise<RawGmailMessage | undefined> {
  return getForm(client, id, "raw", COST.messagesGetRaw);
}

/** Labels and dates, without headers or body (20 units); `sizeEstimate` too, though Google doesn't promise it. */
export async function getMinimal(client: GmailClient, id: string): Promise<RawGmailMessage | undefined> {
  return getForm(client, id, "minimal", COST.messagesGet);
}

/** Whether a message read in the minimal form goes the full form's way: over the limit, or of unknown size. */
export function overLimit(message: { sizeEstimate?: unknown }, limit: number): boolean {
  return typeof message.sizeEstimate !== "number" || message.sizeEstimate > limit;
}

async function getForm(client: GmailClient, id: string, format: string, cost: number): Promise<RawGmailMessage | undefined> {
  try {
    return await client.request<RawGmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, { cost, query: { format } });
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return undefined;
    throw error;
  }
}

/** How much of a mailbox the provider holds at once. */
export interface MessageLimits {
  /**
   * Messages whose `sizeEstimate` is over this many bytes are read in the full form, without their attachments'
   * bytes; such a message downloads at most this many bytes of the parts Gmail left out. Infinity reads every message
   * raw, unchecked.
   */
  largeMessageBytes: number;
  /** Messages fetched and converted at once, and attachments downloaded at once. */
  gate: Gate;
}

export interface ConvertContext {
  ownAddresses: readonly string[];
  labelIds: Partial<Record<LabelKey, string>>;
  /** Gmail's checker and the organisational-domain rule, when the server asked for `fromCheck`. */
  authentication?: AuthenticationOptions;
  limits: MessageLimits;
}

/** What a message over the limit says when its text didn't fit the download budget and nothing of it is left. */
export const TEXT_LEFT_OUT = "This message's text is too large to keep here. Open it in Gmail to read it.";
/** The same when Gmail didn't give the text (refused, unreadable, or nested too deep), not because of its size. */
export const TEXT_NOT_GIVEN = "Gmail didn't give this message's text. Open it in Gmail to read it.";

export async function toProviderMessage(message: RawGmailMessage, context: ConvertContext): Promise<ProviderMessage> {
  const bytes = Buffer.from(message.raw ?? "", "base64url");
  // The base64 text isn't needed once decoded; let it go before the parser makes its own copies.
  delete message.raw;
  return finish(await parseOrNote(bytes, parseContext(message, context), message.id), message, context);
}

/** A message read in the full form (over the size limit), converted as its raw form would be. */
export async function fromFullForm(client: GmailClient, message: FullGmailMessage, context: ConvertContext): Promise<ProviderMessage> {
  const parse = parseContext(message, context);
  let parsed: ParsedMessage;
  try {
    const { rebuilt, textLeftOut } = await rebuildFull(client, message, { budget: context.limits.largeMessageBytes, serve: false });
    parsed = await parseOrNote(rebuilt.bytes, parse, message.id, rebuilt.leftOut);
    if (textLeftOut && parsed.text === undefined && parsed.html === undefined) parsed.text = textLeftOut === "size" ? TEXT_LEFT_OUT : TEXT_NOT_GIVEN;
  } catch (error) {
    // A failure that may pass fails the batch, to be tried again; anything else would fail the same way every time.
    if (failsTheBatch(error)) throw error;
    parsed = unreadable(error, parse, message.id);
  }
  return finish(parsed, message, context);
}

function parseContext(message: { internalDate?: string }, context: ConvertContext): ParseContext {
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : undefined;
  return { ownAddresses: context.ownAddresses, receivedAt, ...(context.authentication && { authentication: context.authentication }) };
}

function finish(parsed: ParsedMessage, message: { id: string; threadId: string; labelIds?: string[] }, context: ConvertContext): ProviderMessage {
  const labels = message.labelIds ?? [];
  // From naming the mailbox proves nothing (anyone can write it): only Gmail's SENT label makes mail the mailbox's own.
  const { fromSelf: _fromSelf, threadKey: _ignored, ...rest } = parsed;
  return {
    ...rest,
    ref: message.id,
    threadKey: message.threadId,
    seen: !labels.includes("UNREAD"),
    outgoing: labels.includes("SENT"),
    placement: placementFromLabels(labels, context.labelIds),
  };
}

/**
 * Fetches and converts `ids`, a few at a time; ids Gmail no longer has come back in `missing`, drafts and chats in
 * neither. `sizes` holds the `sizeEstimate`s a caller already has (a conversation's minimal form), saving the check.
 * `onFetched` is called as each id is done, whatever became of it (a first sync's count, `SyncOptions.onProgress`).
 */
export async function fetchMessages(
  client: GmailClient,
  ids: readonly string[],
  context: ConvertContext,
  sizes?: ReadonlyMap<string, number>,
  onFetched?: () => void,
): Promise<{ messages: ProviderMessage[]; missing: string[] }> {
  const results = await Promise.all(ids.map((id) => context.limits.gate.run(async () => {
    const result = await fetchOne(client, id, context, sizes?.get(id));
    onFetched?.();
    return result;
  })));
  const messages: ProviderMessage[] = [];
  const missing: string[] = [];
  for (const [i, result] of results.entries()) {
    if (result === "missing") missing.push(ids[i]!);
    else if (result !== "skipped") messages.push(result);
  }
  return { messages, missing };
}

async function fetchOne(client: GmailClient, id: string, context: ConvertContext, knownSize: number | undefined): Promise<ProviderMessage | "missing" | "skipped"> {
  const limit = context.limits.largeMessageBytes;
  let size = knownSize;
  if (size === undefined && Number.isFinite(limit)) {
    const minimal = await getMinimal(client, id);
    if (!minimal) return "missing";
    if (isSkipped(minimal.labelIds)) return "skipped";
    // Google documents the minimal form as the id and labels only; without a size, the full form is the safe way.
    size = overLimit(minimal, limit) ? Number.POSITIVE_INFINITY : (minimal.sizeEstimate as number);
  }
  if (size === undefined || size <= limit) {
    const raw = await getRaw(client, id);
    if (!raw) return "missing";
    return isSkipped(raw.labelIds) ? "skipped" : toProviderMessage(raw, context);
  }
  const full = await getFull(client, id);
  if (!full) return "missing";
  return isSkipped(full.labelIds) ? "skipped" : fromFullForm(client, full, context);
}

/** Label ids only (the minimal form, 20 units instead of 60). Ids Gmail no longer has map to undefined. */
export async function fetchLabelIds(client: GmailClient, ids: readonly string[]): Promise<Map<string, string[] | undefined>> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const message = await client.request<RawGmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, {
          cost: COST.messagesGet,
          query: { format: "minimal" },
        });
        return message.labelIds ?? [];
      } catch (error) {
        if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return undefined;
        throw error;
      }
    }),
  );
  return new Map(ids.map((id, i) => [id, results[i]]));
}

interface MetadataGmailMessage {
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

/**
 * What Gmail's checker proved about each message's From domain, read again in the metadata form with only the
 * Authentication-Results and From headers (20 quota units each, against 60 for the whole message). Gmail gives the
 * headers in the message's order, top first. Refs Gmail no longer has are left out.
 */
export async function fetchFromChecks(client: GmailClient, refs: readonly string[], authentication: AuthenticationOptions): Promise<Map<string, FromCheck>> {
  const results = await Promise.all(refs.map(async (ref) => {
    try {
      const message = await client.request<MetadataGmailMessage>("GET", `/messages/${encodeURIComponent(ref)}`, {
        cost: COST.messagesGet,
        query: { format: "metadata", metadataHeaders: ["Authentication-Results", "From"] },
      });
      const headers = (message.payload?.headers ?? [])
        .filter((h): h is { name: string; value: string } => typeof h.name === "string" && typeof h.value === "string")
        .map((h) => ({ key: h.name.toLowerCase(), value: h.value }));
      const from = headers.filter((h) => h.key === "from");
      const address = from.length === 1 ? firstFromAddress(from[0]!.value) : "";
      return fromCheckOf(headers, address, authentication);
    } catch (error) {
      if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return undefined;
      throw error;
    }
  }));
  const out = new Map<string, FromCheck>();
  refs.forEach((ref, i) => {
    const check = results[i];
    if (check) out.set(ref, check);
  });
  return out;
}
