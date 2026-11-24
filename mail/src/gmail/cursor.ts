/**
 * The Gmail sync cursor, opaque to the server.
 *
 * `h` is the history id to continue from. While a first sync or a reset listing is under way, `p` lists the
 * message ids still to send whole and `c` the ones still to send as `changed`, both newest first; history
 * from `h` covers whatever changes meanwhile. `t` is when history last answered, which decides how much of
 * a reset listing is fetched whole. `f` marks `p` as the first sync's listing, `n` counts how much of it was sent, and
 * `w` is the window it was narrowed to when the window was made smaller meanwhile.
 */

export interface GmailCursor {
  v: 1;
  h: string;
  /**
   * The first sync's window, as an ISO time: how far back it began. A listing after history is lost covers it, so
   * nothing the first sync fetched is dropped, also after the window was made smaller.
   */
  s?: string;
  /** True while `p` is the first sync's own listing, which a smaller window may still narrow. */
  f?: true;
  /**
   * How many of the first sync's listing were sent so far (`SyncBatch.progress`), kept with `f`. A cursor written
   * before it was kept has none, and counts from 0 when it is read.
   */
  n?: number;
  /** The window the first sync was narrowed to, when it was made smaller while the first sync was being sent. */
  w?: string;
  /** When history was last read successfully, in ms since the epoch. */
  t?: number;
  /** Message ids still to send whole, newest first. */
  p?: string[];
  /** Reset listing: messages still to send as `changed`, newest first, each "<id>:<state bits in base 36>". */
  c?: string[];
}

const PREFIX = "gmail1.";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY = /^([A-Za-z0-9_-]{1,64}):([0-9a-z]{1,4})$/;

export function encodeGmailCursor(cursor: GmailCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeGmailCursor(value: string): GmailCursor {
  if (!value.startsWith(PREFIX)) throw new Error("This cursor doesn't belong to a Gmail inbox.");
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("The Gmail cursor is damaged.");
  }
  const c = data as Partial<GmailCursor>;
  const ok =
    c !== null &&
    typeof c === "object" &&
    c.v === 1 &&
    typeof c.h === "string" &&
    /^\d{1,20}$/.test(c.h) &&
    (c.s === undefined || (typeof c.s === "string" && !Number.isNaN(Date.parse(c.s)))) &&
    (c.f === undefined || c.f === true) &&
    (c.n === undefined || (typeof c.n === "number" && Number.isSafeInteger(c.n) && c.n >= 0)) &&
    (c.w === undefined || (typeof c.w === "string" && !Number.isNaN(Date.parse(c.w)))) &&
    (c.t === undefined || (typeof c.t === "number" && Number.isFinite(c.t))) &&
    (c.p === undefined || (Array.isArray(c.p) && c.p.every((id) => typeof id === "string" && ID.test(id)))) &&
    (c.c === undefined || (Array.isArray(c.c) && c.c.every((entry) => typeof entry === "string" && ENTRY.test(entry))));
  if (!ok) throw new Error("The Gmail cursor is damaged.");
  return c as GmailCursor;
}

export function encodeEntry(id: string, bits: number): string {
  return `${id}:${bits.toString(36)}`;
}

export function decodeEntry(entry: string): { id: string; bits: number } {
  const match = ENTRY.exec(entry);
  if (!match) throw new Error("The Gmail cursor is damaged.");
  return { id: match[1]!, bits: parseInt(match[2]!, 36) };
}
