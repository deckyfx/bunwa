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

import { createDatabase, pathOf, type Database } from "./index";

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * `BEGIN IMMEDIATE` rather than a deferred begin: the write lock is taken up
 * front, so a concurrent writer fails fast instead of halfway through, when
 * some of the work is already done.
 */
export async function withTransaction<T>(database: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  // A dedicated connection, so nothing else can join the transaction.
  //
  // Queueing only transaction callers was not enough: a plain write on the
  // shared handle, issued after an await inside the callback, ran inside the
  // open transaction and was committed or rolled back with it. A separate
  // connection makes that impossible rather than merely unlikely — SQLite's
  // own locking arbitrates, with busy_timeout covering contention.
  const path = pathOf(database);
  if (path !== undefined && path !== ":memory:") {
    const tx = createDatabase(path);
    try {
      return await runIn(tx, () => fn(tx));
    } finally {
      // Releases the file handle and the write lock with it.
      (tx as unknown as { $client: { close: () => void } }).$client.close();
    }
  }

  // An in-memory database cannot be reopened — a second connection would be a
  // different, empty database — so fall back to serialising on the one handle.
  return runQueued(database, () => runIn(database, () => fn(database)));
}

/** BEGIN/COMMIT/ROLLBACK around an awaited callback. */
async function runIn<T>(database: Database, fn: () => Promise<T>): Promise<T> {
  database.run(sql`BEGIN IMMEDIATE`);
  {
    try {
      const result = await fn();
      database.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try {
        database.run(sql`ROLLBACK`);
      } catch {
        // A rollback can fail if the transaction is already resolved. The
        // original error is what the caller needs; masking it would hide the
        // actual failure.
      }
      throw err;
    }
  }
}

/** Serialise callers on one handle, for the in-memory fallback. */
async function runQueued<T>(database: Database, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(database) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(database, previous.then(() => mine));
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * One queue per handle.
 *
 * Weak so a throwaway test database does not keep its queue alive after the
 * handle is dropped.
 */
const queues = new WeakMap<object, Promise<void>>();
