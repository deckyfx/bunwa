/**
 * Backup and restore.
 *
 * The point of these is the failure they rule out: a backup that exists, has a
 * plausible size, and restores empty or corrupt. That failure is invisible
 * until the day it matters — which is the day nothing else is going well.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../../stores/project-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ApiKeyStore } from "../../stores/api-key-store";
import { resetConfig } from "../../config/env";
import { backupFilename, createBackup, listBackups, pruneBackups, verifyBackup } from "../backup";

let dir: string;
let database: Database;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-backup-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "live.sqlite");

  database = createDatabase(join(dir, "live.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  await ApiKeyStore.create(
    { projectId: project.id, environmentId: environment.id, label: "backend", scopes: ["send:text"] },
    database,
  );
});

afterEach(() => {
  try {
    database.$client.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

describe("createBackup", () => {
  test("writes a file that opens as a database with the data in it", async () => {
    const target = join(dir, "backups", backupFilename());
    const info = await createBackup(target, database);
    expect(info.sizeBytes).toBeGreaterThan(0);

    const result = await verifyBackup(target);
    expect(result.problem).toBeNull();
    expect(result.counts["projects"]).toBe(1);
    expect(result.counts["api_keys"]).toBe(1);
  });

  test("the snapshot needs no WAL file beside it", async () => {
    // VACUUM INTO writes a fully checkpointed database. A plain file copy would
    // leave recent writes in a WAL that does not travel with it, producing a
    // backup that restores cleanly and is silently short of data.
    const target = join(dir, "solo", backupFilename());
    await createBackup(target, database);

    const moved = join(dir, "elsewhere.sqlite");
    Bun.spawnSync(["cp", target, moved]);
    const result = await verifyBackup(moved);
    expect(result.ok).toBe(true);
    expect(result.counts["projects"]).toBe(1);
  });

  test("captures writes made right up to the snapshot", async () => {
    await ProjectStore.create({ slug: "late", displayName: "Late" }, database);
    const target = join(dir, "backups", backupFilename());
    await createBackup(target, database);
    expect((await verifyBackup(target)).counts["projects"]).toBe(2);
  });

  test("overwrites an existing file rather than refusing", async () => {
    // VACUUM INTO will not overwrite, so createBackup removes first. Failing
    // here would mean a scheduled backup silently stops after its first run.
    const target = join(dir, "backups", "fixed-name.sqlite");
    await createBackup(target, database);
    await expect(createBackup(target, database)).resolves.toBeDefined();
  });
});

describe("verifyBackup", () => {
  test("rejects a file that is not a database", async () => {
    const bogus = join(dir, "not-a-db.sqlite");
    writeFileSync(bogus, "this is not a database");
    const result = await verifyBackup(bogus);
    expect(result.ok).toBe(false);
    expect(result.problem).toBeString();
  });

  test("rejects a truncated database", async () => {
    // The failure this file exists to catch: a plausible-looking file that is
    // not a working database.
    const target = join(dir, "backups", backupFilename());
    await createBackup(target, database);
    const bytes = await Bun.file(target).arrayBuffer();
    writeFileSync(target, Buffer.from(bytes.slice(0, Math.floor(bytes.byteLength / 2))));

    expect((await verifyBackup(target)).ok).toBe(false);
  });

  test("rejects a database whose schema does not match this build", async () => {
    // Restoring against unexpected tables is worse than a failed restore.
    const stale = join(dir, "stale.sqlite");
    const other = createDatabase(stale);
    other.run(sql`CREATE TABLE unrelated (id integer primary key)`);
    other.$client.close();

    const result = await verifyBackup(stale);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("migration");
  });
});

describe("pruneBackups", () => {
  test("keeps the newest and removes the rest", async () => {
    const backups = join(dir, "many");
    for (const name of [
      "bunwa-20260101-000000.sqlite",
      "bunwa-20260102-000000.sqlite",
      "bunwa-20260103-000000.sqlite",
    ]) {
      await createBackup(join(backups, name), database);
    }
    expect(await pruneBackups(backups, 2)).toHaveLength(1);

    const left = (await listBackups(backups)).map((b) => b.path.split("/").pop());
    expect(left).toEqual(["bunwa-20260102-000000.sqlite", "bunwa-20260103-000000.sqlite"]);
  });

  test("refuses to keep zero, which would delete every backup", async () => {
    await expect(pruneBackups(dir, 0)).rejects.toThrow(/at least 1/);
  });

  test("is a no-op on a directory that does not exist", async () => {
    expect(await pruneBackups(join(dir, "nope"), 3)).toEqual([]);
  });
});

describe("backupFilename", () => {
  test("sorts chronologically as text, which is what prune relies on", () => {
    const early = backupFilename(new Date("2026-01-02T03:04:05Z"));
    const late = backupFilename(new Date("2026-11-12T13:14:15Z"));
    expect(early < late).toBe(true);
    expect(early).toBe("bunwa-20260102-030405.sqlite");
  });
});
