// The store on Node: a libSQL file (or memory), migrated on open. Only libSQL's local client: its main entry also
// loads the clients for remote databases (HTTP and WebSocket), which the server never opens, and the bundle and the
// image would carry them and their packages (scripts/build.mjs).

import { createClient } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql/sqlite3";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schema, type Database } from "../db/index.ts";

/** migrations/ sits two levels up from src/node/ and one level up from the bundle in dist/. */
function migrationsFolder(): string {
  for (const relative of ["../../migrations", "../migrations"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(`${path}/meta/_journal.json`)) return path;
  }
  throw new Error("Can't find the migrations folder next to the server");
}

/** `url` is "file:<path>" or ":memory:". One connection, so writes never wait on each other's locks. */
export async function openDatabase(url: string): Promise<{ db: Database; close(): void }> {
  const client = createClient({ url, concurrency: 1 });
  if (url.startsWith("file:")) await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => client.close() };
}
