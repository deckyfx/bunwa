/**
 * Atomicity for flows that await between writes.
 *
 * `drizzle.transaction(async (tx) => …)` does **not** work on bun-sqlite: the
 * driver is synchronous, so the wrapper does not await the callback. Verified —
 * two inserts either side of an `await`, followed by a throw, both survived the
 * rollback. Code written against it looks transactional and is not, which is
 * worse than having no transaction at all, because the reviewer stops looking.
 *
 * This issues the statements directly and awaits the callback itself.
 */
import { sql } from "drizzle-orm";

import type { Database } from "./index";

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * `BEGIN IMMEDIATE` rather than a deferred begin: the write lock is taken up
 * front, so a concurrent writer fails fast instead of halfway through, when
 * some of the work is already done.
 */
export async function withTransaction<T>(database: Database, fn: () => Promise<T>): Promise<T> {
  database.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = await fn();
    database.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      database.run(sql`ROLLBACK`);
    } catch {
      // A rollback can fail if the transaction is already resolved. The
      // original error is what the caller needs; masking it with this one
      // would hide the actual failure.
    }
    throw err;
  }
}
