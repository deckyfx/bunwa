/**
 * Backup and restore.
 *
 * The whole system is one SQLite file: projects, environments, API key hashes,
 * devices, consents and the delivery queue. Losing it does not degrade the
 * service, it ends it — every customer re-scans a QR code, and every consent
 * decision they made is gone. That is the worst realistic day this project can
 * have, and it costs an afternoon to prevent.
 *
 * Uses SQLite's own `VACUUM INTO` rather than copying the file. A plain copy of
 * a live database can capture a torn write or miss the WAL entirely, producing
 * a backup that restores cleanly and is silently short of recent data — the
 * worst possible failure, because it looks like it worked.
 */
import type { Stats } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { sql } from "drizzle-orm";

import { config } from "../config/env";
import { createDatabase, openReadOnly, type Database } from "../db";
import { MigrationManager } from "../db/migration-manager";
import { log } from "../observability/logger";

/** A backup and what is known about it without opening it. */
export interface BackupInfo {
  path: string;
  sizeBytes: number;
  createdAt: Date;
}

/** Result of checking that a backup is actually usable. */
export interface VerifyResult {
  ok: boolean;
  /** Rows found per table, so an empty-but-valid backup is visible. */
  counts: Record<string, number>;
  problem: string | null;
}

/** Tables whose emptiness would make a backup worthless. */
const CRITICAL_TABLES = ["projects", "environments", "api_keys", "devices", "device_consents"] as const;

/**
 * Write a consistent snapshot to `destination`.
 *
 * `VACUUM INTO` takes a read lock and writes a fully-checkpointed database, so
 * the result needs no WAL alongside it and can be copied elsewhere as one file.
 */
export async function createBackup(destination: string, database?: Database): Promise<BackupInfo> {
  // Opened here rather than in a default parameter so this function knows
  // whether it owns the handle. A default that opens a connection makes every
  // caller who omits the argument leak one, and nothing in the signature says
  // so — the CLI passes a handle explicitly, so the leak waits for the next
  // caller instead of showing up now.
  const owned = database === undefined;
  const handle = database ?? createDatabase(config().databasePath);

  try {
    await mkdir(join(destination, ".."), { recursive: true }).catch(() => undefined);

    // Written to a staging name and moved into place only on success.
    //
    // VACUUM INTO refuses to overwrite, so the previous version deleted the
    // destination first — which meant a snapshot that then failed, on a full
    // disk or an SQLite error, had destroyed the last good backup to produce
    // nothing. The window was small and the loss total.
    //
    // Same directory, so the final step is a rename within one filesystem
    // rather than a copy that can half-succeed.
    const staging = `${destination}.partial`;
    await rm(staging, { force: true });

    try {
      handle.run(sql.raw(`VACUUM INTO '${staging.replace(/'/g, "''")}'`));
      await rename(staging, destination);
    } catch (err) {
      // The previous backup is still where it was; clear only our debris.
      await rm(staging, { force: true }).catch(() => undefined);
      throw err;
    }
  } finally {
    if (owned) {
      try {
        handle.$client.close();
      } catch {
        // Already closed.
      }
    }
  }

  const info = await stat(destination);
  log.info("backup written", { path: destination, sizeBytes: info.size });
  return { path: destination, sizeBytes: info.size, createdAt: new Date() };
}

/**
 * Open a backup and confirm it is a working database with data in it.
 *
 * A backup nobody has restored is a hypothesis. This is what turns it into a
 * fact: it opens the file, runs SQLite's own integrity check, confirms the
 * schema matches this build, and counts the rows that would matter on the day
 * it is needed.
 */
export async function verifyBackup(path: string): Promise<VerifyResult> {
  const counts: Record<string, number> = {};

  // Checked before opening, because the opener creates what it cannot find.
  // Verifying a missing backup used to produce an empty database at that path
  // and then report "2 migration(s) not applied" — a verdict about a file this
  // function had just written, and the wrong reason besides.
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (err) {
    if (isNotFound(err)) return { ok: false, counts, problem: `no backup at ${path}` };
    // A path that cannot be reached is a different fault from a backup that was
    // never taken, and the operator needs to be able to tell them apart.
    return {
      ok: false,
      counts,
      problem: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!stats.isFile()) return { ok: false, counts, problem: `not a regular file: ${path}` };

  let restored: Database;
  try {
    restored = openReadOnly(path);
  } catch (err) {
    return { ok: false, counts, problem: `cannot open: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const [integrity] = restored.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
    if (integrity?.integrity_check !== "ok") {
      return { ok: false, counts, problem: `integrity check failed: ${integrity?.integrity_check ?? "no result"}` };
    }

    // The schema must match this build, or a restore would run against tables
    // the code does not expect. Reuses the same comparison the startup path
    // uses, so there is one definition of "this database matches this binary".
    const state = await MigrationManager.inspect(restored);
    if (state.problem !== null) return { ok: false, counts, problem: `schema mismatch: ${state.problem}` };
    if (state.pending > 0) return { ok: false, counts, problem: `${state.pending} migration(s) not applied` };

    for (const table of CRITICAL_TABLES) {
      const [row] = restored.all<{ n: number }>(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
      counts[table] = Number(row?.n ?? 0);
    }

    // The failure this function exists to catch, named in its own header: a
    // file that exists, has plausible size, restores cleanly — and is empty.
    // Counting the rows without judging them left the operator reading
    // "verified" above a row of zeros.
    if (CRITICAL_TABLES.every((table) => counts[table] === 0)) {
      return { ok: false, counts, problem: "every critical table is empty" };
    }

    return { ok: true, counts, problem: null };
  } catch (err) {
    return { ok: false, counts, problem: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      restored.$client.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Remove all but the newest `keep` backups in a directory.
 *
 * Retention exists so the disk filling is not itself the outage. Newest by
 * filename, which the timestamped names below sort correctly.
 */
export async function pruneBackups(directory: string, keep: number): Promise<string[]> {
  if (keep < 1) throw new Error("keep must be at least 1");
  let entries: string[];
  try {
    entries = await backupFilesIn(directory);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const doomed = entries.slice(0, Math.max(0, entries.length - keep));
  await Promise.all(doomed.map((f) => rm(join(directory, f), { force: true })));
  return doomed;
}

/** `bunwa-20260823-154210.sqlite` — sorts chronologically as text. */
export function backupFilename(at: Date = new Date()): string {
  const iso = at.toISOString();
  return `bunwa-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}.sqlite`;
}

/**
 * True only for "it is not there", which is the one legitimately empty answer.
 *
 * Every filesystem call in this module used to catch everything and report
 * absence. EACCES, ENOTDIR and ordinary I/O errors were therefore indistinguishable
 * from a healthy directory with no backups, or from a backup not yet taken. An
 * operator whose BACKUP_DIR points at a regular file was told the backup did
 * not exist, and retention reported success while pruning nothing — the disk
 * filling quietly.
 *
 * Named for the condition rather than for the caller: the first version of
 * this helper was isMissingDirectory and covered the two readdir sites, which
 * left verifyBackup's stat() reporting ENOTDIR as "no backup at ...".
 */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Names in `directory` that are actually backup files, oldest first.
 *
 * Regular files only. A directory named `something.sqlite` was treated as a
 * backup: it appeared in listings, and prune's `rm(..., { force: true })`
 * rejected with ERR_FS_EISDIR — force suppresses "missing", not "is a
 * directory" — so one stray directory stopped retention entirely and the disk
 * kept filling.
 */
async function backupFilesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".sqlite"))
    .map((e) => e.name)
    .sort();
}

/**
 * List what is in a backup directory, newest last.
 *
 * Exported so an operator can see which snapshots retention has kept, and how
 * old the newest one is, without opening a database file or trusting that the
 * scheduled job ran. `backup list` is the command someone reaches for at the
 * start of a restore, when the answer needs to come from the filesystem rather
 * than from a log.
 */
export async function listBackups(directory: string): Promise<BackupInfo[]> {
  let entries: string[];
  try {
    entries = await backupFilesIn(directory);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return Promise.all(
    entries.map(async (f) => {
      const info = await stat(join(directory, f));
      return { path: join(directory, f), sizeBytes: info.size, createdAt: info.mtime };
    }),
  );
}
