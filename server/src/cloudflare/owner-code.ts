// The owner's pairing code on Cloudflare, as the owner decided (server-cloudflare.md, "Decided by the owner"): a plain
// copy in a one-row table this host owns, `owner_pairing_code`, where the owner reads it in the Cloudflare dashboard's
// Data Studio, as Node writes `<data-dir>/owner-pairing-code`. Written when a code is made, read back at every start
// and handed to `keepOwnerCode` as `kept` (so an evicted object keeps the code it showed), deleted once a person pairs;
// a new code (the old one expired) replaces it. It is never logged: the log and the dashboard's sign-in page say only
// that a code waits, until when, and where to find it. Not sealed: whoever can read the row in Data Studio can read the
// secret key beside it too.
//
// An unpaired object has no alarm, so a code can expire while the object is evicted and stay in the table until the
// next start. That start removes it before making a new one, and remembers it (by hash, in memory) as spent: a pairing
// with it is then refused in plain words by the host (requests.ts), before the service counts it as a wrong code.

import type { PairingCode } from "@usualmail/core";
import type { Log } from "../host.ts";
import type { MailServer } from "../service/server.ts";
import { normalizePairingCode, sha256 } from "../util.ts";

export const OWNER_CODE_TABLE = "owner_pairing_code";

/** The host's own table, beside the migrated schema; created before the server starts. */
export function createOwnerCodeTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${OWNER_CODE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
}

/** The code in the table and its expiry; null without one. */
export function readOwnerCode(sql: SqlStorage): PairingCode | null {
  const row = sql.exec<{ code: string; expires_at: string }>(`SELECT code, expires_at FROM ${OWNER_CODE_TABLE} WHERE id = 1`).toArray()[0];
  return row?.code ? { code: row.code, expiresAt: row.expires_at } : null;
}

export function writeOwnerCode(sql: SqlStorage, code: PairingCode): void {
  sql.exec(`INSERT OR REPLACE INTO ${OWNER_CODE_TABLE} (id, code, expires_at) VALUES (1, ?, ?)`, code.code, code.expiresAt);
}

export function removeOwnerCode(sql: SqlStorage): void {
  sql.exec(`DELETE FROM ${OWNER_CODE_TABLE}`);
}

const DASHBOARD_PATH =
  `Durable Objects, this Worker's namespace for the class UsualMailServer, Data Studio, the object named "server", ` +
  `the table ${OWNER_CODE_TABLE}`;

/** Where the code is, in the Cloudflare dashboard's words. */
export const OWNER_CODE_WHERE = `Read it in the Cloudflare dashboard: ${DASHBOARD_PATH}.`;

/** The same for the dashboard's sign-in page (`DashboardOptions.ownerCodeWhere`: what follows "it" there). */
export const OWNER_CODE_WHERE_DASHBOARD = `keeps it out of its log, in the Cloudflare dashboard: ${DASHBOARD_PATH}`;

/**
 * What the log says about the owner's code, never the code itself: that one waits, until when, and where to read it.
 * Nothing once a person's device is paired.
 */
export function ownerCodeLines(code: PairingCode | null, made: boolean): string[] {
  if (!code) return [];
  return [
    made
      ? `An owner's pairing code is waiting, until ${code.expiresAt}; it isn't written to the log.`
      : `An owner's pairing code made at an earlier start is still waiting, until ${code.expiresAt}.`,
    `  ${OWNER_CODE_WHERE} Then POST /v1/pair {"code": "<the code>", "name": "My Mac"} returns the token.`,
  ];
}

/** Owner's codes that expired and were replaced, while no person's device is paired; the last few, by hash. */
export class SpentOwnerCodes {
  readonly #spent = new Map<string, string>();

  async add(code: PairingCode): Promise<void> {
    this.#spent.set(await sha256(normalizePairingCode(code.code)), code.expiresAt);
    while (this.#spent.size > 4) this.#spent.delete(this.#spent.keys().next().value!);
  }

  /** When the code given expired, when it is one of these; null otherwise. */
  async expiredAt(code: string): Promise<string | null> {
    if (this.#spent.size === 0 || !code.trim()) return null;
    return this.#spent.get(await sha256(normalizePairingCode(code))) ?? null;
  }

  /** A person's device paired: no new owner's code waits, so a spent one is just a wrong code again. */
  clear(): void {
    this.#spent.clear();
  }
}

/** How a pairing with a spent owner's code is refused: no wrong code counted, and where the new one is. */
export function spentCodeWords(expiresAt: string): string {
  return `That owner's pairing code expired at ${expiresAt}, so nothing was paired. A new one is waiting. ${OWNER_CODE_WHERE}`;
}

/**
 * Starts keeping the owner's code in its table: an expired code left from an eviction is removed first (and noted as
 * spent), a code still valid is kept, and each new code replaces the row, the one it replaces noted as spent.
 */
export async function keepOwnerCodeInTable(server: MailServer, sql: SqlStorage, log: Log, spent: SpentOwnerCodes, now: number): Promise<void> {
  const row = readOwnerCode(sql);
  let kept: string | null = row?.code ?? null;
  if (row && !(Date.parse(row.expiresAt) > now)) {
    removeOwnerCode(sql);
    await spent.add(row);
    kept = null;
    log.info(`The owner's pairing code in ${OWNER_CODE_TABLE} expired at ${row.expiresAt} while the server was stopped; it was removed, and a new one is made.`);
  }
  await server.keepOwnerCode((code, made) => {
    for (const line of ownerCodeLines(code, made)) log.info(line);
    if (!code) {
      removeOwnerCode(sql);
      spent.clear();
      return;
    }
    if (!made) return;
    // The code this one replaces, when it expired (the expiry timer, while the object stayed in memory).
    const previous = readOwnerCode(sql);
    if (previous && previous.code !== code.code && !(Date.parse(previous.expiresAt) > Date.now())) void spent.add(previous);
    writeOwnerCode(sql, code);
  }, kept ? { kept } : {});
}
