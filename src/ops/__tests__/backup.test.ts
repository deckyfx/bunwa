/**
 * Backup and restore.
 *
 * The point of these is the failure they rule out: a backup that exists, has a
 * plausible size, and restores empty or corrupt. That failure is invisible
 * until the day it matters — which is the day nothing else is going well.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

describe("verification does not author what it inspects", () => {
  // Every one of these passed review as "verified" behaviour before: the
  // function opened the path with create:true, so a missing backup became an
  // empty database, and the empty database became the verdict.
  test("a missing backup is reported as missing, and no file appears", async () => {
    const path = join(dir, "absent", "nope.sqlite");
    const result = await verifyBackup(path);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no backup at");
    // The reason matters as much as the verdict: this used to say
    // "2 migration(s) not applied", describing a file it had just created.
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a directory is not a backup", async () => {
    const result = await verifyBackup(dir);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("not a regular file");
  });

  test("a structurally perfect but empty backup fails", async () => {
    // Correct schema, current migrations, passes integrity_check, restores
    // cleanly — and the service is gone. This is the exact failure the module
    // header names, and counting the rows without judging them let it through.
    const empty = join(dir, "empty.sqlite");
    const source = createDatabase(join(dir, "source.sqlite"));
    await MigrationManager.runMigrations(source);
    await createBackup(empty, source);
    source.$client.close();

    const result = await verifyBackup(empty);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("every critical table is empty");
    expect(result.counts["projects"]).toBe(0);
  });

  test("a backup with data still verifies", async () => {
    // The guard above must not reject a good backup.
    const good = join(dir, "good.sqlite");
    await createBackup(good, database);

    const result = await verifyBackup(good);
    expect(result.problem).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.counts["projects"]).toBeGreaterThan(0);
  });

  test("verification cannot write to the backup it opens", async () => {
    // Read-only is the structural guarantee behind the tests above: no WAL
    // sidecar appears, and no pragma mutates the file being judged.
    const good = join(dir, "readonly.sqlite");
    await createBackup(good, database);
    const before = Bun.file(good).size;

    expect((await verifyBackup(good)).ok).toBe(true);

    expect(Bun.file(good).size).toBe(before);
    expect(await Bun.file(`${good}-wal`).exists()).toBe(false);
  });
});

describe("a failed backup must not destroy the last good one", () => {
  test("the previous snapshot survives a failed replacement", async () => {
    // VACUUM INTO refuses to overwrite, so the destination used to be deleted
    // first. A snapshot that then failed — a full disk, an SQLite error — had
    // already destroyed the only backup, to produce nothing in its place.
    const destination = join(dir, "rolling.sqlite");
    await createBackup(destination, database);
    const goodSize = Bun.file(destination).size;
    expect(goodSize).toBeGreaterThan(0);
    expect((await verifyBackup(destination)).ok).toBe(true);

    // A closed handle fails inside VACUUM INTO, after the point where the old
    // implementation had already removed the destination.
    const doomed = createDatabase(join(dir, "doomed.sqlite"));
    await MigrationManager.runMigrations(doomed);
    doomed.$client.close();

    await expect(createBackup(destination, doomed)).rejects.toThrow();

    // The backup that was there before is still there, and still usable.
    expect(Bun.file(destination).size).toBe(goodSize);
    expect((await verifyBackup(destination)).ok).toBe(true);
    // And no staging debris is left to be mistaken for a backup.
    expect(await Bun.file(`${destination}.partial`).exists()).toBe(false);
  });
});

describe("retention survives what it finds in the directory", () => {
  test("a directory named like a backup does not halt pruning", async () => {
    // `rm(..., { force: true })` suppresses "missing", not "is a directory":
    // one stray *.sqlite directory made prune reject with ERR_FS_EISDIR, so
    // retention stopped entirely and the disk kept filling — the exact outage
    // retention exists to prevent.
    const backups = join(dir, "retention");
    await mkdir(backups, { recursive: true });
    for (const name of [
      "bunwa-20260101-000000.sqlite",
      "bunwa-20260102-000000.sqlite",
      "bunwa-20260103-000000.sqlite",
    ]) {
      await createBackup(join(backups, name), database);
    }
    await mkdir(join(backups, "bunwa-20260104-000000.sqlite"), { recursive: true });

    const pruned = await pruneBackups(backups, 2);
    expect(pruned).toEqual(["bunwa-20260101-000000.sqlite"]);

    // The directory is not a backup, so it is neither listed nor deleted.
    const listed = (await listBackups(backups)).map((b) => b.path.split("/").pop());
    expect(listed).toEqual(["bunwa-20260102-000000.sqlite", "bunwa-20260103-000000.sqlite"]);
    // stat().isDirectory(), not Bun.file().exists(): exists() returns false for
    // a live directory and for a missing path alike, so the assertion this
    // replaced held whether prune preserved the directory or deleted it —
    // directly above a comment claiming it proved the first. stat() throws
    // ENOENT if the directory is gone, which is the failure this must catch.
    const stray = await Bun.file(join(backups, "bunwa-20260104-000000.sqlite")).stat();
    expect(stray.isDirectory()).toBe(true);
  });
});
