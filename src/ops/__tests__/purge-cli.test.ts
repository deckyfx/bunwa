/**
 * The purge CLI, driven as a subprocess.
 *
 * Spawned rather than imported because the thing under test is the whole
 * command — its argument parsing, its refusals and its exit codes — and those
 * live in top-level code that calls process.exit. Importing it would end the
 * test run.
 *
 * The properties here are the safety ones. Whether purge deletes a database is
 * easy to notice; whether it declines to delete the backups beside it, or
 * accepts --yes on a production box, is exactly the kind of thing that stays
 * true until someone tidies the argument handling.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../purge-cli.ts", import.meta.url).pathname;

let dir = "";
let databasePath = "";
let backupDir = "";
let runtimeDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bunwa-purge-"));
  databasePath = join(dir, "db", "bunwa.sqlite");
  backupDir = join(dir, "backups");
  runtimeDir = join(dir, "runtime");
  await mkdir(join(dir, "db"), { recursive: true });
  await mkdir(backupDir, { recursive: true });
  // Not a real SQLite file. Nothing under test opens it — purge unlinks paths
  // — and a fixture that has to be migrated first would make every case here
  // depend on the migration runner working.
  await writeFile(databasePath, "not really a database");
  await writeFile(`${databasePath}-wal`, "");
  await writeFile(join(backupDir, "bunwa-20260101.sqlite"), "a snapshot");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the CLI with the environment a test needs, and collect its verdict. */
async function purge(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      BACKUP_DIR: backupDir,
      RUNTIME_DIR: runtimeDir,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

const exists = (path: string) => Bun.file(path).exists();

describe("purging", () => {
  test("removes the database and the sidecars WAL mode leaves beside it", async () => {
    const { code } = await purge(["--yes"]);
    expect(code).toBe(0);
    expect(await exists(databasePath)).toBe(false);
    expect(await exists(`${databasePath}-wal`)).toBe(false);
  });

  test("--dry-run deletes nothing", async () => {
    const { code, out } = await purge(["--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing was deleted");
    expect(await exists(databasePath)).toBe(true);
  });

  test("a database that is already gone is not an error", async () => {
    await rm(databasePath);
    await rm(`${databasePath}-wal`);
    const { code, out } = await purge(["--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("already blank");
  });
});

describe("what it refuses to do", () => {
  test("leaves the backups alone", async () => {
    // The property that makes the command survivable at all.
    await purge(["--yes"]);
    expect(await exists(join(backupDir, "bunwa-20260101.sqlite"))).toBe(true);
  });

  test("refuses a database that lives inside the backup directory", async () => {
    const inside = join(backupDir, "bunwa.sqlite");
    await writeFile(inside, "a database somebody pointed at the backups");
    const { code, out } = await purge(["--yes"], { DATABASE_PATH: inside });
    expect(code).toBe(73);
    expect(out).toContain("backup directory");
    expect(await exists(inside), "it deleted a database inside the backup dir").toBe(true);
  });

  test("refuses a database directory that contains the backups", async () => {
    // The mirror of the test above, and the direction that was open: the
    // delete is recursive and DATABASE_PATH can be a directory, so a parent of
    // BACKUP_DIR would have taken the restore point with it. Checking only
    // "target inside backups" left the containing case reachable.
    const { code, out } = await purge(["--yes"], { DATABASE_PATH: dir });
    expect(code).toBe(73);
    expect(out).toContain("backup directory");
    expect(
      await exists(join(backupDir, "bunwa-20260101.sqlite")),
      "it deleted the backups by way of their parent directory",
    ).toBe(true);
  });

  test("will not take --yes in production", async () => {
    const { code, out } = await purge(["--yes"], {
      NODE_ENV: "production",
      ADMIN_API_ENABLED: "false",
      MIGRATE_STRICT: "false",
      CREDENTIAL_ENCRYPTION_KEY: "0".repeat(64),
    });
    expect(code).toBe(77);
    expect(out).toContain("confirm interactively");
    expect(await exists(databasePath), "production was purged without a confirmation").toBe(true);
  });

  test("an unrecognised flag stops the command rather than being ignored", async () => {
    // The case this exists for is a misspelt --dry-run. Ignoring the flag runs
    // the destructive path the operator was trying to avoid.
    const { code } = await purge(["--dryrun"]);
    expect(code).toBe(64);
    expect(await exists(databasePath), "a typo deleted the database").toBe(true);
  });

  test("without a terminal it asks for --yes rather than assuming consent", async () => {
    const { code, out } = await purge([]);
    expect(code).toBe(64);
    expect(out).toContain("--yes");
    expect(await exists(databasePath)).toBe(true);
  });
});
