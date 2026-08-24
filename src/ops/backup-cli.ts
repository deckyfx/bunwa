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
  const directory = process.env["BACKUP_DIR"] ?? "./data/backups";

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

await main();
