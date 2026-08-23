/**
 * Engine events reaching the control plane.
 *
 * This is the last link in the chain the project is named for: gowa forwards no
 * lifecycle event, the adapter manufactures one from polling, and this is what
 * turns it into a row change and a tenant's webhook.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { deliveries, devices, environmentWebhooks, virtualDevices } from "../../db/schema";
import { handleEngineEvent } from "../consumer";
import { DeviceStore } from "../../stores/device-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { resetConfig } from "../../config/env";

let dir: string;
let database: Database;
let deviceId: string;
let environmentId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-consumer-"));
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  environmentId = environment.id;
  await database.insert(environmentWebhooks).values({
    environmentId,
    url: "https://hooks.example.com/wa",
    secret: "0123456789abcdef",
  });

  const claimed = await DeviceStore.claim(
    { environmentId, msisdn: "+628123456789", alias: "otp-sender" },
    database,
  );
  deviceId = claimed.device.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

describe("device.connected", () => {
  test("activates a binding that was waiting on the scan", async () => {
    expect((await database.select().from(virtualDevices))[0]!.status).toBe("pending_pairing");

    await handleEngineEvent(
      { type: "device.connected", deviceId, jid: "628@s.whatsapp.net", pushName: "Test" },
      database,
    );

    const [binding] = await database.select().from(virtualDevices);
    expect(binding!.status).toBe("active");
    const [device] = await database.select().from(devices);
    expect(device!.state).toBe("connected");
    expect(device!.jid).toBe("628@s.whatsapp.net");
  });

  test("does not activate a binding waiting on a person", async () => {
    // pending_consent is waiting on the phone holder, not a socket. Activating
    // it here would grant a project access nobody agreed to.
    await database.update(virtualDevices).set({ status: "pending_consent" }).where(eq(virtualDevices.deviceId, deviceId));
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    expect((await database.select().from(virtualDevices))[0]!.status).toBe("pending_consent");
  });
});

describe("device.logged_out", () => {
  test("is queued for every active binding — the event gowa never sends", async () => {
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    await handleEngineEvent({ type: "device.logged_out", deviceId, reason: "remote_logout" }, database);

    const queued = await database.select().from(deliveries);
    expect(queued.some((d) => d.eventType === "device.logged_out")).toBe(true);

    // Keep-slot: the row survives so re-pairing needs no new consent.
    const [device] = await database.select().from(devices);
    expect(device!.state).toBe("logged_out");
    expect(device!.jid).toBeNull();
  });

  test("the global device id is never in the delivered payload", async () => {
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    await handleEngineEvent({ type: "device.logged_out", deviceId, reason: "remote_logout" }, database);

    const queued = await database.select().from(deliveries);
    // Two tenants sharing a phone must not be able to correlate through it.
    expect(JSON.stringify(queued)).not.toContain(deviceId);
  });
});

describe("fan-out", () => {
  test("an inactive binding receives nothing", async () => {
    // Still pending_pairing: no delivery should be queued at all.
    await handleEngineEvent({ type: "device.disconnected", deviceId, reason: "x", willRetry: true }, database);
    expect(await database.select().from(deliveries)).toHaveLength(0);
  });
});
