/**
 * The claim flow end to end over HTTP, with a fake engine.
 *
 * The store tests prove the decision logic; these prove an integrator can
 * actually reach it, and that the three outcomes are distinguishable from the
 * outside — because the caller's next action differs completely between them.
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
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let app: ReturnType<typeof createApp>;
let grandeProdKey: string;
let grandeStagingKey: string;
let rivalKey: string;

const NUMBER = "+628123456789";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-claim-http-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");

  const database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const mint = async (projectSlug: string, envSlug: string): Promise<string> => {
    const project =
      (await ProjectStore.findBySlug(projectSlug, database)) ??
      (await ProjectStore.create({ slug: projectSlug, displayName: projectSlug }, database));
    const environment = await EnvironmentStore.create({ projectId: project.id, slug: envSlug }, database);
    const { plaintext } = await ApiKeyStore.create(
      { projectId: project.id, environmentId: environment.id, label: "k", scopes: ["manage:devices"] },
      database,
    );
    return plaintext;
  };

  grandeProdKey = await mint("grande", "production");
  grandeStagingKey = await mint("grande", "staging");
  rivalKey = await mint("rival", "production");

  const registry = new EngineRegistry();
  registry.register({ id: "fake-1", kind: "fake", capacity: 25, engine: new FakeEngine() });
  app = createApp(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const claim = (key: string, alias: string, msisdn = NUMBER) =>
  app.handle(
    new Request("http://localhost/v1/devices/claim", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ msisdn, alias }),
    }),
  );

describe("POST /v1/devices/claim", () => {
  test("a new number returns a QR to scan", async () => {
    const res = await claim(grandeProdKey, "otp-sender");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: string; pairing?: { qr?: string } };
    expect(body.outcome).toBe("pending_pairing");
    expect(body.pairing?.qr).toBeString();
  });

  test("a database fault is not reported as a capacity problem", async () => {
    // countByPool() used to sit inside the same try as choosePool, so a
    // database failure was caught by the handler meaning "no pool has room"
    // and answered with 503 plus Retry-After — telling the caller to retry a
    // fault that retrying cannot fix, and hiding the real error entirely.
    const real = DeviceStore.countByPool;
    (DeviceStore as { countByPool: typeof DeviceStore.countByPool }).countByPool = () => {
      throw new Error("database is on fire");
    };
    try {
      const res = await claim(grandeProdKey, "otp-sender");
      expect(res.status, "a database fault was reported as 503 capacity").not.toBe(503);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      (DeviceStore as { countByPool: typeof DeviceStore.countByPool }).countByPool = real;
    }
  });

  test("the same project's second environment is active immediately", async () => {
    // The product, over HTTP: no QR, no message to the customer, 200 not 201.
    await claim(grandeProdKey, "otp-sender");
    const res = await claim(grandeStagingKey, "otp-sender");
    expect(res.status).toBe(200);
    expect((await res.json() as { outcome: string }).outcome).toBe("active");
  });

  test("a different project is told the phone holder was asked", async () => {
    await claim(grandeProdKey, "otp-sender");
    const res = await claim(rivalKey, "theirs");
    // 202, not 201: the device already exists and nothing happens until a
    // human replies, which docs/06 distinguishes deliberately.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { outcome: string; message?: string };
    expect(body.outcome).toBe("awaiting_confirmation");
    expect(body.message).toContain("confirm");
  });

  test("the challenge token is never returned to the project", async () => {
    // It is the phone holder's to present. Returning it would let the project
    // confirm on their behalf, which is the whole thing consent prevents.
    await claim(grandeProdKey, "otp-sender");
    const text = await (await claim(rivalKey, "theirs")).text();
    const device = await DeviceStore.findByMsisdn(NUMBER);
    const rivalProject = await ProjectStore.findBySlug("rival");
    const consent = await DeviceStore.consentFor(device!.id, rivalProject!.id);
    expect(text).not.toContain(consent!.challengeToken);
  });

  test("the global device id is never exposed", async () => {
    // Two tenants sharing a phone must not be able to correlate through a
    // shared identifier.
    await claim(grandeProdKey, "otp-sender");
    const device = await DeviceStore.findByMsisdn(NUMBER);
    const text = await (await claim(rivalKey, "theirs")).text();
    expect(text).not.toContain(device!.id);
  });

  test("a key without manage:devices is refused", async () => {
    const database = createDatabase(join(dir, "t.sqlite"));
    const project = await ProjectStore.findBySlug("grande", database);
    const [environment] = await EnvironmentStore.listForProject(project!.id, database);
    const { plaintext } = await ApiKeyStore.create(
      { projectId: project!.id, environmentId: environment!.id, label: "ro", scopes: [] },
      database,
    );
    expect((await claim(plaintext, "nope")).status).toBe(403);
  });

  test("an unauthenticated claim is refused", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/devices/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msisdn: NUMBER, alias: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a malformed number is rejected before anything is provisioned", async () => {
    const res = await claim(grandeProdKey, "x", "not-a-number");
    expect(res.status).toBe(422);
    expect(await DeviceStore.findByMsisdn("not-a-number")).toBeNull();
  });
});

describe("GET /v1/devices", () => {
  test("lists this environment's bindings only", async () => {
    await claim(grandeProdKey, "otp-sender");
    await claim(rivalKey, "theirs");

    const res = await app.handle(
      new Request("http://localhost/v1/devices", { headers: { "x-api-key": grandeProdKey } }),
    );
    const body = (await res.json()) as Array<{ alias: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.alias).toBe("otp-sender");
  });
});
