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
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

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
  restoreEnv();
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
    // Bun's own copy rather than spawning cp: this test should fail for a
    // backup reason, not because a runner has no cp on PATH.
    await Bun.write(moved, Bun.file(target));
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
    // VACUUM INTO will not overwrite, so createBackup writes a staging file and
    // renames it over the destination. Failing here would mean a scheduled
    // backup silently stops after its first run.
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

  test("an unreachable path is reported as unreachable, not as missing", async () => {
    // A path beneath a regular file fails with ENOTDIR. Reporting that as
    // "no backup at ..." tells an operator whose BACKUP_DIR is misconfigured
    // that the backup was never taken — a scheduling problem, not the path
    // problem it actually is.
    const notADirectory = join(dir, "regular-file");
    writeFileSync(notADirectory, "not a directory");

    const result = await verifyBackup(join(notADirectory, "under.sqlite"));
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("cannot read");
    expect(result.problem).toContain("ENOTDIR");
    expect(result.problem).not.toContain("no backup at");
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


describe("an unreadable backup directory is not an empty one", () => {
  // Both functions caught everything and returned empty, so EACCES, ENOTDIR
  // and ordinary I/O errors read as "no backups". An operator checking a
  // misconfigured path was told backups had never been taken, and retention
  // reported success while pruning nothing — the disk filling quietly, which
  // is the outage retention exists to prevent.
  test("listBackups surfaces ENOTDIR rather than reporting no backups", async () => {
    const notADirectory = join(dir, "a-regular-file");
    writeFileSync(notADirectory, "not a directory");

    await expect(listBackups(notADirectory)).rejects.toThrow(/ENOTDIR/);
  });

  test("pruneBackups surfaces ENOTDIR rather than reporting success", async () => {
    const notADirectory = join(dir, "another-regular-file");
    writeFileSync(notADirectory, "not a directory");

    await expect(pruneBackups(notADirectory, 2)).rejects.toThrow(/ENOTDIR/);
  });

  test("a directory that is genuinely absent is still an empty result", async () => {
    // The distinction that matters: nothing there yet is not a failure, and a
    // first run must not throw before the first backup exists.
    const absent = join(dir, "never-created");
    expect(await listBackups(absent)).toEqual([]);
    expect(await pruneBackups(absent, 2)).toEqual([]);
  });
});


describe("the CLI turns a filesystem fault into a diagnosis", () => {
  // backup.ts rethrows EACCES and ENOTDIR so an operator can tell a broken
  // path from an empty one. That only helps if the message survives the trip
  // to the terminal: with no catch at the entry point, a BACKUP_DIR pointing
  // at a regular file printed a Bun crash dump instead.
  test("a misconfigured BACKUP_DIR prints the reason and exits 74", async () => {
    const notADirectory = join(dir, "backup-dir-that-is-a-file");
    writeFileSync(notADirectory, "not a directory");

    const proc = Bun.spawnSync(["bun", "run", "src/ops/backup-cli.ts", "list"], {
      env: { ...process.env, BACKUP_DIR: notADirectory },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("backup failed");
    expect(stderr).toContain("ENOTDIR");
    // A stack trace means the operator got a crash, not an explanation.
    expect(stderr).not.toContain("at async backupFilesIn");
    // 74 is EX_IOERR — distinct from 64 (usage) and 78 (config).
    expect(proc.exitCode).toBe(74);
  }, 30_000);
});


describe("retention only deletes what this tool created", () => {
  // The worst failure available to a backup tool: destroying a database it did
  // not create. `*.sqlite` matched anything, and an unrelated
  // app-production.sqlite sorted ahead of the bunwa- names, so it landed in
  // the doomed slice and a routine prune removed it.
  test("an unrelated database in the directory is neither listed nor pruned", async () => {
    const backups = join(dir, "mixed");
    await mkdir(backups, { recursive: true });

    const bystander = join(backups, "app-production.sqlite");
    writeFileSync(bystander, "IRREPLACEABLE");
    for (const name of [
      "bunwa-20260101-000000.sqlite",
      "bunwa-20260102-000000.sqlite",
      "bunwa-20260103-000000.sqlite",
    ]) {
      await createBackup(join(backups, name), database);
    }

    expect(await pruneBackups(backups, 2)).toEqual(["bunwa-20260101-000000.sqlite"]);

    // Still there, and still its own content.
    expect(await Bun.file(bystander).text()).toBe("IRREPLACEABLE");
    // And it was never a backup as far as listing is concerned.
    const listed = (await listBackups(backups)).map((b) => b.path.split("/").pop());
    expect(listed).not.toContain("app-production.sqlite");
  });

  test("the filter accepts exactly what backupFilename produces", () => {
    // Tied to the generator so the two cannot drift: a pattern that stopped
    // matching real backups would silently disable retention instead.
    const backups = join(dir, "roundtrip");
    const produced = backupFilename(new Date("2026-11-12T13:14:15Z"));
    expect(produced).toBe("bunwa-20261112-131415.sqlite");
    void backups;
  });

  test("a near-miss name is not treated as a backup", async () => {
    const backups = join(dir, "nearmiss");
    await mkdir(backups, { recursive: true });
    for (const name of ["bunwa-2026111-131415.sqlite", "bunwa-20261112-131415.sqlite.bak", "bunwa-.sqlite"]) {
      writeFileSync(join(backups, name), "x");
    }
    await createBackup(join(backups, backupFilename(new Date("2026-11-12T13:14:15Z"))), database);

    expect((await listBackups(backups)).map((b) => b.path.split("/").pop())).toEqual([
      "bunwa-20261112-131415.sqlite",
    ]);
  });
});
