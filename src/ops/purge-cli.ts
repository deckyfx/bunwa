/**
 * Purge CLI — delete the database and start from blank.
 *
 *   bun run db:purge              confirm, then delete
 *   bun run db:purge --migrate    delete, then recreate the schema
 *   bun run db:purge --dry-run    list what would go, delete nothing
 *   bun run db:purge --yes        skip the prompt, for scripts
 *
 * This is the most destructive command in the project and it is deliberately
 * the least convenient. The database holds the WhatsApp credentials and Signal
 * keys for every paired device (docs/13), so deleting it is not "reset the
 * dev data" — it is every customer re-scanning a QR code, which
 * docs/08 names as the worst day this project can have. A typed confirmation
 * costs four seconds and is the only thing standing between that and a
 * mistyped command in the wrong terminal.
 *
 * What it does not touch, on purpose:
 *
 *   - **Backups.** Purging the thing and its restore point in one command is
 *     how a recoverable mistake becomes a permanent one.
 *   - **Logs.** They are the record of what the system did before you wiped
 *     it, which is often exactly what you wanted to read afterwards.
 */
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { config, ConfigError } from "../config/env";

/** The database file, plus the two sidecars WAL mode leaves beside it. */
const SIDECARS = ["", "-wal", "-shm"] as const;

interface Target {
  path: string;
  /** Bytes, or undefined when it is not there — which is not an error. */
  sizeBytes?: number;
}

/**
 * Everything a purge would remove, whether or not it exists.
 *
 * Built before anything is deleted so `--dry-run` and the confirmation prompt
 * describe exactly what the destructive path will do, rather than an
 * approximation of it that can drift.
 */
async function targets(): Promise<Target[]> {
  const cfg = config();
  const found: Target[] = [];

  // :memory: has nothing on disk. Reported rather than silently doing nothing,
  // because an operator who ran this expecting a wipe should learn that the
  // database was never persistent in the first place.
  if (cfg.databasePath !== ":memory:") {
    for (const suffix of SIDECARS) found.push(await describe(cfg.databasePath + suffix));
  }

  // Migrations materialised out of the binary at boot. Not a source of truth —
  // they are rewritten on the next start — but a purge that leaves them makes
  // "blank" a half-truth, and a stale copy here has already caused one
  // confusing failure.
  found.push(await describe(join(cfg.runtimeDir, ".migrations")));

  return found;
}

async function describe(path: string): Promise<Target> {
  try {
    const info = await stat(path);
    return { path, sizeBytes: info.size };
  } catch {
    return { path };
  }
}

/**
 * Refuse to delete anything inside the backup directory.
 *
 * A `DATABASE_PATH` pointing into `BACKUP_DIR` is a misconfiguration rather
 * than a request, and honouring it would delete the snapshots along with the
 * database — removing the one thing that makes this command survivable.
 */
function refuseIfBackup(paths: readonly string[]): void {
  const backupDir = resolve(Bun.env["BACKUP_DIR"] ?? "./data/backups");
  for (const path of paths) {
    const full = isAbsolute(path) ? path : resolve(path);
    if (full === backupDir || full.startsWith(backupDir + "/")) {
      console.error(`refusing: ${path} is inside the backup directory (${backupDir})`);
      console.error("purging a database and its restore point together is not recoverable");
      process.exit(73); // EX_CANTCREAT — the request is valid, the state is not
    }
  }
}

/**
 * Ask, and accept only the database's own filename.
 *
 * A y/n prompt is answered reflexively; typing the name requires reading which
 * database is about to go, which is the entire point when the difference
 * between the right terminal and the wrong one is one word.
 */
async function confirm(expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("not a terminal: pass --yes to purge without confirmation");
    process.exit(64);
  }
  process.stdout.write(`\nType ${expected} to confirm, or anything else to abort: `);
  for await (const line of console) return line.trim() === expected;
  return false;
}

function format(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(0)} KiB`;
}

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

  const args = new Set(Bun.argv.slice(2));
  const unknown = [...args].filter((a) => !["--yes", "--dry-run", "--migrate"].includes(a));
  if (unknown.length > 0) {
    // Not ignored. An unrecognised flag on a destructive command is most
    // likely a misspelt --dry-run, and treating it as absent would run the
    // destructive path the operator was trying to avoid.
    console.error(`unknown option: ${unknown.join(" ")}`);
    console.error("usage: bun run db:purge [--yes] [--dry-run] [--migrate]");
    process.exit(64);
  }

  const cfg = config();
  const found = await targets();
  refuseIfBackup(found.map((t) => t.path));

  const present = found.filter((t) => t.sizeBytes !== undefined);
  console.log(`\ndatabase: ${cfg.databasePath}   environment: ${cfg.nodeEnv}\n`);

  if (present.length === 0) {
    console.log("nothing to purge; already blank");
    return;
  }
  for (const t of present) console.log(`  ${t.path}  ${format(t.sizeBytes ?? 0)}`);

  if (args.has("--dry-run")) {
    console.log("\n--dry-run: nothing was deleted");
    return;
  }

  // Production is not refused outright, because a staging box that calls
  // itself production is a real thing and an operator who means it should not
  // have to edit the environment to get their way. It is called out loudly
  // instead, and the typed confirmation is not skippable there.
  if (cfg.nodeEnv === "production") {
    console.warn("\n⚠ NODE_ENV is production. Every paired device will have to re-scan a QR code.");
    if (args.has("--yes")) {
      console.error("--yes is not accepted in production; confirm interactively");
      process.exit(77); // EX_NOPERM
    }
  }

  const name = cfg.databasePath.split("/").pop() ?? cfg.databasePath;
  if (!args.has("--yes") && !(await confirm(name))) {
    console.log("aborted; nothing was deleted");
    process.exit(1);
  }

  for (const target of present) {
    await rm(target.path, { recursive: true, force: true });
    console.log(`  removed ${target.path}`);
  }

  if (args.has("--migrate")) {
    // Imported here rather than at the top so the module — and the database
    // handle it opens — is never constructed on a run that does not migrate.
    const { MigrationManager } = await import("../db/migration-manager");
    await MigrationManager.init();
    console.log("\nschema recreated; the database is blank and ready");
    return;
  }

  console.log("\npurged. The schema is recreated on the next start in development,");
  console.log("or by `bun run db:migrate` anywhere else.");
}

// 74 is sysexits' EX_IOERR, matching backup-cli: the command was well-formed
// and the filesystem was not. Distinct from 64 (usage), 73 (refused), 77
// (not permitted) and 78 (config) used above, so a script can tell them apart.
try {
  await main();
} catch (err) {
  console.error(`purge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(74);
}
