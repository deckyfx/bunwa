/**
 * Credential and Signal key storage.
 *
 * The properties worth proving are the ones whose failure is silent: keys that
 * round-trip as the wrong bytes, a phone number reaching a column, a partial
 * write leaving Baileys disagreeing with the store, and credentials surviving
 * a device that was purged.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { AuthStateStore } from "../auth-state-store";
import { DeviceStore } from "../device-store";
import { ProjectStore } from "../project-store";
import { EnvironmentStore } from "../environment-store";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "CREDENTIAL_ENCRYPTION_KEY"]);

let dir: string;
let database: Database;
let deviceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-auth-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  Bun.env["CREDENTIAL_ENCRYPTION_KEY"] = "a".repeat(64);
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "G" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  const claimed = await DeviceStore.claim(
    { environmentId: environment.id, msisdn: "+628123456789", alias: "otp" },
    database,
  );
  deviceId = claimed.device.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const CREDS = Buffer.from(JSON.stringify({ noiseKey: "x".repeat(64), advSecretKey: "secret" }));

describe("credentials", () => {
  test("round-trip exactly", async () => {
    await AuthStateStore.saveCreds(deviceId, CREDS, database);
    expect(await AuthStateStore.loadCreds(deviceId, database)).toEqual(CREDS);
  });

  test("a device that never paired has none", async () => {
    expect(await AuthStateStore.loadCreds(deviceId, database)).toBeNull();
  });

  test("saving twice replaces rather than failing or duplicating", async () => {
    // Baileys reports creds.update constantly. A delete-then-insert would open
    // a window where a restart loses the pairing.
    await AuthStateStore.saveCreds(deviceId, CREDS, database);
    const updated = Buffer.from("second version");
    await AuthStateStore.saveCreds(deviceId, updated, database);
    expect(await AuthStateStore.loadCreds(deviceId, database)).toEqual(updated);
  });

  test("nothing readable reaches the column", async () => {
    await AuthStateStore.saveCreds(deviceId, CREDS, database);
    const [row] = database.all<{ ciphertext: Uint8Array }>(
      sql`SELECT ciphertext FROM device_credentials WHERE device_id = ${deviceId}`,
    );
    expect(Buffer.from(row!.ciphertext).includes(Buffer.from("advSecretKey"))).toBe(false);
  });
});

describe("signal keys", () => {
  test("round-trip by id", async () => {
    await AuthStateStore.saveKeys(
      deviceId,
      [
        { keyType: "pre-key", id: "1", value: Buffer.from([1, 2, 3]) },
        { keyType: "pre-key", id: "2", value: Buffer.from([4, 5, 6]) },
      ],
      database,
    );

    const got = await AuthStateStore.loadKeys(deviceId, "pre-key", ["1", "2"], database);
    expect(got.get("1")).toEqual(Buffer.from([1, 2, 3]));
    expect(got.get("2")).toEqual(Buffer.from([4, 5, 6]));
  });

  test("an id that is not held is simply absent", async () => {
    // Baileys expects a sparse result and treats a missing id as "not held".
    const got = await AuthStateStore.loadKeys(deviceId, "pre-key", ["nope"], database);
    expect(got.size).toBe(0);
  });

  test("key types do not collide", async () => {
    await AuthStateStore.saveKeys(deviceId, [{ keyType: "pre-key", id: "1", value: Buffer.from("a") }], database);
    await AuthStateStore.saveKeys(deviceId, [{ keyType: "session", id: "1", value: Buffer.from("b") }], database);

    expect((await AuthStateStore.loadKeys(deviceId, "pre-key", ["1"], database)).get("1")).toEqual(Buffer.from("a"));
    expect((await AuthStateStore.loadKeys(deviceId, "session", ["1"], database)).get("1")).toEqual(Buffer.from("b"));
  });

  test("a null value deletes, which is how a pre-key is consumed", async () => {
    await AuthStateStore.saveKeys(deviceId, [{ keyType: "pre-key", id: "1", value: Buffer.from("a") }], database);
    await AuthStateStore.saveKeys(deviceId, [{ keyType: "pre-key", id: "1", value: null }], database);
    expect((await AuthStateStore.loadKeys(deviceId, "pre-key", ["1"], database)).size).toBe(0);
  });

  test("no phone number reaches the database", async () => {
    // The whole reason ids are hashed. Baileys' file store names a file
    // session-628123456789@s.whatsapp.net.json, so the recipient list is a
    // directory listing.
    const sessionId = "628123456789@s.whatsapp.net";
    await AuthStateStore.saveKeys(deviceId, [{ keyType: "session", id: sessionId, value: Buffer.from("s") }], database);

    const [row] = database.all<{ key_hash: string }>(
      sql`SELECT key_hash FROM device_signal_keys WHERE device_id = ${deviceId}`,
    );
    expect(row!.key_hash).not.toContain("628123456789");
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);

    // And it is still findable by the real id.
    expect((await AuthStateStore.loadKeys(deviceId, "session", [sessionId], database)).get(sessionId)).toEqual(
      Buffer.from("s"),
    );
  });
});

describe("forgetting a device", () => {
  test("removes credentials and every key", async () => {
    await AuthStateStore.saveCreds(deviceId, CREDS, database);
    await AuthStateStore.saveKeys(
      deviceId,
      Array.from({ length: 20 }, (_, i) => ({ keyType: "pre-key", id: String(i), value: Buffer.from([i]) })),
      database,
    );
    expect(await AuthStateStore.keyCount(deviceId, database)).toBe(20);

    await AuthStateStore.forget(deviceId, database);

    expect(await AuthStateStore.loadCreds(deviceId, database)).toBeNull();
    expect(await AuthStateStore.keyCount(deviceId, database)).toBe(0);
  });
});

describe("without a key, nothing is written in the clear", () => {
  test("saving refuses rather than falling back to plaintext", async () => {
    delete Bun.env["CREDENTIAL_ENCRYPTION_KEY"];
    resetConfig();

    await expect(AuthStateStore.saveCreds(deviceId, CREDS, database)).rejects.toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
  });
});
