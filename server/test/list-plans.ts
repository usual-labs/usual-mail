// The query plans of the lists bound as JSON (docs/agents/decisions.md, 2026-11-21): each statement a test file sent
// with `json_each` reads the tables it filters through an index, as the literal list it replaced did, never by scanning
// them. The plans come from an empty store with every migration: without ANALYZE, SQLite's plans don't depend on rows.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { jsonLists } from "./parameters.ts";

/**
 * What a plan may scan: the JSON list itself (`json_each`, or its alias `page`), the full-text index a MATCH reads
 * (`search_index`, and `ex`, the excluded words'), and the inboxes table, a handful of rows.
 */
const MAY_SCAN = /^SCAN (json_each|page|search_index|ex|inboxes)\b/;

/** The statements of this test file that bound a list as JSON, and every plan line of theirs that scans a table. */
export async function listScans(): Promise<{ statements: number; scans: string[] }> {
  const client = createClient({ url: ":memory:" });
  try {
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const scans: string[] = [];
    for (const [sql, args] of [...jsonLists]) {
      const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
      for (const row of plan.rows) {
        const detail = String(row.detail);
        if (detail.startsWith("SCAN ") && !MAY_SCAN.test(detail)) scans.push(`${detail}: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    return { statements: jsonLists.size, scans };
  } finally {
    client.close();
  }
}
