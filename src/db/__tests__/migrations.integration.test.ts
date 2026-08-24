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
  // The first version of this guard pinned only journal timestamps, which
  // left the actual hole open: editing the SQL body without touching the
  // journal still passed. inspect() compares the hash, so the hash is what
  // has to be pinned.
  //
  // When a migration is legitimately added, add its row here. When an
  // existing row needs changing, the change itself is the bug.
  const RELEASED: { tag: string; hash: string; when: number }[] = [
    {
      tag: "0000_full_schema",
      hash: "c4ef1122639dbcd6ad9220a6a60bafce25277bdb3b67472c4785ae0a7e22be01",
      when: 1787499178671,
    },
    {
      tag: "0001_rate_limits",
      hash: "4730d2109199364d0791e02b47562542c56cdc924b5a6c71ab218530396bda3d",
      when: 1787540388134,
    },
    {
      tag: "0002_rate_limit_expiry",
      hash: "fcb348cb11ea796069145be3ec129eb9d8e6a7b849f5c13cd637da647a639714",
      when: 1787558564082,
    },
  ];

  test("shipped migrations keep the order, hash and timestamp inspect() compares", () => {
    const built = MigrationManager.buildSequence();

    // By position, not by lookup. `find` by tag passed when a migration was
    // inserted ahead of the pinned ones or added unlisted at the end, and
    // inspect() compares applied rows by sequence position — so a reordering
    // it would reject was a reordering this test accepted.
    expect(built.length, "a migration was added or removed without pinning it here").toBe(RELEASED.length);

    RELEASED.forEach((released, i) => {
      const actual = built[i];
      expect(actual?.tag, `position ${i} is no longer ${released.tag}`).toBe(released.tag);
      // Both halves of the comparison, because a database records both. Pinning
      // the timestamp alone let the SQL body change freely.
      expect(actual!.hash, `migration ${released.tag} changed its contents`).toBe(released.hash);
      expect(actual!.when, `migration ${released.tag} changed its timestamp`).toBe(released.when);
    });
  });

  test("a database at the previous release upgrades instead of being rejected", async () => {
    // The actual regression, reproduced rather than approximated: a database
    // that recorded only the released 0000 row. Running the current sequence
    // against a fresh database — as the first version of this test did — never
    // reaches the comparison that failed in production.
    const { database } = scratch();
    const built = MigrationManager.buildSequence();
    expect(built.length).toBeGreaterThan(1);

    await MigrationManager.runMigrations(database);

    // Roll the database back to the prior release: drop what 0001 created and
    // forget that it ran, leaving 0000's recorded hash exactly as shipped.
    database.run(sql`DROP TABLE IF EXISTS rate_limits`);
    database.run(sql.raw(`DELETE FROM __drizzle_migrations WHERE created_at > ${built[0]!.when}`));

    const before = await MigrationManager.inspect(database);
    expect(before.problem, "the historical state must be acceptable, not rejected").toBeNull();
    expect(before.pending).toBe(built.length - 1);

    // Now the upgrade that used to exit 75.
    await MigrationManager.runMigrations(database);

    const after = await MigrationManager.inspect(database);
    expect(after.problem).toBeNull();
    expect(after.pending).toBe(0);

    const [table] = database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limits'`,
    );
    expect(table?.name).toBe("rate_limits");
  });
});
