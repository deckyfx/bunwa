/**
 * The auth state Baileys is handed.
 *
 * Exercised through the port's own round-trip rather than a socket, because
 * the failures worth catching are all serialisation: a Buffer that comes back
 * as `{type:"Buffer",data:[…]}`, an app-state-sync-key handed over as a plain
 * object, a deleted key that was only overwritten. Each of those saves and
 * loads without complaint and fails cryptographically much later.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, resetDatabase, type Database } from "../../../db";
import { MigrationManager } from "../../../db/migration-manager";
import { resetConfig } from "../../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../../testing/env";
import { AuthStateStore } from "../../../stores/auth-state-store";
import { DeviceStore } from "../../../stores/device-store";
import { ProjectStore } from "../../../stores/project-store";
import { EnvironmentStore } from "../../../stores/environment-store";
import { loadAuthStateForTests } from "../socket";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "CREDENTIAL_ENCRYPTION_KEY"]);

let dir: string;
let database: Database;
let deviceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-bauth-"));
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
  deviceId = (
    await DeviceStore.claim({ environmentId: environment.id, msisdn: "+628123456789", alias: "otp" }, database)
  ).device.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

describe("credentials survive a restart as the same bytes", () => {
  test("a fresh device gets usable credentials", async () => {
    const { state } = await loadAuthStateForTests(deviceId);
    expect(state.creds.noiseKey.private).toBeInstanceOf(Uint8Array);
    expect(state.creds.registered).toBe(false);
  });

  test("saved credentials reload as Buffers, not as plain objects", async () => {
    // The trap. JSON.stringify turns a Buffer into {type:"Buffer",data:[…]},
    // which Baileys accepts syntactically and then fails on cryptographically,
    // far from here.
    const first = await loadAuthStateForTests(deviceId);
    const original = Buffer.from(first.state.creds.noiseKey.private);
    await first.saveCreds();

    const second = await loadAuthStateForTests(deviceId);
    const reloaded = second.state.creds.noiseKey.private;

    expect(reloaded).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(reloaded).equals(original)).toBe(true);
  });
});

describe("the key store round-trips what Baileys puts in it", () => {
  test("a pre-key comes back as the same key pair", async () => {
    const { state } = await loadAuthStateForTests(deviceId);
    const pair = { private: Buffer.alloc(32, 3), public: Buffer.alloc(32, 4) };

    await state.keys.set({ "pre-key": { "7": pair } } as never);
    const got = (await state.keys.get("pre-key", ["7"]))["7"];

    expect(Buffer.from(got!.private).equals(pair.private)).toBe(true);
    expect(Buffer.from(got!.public).equals(pair.public)).toBe(true);
  });

  test("an app-state-sync-key comes back as the protobuf type", async () => {
    // Baileys' own store special-cases this. A plain object fails during app
    // state sync with an error naming neither this code nor the key.
    const { state } = await loadAuthStateForTests(deviceId);
    await state.keys.set({
      "app-state-sync-key": { k1: { keyData: Buffer.alloc(32, 5), fingerprint: null, timestamp: null } },
    } as never);

    const got = (await state.keys.get("app-state-sync-key", ["k1"]))["k1"];
    expect(got).not.toBeNull();
    // fromObject produces an instance with the protobuf shape rather than the
    // bare object that went in.
    expect(typeof (got as { toJSON?: unknown }).toJSON).toBe("function");
  });

  test("setting null deletes, so a consumed pre-key does not linger", async () => {
    const { state } = await loadAuthStateForTests(deviceId);
    await state.keys.set({ "pre-key": { "7": { private: Buffer.alloc(32), public: Buffer.alloc(32) } } } as never);
    expect(await AuthStateStore.keyCount(deviceId, database)).toBe(1);

    await state.keys.set({ "pre-key": { "7": null } } as never);
    expect(await AuthStateStore.keyCount(deviceId, database)).toBe(0);
  });

  test("clear forgets the device entirely", async () => {
    const { state, saveCreds } = await loadAuthStateForTests(deviceId);
    await saveCreds();
    await state.keys.set({ "pre-key": { "1": { private: Buffer.alloc(32), public: Buffer.alloc(32) } } } as never);

    await state.keys.clear!();

    expect(await AuthStateStore.loadCreds(deviceId, database)).toBeNull();
    expect(await AuthStateStore.keyCount(deviceId, database)).toBe(0);
  });
});

describe("nothing is written to disk any more", () => {
  test("no credential files appear beside the database", async () => {
    // The file store wrote creds.json plus one file per key, including
    // session-<msisdn>@s.whatsapp.net.json. This asserts that path is gone
    // rather than merely unused.
    const { state, saveCreds } = await loadAuthStateForTests(deviceId);
    await saveCreds();
    await state.keys.set({
      session: { "628123456789@s.whatsapp.net": Buffer.alloc(64, 1) },
    } as never);

    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".json"))).toEqual([]);
    expect(files.some((f) => f.includes("628123456789"))).toBe(false);
    expect(existsSync(join(dir, "creds.json"))).toBe(false);
  });
});
