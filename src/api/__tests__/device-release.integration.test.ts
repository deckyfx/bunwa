/**
 * Letting go of a number, at both levels.
 *
 * One button, two outcomes, and which one you get depends on something the
 * operator pressing it cannot see: whether another project is still using the
 * same phone. Getting this wrong in either direction is expensive — unlink a
 * number two other tenants depend on, or leave the credentials to a WhatsApp
 * account nobody is using sitting in the database.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { ApiKeyStore } from "../../stores/api-key-store";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { deviceConsents, deviceCredentials, devices, environments, virtualDevices } from "../../db/schema";
import { createApp } from "../server";
import { createDatabase, resetDatabase, type Database } from "../../db";
import { DeviceStore } from "../../stores/device-store";
import { EngineRegistry } from "../../engine/registry";
import { EnvironmentStore } from "../../stores/environment-store";
import { FakeEngine } from "../../engine/fake";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../../stores/project-store";
import { resetConfig } from "../../config/env";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let engine: FakeEngine;
let deviceId: string;
let keyA: string;
let keyB: string;
let adminKey: string;

/** Bind an existing device to a second project, as a shared number would be. */
const bindSecondProject = async (msisdn: string) => {
  const project = await ProjectStore.create({ slug: "beta", displayName: "Beta" }, database);
  const env = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  await DeviceStore.claim({ environmentId: env.id, msisdn, alias: "shared" }, database);
  const key = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: env.id, label: "beta", scopes: ["manage:devices"] },
      database,
    )
  ).plaintext;
  return key;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-release-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  Bun.env["ADMIN_API_ENABLED"] = "true";
  Bun.env["CREDENTIAL_ENCRYPTION_KEY"] = "a".repeat(64);
  resetConfig();

  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "alpha", displayName: "Alpha" }, database);
  const env = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  keyA = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: env.id, label: "alpha", scopes: ["manage:devices"] },
      database,
    )
  ).plaintext;
  adminKey = (
    await ApiKeyStore.createAdmin({ label: "operator", scopes: ["manage:projects"] }, database)
  ).plaintext;

  const claimed = await DeviceStore.claim(
    { environmentId: env.id, msisdn: "+628123456789", alias: "otp" },
    database,
  );
  deviceId = claimed.device.id;

  engine = new FakeEngine();
  const registry = new EngineRegistry();
  registry.register({ id: "fake-1", kind: "fake", capacity: 25, engine });
  await engine.provision(deviceId);
  await DeviceStore.assignPool(deviceId, "fake-1", "fake", deviceId, database);

  app = createApp(registry);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetDatabase();
});

/** The project holding the device in the default fixture. */
const soleHolder = async () => {
  const [row] = await database
    .select({ projectId: environments.projectId })
    .from(virtualDevices)
    .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
    .where(and(eq(virtualDevices.deviceId, deviceId), eq(virtualDevices.alias, "otp")));
  return row!.projectId;
};

/** Release by the alias that project knows the device under, not a shared one. */
const release = (key: string, ref = "otp") =>
  app.handle(
    new Request(`http://localhost/v1/devices/${ref}`, { method: "DELETE", headers: { "x-api-key": key } }),
  );

const retire = (key: string) =>
  app.handle(
    new Request(`http://localhost/admin/v1/devices/${deviceId}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    }),
  );

/**
 * Give the device something worth destroying.
 *
 * The credentials are the point of retirement — the state is a label, and the
 * keys are the thing that would let this process open the account again — so
 * every case here plants a row and then asks whether it survived.
 */
const storeCredentials = () =>
  database.insert(deviceCredentials).values({
    deviceId,
    ciphertext: Buffer.from("ciphertext"),
    iv: Buffer.from("iv"),
  });

const credentialRows = async () =>
  (await database.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, deviceId))).length;

describe("a project releasing a number nobody else uses", () => {
  test("retires it: unlinked, credentials gone, history erased", async () => {
    await storeCredentials();
    expect(await credentialRows(), "the fixture did not store credentials").toBe(1);

    const res = await release(keyA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "retired", stillHeldBy: 0 });

    expect(await credentialRows(), "the credentials outlived the device").toBe(0);

    const [device] = await database.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.state, "the device still claims to be paired").toBe("unpaired");
    expect(device?.enginePoolId, "it is still assigned to a pool").toBeNull();
  });
});

describe("a project releasing a number another project still uses", () => {
  test("unsubscribes, and leaves the device working for the others", async () => {
    keyB = await bindSecondProject("+628123456789");

    await storeCredentials();

    const res = await release(keyA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "released" });

    // The credentials are the point: unlinking here would take a working
    // number away from a tenant who asked for nothing.
    expect(await credentialRows(), "a shared number was unlinked by one of its holders").toBe(1);

    // The pool assignment, not the state: this fixture never completes a
    // pairing, so `state` is "unpaired" from the start and would pass this
    // check whether or not the device had been retired underneath it.
    const [device] = await database.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.enginePoolId, "a shared device was retired by one holder").not.toBeNull();

    // And the releasing project really has gone.
    const stillMine = await app.handle(
      new Request("http://localhost/v1/devices", { headers: { "x-api-key": keyA } }),
    );
    const mine = (await stillMine.json()) as Array<{ status: string }>;
    expect(mine.every((d) => d.status === "revoked"), "the binding survived its own release").toBe(true);

    // While the other project still has one.
    expect(await DeviceStore.projectsHolding(deviceId, database)).toHaveLength(1);
  });

  test("the last one out retires it", async () => {
    keyB = await bindSecondProject("+628123456789");
    await storeCredentials();

    expect(await (await release(keyA)).json()).toMatchObject({ outcome: "released" });
    expect(await (await release(keyB, "shared")).json()).toMatchObject({ outcome: "retired" });

    expect(await credentialRows(), "the last holder left without retiring it").toBe(0);
  });
});

describe("an operator retiring a device", () => {
  test("does it whoever is still using it", async () => {
    keyB = await bindSecondProject("+628123456789");
    await storeCredentials();

    const res = await retire(adminKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "retired", revokedFrom: 2 });

    expect(await credentialRows(), "an operator retire left the credentials behind").toBe(0);

    // Every binding revoked, not just one project's.
    const bindings = await database
      .select()
      .from(virtualDevices)
      .where(and(eq(virtualDevices.deviceId, deviceId)));
    expect(
      bindings.every((b) => b.status === "revoked"),
      "a tenant kept a binding to a device the operator retired",
    ).toBe(true);
  });

  test("is refused to a project key", async () => {
    const res = await retire(keyA);
    expect(res.status, "a tenant reached the fleet-wide retire").toBe(403);
  });
});

describe("a project that was refused does not keep the number alive", () => {
  /** The project id behind the second binding, for reaching its consent row. */
  const betaProjectId = async () => {
    const [row] = await database
      .select({ projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), eq(virtualDevices.alias, "shared")));
    return row!.projectId;
  };

  test("a denied claim is not a holder", async () => {
    // A binding is created `pending_consent` and only a grant ever moves it
    // off that, so a denial left a row that still read as a live claim.
    // Counting bindings meant the last project that actually had consent
    // released the number and it was not retired — credentials and history
    // kept alive on behalf of a project the phone holder had said no to.
    keyB = await bindSecondProject("+628123456789");
    await storeCredentials();

    const consent = await DeviceStore.consentFor(deviceId, await betaProjectId(), database);
    await DeviceStore.respondToConsent(consent!.challengeToken, "denied", "whatsapp_reply", {}, database);

    const res = await release(keyA);
    expect(res.status).toBe(200);
    expect(
      await res.json(),
      "a refused project kept a number alive for itself",
    ).toMatchObject({ outcome: "retired", stillHeldBy: 0 });

    expect(await credentialRows(), "credentials outlived the last consenting project").toBe(0);
  });

  test("a claim whose deadline passed is not a holder", async () => {
    // The same hole by the other route: nobody answered, the question lapsed,
    // and the binding still said pending_consent.
    keyB = await bindSecondProject("+628123456789");
    await storeCredentials();

    const consent = await DeviceStore.consentFor(deviceId, await betaProjectId(), database);
    await database
      .update(deviceConsents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(deviceConsents.id, consent!.id));

    const res = await release(keyA);
    expect(await res.json(), "a lapsed request kept a number alive").toMatchObject({
      outcome: "retired",
      stillHeldBy: 0,
    });
  });

  test("a claim still inside its deadline does hold", async () => {
    // The other direction, so this cannot be read as "only granted counts". A
    // request awaiting an answer is a decision outstanding, and retiring the
    // device would answer it by destroying what it was about.
    keyB = await bindSecondProject("+628123456789");
    await storeCredentials();

    const res = await release(keyA);
    expect(
      await res.json(),
      "a number was destroyed while a claim on it was still awaiting an answer",
    ).toMatchObject({ outcome: "released", stillHeldBy: 1 });

    expect(await credentialRows(), "a pending claim lost the credentials it was waiting for").toBe(1);
  });
});

describe("the window between deciding and destroying", () => {
  test("a claim arriving mid-retirement is refused, not bound to a dying session", async () => {
    // The race the reservation exists for. `projectsHolding` says nobody holds
    // the number; before the credentials are destroyed, a third project claims
    // it. Without the reservation that binding is created against a live
    // session which is then logged out from under it, and the tenant has a
    // device that stopped working for reasons nothing in their project
    // explains.
    //
    // Reproduced by holding the device in the state the reservation puts it
    // in, which is exactly what the window looks like from a claimer's side.
    await storeCredentials();
    await DeviceStore.releaseFor(deviceId, await soleHolder(), "operator", database);

    const [row] = await database.select({ state: devices.state }).from(devices).where(eq(devices.id, deviceId));
    expect(row?.state, "the last release did not reserve the device").toBe("retiring");

    const gamma = await ProjectStore.create({ slug: "gamma", displayName: "Gamma" }, database);
    const env = await EnvironmentStore.create({ projectId: gamma.id, slug: "prod" }, database);

    // Awaited. `rejects` returns a promise, and an unawaited one lets the test
    // finish before the assertion has decided anything.
    await expect(
      DeviceStore.claim({ environmentId: env.id, msisdn: "+628123456789", alias: "late" }, database),
      "a project was bound to a number whose credentials were being destroyed",
    ).rejects.toThrow(/being retired/);
  });

  test("a failed retirement gives the reservation back", async () => {
    // Otherwise the number is unclaimable for ever, refused with an
    // explanation that stopped being true the moment the retirement failed.
    await DeviceStore.releaseFor(deviceId, await soleHolder(), "operator", database);
    await DeviceStore.cancelRetirement(deviceId, database);

    const gamma = await ProjectStore.create({ slug: "delta", displayName: "Delta" }, database);
    const env = await EnvironmentStore.create({ projectId: gamma.id, slug: "prod" }, database);

    const claimed = await DeviceStore.claim(
      { environmentId: env.id, msisdn: "+628123456789", alias: "after" },
      database,
    );
    expect(claimed.device.id, "a device stayed unclaimable after a failed retirement").toBe(deviceId);
  });
});

describe("an operator retiring a device", () => {
  test("revokes the binding of a project that was refused, too", async () => {
    // `projectsHolding` deliberately does not count a project whose consent
    // was denied — it holds nothing, and must not keep a number alive. But it
    // still has a binding row, and revoking by holder left that row behind
    // pointing at a device whose credentials had just been destroyed.
    keyB = await bindSecondProject("+628123456789");

    const [beta] = await database
      .select({ projectId: environments.projectId })
      .from(virtualDevices)
      .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
      .where(and(eq(virtualDevices.deviceId, deviceId), eq(virtualDevices.alias, "shared")));

    const consent = await DeviceStore.consentFor(deviceId, beta!.projectId, database);
    await DeviceStore.respondToConsent(consent!.challengeToken, "denied", "whatsapp_reply", {}, database);

    const res = await retire(adminKey);
    expect(res.status).toBe(200);

    const bindings = await database.select().from(virtualDevices).where(eq(virtualDevices.deviceId, deviceId));
    expect(
      bindings.every((b) => b.status === "revoked"),
      "a refused project kept a binding to a device the operator retired",
    ).toBe(true);
  });
});

describe("an id that does not name a device", () => {
  test("is refused, not reported as a retirement", async () => {
    // Every step of a retirement is a no-op for an id that matches nothing:
    // no bindings to revoke, an update touching no rows, no session to end. So
    // the route answered 200 "retired, revokedFrom 0" and an operator who
    // mistyped an id was told a number had been destroyed that never existed.
    const res = await app.handle(
      new Request("http://localhost/admin/v1/devices/no-such-device", {
        method: "DELETE",
        headers: { "x-api-key": adminKey },
      }),
    );

    expect(res.status, "a mistyped device id reported a successful retirement").toBe(404);
  });
});
