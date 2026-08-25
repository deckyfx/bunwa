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
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

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
  restoreEnv();
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

describe("the rule subject", () => {
  test("is the shape rules are documented against, not the engine's", async () => {
    // A rule written against `data.text` — exactly as the brief and docs/05
    // describe — matched nothing, because the engine's shape is `message.body`.
    const { toRuleSubject } = await import("../consumer");
    const subject = toRuleSubject(
      {
        type: "message.received",
        deviceId: "d1",
        message: {
          id: "m1",
          from: "628123@s.whatsapp.net",
          fromLid: "999@lid",
          chatId: "628123@s.whatsapp.net",
          chatLid: null,
          pushName: "Someone",
          isFromMe: false,
          timestamp: new Date(),
          body: "PAY AB1234",
          media: null,
        },
      },
      "628999@s.whatsapp.net",
    ) as { device: { jid: string }; data: Record<string, unknown> };

    expect(subject.data["text"]).toBe("PAY AB1234");
    expect(subject.data["from"]).toBe("628123@s.whatsapp.net");
    expect(subject.data["chat_type"]).toBe("direct");
    // The brief matches on which of our numbers received it.
    expect(subject.device.jid).toBe("628999@s.whatsapp.net");
  });

  test("classifies a group chat", async () => {
    const { toRuleSubject } = await import("../consumer");
    const subject = toRuleSubject(
      {
        type: "message.received",
        deviceId: "d1",
        message: {
          id: "m1", from: null, fromLid: null, chatId: "1234@g.us", chatLid: null,
          pushName: null, isFromMe: false, timestamp: new Date(), body: "hi", media: null,
        },
      },
      null,
    ) as { data: Record<string, unknown> };
    expect(subject.data["chat_type"]).toBe("group");
  });
});

describe("pairing credentials", () => {
  test("device.qr is never fanned out to any binding", async () => {
    // The QR is a credential: anyone who sees it can scan and take over the
    // account. Fanning it to active bindings hands it to every *other* project
    // sharing that phone.
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    await handleEngineEvent(
      { type: "device.qr", deviceId, qr: "SECRET-QR-PAYLOAD", expiresAt: new Date(Date.now() + 30_000) },
      database,
    );

    const queued = await database.select().from(deliveries);
    expect(JSON.stringify(queued)).not.toContain("SECRET-QR-PAYLOAD");
    expect(queued.some((d) => d.eventType === "device.qr")).toBe(false);
  });

  test("device.pair_code is withheld too", async () => {
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    await handleEngineEvent(
      { type: "device.pair_code", deviceId, code: "ABCD-1234", expiresAt: new Date(Date.now() + 30_000) },
      database,
    );
    expect(JSON.stringify(await database.select().from(deliveries))).not.toContain("ABCD-1234");
  });

  test("ordinary lifecycle events are still delivered", async () => {
    // The withholding must be specific, not a blanket refusal.
    await handleEngineEvent({ type: "device.connected", deviceId, jid: "628@x", pushName: null }, database);
    await handleEngineEvent({ type: "device.logged_out", deviceId, reason: "remote_logout" }, database);
    const queued = await database.select().from(deliveries);
    expect(queued.some((d) => d.eventType === "device.logged_out")).toBe(true);
  });
});
