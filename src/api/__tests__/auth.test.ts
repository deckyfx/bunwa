/**
 * The authenticated HTTP boundary.
 *
 * The store tests prove the queries are scoped; these prove the boundary in
 * front of them cannot be talked out of it — no tenant accepted from the
 * request, no distinction between kinds of bad credential.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ApiKeyStore } from "../../stores/api-key-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let key: string;
let ids: { projectId: string; environmentId: string };
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-auth-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");

  const database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);
  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create(
    { projectId: project.id, slug: "production", kind: "live" },
    database,
  );
  const minted = await ApiKeyStore.create(
    { projectId: project.id, environmentId: environment.id, label: "backend", scopes: ["send:text"] },
    database,
  );
  key = minted.plaintext;
  ids = { projectId: project.id, environmentId: environment.id };
  app = createApp();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));

describe("GET /v1/whoami", () => {
  test("resolves the tenant from the key alone", async () => {
    const res = await get("/v1/whoami", { "x-api-key": key });
    expect(res.status).toBe(200);
    // Exact match, not a subset: whoami is the endpoint an integrator hits
    // first, and a field appearing in it silently is a contract change.
    expect(await res.json()).toEqual({
      ...ids,
      projectSlug: "grande",
      projectName: "Grande",
      environmentSlug: "production",
      environmentKind: "live",
      scopes: ["send:text"],
      serverTimezone: "Asia/Jakarta",
    });
  });

  test("rejects a request with no credential", async () => {
    expect((await get("/v1/whoami")).status).toBe(401);
  });

  test("rejects every kind of bad credential identically", async () => {
    // Unknown, malformed, revoked and expired must be indistinguishable, or
    // probing reveals which keys once existed and when they were turned off.
    const database = createDatabase(join(dir, "t.sqlite"));
    const project = await ProjectStore.findBySlug("grande", database);
    const [environment] = await EnvironmentStore.listForProject(project!.id, database);

    const revoked = await ApiKeyStore.create(
      { projectId: project!.id, environmentId: environment!.id, label: "revoked", scopes: [] },
      database,
    );
    await ApiKeyStore.revoke(project!.id, environment!.id, revoked.apiKey.id, database);

    const expired = await ApiKeyStore.create(
      {
        projectId: project!.id,
        environmentId: environment!.id,
        label: "expired",
        scopes: [],
        expiresAt: new Date(Date.now() - 1000),
      },
      database,
    );

    const bodies = new Set<string>();
    for (const bad of [
      "nonsense",
      "bw_live_grande_" + "a".repeat(40),
      "bw_test_other_" + "b".repeat(40),
      revoked.plaintext,
      expired.plaintext,
    ]) {
      const res = await get("/v1/whoami", { "x-api-key": bad });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      delete body["correlationId"];
      bodies.add(JSON.stringify(body));
    }
    expect(bodies.size).toBe(1);
  });

  test("never echoes the presented key", async () => {
    const res = await get("/v1/whoami", { "x-api-key": "bw_live_grande_" + "s3cret".repeat(6) });
    expect(await res.text()).not.toContain("s3cret");
  });
});

describe("the tenant may not be named by the caller", () => {
  for (const header of ["x-project-id", "x-environment-id", "x-tenant-id"]) {
    test(`rejects ${header} outright`, async () => {
      // Ignoring it would be safe; failing loudly means nobody builds on the
      // assumption that it works.
      const res = await get("/v1/whoami", { "x-api-key": key, [header]: "someone-else" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("derived from the API key");
    });
  }
});

describe("admin API", () => {
  test("is not mounted unless explicitly enabled", async () => {
    // It can mint keys and has no authentication yet, so the default must be
    // unreachable rather than relying on a reverse proxy.
    expect((await get("/admin/v1/projects")).status).toBe(404);
  });
});

describe("instance settings are not a tenant's to change", () => {
  /** Mint a key in the same environment with exactly these scopes. */
  const keyWith = async (scopes: string[], label: string): Promise<string> => {
    const database = createDatabase(join(dir, "t.sqlite"));
    const minted = await ApiKeyStore.create(
      { projectId: ids.projectId, environmentId: ids.environmentId, label, scopes },
      database,
    );
    return minted.plaintext;
  };

  const put = (apiKey: string) =>
    app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "seized" }),
      }),
    );

  test("a project key cannot rename the instance for everyone else", async () => {
    // The settings behind this route are one per process: the instance name is
    // what WhatsApp lists *every* project's number under, and the timezone is
    // the one the logs are written in. `manage:devices` is a scope an ordinary
    // tenant is expected to hold — claiming a number needs it — and it used to
    // be enough to do both to every other tenant on the deployment.
    const tenant = await keyWith(["manage:devices", "send:text"], "tenant");
    expect((await put(tenant)).status, "a tenant key changed an instance-wide setting").toBe(403);
  });

  test("reading them needs the same scope", async () => {
    const tenant = await keyWith(["manage:devices"], "tenant-read");
    const response = await app.handle(
      new Request("http://localhost/v1/settings", { headers: { "x-api-key": tenant } }),
    );
    expect(response.status).toBe(403);
  });

  test("a key that holds manage:instance still works", async () => {
    // The guard has to stop a tenant without locking the console out: its own
    // key is minted with the full set.
    const operator = await keyWith(["manage:instance"], "operator");
    expect((await put(operator)).status).toBe(200);
  });
});
