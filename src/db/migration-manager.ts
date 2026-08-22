/**
 * Laravel-style migration workflow over Drizzle's migrator.
 *
 * Two things this adds beyond calling `migrate()`:
 *
 * 1. **Migrations travel inside the binary.** A relative migrations directory
 *    does not exist beside an installed single-file build, and the failure is
 *    silent — no tables are created and the manager reports "none found". The
 *    SQL is compiled in as text and written back to a real directory at start.
 *
 * 2. **The applied set is verified as an ordered prefix.** Drizzle's migrator
 *    selects work by comparing each journal timestamp against the single
 *    greatest recorded `created_at` (`pg-core/dialect.js`: `order by created_at
 *    desc limit 1`), and never inspects individual hashes. A database holding
 *    [A, C] against a build of [A, B, C] therefore passes a membership check
 *    and then skips B permanently. Comparing sequences catches rollback,
 *    divergence, gaps, and byte-identical duplicates in one rule.
 */
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { config } from "../config/env";
import { db, type Database } from "./index";
import { embeddedFiles, embeddedJournal, embeddedMigrationCount } from "./migrations-embedded";
import { log } from "../observability/logger";

/** Raised when migrations cannot be applied, wrapping the driver's error. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export interface MigrationConfig {
  /** Refuse to start when migrations are pending. Production default. */
  strict?: boolean;
  /** Apply pending migrations automatically. Development convenience. */
  autoMigrate?: boolean;
}

/** One migration as this build knows it, in journal order. */
interface BuildMigration {
  tag: string;
  when: number;
  hash: string;
}

/**
 * One row of Drizzle's tracking table.
 *
 * `created_at` is declared `bigint` in pg-core/dialect.js, and a driver may
 * surface that as a number or a string depending on its bigint handling, so
 * both are accepted and normalised at the comparison.
 */
export interface AppliedMigrationRow extends Record<string, unknown> {
  hash: string;
  created_at: number | string;
}

/** Outcome of comparing the database against this build. */
export interface MigrationState {
  pending: number;
  /** Non-null when the database cannot be reconciled with this build. */
  problem: string | null;
}

export class MigrationManager {
  /** Where embedded SQL is written so Drizzle's migrator can read it. */
  private static get migrationsDir(): string {
    return join(config().runtimeDir, ".migrations");
  }

  /**
   * This build's migrations, ordered and hashed the way Drizzle records them.
   *
   * The reference sequence every comparison is made against: what the running
   * binary can create, independent of what any database currently holds.
   */
  static buildSequence(): BuildMigration[] {
    return embeddedJournal.entries
      .slice()
      .sort((a, b) => a.when - b.when)
      .map((e) => ({
        tag: e.tag,
        when: e.when,
        // Drizzle hashes the raw file contents (migrator.js: readMigrationFiles).
        hash: createHash("sha256").update(embeddedFiles[`${e.tag}.sql`] ?? "").digest("hex"),
      }));
  }

  /**
   * Write the embedded SQL to disk, removing anything this build does not carry.
   *
   * Rewritten every start: the files must match the binary that is running.
   * Without the prune, rolling back to an older build leaves a newer build's
   * .sql on disk, and the scan reports a migration pending that this journal
   * cannot run.
   */
  static async materialise(): Promise<void> {
    const dir = this.migrationsDir;
    const expected = new Set(Object.keys(embeddedFiles));

    let existing: string[] = [];
    try {
      existing = await readdir(dir);
    } catch {
      /* first run */
    }
    await Promise.all(
      existing
        .filter((f) => f.endsWith(".sql") && !expected.has(f))
        .map((f) => rm(join(dir, f), { force: true })),
    );

    await Bun.write(join(dir, "meta", "_journal.json"), JSON.stringify(embeddedJournal));
    for (const [name, contents] of Object.entries(embeddedFiles)) {
      await Bun.write(join(dir, name), contents);
    }
  }

  /**
   * Compare the database's applied migrations against this build's sequence.
   *
   * Membership is not enough — see the class comment. Both hash and timestamp
   * are compared because byte-identical SQL in two migrations would otherwise
   * match at the wrong position.
   */
  static async inspect(database: Database = db()): Promise<MigrationState> {
    // Checked here rather than only in the callers: a build with nothing
    // embedded has zero pending migrations, which every caller would otherwise
    // read as "schema is up to date" and report success on an empty database.
    this.assertPackaged();
    const buildSeq = this.buildSequence();

    let rows: AppliedMigrationRow[];
    try {
      // SQLite keeps the tracking table unqualified — Postgres puts it in a
      // `drizzle` schema (pg-core/dialect.js), SQLite does not
      // (sqlite-core/dialect.js). Ordered ascending so position is comparable.
      rows = database.all<AppliedMigrationRow>(
        sql`select hash, created_at from __drizzle_migrations order by created_at asc`,
      );
    } catch {
      // No tracking table yet: nothing has been applied.
      return { pending: buildSeq.length, problem: null };
    }

    if (rows.length > buildSeq.length) {
      return {
        pending: 0,
        problem: `database has ${rows.length - buildSeq.length} migration(s) beyond this build; it is newer than the running code`,
      };
    }

    for (const [i, row] of rows.entries()) {
      const expected = buildSeq[i];
      if (expected === undefined) {
        return { pending: 0, problem: `applied migration ${i + 1} is beyond this build` };
      }
      // created_at is bigint and may arrive as a string.
      if (row.hash !== expected.hash || Number(row.created_at) !== expected.when) {
        return { pending: 0, problem: `applied migration ${i + 1} does not match this build (expected ${expected.tag})` };
      }
    }

    return { pending: buildSeq.length - rows.length, problem: null };
  }

  /**
   * Apply pending migrations.
   *
   * Materialises first, because this is also the CLI entry point and would
   * otherwise find an empty directory on a clean runtime dir, apply nothing,
   * and report success.
   */
  static async runMigrations(database: Database = db()): Promise<void> {
    this.assertPackaged();
    await this.materialise();
    try {
      await migrate(database, { migrationsFolder: this.migrationsDir });
    } catch (err) {
      // A bundled binary's stack trace is thousands of lines of vendored code
      // and tells an operator nothing. Report what failed and why, and let the
      // stack go to the log's structured error field rather than to stderr raw.
      throw new MigrationError(
        `failed to apply migrations from ${this.migrationsDir}`,
        { cause: err },
      );
    }
  }

  /** Zero migrations compiled in is a packaging fault, not a valid state. */
  static assertPackaged(): void {
    if (embeddedMigrationCount === 0) {
      log.error("no migrations were compiled into this build — the database cannot be created");
      log.error("this is a packaging fault; run `bun run db:generate` and rebuild");
      process.exit(78); // EX_CONFIG
    }
  }

  /** Startup check. Behaviour is driven by configuration, not by guesswork. */
  static async init(options: MigrationConfig = {}): Promise<void> {
    const cfg = config();
    const strict = options.strict ?? cfg.migrateStrict;
    const autoMigrate = options.autoMigrate ?? !cfg.migrateStrict;

    this.assertPackaged();
    await this.materialise();

    const state = await this.inspect();

    if (state.problem !== null) {
      // Letting an older build write to a newer schema is how a downgrade
      // corrupts data rather than merely failing.
      log.error("database and build disagree", undefined, { problem: state.problem });
      process.exit(75); // EX_TEMPFAIL — operator action required
    }

    if (state.pending === 0) {
      log.info("database schema is up to date", { applied: this.buildSequence().length });
      return;
    }

    if (strict) {
      log.error("pending migrations", undefined, { pending: state.pending, hint: "run `bun run db:migrate`" });
      process.exit(75);
    }

    if (autoMigrate) {
      log.info("applying pending migrations", { pending: state.pending });
      try {
        await this.runMigrations();
      } catch (err) {
        log.error("migration failed; refusing to serve on an unknown schema", err);
        process.exit(75);
      }
      log.info("migrations applied", { applied: state.pending });
      return;
    }

    log.warn("pending migrations detected but auto-migrate is off", { pending: state.pending });
  }
}
