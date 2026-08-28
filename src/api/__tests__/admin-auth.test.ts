/**
 * Who may reach the admin API.
 *
 * This surface creates tenants and mints credentials for them, and it was
 * protected by nothing: an environment flag decided whether it existed, and
 * once it existed `POST /admin/v1/projects` with no headers answered 201. The
 * only test it had asserted it was absent when the flag was off, which is a
 * true statement about the case that was never the risk.
 *
 * Every route is checked, not just one. A guard applied per handler is a guard
 * that gets forgotten on the next route added, and the routes here mint
 * credentials.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { ApiKeyStore } from "../../stores/api-key-store";
import { ALL_SCOPES } from "../../auth/scopes";
import { ensureBootstrap } from "../../ops/bootstrap";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "ADMIN_API_ENABLED"]);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let projectId: string;
let environmentId: string;

/** Mint a key in the bootstrap environment with exactly these scopes. */
const keyWith = async (scopes: string[], label: string): Promise<string> => {
  const { plaintext } = await ApiKeyStore.create({ projectId, environmentId, label, scopes }, database);
  return plaintext;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-admin-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  Bun.env["ADMIN_API_ENABLED"] = "true";
  resetConfig();

  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const state = await ensureBootstrap(database);
  projectId = state.projectId!;
  environmentId = state.environmentId!;

  app = createApp();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetDatabase();
});

/** Every route on the surface, so a new one cannot quietly go unguarded. */
const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/admin/v1/projects" },
  { method: "POST", path: "/admin/v1/projects", body: { slug: "acme", displayName: "Acme" } },
  { method: "GET", path: "/admin/v1/projects/some-id" },
  { method: "GET", path: "/admin/v1/projects/some-id/environments" },
  {
    method: "POST",
    path: "/admin/v1/projects/some-id/environments",
    body: { slug: "production" },
  },
  { method: "GET", path: "/admin/v1/projects/some-id/environments/some-env/api-keys" },
];

const call = (route: { method: string; path: string; body?: unknown }, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost${route.path}`, {
      method: route.method,
      headers: { "content-type": "application/json", ...headers },
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    }),
  );

describe("with no credential", () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} is refused`, async () => {
      const res = await call(route);
      expect(res.status, "an unauthenticated caller must never reach this surface").toBe(401);
    });
  }

  test("nothing was created by the attempt", async () => {
    // The assertion that matters: a 401 that still wrote a row would be worse
    // than no check at all, because the log would say it was refused.
    await call({ method: "POST", path: "/admin/v1/projects", body: { slug: "ghost", displayName: "Ghost" } });

    const admin = await keyWith([...ALL_SCOPES], "admin");
    const listed = (await (
      await call({ method: "GET", path: "/admin/v1/projects" }, { "x-api-key": admin })
    ).json()) as Array<{ slug: string }>;

    expect(listed.some((p) => p.slug === "ghost")).toBe(false);
  });
});

describe("with an ordinary project key", () => {
  for (const route of ROUTES) {
    test(`${route.method} ${route.path} is refused`, async () => {
      // Every scope a project legitimately holds, and still not this one.
      const key = await keyWith(
        ["send:text", "send:media", "receive:messages", "manage:devices", "manage:webhook", "manage:rules"],
        "tenant",
      );

      const res = await call(route, { "x-api-key": key });
      expect(res.status, "a tenant must not be able to see or create other tenants").toBe(403);
    });
  }
});

describe("with manage:projects", () => {
  test("the surface works", async () => {
    const admin = await keyWith(["manage:projects"], "operator");

    const res = await call(
      { method: "POST", path: "/admin/v1/projects", body: { slug: "acme", displayName: "Acme" } },
      { "x-api-key": admin },
    );

    expect(res.status).toBe(201);
  });

  test("the key minted by setup has it", async () => {
    // Otherwise the operator's own credential cannot reach the surface it
    // exists to use, which is how a scope addition becomes a lockout.
    expect(ALL_SCOPES).toContain("manage:projects");
  });
});

describe("the flag", () => {
  test("still removes the surface entirely", async () => {
    // A flag is a deployment decision and a credential check is a different
    // thing; adding one must not have quietly retired the other.
    Bun.env["ADMIN_API_ENABLED"] = "false";
    resetConfig();
    const disabled = createApp();

    const admin = await keyWith([...ALL_SCOPES], "admin");
    const res = await disabled.handle(
      new Request("http://localhost/admin/v1/projects", { headers: { "x-api-key": admin } }),
    );

    expect(res.status).toBe(404);
  });
});
