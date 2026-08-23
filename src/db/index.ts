/**
 * Database connection.
 *
 * SQLite through Bun's built-in driver — no server, no container, and a real
 * database in tests rather than a mock. See
 * docs/adr/0005-postgres-over-sqlite.md for when this changes and why.
 *
 * The handle is created lazily: constructing it at import time would make every
 * test and CLI tool open a database file just by importing a module.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database as BunDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { config } from "../config/env";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/** Where each handle was opened, so a transaction can open its own. */
const paths = new WeakMap<object, string>();

/** The file a handle was opened against, for opening a sibling connection. */
export function pathOf(database: object): string | undefined {
  return paths.get(database);
}

/**
 * Build a Drizzle handle against the given SQLite file.
 *
 * Exported separately from `db()` so a caller can hold an isolated handle:
 * a transaction's own connection, and a test's throwaway file, neither of
 * which should mutate the process-wide one.
 *
 * `:memory:` is accepted and skips directory creation.
 */
export function createDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new BunDatabase(path, { create: true });

  // WAL lets readers proceed during a write, which matters as soon as the
  // delivery worker shares this process with request handling.
  sqlite.exec("PRAGMA journal_mode = WAL");
  // Foreign keys are off by default in SQLite. The schema relies on them for
  // cascade deletes, so a tenant removal would otherwise orphan its rows.
  sqlite.exec("PRAGMA foreign_keys = ON");
  // Wait rather than fail immediately when another connection holds the write
  // lock; without this a concurrent write surfaces as SQLITE_BUSY.
  sqlite.exec("PRAGMA busy_timeout = 5000");

  const handle = drizzle(sqlite, { schema });
  paths.set(handle, path);
  return handle;
}

let instance: Database | undefined;

/** The process-wide database handle, created on first use. */
export function db(): Database {
  instance ??= createDatabase(config().databasePath);
  return instance;
}

/** Reset the memoised handle. Tests only. */
/**
 * Drop and close the process-wide handle. **Tests only.**
 *
 * Each test opens its own database; without this they would share whichever
 * one happened to be created first, and results would depend on execution
 * order. Closing rather than dropping also releases the file, which a temp
 * directory cannot be removed without.
 */
export function resetDatabase(): void {
  // Closed, not merely dropped. Tests create a handle per case; leaking the
  // descriptor eventually exhausts them, and an unclosed handle keeps the file
  // locked so a temp directory cannot be removed.
  try {
    instance?.$client.close();
  } catch {
    // Already closed, or never opened.
  }
  instance = undefined;
}

export { schema };
