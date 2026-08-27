/**
 * Logout and re-pair.
 *
 * Both act on a real engine, so both are ways to disturb a customer's device
 * from an API call. Tenancy and scope are the things worth proving, plus the
 * distinction the endpoints exist to preserve: logging out keeps the slot, so
 * re-pairing needs no fresh consent.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../../stores/project-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ApiKeyStore } from "../../stores/api-key-store";
import { DeviceStore } from "../../stores/device-store";
import { EngineRegistry } from "../../engine/registry";
import { FakeEngine } from "../../engine/fake";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let engine: FakeEngine;
let key: string;
let unscopedKey: string;
let otherKey: string;
let deviceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-devact-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "G" }, database);
  const env = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  const other = await EnvironmentStore.create({ projectId: project.id, slug: "staging" }, database);

  key = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: env.id, label: "console", scopes: ["manage:devices"] },
      database,
    )
  ).plaintext;
  unscopedKey = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: env.id, label: "sender", scopes: ["send:text"] },
      database,
    )
  ).plaintext;
  otherKey = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: other.id, label: "other", scopes: ["manage:devices"] },
      database,
    )
  ).plaintext;

  const claimed = await DeviceStore.claim(
    { environmentId: env.id, msisdn: "+628123456789", alias: "otp" },
    database,
  );
  deviceId = claimed.device.id;

  engine = new FakeEngine();
  const registry = new EngineRegistry();
  registry.register({ id: "fake-1", kind: "fake", capacity: 25, engine });
  await engine.provision(deviceId);
  await DeviceStore.assignPool(deviceId, "fake-1", "fake", deviceId, database);

  app = createApp(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const post = (path: string, withKey = key) =>
  app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "x-api-key": withKey } }));

describe("logging a device out", () => {
  test("the owner can, and the engine is told", async () => {
    // Paired first. provision() leaves loggedIn false, so asserting it is
    // false after the call passed whether or not the endpoint did anything —
    // the test could not fail.
    engine.completePairing(deviceId, "628123456789@s.whatsapp.net", "Test");
    expect((await engine.status(deviceId)).loggedIn).toBe(true);

    expect((await post("/v1/devices/otp/logout")).status).toBe(204);
    expect((await engine.status(deviceId)).loggedIn).toBe(false);
  });

  test("another environment cannot", async () => {
    expect((await post("/v1/devices/otp/logout", otherKey)).status).toBe(404);
  });

  test("a key without manage:devices cannot", async () => {
    expect((await post("/v1/devices/otp/logout", unscopedKey)).status).toBe(403);
  });

  test("an unknown device is 404, not a crash", async () => {
    expect((await post("/v1/devices/nope/logout")).status).toBe(404);
  });
});

describe("re-pairing an existing device", () => {
  test("returns a fresh pairing session", async () => {
    const res = await post("/v1/devices/otp/repair");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairing: { method: string; qr?: string } };
    expect(body.pairing.method).toBe("qr");
    expect(body.pairing.qr).toBeString();
  });

  test("another environment cannot", async () => {
    expect((await post("/v1/devices/otp/repair", otherKey)).status).toBe(404);
  });

  test("a key without manage:devices cannot", async () => {
    expect((await post("/v1/devices/otp/repair", unscopedKey)).status).toBe(403);
  });

  test("it is rate limited like a claim", async () => {
    // Each attempt can put a QR in front of a person; an unbounded loop is how
    // a device gets hammered.
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      refused = (await post("/v1/devices/otp/repair")).status === 429;
    }
    expect(refused, "re-pair was not rate limited").toBe(true);
  });
});
