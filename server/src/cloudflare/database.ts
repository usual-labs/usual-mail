// The store on Cloudflare: the Durable Object's own SQLite through Drizzle's durable-sqlite driver, migrated from the
// same frozen files as on Node (migrations.generated.ts, written from server/migrations/).
//
// That driver is synchronous. Awaiting a query builder works on it as on libSQL, but two things the shared code relies on
// differ, and the adapter below makes them behave as on libSQL:
// - `batch` doesn't exist: it runs every statement inside one `transactionSync`, all or nothing.
// - `db.run/all/get/values(sql…)` execute the moment they are called (drizzle's sqlite-core/db.js in sync mode), so one
//   placed in a batch's list ran at once, outside the batch (the spike's orphan search rows). Here they return a
//   statement that runs when awaited or when its batch runs, as libSQL's do.

import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { schema, type Database } from "../db/index.ts";
import { migrationConfig } from "./migrations.generated.ts";

/**
 * Applies every migration the store hasn't had, in one transaction with foreign keys on (a Durable Object can't turn
 * them off, so a table rebuild would cascade: known-issues.md). Runs eagerly, on a plain driver of its own.
 */
export async function migrateStore(storage: DurableObjectStorage): Promise<void> {
  await migrate(drizzle(storage), migrationConfig);
}

/** A statement of `db.run/all/get/values` that runs only when awaited or when the batch holding it runs. */
class LazyStatement<T> implements PromiseLike<T> {
  readonly #run: () => T;

  constructor(run: () => T) {
    this.#run = run;
  }

  runNow(): T {
    return this.#run();
  }

  then<A = T, B = never>(onFulfilled?: ((value: T) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return new Promise<T>((resolve) => resolve(this.#run())).then(onFulfilled, onRejected);
  }
}

/** What a query builder offers in sync mode: its prepared query, whose `execute()` runs on `sync()`. */
interface SyncBuilder {
  _prepare(): { execute(): { sync(): unknown } };
}

/** Runs one batch item now, inside the batch's transaction. */
function runItem(item: unknown): unknown {
  if (item instanceof LazyStatement) return item.runNow();
  const builder = item as Partial<SyncBuilder>;
  if (typeof builder._prepare !== "function") throw new Error("This statement can't run in a batch on Cloudflare");
  return builder._prepare().execute().sync();
}

const RAW = ["run", "all", "get", "values"] as const;

/** The service's `Database` over the object's SQLite. */
export function openDatabase(storage: DurableObjectStorage): Database {
  const db = drizzle(storage, { schema });
  const shaped = db as unknown as Record<string, unknown>;
  for (const kind of RAW) {
    const eager = (db[kind] as (query: SQLWrapper | string) => unknown).bind(db);
    shaped[kind] = (query: SQLWrapper | string) => new LazyStatement(() => eager(query));
  }
  shaped.batch = async (items: readonly unknown[]) => storage.transactionSync(() => items.map(runItem));
  return db as unknown as Database;
}
