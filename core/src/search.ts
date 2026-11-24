/**
 * Search (docs/contract-search.md): what the server holds, found by full text with filters, and, when a person asks,
 * the mailbox itself for older mail the server doesn't hold. The behaviour is on that page; the shapes are here.
 */
import type { AiState } from "./ai.ts";
import { CATEGORIES, type Address, type Category, type Id, type IsoTime, type Thread } from "./domain.ts";

/**
 * What the kind filter takes: a category (a thread in any of the categories named), `screened` (only screened
 * threads) and `done` (only done, that is archived, threads). Categories among themselves are "any of"; `screened`
 * and `done` each narrow what the categories found: `["receipt", "invoice", "done"]` is archived receipts and invoices.
 */
export type SearchKind = Category | "screened" | "done";
export const SEARCH_KINDS = [...CATEGORIES, "screened", "done"] as const satisfies readonly SearchKind[];

/**
 * The filters a search takes, all optional and combinable with the text. Plain values only, so a later step can fill
 * them from a model's structured answer to a sentence ("receipts from Paperloop last month").
 */
export interface SearchFilters {
  /** One or more inboxes. Default: every inbox the caller may see. */
  inboxIds?: Id[];
  kinds?: SearchKind[];
  /**
   * Who wrote: an address (`anna@studio.example`, exact), a domain (`studio.example`, its subdomains too), or a word of
   * a sender's name or address (`anna`, a word starting so). Only messages a person sees count.
   */
  from?: string;
  /** Who it was sent to (To and Cc), read like `from`. */
  to?: string;
  /** Words the subject holds, read like the text. */
  subject?: string;
  /** True: only threads with an attachment (inline pictures don't count). False: only threads without. */
  hasAttachment?: boolean;
  /** Only threads whose newest mail a person sees is at or after this time. */
  after?: IsoTime;
  /** Only threads whose newest mail a person sees is before this time. */
  before?: IsoTime;
  /** True: only unread threads. False: only read ones. */
  unread?: boolean;
}

/**
 * A search: the text as a person typed it, operators included, and filters. A search with filters and no text is
 * allowed (every receipt from one sender); one with neither is `invalid`. REST takes each field as a query parameter:
 * `q`, `inboxIds` and `kinds` comma-separated, `hasAttachment` and `unread` as `true` or `false`, `after` and
 * `before` as times, `tz`, `cursor`, `limit`.
 */
export interface SearchQuery extends SearchFilters {
  /** At most 200 characters. Gmail's common operators in it become filters (docs/contract-search.md). */
  q?: string;
  /**
   * The IANA time zone typed dates (`after:2026/11/01`) are days in: the start of that day there. Default: the
   * server's own time zone.
   */
  tz?: string;
  cursor?: string;
  /** Local search: default 50, at most 200. Remote search: default 10, at most `REMOTE_SEARCH_MAX`. */
  limit?: number;
}

/**
 * What the server understood: the filters it applied, those given and those typed as operators (a typed operator wins
 * over the same filter given), and the free text left once operators were taken out, so a client can show the filters
 * as chips. Echoed with every answer.
 */
export interface SearchUnderstood extends SearchFilters {
  /** The free text matched against the mail: words and "quoted phrases", without operators or excluded words. */
  text: string;
  /** Words to leave out (typed with a leading minus). */
  exclude?: string[];
}

/** Where a search's text matched, most telling first in `SearchMatch.fields`. */
export type SearchField = "subject" | "sender" | "people" | "summary" | "facts" | "attachments" | "body";
export const SEARCH_FIELDS = ["subject", "sender", "people", "summary", "facts", "attachments", "body"] as const satisfies readonly SearchField[];

/**
 * A piece of plain text, matched or not. A client draws the runs in order and marks the matched ones; the text is
 * never markup (it passes a snippet's checks: no tags, control characters or line breaks), so it is drawn as text.
 */
export interface SearchRun {
  text: string;
  match: boolean;
}

/** Where the text matched in one thread. */
export interface SearchMatch {
  /** Every field the text matched, most telling first: subject, sender, people, summary, facts, attachments, body. */
  fields: SearchField[];
  /** The subject in runs, with the matched words marked, when the subject matched. */
  subject?: SearchRun[];
  /**
   * A short excerpt (at most about 200 characters) around a match outside the subject, from the first of body,
   * summary, facts, attachments, people and sender that matched. Absent when only the subject matched.
   */
  excerpt?: { field: SearchField; runs: SearchRun[] };
}

/**
 * One local result: the thread exactly as lists give it (its avatar, payment, event, `done` and the rest), plus
 * where the text matched. `match` is absent for a search with filters and no text.
 */
export type SearchHit = Thread & { match?: SearchMatch };

/** A sender whose name or address matches the text: "everything from them" is the `from` filter with `email`. */
export interface SearchPerson {
  email: string;
  /** The name they last wrote under, when they gave one. */
  name?: string;
  /** How many threads (not trashed) in the inboxes searched hold mail from them. */
  threads: number;
  /** Their newest mail's time. */
  lastMessageAt: IsoTime;
}

/** The answer of `GET /v1/search`. A client that reads it as a `Page<Thread>` still works. */
export interface SearchResult {
  items: SearchHit[];
  /** Pass back as `cursor`, with the same query, for the next page. Absent on the last page. */
  nextCursor?: string;
  understood: SearchUnderstood;
  /** On the first page of a search with text: up to five senders whose name or address matches it, most threads first. */
  people?: SearchPerson[];
}

/** Remote search's page size: 10 unless asked otherwise, at most this. */
export const REMOTE_SEARCH_MAX = 20;

/**
 * One thread found in the mailbox itself that the server doesn't hold. Nothing of it is stored. `id` is the same for
 * the same mailbox thread across pages and searches, and opens it (`POST /v1/search/remote/:id/open`).
 */
export interface RemoteHit {
  id: Id;
  inboxId: Id;
  subject: string;
  /** The sender of its newest message. */
  from: Address;
  /** Its newest message's time. */
  lastMessageAt: IsoTime;
  /** The mailbox provider's own preview, plain text. */
  snippet: string;
  hasAttachments: boolean;
  messageCount: number;
  /** True when no message of it is in the mailbox's inbox: opened, it arrives done (docs/contract-search.md). */
  archived: boolean;
}

/**
 * How one inbox answered a remote search. `unsupported`: its provider can't search the mailbox (IMAP for now).
 * `paused`: the person paused it. `needs_sign_in`: the mailbox refused the sign-in (Sign in with Google again).
 * `provider_error`: the mailbox refused or failed, in `message`.
 */
export interface RemoteInboxState {
  inboxId: Id;
  state: "ok" | "unsupported" | "paused" | "needs_sign_in" | "provider_error";
  /** The provider's or the server's words, for every state but `ok`. */
  message?: string;
}

/** The answer of `GET /v1/search/remote`. */
export interface RemoteSearchResult {
  items: RemoteHit[];
  nextCursor?: string;
  understood: SearchUnderstood;
  /** One per inbox searched, in the inbox list's order. */
  inboxes: RemoteInboxState[];
}

/** The longest sentence `POST /v1/search/ask` takes: the same as `q`, so the sentence itself can be searched as typed. */
export const SEARCH_ASK_MAX = 200;

/**
 * A search asked in a sentence ("invoices from Hetzner last month"), for the server's AI to turn into the filters and
 * text a search takes (docs/contract-search.md, "Asking in a sentence"). Person only. Only when a person asks this
 * way: what is typed into the search field otherwise never goes to the AI.
 */
export interface SearchAskInput {
  /** The sentence as the person wrote it, 1 to `SEARCH_ASK_MAX` characters. */
  question: string;
  /** The inboxes the search will cover: checked and echoed in `understood`, never sent to the AI. */
  inboxIds?: Id[];
  /** The IANA time zone "today", "last month" and the like are read in. Default: the server's own time zone. */
  tz?: string;
}

/**
 * What the AI made of a sentence, every field checked by the server. No mail is searched or returned: a client shows
 * `understood` as chips with `text` in the field, lets the person correct them, and calls `GET /v1/search` with them.
 * Whatever happens, `understood` and `text` are a search that can be run: when the AI isn't working, gave nothing
 * usable or found no filter, they are the sentence as if it had been typed.
 */
export interface SearchAskResult {
  /** The filters and free text to search with, in exactly the shape a search echoes. */
  understood: SearchUnderstood;
  /**
   * What stands in the search field: `understood.text`, with each excluded word after it as `-word`. Sent as `q`
   * with `understood`'s filters as parameters, a search answers the same `understood`.
   */
  text: string;
  /** True when the AI turned something in the sentence into a filter or an excluded word. */
  found: boolean;
  /**
   * `working` when the AI answered this sentence. Otherwise why it wasn't asked or didn't answer, in the AI's own
   * states (`not_set_up`, `paused`, `key_refused`, `model_not_found`, `out_of_credit`, `unavailable`); `found` is
   * then false and the sentence stands as typed.
   */
  ai: AiState;
  /** Why `ai` isn't `working`, in words a person can act on. Never the key. */
  detail?: string;
}
