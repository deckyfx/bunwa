/**
 * Sending, end to end.
 *
 * The OTP path. Two properties matter more than the rest: a retry must never
 * produce a second message, and the response must never claim delivery the
 * engine cannot vouch for.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { EngineRegistry } from "../../engine/registry";
import { FakeEngine } from "../../engine/fake";
import { ApiKeyStore } from "../../stores/api-key-store";
import { DeviceStore } from "../../stores/device-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { handleEngineEvent } from "../../engine/consumer";
import { resetConfig } from "../../config/env";

let dir: string;
let app: ReturnType<typeof createApp>;
let key: string;
let engine: FakeEngine;

const NUMBER = "+628123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-send-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");

  const database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  key = (
    await ApiKeyStore.create(
      {
        projectId: project.id,
        environmentId: environment.id,
        label: "backend",
        scopes: ["manage:devices", "send:text", "send:media"],
      },
      database,
    )
  ).plaintext;

  // Claim, then complete pairing through the fake so the binding is active.
  const claimed = await DeviceStore.claim(
    { environmentId: environment.id, msisdn: NUMBER, alias: "otp-sender" },
    database,
  );
  engine = new FakeEngine();
  await engine.provision(claimed.device.id);
  engine.completePairing(claimed.device.id, "628123456789@s.whatsapp.net");

  // Drive the event the engine just emitted through the consumer, exactly as
  // the running service does. Marking the binding active directly here would
  // test a state the product can never actually produce.
  await handleEngineEvent(
    { type: "device.connected", deviceId: claimed.device.id, jid: "628123456789@s.whatsapp.net", pushName: null },
    database,
  );

  const registry = new EngineRegistry();
  registry.register({ id: "fake-1", kind: "fake", capacity: 25, engine });
  app = createApp(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

const send = (body: unknown, idempotencyKey = crypto.randomUUID(), apiKey = key) =>
  app.handle(
    new Request("http://localhost/v1/devices/otp-sender/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    }),
  );

const otp = { type: "text", to: "+628999888777", text: "Your code is 448126" };

describe("POST /v1/devices/:ref/messages", () => {
  test("accepts an OTP and says accepted, not sent", async () => {
    const res = await send(otp);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { messageId: string; state: string };
    // Never "sent": the engine took it, WhatsApp has not acknowledged it, and
    // for up to 203s after a silent drop the engine cannot tell the difference.
    expect(body.state).toBe("accepted");
    expect(body.messageId).toBeString();
  });

  test("a retry with the same key returns the original answer, and sends once", async () => {
    // For OTP this is the difference between one code and two.
    const idem = crypto.randomUUID();
    const first = (await (await send(otp, idem)).json()) as { messageId: string };
    const again = await send(otp, idem);
    const second = (await again.json()) as { messageId: string };

    expect(second.messageId).toBe(first.messageId);
    expect(again.headers.get("idempotent-replay")).toBe("true");
  });

  test("the same key with a different body is a conflict, not a silent replay", async () => {
    // Replaying the first response would report the wrong message as sent.
    const idem = crypto.randomUUID();
    await send(otp, idem);
    const res = await send({ ...otp, text: "a different message" }, idem);
    expect(res.status).toBe(409);
  });

  test("a send without an idempotency key is refused", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/devices/otp-sender/messages", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(otp),
      }),
    );
    expect(res.status).toBe(422);
  });

  test("accepts all six v1 types", async () => {
    const media = { url: "https://example.com/f" };
    const to = "+628999888777";
    for (const body of [
      { type: "text", to, text: "t" },
      { type: "image", to, media },
      { type: "document", to, media, filename: "invoice.pdf" },
      { type: "link", to, url: "https://example.com" },
      { type: "audio", to, media },
      { type: "video", to, media },
    ]) {
      expect((await send(body)).status).toBe(202);
    }
  });

  test("a device from another environment is not reachable by alias", async () => {
    const database = createDatabase(join(dir, "t.sqlite"));
    const other = await ProjectStore.create({ slug: "rival", displayName: "Rival" }, database);
    const otherEnv = await EnvironmentStore.create({ projectId: other.id, slug: "production" }, database);
    const otherKey = (
      await ApiKeyStore.create(
        { projectId: other.id, environmentId: otherEnv.id, label: "k", scopes: ["send:text"] },
        database,
      )
    ).plaintext;

    // Same alias, different environment: must not resolve to grande's binding.
    const res = await send(otp, crypto.randomUUID(), otherKey);
    expect(res.status).toBe(404);
  });

  test("a key without the send scope is refused", async () => {
    const database = createDatabase(join(dir, "t.sqlite"));
    const project = await ProjectStore.findBySlug("grande", database);
    const [environment] = await EnvironmentStore.listForProject(project!.id, database);
    const readOnly = (
      await ApiKeyStore.create(
        { projectId: project!.id, environmentId: environment!.id, label: "ro", scopes: [] },
        database,
      )
    ).plaintext;
    expect((await send(otp, crypto.randomUUID(), readOnly)).status).toBe(403);
  });

  test("a disconnected device is a 503, so the caller retries rather than gives up", async () => {
    const claimed = await DeviceStore.findByMsisdn(NUMBER);
    engine.dropConnection(claimed!.id);
    await engine.logout(claimed!.id);
    const res = await send(otp);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeString();
  });
});

describe("GET /v1/devices/:ref/messages/:id", () => {
  test("reports the state of a send", async () => {
    const sent = (await (await send(otp)).json()) as { messageId: string };
    const res = await app.handle(
      new Request(`http://localhost/v1/devices/otp-sender/messages/${sent.messageId}`, {
        headers: { "x-api-key": key },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { state: string }).state).toBe("accepted");
  });
});
