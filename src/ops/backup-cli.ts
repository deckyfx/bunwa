/**
 * Backup CLI.
 *
 *   bun run backup            take a snapshot, verify it, prune old ones
 *   bun run backup verify <f> check an existing file
 *   bun run backup list       what is on disk
 *
 * Verification runs by default rather than on request. A backup nobody has
 * opened is a hypothesis, and the failure mode this guards against — a file
 * that exists, has plausible size, and restores empty — is invisible until the
 * day it matters.
 */
import { join } from "node:path";

import { config, ConfigError } from "../config/env";
import { createDatabase } from "../db";
import { log } from "../observability/logger";
import { backupFilename, createBackup, listBackups, pruneBackups, verifyBackup } from "./backup";

/** How many snapshots to keep. Enough to survive a bad one going unnoticed. */
const KEEP = 7;

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

  const [command, argument] = Bun.argv.slice(2);
  const directory = Bun.env["BACKUP_DIR"] ?? "./data/backups";

  if (command === "list") {
    const backups = await listBackups(directory);
    if (backups.length === 0) {
      console.log(`no backups in ${directory}`);
      return;
    }
    for (const b of backups) {
      console.log(`  ${b.path}  ${(b.sizeBytes / 1024).toFixed(0)} KiB  ${b.createdAt.toISOString()}`);
    }
    return;
  }

  if (command === "verify") {
    if (argument === undefined) {
      console.error("usage: bun run backup verify <file>");
      process.exit(64);
    }
    // Exits non-zero on failure, matching the backup path below. Printing the
    // failure and returning 0 makes `backup verify` useless to the thing most
    // likely to run it: a cron job or a CI step that only reads the status.
    const verified = await verifyBackup(argument);
    report(argument, verified);
    if (!verified.ok) process.exit(1);
    return;
  }

  // Only a bare invocation takes a backup. Anything else falls through to
  // here, so `backup verfiy file.sqlite` used to write a snapshot and prune
  // older ones — a typo in a verification command silently mutating the backup
  // set is the opposite of what the operator asked for.
  if (command !== undefined) {
    console.error(`unknown command: ${command}`);
    console.error("usage: bun run backup [list | verify <file>]");
    process.exit(64);
  }

  const destination = join(directory, backupFilename());
  const database = createDatabase(config().databasePath);
  try {
    const info = await createBackup(destination, database);
    console.log(`  wrote ${info.path} (${(info.sizeBytes / 1024).toFixed(0)} KiB)`);
  } finally {
    try {
      database.$client.close();
    } catch {
      // Already closed.
    }
  }

  // Verified immediately, while the operator is watching. Discovering a broken
  // backup during a restore is discovering it too late.
  const result = await verifyBackup(destination);
  report(destination, result);
  if (!result.ok) process.exit(1);

  const pruned = await pruneBackups(directory, KEEP);
  if (pruned.length > 0) console.log(`  pruned ${pruned.length} older backup(s), keeping ${KEEP}`);
}

function report(path: string, result: ReturnType<typeof verifyBackup> extends Promise<infer R> ? R : never): void {
  if (!result.ok) {
    console.error(`  ✗ ${path} is not usable: ${result.problem ?? "unknown"}`);
    log.error("backup verification failed", undefined, { path, problem: result.problem });
    return;
  }
  const summary = Object.entries(result.counts)
    .map(([table, n]) => `${table}=${n}`)
    .join(" ");
  console.log(`  ✓ verified: opens, integrity ok, schema current — ${summary}`);
}

// Every other failure in this file prints a diagnosis and picks an exit code.
// This one did not exist, so once backup.ts started rethrowing EACCES and
// ENOTDIR instead of reporting them as "no backups", a BACKUP_DIR pointing at
// a regular file produced a Bun crash dump. The diagnosis those rethrows exist
// to deliver never reached the operator it was written for.
//
// 74 is sysexits' EX_IOERR: the command was well-formed, the filesystem was
// not cooperative. Distinct from 64 (bad usage) and 78 (bad config) already
// used above, so a script can tell them apart.
try {
  await main();
} catch (err) {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(74);
}
