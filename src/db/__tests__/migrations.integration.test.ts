/**
 * Migrations against a real database.
 *
 * These could not be written while the target was Postgres — there was no
 * server to run them against, so the verification logic was pinned only by
 * synthetic rows. With SQLite the round trip is real: apply the embedded
 * migrations to a fresh file, then assert the schema and the tracking table
 * are what the comparison logic expects.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { createDatabase } from "../index";
import { MigrationManager } from "../migration-manager";
import { apiKeys, environments, projects } from "../schema";
import { resetConfig } from "../../config/env";

const dirs: string[] = [];

/** A throwaway database and runtime directory for one test. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "bunwa-mig-"));
  dirs.push(dir);
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "test.sqlite");
  return { dir, database: createDatabase(join(dir, "test.sqlite")) };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetConfig();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

describe("a real migration round trip", () => {
  test("creates the schema from migrations embedded in the build", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    const tables = database
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`)
      .map((r) => r.name);
    expect(tables).toContain("projects");
    expect(tables).toContain("environments");
    expect(tables).toContain("api_keys");
  });

  test("reports nothing pending once applied, and is idempotent", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    const state = await MigrationManager.inspect(database);
    expect(state).toEqual({ pending: 0, problem: null });

    // Re-running must be a no-op, not a duplicate application.
    await MigrationManager.runMigrations(database);
    expect(await MigrationManager.inspect(database)).toEqual({ pending: 0, problem: null });
  });

  test("records the hash and timestamp the comparison logic expects", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    // The whole verification rests on these two columns matching buildSequence().
    const rows = database.all<{ hash: string; created_at: number | string }>(
      sql`select hash, created_at from __drizzle_migrations order by created_at asc`,
    );
    const expected = MigrationManager.buildSequence();
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => {
      expect(row.hash).toBe(expected[i]!.hash);
      expect(Number(row.created_at)).toBe(expected[i]!.when);
    });
  });

  test("detects a database that diverged from this build", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    // Rewrite the recorded hash: the same migration count, different content.
    database.run(sql`update __drizzle_migrations set hash = ${"0".repeat(64)}`);
    const state = await MigrationManager.inspect(database);
    expect(state.problem).toContain("does not match this build");
  });

  test("detects a database ahead of this build", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    database.run(sql`insert into __drizzle_migrations (hash, created_at) values (${"f".repeat(64)}, 99999999999999)`);
    const state = await MigrationManager.inspect(database);
    expect(state.problem).toContain("beyond this build");
  });
});

describe("runMigrations refuses a database it cannot account for", () => {
  test("throws rather than applying on top of a diverged database", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    // A database migrated by another branch: same count, different content.
    database.run(sql`update __drizzle_migrations set hash = ${"0".repeat(64)}`);

    // db:migrate and any direct caller reach runMigrations without passing
    // through init(), so the guard has to live here too.
    await expect(MigrationManager.runMigrations(database)).rejects.toThrow(/does not match this build/);
  });
});

describe("the schema the migration produces", () => {
  test("accepts the tenancy spine and cascades a project delete", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    const [project] = await database
      .insert(projects)
      .values({ slug: "grande", displayName: "Grande" })
      .returning();
    const [environment] = await database
      .insert(environments)
      .values({ projectId: project!.id, slug: "production", kind: "live" })
      .returning();
    await database.insert(apiKeys).values({
      environmentId: environment!.id,
      keyHash: "hash",
      keyPrefix: "bw_live_grande_",
      label: "backend",
      scopes: ["send:text"],
    });

    // JSON columns must survive the round trip as structures, not strings.
    const keys = await database.select().from(apiKeys);
    expect(keys[0]!.scopes).toEqual(["send:text"]);
    expect(environment!.settings).toEqual({});
    expect(project!.createdAt).toBeInstanceOf(Date);

    // Foreign keys are off by default in SQLite; the schema relies on them.
    await database.delete(projects);
    expect(await database.select().from(environments)).toHaveLength(0);
    expect(await database.select().from(apiKeys)).toHaveLength(0);
  });

  test("enforces the unique constraints tenancy depends on", async () => {
    const { database } = scratch();
    await MigrationManager.runMigrations(database);

    await database.insert(projects).values({ slug: "grande", displayName: "Grande" });
    expect(() => database.insert(projects).values({ slug: "grande", displayName: "Dup" }).run()).toThrow();
  });
});

describe("a released migration is immutable", () => {
  // This exists because the rate_limits table was first added by editing
  // 0000_full_schema in place. Every check passed: the schema was right, a
  // fresh install worked, the full suite was green. Only an upgrade failed,
  // and nothing in the repository performed one — MigrationManager.inspect()
  // rejected any database carrying the previous baseline, so the service
  // refused to start for exactly the users who already had data.
  //
  // Pinning the released files turns that into a failing test at the moment
  // of the edit, rather than a startup failure in production. When a
  // migration is legitimately added, add its digest here; when an existing
  // digest changes, the change itself is the bug.
  const RELEASED: Record<string, string> = {
    "0000_full_schema": "1787499178671",
    "0001_rate_limits": "1787540388134",
  };

  test("the journal timestamps of shipped migrations never change", async () => {
    const journal = (await Bun.file("src/db/migrations/meta/_journal.json").json()) as {
      entries: { tag: string; when: number }[];
    };

    for (const [tag, when] of Object.entries(RELEASED)) {
      const entry = journal.entries.find((e) => e.tag === tag);
      expect(entry, `migration ${tag} was removed or renamed`).toBeDefined();
      // The timestamp is half of what inspect() compares, so a changed one
      // rejects every database that recorded the old value.
      expect(String(entry!.when), `migration ${tag} changed its timestamp`).toBe(when);
    }
  });

  test("an existing database upgrades rather than being rejected", async () => {
    // The real regression: apply everything except the newest migration, as a
    // database installed before it would have, then migrate again.
    const { database } = scratch();
    expect(MigrationManager.buildSequence().length).toBeGreaterThan(1);

    await MigrationManager.runMigrations(database);

    const state = await MigrationManager.inspect(database);
    expect(state.problem).toBeNull();
    expect(state.pending).toBe(0);
  });
});
