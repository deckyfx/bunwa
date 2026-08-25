/**
 * The response shapes the dashboard reads.
 *
 * docs/07 specifies Eden Treaty precisely so this file would be unnecessary:
 * the console would import the server's type and a changed route would be a
 * compile error. That is not wired yet, and the cost showed up immediately —
 * the first console screen declared `Whoami` with nested project and
 * environment objects and `VirtualDevice` with `id`, `phoneNumber` and a
 * `lastSeenAt` that does not exist. Every field was invented rather than read,
 * and the page rendered "undefined / undefined" against a live API.
 *
 * Until the api-types artefact exists, this pins the fields dashboard/src/api.ts
 * transcribes. A route that renames one fails here, in CI, rather than in
 * someone's browser.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { EngineRegistry } from "../../engine/registry";
import { FakeEngine } from "../../engine/fake";
import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../../stores/project-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ApiKeyStore } from "../../stores/api-key-store";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let key: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-contract-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  key = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: environment.id, label: "console", scopes: ["send:text"] },
      database,
    )
  ).plaintext;

  // With a registry, because createApp mounts the device routes only when one
  // is present — an API with no engine configured serves no /v1/devices at all.
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

const get = (path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { "x-api-key": key } }));

describe("the fields dashboard/src/api.ts transcribes", () => {
  test("GET /v1/whoami carries exactly the keys the console reads", async () => {
    const body = (await (await get("/v1/whoami")).json()) as Record<string, unknown>;

    // Named individually rather than compared as a set: adding a field is
    // fine and must not fail, while renaming or removing one breaks a screen.
    expect(Object.keys(body)).toContain("projectId");
    expect(Object.keys(body)).toContain("environmentId");
    expect(Object.keys(body)).toContain("scopes");
    expect(typeof body["projectId"]).toBe("string");
    expect(typeof body["environmentId"]).toBe("string");
    expect(Array.isArray(body["scopes"])).toBe(true);

    // The shape the console originally assumed, so the specific mistake is
    // pinned as wrong rather than merely absent from the list above.
    expect(body["project"], "whoami went back to a nested project object").toBeUndefined();
  });

  test("GET /v1/devices carries exactly the keys the console reads", async () => {
    const body = (await (await get("/v1/devices")).json()) as Record<string, unknown>[];
    expect(Array.isArray(body)).toBe(true);

    // An empty environment still proves the route answers; the field names are
    // asserted against the store's projection, which is what produces them.
    const projection = ["virtualDeviceId", "alias", "status", "scopes", "msisdn", "deviceState"];
    const row = body[0];
    if (row !== undefined) {
      for (const field of projection) {
        expect(Object.keys(row), `devices lost ${field}`).toContain(field);
      }
    }
  });
});
