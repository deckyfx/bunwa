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

import { recordBusyRetry } from "../ops/pressure";
import { createDatabase, pathOf, type Database } from "./index";

/**
 * How long acquiring the write lock may take before it counts as contention.
 *
 * An uncontended BEGIN IMMEDIATE on a local file is well under a millisecond,
 * so this is generous enough not to fire on ordinary scheduling noise and
 * small enough to notice a real wait.
 */
const LOCK_WAIT_THRESHOLD_MS = 5;

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
  // Timed, because `PRAGMA busy_timeout` retries inside SQLite and offers no
  // callback to count. What is observable from out here is how long acquiring
  // the write lock took: instant means no contention, a measurable wait means
  // another writer held it — which is the signal ADR-0005's trigger depends on.
  const lockWaitBegan = performance.now();
  database.run(sql`BEGIN IMMEDIATE`);
  if (performance.now() - lockWaitBegan > LOCK_WAIT_THRESHOLD_MS) recordBusyRetry();
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
