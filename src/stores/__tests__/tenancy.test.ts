/**
 * The tenant boundary.
 *
 * With SQLite there is no row-level security behind these stores
 * (docs/adr/0005), so the predicates here are the only thing between one
 * customer's data and another's. These tests exist to fail loudly if one is
 * ever dropped.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ApiKeyStore } from "../api-key-store";
import { EnvironmentStore } from "../environment-store";
import { ProjectStore } from "../project-store";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-tenancy-"));
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  restoreEnv();
});

/** Two tenants, so every isolation assertion has something to cross. */
async function twoTenants() {
  const a = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const b = await ProjectStore.create({ slug: "rival", displayName: "Rival" }, database);
  const envA = await EnvironmentStore.create({ projectId: a.id, slug: "production", kind: "live" }, database);
  const envB = await EnvironmentStore.create({ projectId: b.id, slug: "production", kind: "live" }, database);
  return { a, b, envA, envB };
}

describe("ProjectStore", () => {
  test("rejects a slug that is not URL- and prefix-safe", async () => {
    for (const slug of ["Ab", "has space", "-leading", "trailing-", "a", "wi__th_underscores", "é-accent"]) {
      await expect(ProjectStore.create({ slug, displayName: "x" }, database)).rejects.toThrow(ValidationError);
    }
  });

  test("normalises case and surrounding whitespace, deliberately", async () => {
    // A documented convention, not a silent correction of an error: the slug
    // ends up in every API key for the project (bw_live_<slug>_…), so it has to
    // be lowercase, and rejecting "Grande" would be pedantry rather than safety.
    const project = await ProjectStore.create({ slug: "  Grande  ", displayName: "Grande" }, database);
    expect(project.slug).toBe("grande");
  });

  test("rejects an empty display name — it is shown to the phone holder", async () => {
    await expect(ProjectStore.create({ slug: "valid", displayName: "   " }, database)).rejects.toThrow(ValidationError);
  });

  test("rejects a duplicate slug", async () => {
    await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
    await expect(ProjectStore.create({ slug: "grande", displayName: "Other" }, database)).rejects.toThrow(ConflictError);
  });
});

describe("EnvironmentStore isolation", () => {
  test("will not return another project's environment", async () => {
    const { a, envB } = await twoTenants();
    // Project A knows B's environment id — from a log, a bug report, anywhere.
    expect(await EnvironmentStore.findById(a.id, envB.id, database)).toBeNull();
    await expect(EnvironmentStore.requireById(a.id, envB.id, database)).rejects.toThrow(NotFoundError);
  });

  test("will not mutate another project's environment", async () => {
    const { a, envB } = await twoTenants();
    await expect(
      EnvironmentStore.setSettings(a.id, envB.id, { pwned: true }, database),
    ).rejects.toThrow(NotFoundError);
    const untouched = await EnvironmentStore.findById((await ProjectStore.findBySlug("rival", database))!.id, envB.id, database);
    expect(untouched!.settings).toEqual({});
  });

  test("allows the same environment slug in different projects", async () => {
    const { envA, envB } = await twoTenants();
    expect(envA.slug).toBe(envB.slug);
    expect(envA.id).not.toBe(envB.id);
  });

  test("a suspended project stops its environments serving", async () => {
    const { a, envA } = await twoTenants();
    expect(await EnvironmentStore.isServable(a.id, envA.id, database)).toBe(true);
    await ProjectStore.setStatus(a.id, "suspended", database);
    // Checking only the environment row would let a suspended tenant keep sending.
    expect(await EnvironmentStore.isServable(a.id, envA.id, database)).toBe(false);
  });

  test("an environment is not servable under another project's id", async () => {
    // The scope is on the statement, so a mismatched pair resolves to nothing
    // rather than to whichever row the id alone happened to find.
    const { b, envA } = await twoTenants();
    expect(await EnvironmentStore.isServable(b.id, envA.id, database)).toBe(false);
  });
});

describe("ApiKeyStore", () => {
  test("mints a key that resolves to its own environment", async () => {
    const { a, envA } = await twoTenants();
    const { plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: ["send:text"] },
      database,
    );
    const resolved = await ApiKeyStore.resolve(plaintext, database);
    expect(resolved).not.toBeNull();
    expect(resolved!.environmentId).toBe(envA.id);
    expect(resolved!.projectId).toBe(a.id);
    expect(resolved!.scopes).toEqual(["send:text"]);
  });

  test("the key is readable and names its environment kind and project", async () => {
    const { a, envA } = await twoTenants();
    const { plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: [] },
      database,
    );
    // A leaked key should be identifiable at a glance, and bw_test_ must not
    // be mistakable for bw_live_ in a hurry.
    expect(plaintext.startsWith("bw_live_grande_")).toBe(true);
  });

  test("never stores the plaintext", async () => {
    const { a, envA } = await twoTenants();
    const { apiKey, plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: [] },
      database,
    );
    expect(apiKey.keyHash).not.toContain(plaintext);
    expect(apiKey.keyHash.startsWith("$argon2id$")).toBe(true);
  });

  test("will not mint a key for another project's environment", async () => {
    const { a, envB } = await twoTenants();
    await expect(
      ApiKeyStore.create({ projectId: a.id, environmentId: envB.id, label: "x", scopes: [] }, database),
    ).rejects.toThrow(NotFoundError);
  });

  test("will not list or revoke another project's keys", async () => {
    const { a, b, envB } = await twoTenants();
    const { apiKey } = await ApiKeyStore.create(
      { projectId: b.id, environmentId: envB.id, label: "theirs", scopes: [] },
      database,
    );
    expect(await ApiKeyStore.listForEnvironment(a.id, envB.id, database)).toHaveLength(0);
    await expect(ApiKeyStore.revoke(a.id, envB.id, apiKey.id, database)).rejects.toThrow(NotFoundError);
  });

  test("a revoked key authenticates nothing", async () => {
    const { a, envA } = await twoTenants();
    const { apiKey, plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: [] },
      database,
    );
    expect(await ApiKeyStore.resolve(plaintext, database)).not.toBeNull();
    await ApiKeyStore.revoke(a.id, envA.id, apiKey.id, database);
    expect(await ApiKeyStore.resolve(plaintext, database)).toBeNull();
  });

  test("an expired key authenticates nothing", async () => {
    const { a, envA } = await twoTenants();
    const { plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: [], expiresAt: new Date(Date.now() - 1000) },
      database,
    );
    expect(await ApiKeyStore.resolve(plaintext, database)).toBeNull();
  });

  test("a suspended project's key authenticates nothing", async () => {
    const { a, envA } = await twoTenants();
    const { plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "backend", scopes: [] },
      database,
    );
    await ProjectStore.setStatus(a.id, "suspended", database);
    expect(await ApiKeyStore.resolve(plaintext, database)).toBeNull();
  });

  test("rejects malformed and unknown keys without distinguishing them", async () => {
    await twoTenants();
    for (const bad of ["", "nonsense", "bw_live_grande_short", "bw_prod_grande_" + "a".repeat(32)]) {
      expect(await ApiKeyStore.resolve(bad, database)).toBeNull();
    }
  });

  test("a key from one environment does not resolve to another", async () => {
    const { a, b, envA, envB } = await twoTenants();
    const { plaintext } = await ApiKeyStore.create(
      { projectId: a.id, environmentId: envA.id, label: "mine", scopes: [] },
      database,
    );
    await ApiKeyStore.create({ projectId: b.id, environmentId: envB.id, label: "theirs", scopes: [] }, database);
    const resolved = await ApiKeyStore.resolve(plaintext, database);
    expect(resolved!.environmentId).toBe(envA.id);
    expect(resolved!.projectId).not.toBe(b.id);
  });
});
