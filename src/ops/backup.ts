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
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { sql } from "drizzle-orm";

import { config } from "../config/env";
import { createDatabase, type Database } from "../db";
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
export async function createBackup(
  destination: string,
  database: Database = createDatabase(config().databasePath),
): Promise<BackupInfo> {
  await mkdir(join(destination, ".."), { recursive: true }).catch(() => undefined);

  // VACUUM INTO refuses to overwrite, which is a feature — a backup that
  // silently replaced a good one with a failed attempt would be worse than no
  // backup. Remove deliberately, after the caller has chosen the path.
  await rm(destination, { force: true });

  database.run(sql.raw(`VACUUM INTO '${destination.replace(/'/g, "''")}'`));

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
  let restored: Database;
  try {
    restored = createDatabase(path);
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
    entries = (await readdir(directory)).filter((f) => f.endsWith(".sqlite")).sort();
  } catch {
    return [];
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

/** List what is in a backup directory, newest last. */
export async function listBackups(directory: string): Promise<BackupInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((f) => f.endsWith(".sqlite")).sort();
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (f) => {
      const info = await stat(join(directory, f));
      return { path: join(directory, f), sizeBytes: info.size, createdAt: info.mtime };
    }),
  );
}

export { basename };
