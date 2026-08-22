/**
 * Migration verification.
 *
 * Drizzle's migrator selects work by comparing each journal timestamp against
 * the single greatest recorded `created_at` and never inspects individual
 * hashes, so a database that diverged from this build is applied on top of
 * rather than rejected. These tests pin the comparison that catches it.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { MigrationManager } from "../migration-manager";
import { embeddedFiles, embeddedJournal, embeddedMigrationCount } from "../migrations-embedded";
import { resetConfig } from "../../config/env";

const RUNTIME = join(import.meta.dir, ".test-runtime");
const ENV = { NODE_ENV: "test", DATABASE_PATH: ":memory:", LOG_LEVEL: "error", RUNTIME_DIR: RUNTIME };

beforeAll(() => {
  resetConfig();
  for (const [k, v] of Object.entries(ENV)) Bun.env[k] = v;
});
afterAll(async () => {
  resetConfig();
  for (const k of Object.keys(ENV)) delete Bun.env[k];
  await rm(RUNTIME, { recursive: true, force: true });
});

/** A fake applied-migrations table, ordered as Drizzle returns it. */
function rowsFor(indices: number[]) {
  const seq = MigrationManager.buildSequence();
  return indices.map((i) => ({ hash: seq[i]!.hash, created_at: String(seq[i]!.when) }));
}

/** Stand-in for the database handle; only `all` is used by inspect(). */
function fakeDb(rows: unknown[] | Error) {
  return {
    all: () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as never;
}

describe("packaging", () => {
  test("the build carries at least one migration", () => {
    // Zero embedded migrations builds cleanly and then creates no tables at all.
    expect(embeddedMigrationCount).toBeGreaterThan(0);
    expect(embeddedJournal.entries.length).toBe(embeddedMigrationCount);
  });

  test("every journal entry has its SQL compiled in", () => {
    for (const entry of embeddedJournal.entries) {
      expect(embeddedFiles[`${entry.tag}.sql`]).toBeString();
      expect(embeddedFiles[`${entry.tag}.sql`]!.length).toBeGreaterThan(0);
    }
  });

  test("hashes match how Drizzle computes them — sha256 of the raw file", () => {
    const seq = MigrationManager.buildSequence();
    for (const m of seq) {
      const expected = createHash("sha256").update(embeddedFiles[`${m.tag}.sql`]!).digest("hex");
      expect(m.hash).toBe(expected);
    }
  });
});

describe("materialise", () => {
  test("writes the journal and every migration where the migrator will find them", async () => {
    await MigrationManager.materialise();
    const dir = join(RUNTIME, ".migrations");
    const files = await readdir(dir);
    expect(files).toContain("meta");
    for (const entry of embeddedJournal.entries) expect(files).toContain(`${entry.tag}.sql`);
    expect(await Bun.file(join(dir, "meta/_journal.json")).json()).toEqual(embeddedJournal);
  });

  test("prunes SQL this build does not carry", async () => {
    const dir = join(RUNTIME, ".migrations");
    // A newer build's migration, left behind by a rollback.
    await Bun.write(join(dir, "9999_from_a_newer_build.sql"), "SELECT 1;");
    await MigrationManager.materialise();
    expect(await readdir(dir)).not.toContain("9999_from_a_newer_build.sql");
  });
});

describe("inspect", () => {
  test("treats a missing tracking table as nothing applied", async () => {
    const state = await MigrationManager.inspect(fakeDb(new Error("relation does not exist")));
    expect(state.problem).toBeNull();
    expect(state.pending).toBe(embeddedMigrationCount);
  });

  test("reports zero pending when the database matches the build", async () => {
    const all = MigrationManager.buildSequence().map((_, i) => i);
    const state = await MigrationManager.inspect(fakeDb(rowsFor(all)));
    expect(state).toEqual({ pending: 0, problem: null });
  });

  test("rejects a database holding migrations this build does not have", async () => {
    const rows = [...rowsFor([0]), { hash: "deadbeef", created_at: "9999999999999" }];
    const state = await MigrationManager.inspect(fakeDb(rows));
    expect(state.problem).toContain("beyond this build");
  });

  test("rejects a hash mismatch at the same position — divergence, not just count", async () => {
    // [A'] vs build [A]: same length, different content. A count-based check passes this.
    const rows = [{ hash: "0".repeat(64), created_at: String(MigrationManager.buildSequence()[0]!.when) }];
    const state = await MigrationManager.inspect(fakeDb(rows));
    expect(state.problem).toContain("does not match this build");
  });

  test("rejects a matching hash recorded at the wrong timestamp", async () => {
    // Byte-identical SQL in two migrations would otherwise match at the wrong position.
    const rows = [{ hash: MigrationManager.buildSequence()[0]!.hash, created_at: "1" }];
    const state = await MigrationManager.inspect(fakeDb(rows));
    expect(state.problem).toContain("does not match this build");
  });

  test("accepts created_at as a number, as a driver may return bigint", async () => {
    // The string case is already covered by rowsFor(); this exercises the other
    // branch of the normalisation rather than repeating the same one.
    const seq = MigrationManager.buildSequence();
    const rows = [{ hash: seq[0]!.hash, created_at: seq[0]!.when }];
    const state = await MigrationManager.inspect(fakeDb(rows));
    expect(state.problem).toBeNull();
  });
});
