// Every statement stays within 100 bound parameters, the most a Durable Object's SQLite takes (docs/agents/decisions.md,
// 2026-11-21). A list that comes from stored data or a caller is bound as one JSON parameter; a multi-row insert is cut
// into chunks the caller runs in one batch. Lists of the code's own (an enum, deduplicated) stay `inArray`.

import { getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** The most bound parameters one statement may carry. The tests fail any statement over it (test/parameters.ts). */
export const MAX_PARAMS = 100;

/**
 * `expression IN (values)` with the values bound as one JSON array, so any number of them costs one parameter. Text
 * only, compared as stored, with no column mapping: `json_each` gives a JSON number back as a number, which never equals
 * the text a TEXT column holds ('5' against [5] matches nothing), where `inArray` would have bound it as text. No values
 * matches nothing.
 */
export function inList(expression: AnyColumn | SQL, values: readonly string[]): SQL {
  return sql`${expression} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/**
 * `rows` in chunks for multi-row inserts into `table`: each chunk's rows times the table's columns, plus `reserved`
 * parameters the rest of the statement binds (an upsert's own), stay within `MAX_PARAMS`. The caller runs every chunk's
 * statement in one batch, so the rows still land together.
 */
export function insertChunks<T>(table: SQLiteTable, rows: readonly T[], reserved = 0): T[][] {
  const size = Math.floor((MAX_PARAMS - reserved) / Object.keys(getTableColumns(table)).length);
  if (size < 1) throw new Error("A row of this table doesn't fit in one statement");
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += size) out.push(rows.slice(at, at + size));
  return out;
}
