/**
 * Rules over HTTP, end to end.
 *
 * Two properties carry the weight: a project cannot reach another tenant's
 * rules, and the dry run cannot send anything.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ApiKeyStore } from "../../stores/api-key-store";
import { DeviceStore } from "../../stores/device-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { handleEngineEvent } from "../../engine/consumer";
import { resetConfig } from "../../config/env";

let dir: string;
let app: ReturnType<typeof createApp>;
let key: string;
let rivalKey: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-rules-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");

  const database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const mint = async (slug: string, msisdn: string): Promise<string> => {
    const project = await ProjectStore.create({ slug, displayName: slug }, database);
    const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
    const claimed = await DeviceStore.claim(
      { environmentId: environment.id, msisdn, alias: "otp-sender" },
      database,
    );
    await handleEngineEvent(
      { type: "device.connected", deviceId: claimed.device.id, jid: `${msisdn}@s.whatsapp.net`, pushName: null },
      database,
    );
    const minted = await ApiKeyStore.create(
      {
        projectId: project.id,
        environmentId: environment.id,
        label: "k",
        scopes: ["manage:rules"],
      },
      database,
    );
    return minted.plaintext;
  };

  key = await mint("grande", "+628123456789");
  rivalKey = await mint("rival", "+628999888777");
  app = createApp();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

const rule = {
  name: "payments",
  match: {
    all: [
      { field: "type", op: "eq", value: "message.received" },
      { field: "data.text", op: "matches", value: "^PAY\\s+(?<ref>[A-Z0-9]{6,})$" },
    ],
  },
  actions: [{ type: "reply", template: "Received {{ match.ref }}" }],
};

const post = (path: string, body: unknown, apiKey = key) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("rule management", () => {
  test("creates a rule and lists it", async () => {
    expect((await post("/v1/devices/otp-sender/rules", rule)).status).toBe(201);
    const res = await app.handle(
      new Request("http://localhost/v1/devices/otp-sender/rules", { headers: { "x-api-key": key } }),
    );
    expect((await res.json() as unknown[])).toHaveLength(1);
  });

  test("refuses an unsafe pattern at save time", async () => {
    // On the inbound path the only options are to drop a customer's message or
    // to hang, so this must fail while a human is watching.
    const unsafe = { ...rule, name: "unsafe", match: { all: [{ field: "data.text", op: "matches", value: "(a+)+$" }] } };
    const res = await post("/v1/devices/otp-sender/rules", unsafe);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("exponential");
  });

  test("refuses a duplicate name for the same device", async () => {
    await post("/v1/devices/otp-sender/rules", rule);
    expect((await post("/v1/devices/otp-sender/rules", rule)).status).toBe(409);
  });

  test("a key without manage:rules cannot write", async () => {
    const database = createDatabase(join(dir, "t.sqlite"));
    const project = await ProjectStore.findBySlug("grande", database);
    const [environment] = await EnvironmentStore.listForProject(project!.id, database);
    const readOnly = (
      await ApiKeyStore.create(
        { projectId: project!.id, environmentId: environment!.id, label: "ro", scopes: [] },
        database,
      )
    ).plaintext;
    expect((await post("/v1/devices/otp-sender/rules", rule, readOnly)).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  test("another project cannot see or address these rules", async () => {
    await post("/v1/devices/otp-sender/rules", rule);

    // Same alias, different environment: must resolve to rival's own binding,
    // which has no rules — not to grande's.
    const res = await app.handle(
      new Request("http://localhost/v1/devices/otp-sender/rules", { headers: { "x-api-key": rivalKey } }),
    );
    expect(await res.json()).toEqual([]);
  });
});

describe("the dry run", () => {
  test("reports a match and its captures without sending anything", async () => {
    const created = (await (await post("/v1/devices/otp-sender/rules", rule)).json()) as { id: string };

    const res = await post(`/v1/devices/otp-sender/rules/${created.id}/test`, {
      event: { type: "message.received", data: { text: "PAY AB1234" } },
    });
    const body = (await res.json()) as {
      matched: boolean;
      captures: Record<string, string>;
      actionsPlanned: unknown[];
      actionsExecuted: unknown[];
    };

    expect(body.matched).toBe(true);
    expect(body.captures["ref"]).toBe("AB1234");
    expect(body.actionsPlanned).toHaveLength(1);
    // Always empty, and there is no code path that could populate it: the
    // evaluator cannot send, write or reach an engine.
    expect(body.actionsExecuted).toEqual([]);
  });

  test("reports a non-match without pretending otherwise", async () => {
    const created = (await (await post("/v1/devices/otp-sender/rules", rule)).json()) as { id: string };
    const res = await post(`/v1/devices/otp-sender/rules/${created.id}/test`, {
      event: { type: "message.received", data: { text: "hello" } },
    });
    expect((await res.json() as { matched: boolean }).matched).toBe(false);
  });

  test("another project cannot dry-run these rules", async () => {
    const created = (await (await post("/v1/devices/otp-sender/rules", rule)).json()) as { id: string };
    const res = await post(
      `/v1/devices/otp-sender/rules/${created.id}/test`,
      { event: { type: "message.received", data: { text: "PAY AB1234" } } },
      rivalKey,
    );
    expect(res.status).toBe(404);
  });
});
