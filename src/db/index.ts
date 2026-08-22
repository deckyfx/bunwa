/**
 * Database connection.
 *
 * Uses Bun's native Postgres driver through Drizzle, so there is no separate
 * pg dependency. The handle is created lazily: constructing it at import time
 * would make every test and every CLI tool require a reachable database.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { config } from "../config/env";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Build a Drizzle handle against the given connection string.
 *
 * Exported separately from `db()` so a caller can hold an isolated handle:
 * migrations against an administrative connection, and tests against a
 * throwaway database, neither of which should mutate the process-wide one.
 */
export function createDatabase(url: string) {
  return drizzle(new SQL(url), { schema });
}

let instance: Database | undefined;

/** The process-wide database handle, created on first use. */
export function db(): Database {
  instance ??= createDatabase(config().databaseUrl);
  return instance;
}

/** Reset the memoised handle. Tests only. */
export function resetDatabase(): void {
  instance = undefined;
}

export { schema };
