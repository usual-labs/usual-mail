/**
 * A fake of Gmail's REST API and Google's token endpoint, as a `fetch` function. It answers the routes the
 * Gmail provider uses with the request and response shapes from Google's reference pages (users.getProfile,
 * messages.list/get (raw, minimal, metadata and full, with `sizeEstimate`; the full form's parts in payload.ts)/modify/
 * trash/untrash/send, messages.attachments.get, threads.list/get, history.list, labels.list/create, the OAuth token
 * endpoint and the documented error bodies; search operators in search.ts), and lets tests break things on purpose:
 * expire tokens or history, revoke the refresh token, or answer the next requests with rate-limit errors. Tests can
 * slow every answer down (`latencyMs`) and read how many requests of each kind were in flight at once (`peakInFlight`).
 */
import { fullPayload } from "./payload.ts";
import { compileQuery } from "./search.ts";
import { FakeMailbox, type FakeMessage, type FakeHistoryRecord } from "./store.ts";

export { FakeMailbox, type FakeMessage } from "./store.ts";

export interface FakeGmailOptions {
  address: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  now?: () => number;
  /** Seconds an access token lives. Default 3599, as Google issues them. */
  tokenLifetime?: number;
}

export interface Fault {
  status: number;
  reason?: string;
  message?: string;
  retryAfter?: string;
  /** Only requests whose method and path match. */
  match?: (method: string, path: string) => boolean;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

const API_PREFIX = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class FakeGmail {
  readonly mailbox: FakeMailbox;
  readonly clientId: string;
  readonly clientSecret: string;
  refreshToken: string;
  readonly requests: LoggedRequest[] = [];
  readonly tokenRequests: number[] = [];
  /** Whether history's label records carry the message's labels, as Gmail's normally do. */
  historyLabelIds = true;
  /** In the full form, parts without a filename over this many bytes come as an `attachmentId` too. */
  bodyDataLimit = Number.POSITIVE_INFINITY;
  /**
   * The `sizeEstimate` a form reports: the raw message's length, unless a test says otherwise; undefined leaves the field
   * out (Google documents the minimal form as only the id and labels).
   */
  sizeEstimateOf: (message: FakeMessage, format: string) => number | undefined = (message) => message.raw.length;
  /** Milliseconds every API answer waits, so requests overlap. */
  latencyMs = 0;
  /**
   * The most requests of each kind answered at once: `messages.get` (any form), `messages.get:<format>`,
   * `messages.attachments.get`, or the method and path.
   */
  readonly peakInFlight = new Map<string, number>();
  #inFlight = new Map<string, number>();
  /** What each attachment id handed out in a full form stands for. Like Gmail's, a new id on every request. */
  #attachments = new Map<string, { messageId: string; bytes: Buffer }>();
  #tokens = new Map<string, number>();
  #tokenLifetime: number;
  #faults: Fault[] = [];
  #now: () => number;

  constructor(options: FakeGmailOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.mailbox = new FakeMailbox(options.address, this.#now);
    this.clientId = options.clientId ?? "fake-client.apps.example";
    this.clientSecret = options.clientSecret ?? "fake-secret";
    this.refreshToken = options.refreshToken ?? "fake-refresh-token";
    this.#tokenLifetime = options.tokenLifetime ?? 3599;
  }

  get credentials() {
    return { clientId: this.clientId, clientSecret: this.clientSecret, refreshToken: this.refreshToken };
  }

  /** Delivers a message as if it arrived: in the inbox and unread unless other labels are given. */
  deliver(raw: string | Buffer, labelIds: string[] = ["INBOX", "UNREAD"], internalDate?: number): Promise<FakeMessage> {
    const options: { internalDate?: number } = {};
    if (internalDate !== undefined) options.internalDate = internalDate;
    return this.mailbox.insert(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), labelIds, options);
  }

  /** Every access token handed out so far stops working. */
  expireAccessTokens(): void {
    this.#tokens.clear();
  }

  /** Refresh tokens Google's sign-in gave this account (`FakeGoogle`), working beside `refreshToken`. */
  readonly grantedRefreshTokens = new Set<string>();

  /** Whether the token endpoint takes this refresh token for this account. */
  acceptsRefreshToken(token: string): boolean {
    return token === this.refreshToken || this.grantedRefreshTokens.has(token);
  }

  /** A new access token for this account, as the token endpoint hands them out. */
  issueAccessToken(): string {
    const accessToken = `ya29.fake-${Math.random().toString(36).slice(2)}`;
    this.#tokens.set(accessToken, this.#now() + this.#tokenLifetime * 1000);
    return accessToken;
  }

  /** Whether this access token was handed out for this account and still works. */
  holdsAccessToken(token: string): boolean {
    return (this.#tokens.get(token) ?? 0) > this.#now();
  }

  /** The account took back the client's access: every refresh and access token stops working. */
  revokeGrant(): void {
    this.grantedRefreshTokens.clear();
    this.refreshToken = `revoked-${Math.random().toString(36).slice(2)}`;
    this.#tokens.clear();
  }

  /** History up to now is no longer available, as when a client hasn't synced for weeks. */
  expireHistory(): void {
    // Starting from the current id still works; anything older answers 404.
    this.mailbox.minHistoryId = this.mailbox.historyId;
  }

  /** Answer the next `times` matching requests with this error. */
  failNext(times: number, fault: Fault): void {
    for (let i = 0; i < times; i++) this.#faults.push(fault);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.href.split("?")[0] === TOKEN_URL) return this.#token(method, String(init.body ?? ""));
    if (!url.href.startsWith(API_PREFIX)) return error(404, "notFound", `No fake for ${url.href}`);
    const path = url.pathname.slice(new URL(API_PREFIX).pathname.length) || "/";
    this.requests.push({ method, path, query: url.searchParams });

    const auth = headerOf(init.headers, "authorization");
    const token = auth?.replace(/^Bearer\s+/i, "");
    const expiry = token ? this.#tokens.get(token) : undefined;
    if (expiry === undefined || expiry <= this.#now()) {
      return json(401, {
        error: {
          code: 401,
          message: "Request had invalid authentication credentials. Expected OAuth 2 access token.",
          errors: [{ domain: "global", reason: "authError", message: "Invalid Credentials", locationType: "header", location: "Authorization" }],
          status: "UNAUTHENTICATED",
        },
      });
    }
    const faultIndex = this.#faults.findIndex((f) => !f.match || f.match(method, path));
    if (faultIndex >= 0) {
      const [fault] = this.#faults.splice(faultIndex, 1);
      return error(fault!.status, fault!.reason, fault!.message ?? "Rate Limit Exceeded", fault!.retryAfter);
    }
    const body = init.body ? safeJson(String(init.body)) : undefined;
    const kinds = requestKinds(method, path, url.searchParams);
    for (const kind of kinds) {
      const now = (this.#inFlight.get(kind) ?? 0) + 1;
      this.#inFlight.set(kind, now);
      this.peakInFlight.set(kind, Math.max(now, this.peakInFlight.get(kind) ?? 0));
    }
    try {
      if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      return await this.#route(method, path, url.searchParams, body);
    } finally {
      for (const kind of kinds) this.#inFlight.set(kind, this.#inFlight.get(kind)! - 1);
    }
  };

  #token(method: string, body: string): Response {
    const form = new URLSearchParams(body);
    this.tokenRequests.push(this.#now());
    if (method !== "POST" || form.get("grant_type") !== "refresh_token") {
      return json(400, { error: "unsupported_grant_type", error_description: "Invalid grant_type" });
    }
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) {
      return json(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
    }
    if (!this.acceptsRefreshToken(form.get("refresh_token") ?? "")) {
      return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    const accessToken = this.issueAccessToken();
    return json(200, {
      access_token: accessToken,
      expires_in: this.#tokenLifetime,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
  }

  async #route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown> | undefined): Promise<Response> {
    const box = this.mailbox;
    if (method === "GET" && path === "/profile") {
      const threads = new Set([...box.messages.values()].map((m) => m.threadId));
      return json(200, { emailAddress: box.address, messagesTotal: box.messages.size, threadsTotal: threads.size, historyId: String(box.historyId) });
    }
    if (method === "GET" && path === "/labels") return json(200, { labels: [...box.labels.values()] });
    if (method === "POST" && path === "/labels") {
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return error(400, "invalidArgument", "Invalid label name");
      const visibility: { messageListVisibility?: string; labelListVisibility?: string } = {};
      if (typeof body?.messageListVisibility === "string") visibility.messageListVisibility = body.messageListVisibility;
      if (typeof body?.labelListVisibility === "string") visibility.labelListVisibility = body.labelListVisibility;
      const created = box.createLabel(name, visibility);
      if (!created) return error(409, "duplicate", "Label name exists or conflicts", undefined, "ALREADY_EXISTS");
      return json(200, created);
    }
    if (method === "GET" && path === "/history") return this.#history(query);
    if (method === "GET" && path === "/messages") return this.#list(query);
    if (method === "GET" && path === "/threads") return this.#threads(query);
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && thread) return this.#thread(decodeURIComponent(thread[1]!), query);
    if (method === "POST" && path === "/messages/send") return this.#send(body);

    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (method === "GET" && attachment) return this.#attachment(decodeURIComponent(attachment[1]!), decodeURIComponent(attachment[2]!));

    const match = /^\/messages\/([^/]+)(?:\/(modify|trash|untrash))?$/.exec(path);
    if (!match) return error(404, "notFound", "Requested entity was not found.");
    const message = box.messages.get(decodeURIComponent(match[1]!));
    if (!message) return error(404, "notFound", "Requested entity was not found.");
    const action = match[2];
    if (method === "GET" && !action) return json(200, this.#resource(message, query.get("format") ?? "full", query.getAll("metadataHeaders")));
    if (method === "POST" && action === "modify") {
      const add = stringList(body?.addLabelIds);
      const remove = stringList(body?.removeLabelIds);
      for (const id of [...add, ...remove]) if (!box.labels.has(id)) return error(400, "invalidArgument", `Invalid label: ${id}`);
      if (add.some((id) => remove.includes(id))) return error(400, "invalidArgument", "Label can't be both added and removed");
      box.modify(message, add, remove);
      return json(200, this.#resource(message, "minimal", []));
    }
    if (method === "POST" && action === "trash") {
      box.trash(message);
      return json(200, this.#resource(message, "minimal", []));
    }
    if (method === "POST" && action === "untrash") {
      box.untrash(message);
      return json(200, this.#resource(message, "minimal", []));
    }
    return error(404, "notFound", "Requested entity was not found.");
  }

  #resource(message: FakeMessage, format: string, metadataHeaders: string[]) {
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      historyId: String(message.historyId),
      internalDate: String(message.internalDate),
      snippet: "",
    } as Record<string, unknown>;
    const sizeEstimate = this.sizeEstimateOf(message, format);
    if (sizeEstimate !== undefined) base.sizeEstimate = sizeEstimate;
    if (format === "raw") return { ...base, raw: message.raw.toString("base64url") };
    if (format === "minimal") return base;
    if (format === "full") {
      const leaveOut = (bytes: Buffer) => {
        const id = `ANGjdJ${randomToken()}`;
        this.#attachments.set(id, { messageId: message.id, bytes });
        return id;
      };
      return { ...base, payload: fullPayload(message.raw, { leaveOut, bodyDataLimit: this.bodyDataLimit }) };
    }
    const headerBlock = message.raw.toString("latin1").split(/\r?\n\r?\n/)[0] ?? "";
    const headers = headerBlock
      .replace(/\r?\n[ \t]+/g, " ")
      .split(/\r?\n/)
      .map((line) => ({ name: line.slice(0, line.indexOf(":")).trim(), value: line.slice(line.indexOf(":") + 1).trim() }))
      .filter((h) => h.name && (!metadataHeaders.length || metadataHeaders.some((m) => m.toLowerCase() === h.name.toLowerCase())));
    return { ...base, payload: { mimeType: message.parsed.mimeType, headers } };
  }

  /** messages.attachments.get: a MessagePartBody, for an id a full form of the same message handed out. */
  #attachment(messageId: string, attachmentId: string): Response {
    if (!this.mailbox.messages.has(messageId)) return error(404, "notFound", "Requested entity was not found.");
    const held = this.#attachments.get(attachmentId);
    if (!held || held.messageId !== messageId) return error(400, "invalidArgument", "Invalid attachment token");
    return json(200, { attachmentId, size: held.bytes.length, data: held.bytes.toString("base64url") });
  }

  /** The messages `q` finds (search.ts), spam and trash left out unless asked, newest first; or the refusal. */
  #found(query: URLSearchParams): FakeMessage[] | Response {
    const matcher = compileQuery(query.get("q") ?? "", this.mailbox.labels);
    if (typeof matcher !== "function") return error(400, "invalidArgument", `The fake doesn't understand the search term ${matcher.unknown}`);
    const includeSpamTrash = query.get("includeSpamTrash") === "true";
    const labelFilter = query.getAll("labelIds");
    let items = [...this.mailbox.messages.values()].filter(matcher);
    if (!includeSpamTrash) items = items.filter((m) => !m.labelIds.has("SPAM") && !m.labelIds.has("TRASH"));
    if (labelFilter.length) items = items.filter((m) => labelFilter.every((id) => m.labelIds.has(id)));
    return items.sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? 1 : -1));
  }

  #list(query: URLSearchParams): Response {
    const items = this.#found(query);
    if (items instanceof Response) return items;
    const { page, next } = paginate(items, query, 100);
    const out: Record<string, unknown> = { resultSizeEstimate: items.length };
    if (page.length) out.messages = page.map((m) => ({ id: m.id, threadId: m.threadId }));
    if (next) out.nextPageToken = next;
    return json(200, out);
  }

  /** threads.list: the conversations holding a message `q` finds, by their newest such message, with a snippet. */
  #threads(query: URLSearchParams): Response {
    const items = this.#found(query);
    if (items instanceof Response) return items;
    const newest = new Map<string, FakeMessage>();
    for (const message of items) if (!newest.has(message.threadId)) newest.set(message.threadId, message);
    const { page, next } = paginate([...newest.values()], query, 100);
    const out: Record<string, unknown> = { resultSizeEstimate: newest.size };
    if (page.length) {
      out.threads = page.map((m) => ({ id: m.threadId, snippet: snippetOf(m), historyId: String(m.historyId) }));
    }
    if (next) out.nextPageToken = next;
    return json(200, out);
  }

  /** threads.get: every message of the conversation, oldest first, in the form asked for. */
  #thread(id: string, query: URLSearchParams): Response {
    const list = [...this.mailbox.messages.values()].filter((m) => m.threadId === id).sort((a, b) => a.internalDate - b.internalDate);
    if (!list.length) return error(404, "notFound", "Requested entity was not found.");
    const format = query.get("format") ?? "full";
    const headers = query.getAll("metadataHeaders");
    return json(200, { id, historyId: String(this.mailbox.historyId), messages: list.map((m) => ({ ...this.#resource(m, format, headers), snippet: snippetOf(m) })) });
  }

  #history(query: URLSearchParams): Response {
    const start = query.get("startHistoryId");
    if (!start || !/^\d+$/.test(start)) return error(400, "invalidArgument", "startHistoryId is required");
    const from = BigInt(start);
    if (from < this.mailbox.minHistoryId) return error(404, "notFound", "Requested entity was not found.");
    const types = query.getAll("historyTypes");
    const records = this.mailbox.history.filter((r) => r.id > from && (!types.length || types.includes(r.kind)));
    const { page, next } = paginate(records, query, 100);
    const out: Record<string, unknown> = { historyId: String(this.mailbox.historyId) };
    if (page.length) out.history = page.map((record) => historyResource(record, this.historyLabelIds));
    if (next) out.nextPageToken = next;
    return json(200, out);
  }

  async #send(body: Record<string, unknown> | undefined): Promise<Response> {
    if (typeof body?.raw !== "string") return error(400, "invalidArgument", "'raw' RFC822 payload message string or uploading message via /upload/* URL required");
    const original = Buffer.from(body.raw, "base64url").toString("latin1");
    // Gmail sends with a Message-ID of its own; the fake does the same so callers must read it back.
    const gmailId = `<fake-${Math.random().toString(36).slice(2)}@mail.gmail.example>`;
    const rewritten = /^message-id:/im.test(original)
      ? original.replace(/^message-id:.*$/im, `Message-ID: ${gmailId}`)
      : `Message-ID: ${gmailId}\r\n${original}`;
    const raw = Buffer.from(rewritten, "latin1");
    const requested = typeof body.threadId === "string" ? body.threadId : undefined;
    const references = [...rewritten.matchAll(/^(?:in-reply-to|references):(.*)$/gim)].flatMap((m) => [...m[1]!.matchAll(/<([^<>\s]+)>/g)].map((x) => x[1]!));
    const threadOk = requested !== undefined && this.mailbox.threadHasAny(requested, references);
    const labels = ["SENT"];
    const recipients = [...rewritten.matchAll(/^(?:to|cc):(.*)$/gim)].map((m) => m[1]!.toLowerCase()).join(" ");
    if (recipients.includes(this.mailbox.address)) labels.push("INBOX", "UNREAD");
    const options: { threadId?: string } = {};
    if (threadOk) options.threadId = requested;
    const message = await this.mailbox.insert(raw, labels, options);
    return json(200, { id: message.id, threadId: message.threadId, labelIds: [...message.labelIds] });
  }
}

/** The kinds a request counts under in `peakInFlight`. */
function requestKinds(method: string, path: string, query: URLSearchParams): string[] {
  if (method === "GET" && /^\/messages\/[^/]+\/attachments\/[^/]+$/.test(path)) return ["messages.attachments.get"];
  if (method === "GET" && /^\/messages\/[^/]+$/.test(path)) return ["messages.get", `messages.get:${query.get("format") ?? "full"}`];
  return [`${method} ${path}`];
}

function randomToken(): string {
  return Buffer.from(Array.from({ length: 48 }, () => Math.floor(Math.random() * 256))).toString("base64url");
}

/** Gmail's snippet: the start of the text, with what HTML would escape escaped, as Gmail sends it. */
function snippetOf(message: FakeMessage): string {
  return message.parsed.preview.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function historyResource(record: FakeHistoryRecord, withLabels: boolean) {
  const message = withLabels ? { id: record.messageId, threadId: record.threadId, labelIds: record.labelIds } : { id: record.messageId, threadId: record.threadId };
  const out: Record<string, unknown> = { id: String(record.id), messages: [{ id: record.messageId, threadId: record.threadId }] };
  if (record.kind === "messageAdded") out.messagesAdded = [{ message }];
  if (record.kind === "messageDeleted") out.messagesDeleted = [{ message: { id: record.messageId, threadId: record.threadId } }];
  if (record.kind === "labelAdded") out.labelsAdded = [{ message, labelIds: record.changed ?? [] }];
  if (record.kind === "labelRemoved") out.labelsRemoved = [{ message, labelIds: record.changed ?? [] }];
  return out;
}

function paginate<T>(items: T[], query: URLSearchParams, defaultSize: number): { page: T[]; next?: string } {
  const size = Math.min(500, Math.max(1, Number(query.get("maxResults") ?? defaultSize) || defaultSize));
  const offset = Number(query.get("pageToken") ?? 0) || 0;
  const page = items.slice(offset, offset + size);
  return offset + size < items.length ? { page, next: String(offset + size) } : { page };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function headerOf(headers: RequestInit["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries: [string, unknown][] = Array.isArray(headers) ? headers.map((pair) => [String(pair[0]), pair[1]]) : Object.entries(headers);
  const value = entries.find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" ? value : undefined;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });
}

/** Google's documented error body: { error: { code, message, errors: [{ domain, reason, message }], status } }. */
function error(status: number, reason: string | undefined, message: string, retryAfter?: string, statusName?: string): Response {
  const domain = reason && /limit|quota/i.test(reason) ? "usageLimits" : "global";
  const body = {
    error: {
      code: status,
      message,
      errors: [{ domain, reason: reason ?? "unknown", message }],
      status: statusName ?? STATUS_NAMES[status] ?? "UNKNOWN",
    },
  };
  return json(status, body, retryAfter ? { "retry-after": retryAfter } : {});
}

const STATUS_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};
