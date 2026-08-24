/**
 * CLI migration runner.
 *
 * Usage: bun run db:migrate
 *
 * Shares MigrationManager with the startup path, so both entry points
 * materialise the embedded SQL and apply the same verification.
 */
import { config, ConfigError } from "../config/env";
import { MigrationManager } from "./migration-manager";
import { log } from "../observability/logger";

async function main(): Promise<void> {
  try {
    config();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`configuration error: ${err.message}`);
      process.exit(78);
    }
    throw err;
  }

  // inspect() asserts the build carries migrations, so a packaging fault fails
  // here rather than reporting "up to date" against an empty database.
  const state = await MigrationManager.inspect();
  if (state.problem !== null) {
    log.error("refusing to migrate", undefined, { problem: state.problem });
    process.exit(75);
  }

  if (state.pending === 0) {
    log.info("nothing to do; database schema is up to date");
    return;
  }

  log.info("applying migrations", { pending: state.pending });
  try {
    await MigrationManager.runMigrations();
  } catch (err) {
    log.error("migration failed", err);
    process.exit(1);
  }
  log.info("migrations applied", { applied: state.pending });
}

await main();
