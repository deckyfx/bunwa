/**
 * The stage 1 exit criteria, executed.
 *
 * docs/08 lists seven conditions for calling stage 1 finished. Five can be
 * proven here against the fake engine; two need real infrastructure and are
 * marked as such rather than quietly counted as passing — the conformance
 * suite already showed how easy it is to record a skip as a success.
 *
 * This file is deliberately written from the roadmap rather than from the
 * implementation. Every earlier test asked "does the code do what I wrote?";
 * this one asks "does the system do what was promised?", which is a different
 * question and has caught different bugs.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createApp } from "../api/server";
import { createDatabase, resetDatabase, type Database } from "../db";
import { deliveries, deviceConsents } from "../db/schema";
import { MigrationManager } from "../db/migration-manager";
import { handleEngineEvent } from "../engine/consumer";
import { FakeEngine } from "../engine/fake";
import { EngineRegistry } from "../engine/registry";
import { ApiKeyStore } from "../stores/api-key-store";
import { DeviceStore } from "../stores/device-store";
import { EnvironmentStore } from "../stores/environment-store";
import { ProjectStore } from "../stores/project-store";
import { WebhookStore } from "../stores/webhook-store";
import { resetConfig } from "../config/env";

const NUMBER = "+628123456789";

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let engine: FakeEngine;

/** A project with one environment, its own webhook, and a key. */
async function tenant(slug: string, envSlug: string, webhook: string) {
  const project = await ProjectStore.create({ slug, displayName: slug }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: envSlug }, database);
  await WebhookStore.upsert(
    project.id,
    environment.id,
    { url: webhook, secret: "a-sufficiently-long-secret" },
    database,
  );
  const { plaintext } = await ApiKeyStore.create(
    {
      projectId: project.id,
      environmentId: environment.id,
      label: "backend",
      scopes: ["manage:devices", "manage:rules", "send:text", "send:media"],
    },
    database,
  );
  return { projectId: project.id, environmentId: environment.id, key: plaintext };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-exit-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");

  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  engine = new FakeEngine();
  const registry = new EngineRegistry();
  registry.register({ id: "pool-1", kind: "fake", capacity: 25, engine });
  app = createApp(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

/**
 * Complete a pairing the way production does.
 *
 * The fake engine's completePairing only moves the engine. A binding becomes
 * active when the *consumer* processes device.connected — the engine owns
 * sockets, the control plane owns bindings, and nothing crosses that line
 * except through an event.
 */
async function pair(deviceId: string): Promise<void> {
  engine.completePairing(deviceId, "628123456789@s.whatsapp.net");
  await handleEngineEvent(
    { type: "device.connected", deviceId, jid: "628123456789@s.whatsapp.net", pushName: null },
    database,
  );
}

const claim = (key: string, alias: string) =>
  app.handle(
    new Request("http://localhost/v1/devices/claim", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ msisdn: NUMBER, alias }),
    }),
  );

describe("criterion 1 — one device, two projects, neither sees the other", () => {
  test("each project gets its own binding, webhook and rules", async () => {
    const grande = await tenant("grande", "production", "https://grande.example.com/hook");
    const rival = await tenant("rival", "production", "https://rival.example.com/hook");

    await claim(grande.key, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await pair(device!.id);

    // Rival must ask; granting it does not disturb grande.
    await claim(rival.key, "theirs");
    const consent = await DeviceStore.consentFor(device!.id, rival.projectId, database);
    await DeviceStore.respondToConsent(consent!.challengeToken, "granted", "whatsapp_reply", {}, database);

    // One inbound message, two independent deliveries.
    await handleEngineEvent(
      {
        type: "message.received",
        deviceId: device!.id,
        message: {
          id: "m1", from: "628999@s.whatsapp.net", fromLid: null, chatId: "628999@s.whatsapp.net",
          chatLid: null, pushName: "Someone", isFromMe: false, timestamp: new Date(),
          body: "hello", media: null,
        },
      },
      database,
    );

    // Filtered to the message: device.connected also fans out, correctly, and
    // asserting on the total would make this test fail whenever an unrelated
    // lifecycle event is added.
    const queued = (await database.select().from(deliveries)).filter((d) => d.eventType === "message.received");
    expect(new Set(queued.map((d) => d.environmentId))).toEqual(
      new Set([grande.environmentId, rival.environmentId]),
    );
    expect(queued).toHaveLength(2);

    // Neither can read the other's binding by alias.
    const crossRead = await app.handle(
      new Request("http://localhost/v1/devices/theirs", { headers: { "x-api-key": grande.key } }),
    );
    expect(crossRead.status).toBe(404);
  });
});

describe("criterion 2 — a second project asks, and a reply activates it", () => {
  test("no re-scan is required", async () => {
    const grande = await tenant("grande", "production", "https://grande.example.com/hook");
    const rival = await tenant("rival", "production", "https://rival.example.com/hook");

    await claim(grande.key, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await pair(device!.id);

    const response = await claim(rival.key, "theirs");
    // 202, not 201: the device exists and nothing happens until a human replies.
    expect(response.status).toBe(202);
    // `outcome` is the decision; `status` is the binding's own state.
    expect((await response.json() as { outcome: string }).outcome).toBe("awaiting_confirmation");

    const consent = await DeviceStore.consentFor(device!.id, rival.projectId, database);
    await DeviceStore.respondToConsent(consent!.challengeToken, "granted", "whatsapp_reply", {}, database);

    // Active without the customer touching their phone again.
    const binding = await app.handle(
      new Request("http://localhost/v1/devices/theirs", { headers: { "x-api-key": rival.key } }),
    );
    expect(binding.status).toBe(200);
    expect((await binding.json() as { status: string }).status).toBe("active");
  });
});

describe("criterion 3 — a sibling environment activates immediately", () => {
  test("nothing is asked of the customer", async () => {
    const grande = await tenant("grande", "production", "https://grande.example.com/hook");
    await claim(grande.key, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await pair(device!.id);

    // Same project, different environment. Consent is per (device, project).
    const staging = await EnvironmentStore.create({ projectId: grande.projectId, slug: "staging" }, database);
    const { plaintext } = await ApiKeyStore.create(
      { projectId: grande.projectId, environmentId: staging.id, label: "k", scopes: ["manage:devices"] },
      database,
    );

    const response = await claim(plaintext, "staging-sender");
    expect((await response.json() as { status: string }).status).toBe("active");

    // Exactly one consent row for the project, and no new challenge.
    const consents = await database
      .select()
      .from(deviceConsents)
      .where(eq(deviceConsents.deviceId, device!.id));
    expect(consents).toHaveLength(1);
    expect(consents[0]!.status).toBe("granted");
  });
});

describe("criterion 4 — a logout reaches every bound environment", () => {
  test("the event gowa never delivers", async () => {
    const grande = await tenant("grande", "production", "https://grande.example.com/hook");
    const rival = await tenant("rival", "production", "https://rival.example.com/hook");

    await claim(grande.key, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await pair(device!.id);
    await claim(rival.key, "theirs");
    const consent = await DeviceStore.consentFor(device!.id, rival.projectId, database);
    await DeviceStore.respondToConsent(consent!.challengeToken, "granted", "whatsapp_reply", {}, database);

    await handleEngineEvent({ type: "device.logged_out", deviceId: device!.id, reason: "remote_logout" }, database);

    const logouts = (await database.select().from(deliveries)).filter((d) => d.eventType === "device.logged_out");
    expect(new Set(logouts.map((d) => d.environmentId))).toEqual(
      new Set([grande.environmentId, rival.environmentId]),
    );
    // Queued immediately, so the 5-second budget is the delivery worker's.
    for (const row of logouts) expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("criterion 5 — an OTP send is idempotent under retry", () => {
  test("a retry returns the original message rather than sending twice", async () => {
    const grande = await tenant("grande", "production", "https://grande.example.com/hook");
    await claim(grande.key, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER, database);
    await pair(device!.id);

    const idem = crypto.randomUUID();
    const body = JSON.stringify({ type: "text", to: "+628999888777", text: "Your code is 448126" });
    const send = () =>
      app.handle(
        new Request("http://localhost/v1/devices/otp-sender/messages", {
          method: "POST",
          headers: { "x-api-key": grande.key, "content-type": "application/json", "idempotency-key": idem },
          body,
        }),
      );

    const began = performance.now();
    const first = (await (await send()).json()) as { messageId: string };
    const elapsed = performance.now() - began;

    const second = await send();
    expect(((await second.json()) as { messageId: string }).messageId).toBe(first.messageId);
    expect(second.headers.get("idempotent-replay")).toBe("true");

    // The 2s budget is bunwa's own overhead; the engine here is in-memory.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("criteria 6 and 7 — not provable here", () => {
  test.skip("an incoming call rings the phone and bunwa does nothing", () => {
    // Needs a paired handset and a real call. Verified manually in stage 0
    // against gowa: auto_rejected:false, zero reject attempts (docs/12).
  });

  test.skip("killing the engine degrades only its own devices", () => {
    // Needs the container topology and a supervisor, which is stage 2 work.
  });
});
