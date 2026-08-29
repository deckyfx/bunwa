/**
 * First-run setup.
 *
 * This is the only surface that answers before a credential exists and the
 * only one that mints one, so most of what is asserted here is about the ways
 * it must refuse: without the token, after it has already been used, and for a
 * setting the environment owns. A mistake in any of them is an open
 * credential-minting endpoint, which is worth more to an attacker than
 * anything behind authentication.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { apiKeys } from "../../db/schema";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { clearSetupToken, issueSetupToken, SETUP_TOKEN_HEADER } from "../routes/setup";
import { ensureBootstrap } from "../../ops/bootstrap";
import { ProjectStore } from "../../stores/project-store";
import { resetTimeFormatters } from "../../time/format";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "SERVER_TIMEZONE", "API_KEY"]);

let dir: string;
let app: ReturnType<typeof createApp>;
let token: string;

const setupEnv = async (extra: Record<string, string> = {}) => {
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  // The operator's key is an admin key now, so identifying it means reaching
  // the admin surface — which answers 404 unless it is mounted.
  Bun.env["ADMIN_API_ENABLED"] = "true";
  delete Bun.env["SERVER_TIMEZONE"];
  delete Bun.env["API_KEY"];
  for (const [k, v] of Object.entries(extra)) Bun.env[k] = v;
  resetConfig();

  await MigrationManager.runMigrations(createDatabase(join(dir, "t.sqlite")));
  app = createApp();
  token = issueSetupToken();
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-setup-"));
  await setupEnv();
});

afterEach(() => {
  clearSetupToken();
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetDatabase();
  resetTimeFormatters();
});

const status = async () =>
  (await app.handle(new Request("http://localhost/setup/status"))).json() as Promise<Record<string, unknown>>;

const finish = (body: Record<string, string>, headers: Record<string, string> = { [SETUP_TOKEN_HEADER]: token }) =>
  app.handle(
    new Request("http://localhost/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

describe("status", () => {
  test("a blank instance says it is not configured", async () => {
    // The console shows the wrong screen otherwise, which is what a purged
    // database looked like before any of this existed.
    expect(await status()).toMatchObject({ configured: false, apiKeySource: "none", canMintKey: true });
  });

  test("is readable without the token", async () => {
    // Knowing an instance is unconfigured is not worth protecting when the fix
    // is to configure it, and a console that cannot tell "not set up" from
    // "wrong key" cannot route the operator anywhere useful.
    const res = await app.handle(new Request("http://localhost/setup/status"));
    expect(res.status).toBe(200);
  });

  test("reports which settings the environment owns", async () => {
    await setupEnv({ SERVER_TIMEZONE: "UTC" });
    const body = await status();
    expect(body["settings"]).toMatchObject({ serverTimezone: { value: "UTC", source: "environment" } });
  });
});

describe("minting the first key", () => {
  test("refuses without the setup token", async () => {
    // The race an unauthenticated mint would lose: on a public deployment,
    // whoever reaches this first gets an all-scope credential.
    const res = await finish({ instanceName: "grande" }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "setup-token-required" });
  });

  test("refuses a wrong token", async () => {
    const res = await finish({ instanceName: "grande" }, { [SETUP_TOKEN_HEADER]: "0".repeat(32) });
    expect(res.status).toBe(401);
  });

  test("two requests with the same token mint one key, not two", async () => {
    // The token check and clearSetupToken() sat either side of an awaited
    // create, so both requests passed the check and both minted an all-scope
    // key — one instance, two credentials granting everything, and the
    // operator told about one of them.
    const [a, b] = await Promise.all([
      finish({ instanceName: "grande" }),
      finish({ instanceName: "grande" }),
    ]);

    // Serialised, so the second runs after the first rather than beside it —
    // and by then the single-use token it is presenting has been spent, so it
    // is refused. 401 is the honest answer: the credential really is no longer
    // valid. What must not happen is two 201s, or the 500 the unserialised
    // version produced when both raced ensureBootstrap().
    const codes = [a.status, b.status].sort((x, y) => x - y);
    expect(codes, "a concurrent setup was not serialised").toEqual([201, 401]);

    const minted = [await a.json(), await b.json()].filter(
      (r) => (r as { apiKey?: string | null }).apiKey != null,
    );
    expect(minted, "more than one key was handed out for one setup").toHaveLength(1);
  });

  test("returns a key that actually authenticates", async () => {
    // The assertion that matters. A minted string that the auth path rejects
    // is worse than no setup screen: the operator has been told they are done.
    const res = await finish({ instanceName: "grande-pos" });
    expect(res.status).toBe(201);

    const { apiKey } = (await res.json()) as { apiKey: string };
    expect(apiKey).toMatch(/^bw_live_/);

    // The admin whoami, because that is what setup mints now. A key that
    // could answer /v1/whoami would be a tenant credential, which is exactly
    // what the operator's key stopped being.
    const whoami = await app.handle(
      new Request("http://localhost/admin/v1/whoami", { headers: { "x-api-key": apiKey } }),
    );
    expect(whoami.status).toBe(200);
    expect((await whoami.json()) as { level: string }).toMatchObject({ level: "admin" });

    // And it is refused by a project route rather than silently acting as one.
    const tenant = await app.handle(
      new Request("http://localhost/v1/whoami", { headers: { "x-api-key": apiKey } }),
    );
    expect(tenant.status, "the operator key could still act as a tenant").toBe(403);
  });

  test("closes the moment it is used", async () => {
    await finish({ instanceName: "grande" });

    const second = await finish({ instanceName: "other" });
    expect(second.status, "the token is spent, so this is unauthenticated").toBe(401);
  });

  test("mints nothing once a key exists, even with a fresh token", async () => {
    await finish({ instanceName: "grande" });
    token = issueSetupToken();

    const res = await finish({ instanceName: "grande" });
    const body = (await res.json()) as { apiKey: string | null };
    expect(body.apiKey, "a second key would be a second way in nobody asked for").toBeNull();
  });

  test("says it is configured afterwards", async () => {
    await finish({ instanceName: "grande" });
    expect(await status()).toMatchObject({ configured: true, canMintKey: false, apiKeySource: "database" });
  });

  test("stores the normalised instance name", async () => {
    await finish({ instanceName: "Grande POS" });
    const body = await status();
    expect(body["settings"]).toMatchObject({ instanceName: { value: "Grande-POS", source: "database" } });
  });

  test("rejects an instance name that normalises to nothing", async () => {
    const res = await finish({ instanceName: "!!!" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a key supplied by the environment", () => {
  test("authenticates without any setup at all", async () => {
    // The reproducible-deployment case: the credential is fixed by whatever
    // created the instance, and nobody has to click anything.
    const key = `env-${"k".repeat(40)}`;
    await setupEnv({ API_KEY: key });
    await ensureBootstrap();

    // API_KEY registers as an admin key too: it and the setup screen are two
    // doors to the same credential, so they must produce the same kind of one.
    const whoami = await app.handle(
      new Request("http://localhost/admin/v1/whoami", { headers: { "x-api-key": key } }),
    );
    expect(whoami.status).toBe(200);
  });

  test("makes the instance configured, so nothing is minted", async () => {
    await setupEnv({ API_KEY: `env-${"k".repeat(40)}` });
    expect(await status()).toMatchObject({ configured: true, apiKeySource: "environment", canMintKey: false });
  });

  test("registering it twice does not create a second row", async () => {
    // Every restart calls this. A row per boot would fill the table and make
    // revocation meaningless — and a test that only checked the key still
    // authenticates would pass with a thousand duplicates behind it.
    const key = `env-${"k".repeat(40)}`;
    await setupEnv({ API_KEY: key });
    await ensureBootstrap();
    await ensureBootstrap();
    await ensureBootstrap();

    const rows = createDatabase(join(dir, "t.sqlite")).select().from(apiKeys).all();
    expect(rows).toHaveLength(1);
  });

  test("a near-miss key is still rejected", async () => {
    // The derived prefix is an index selector, not the check: a key sharing
    // nothing but a length must not authenticate.
    await setupEnv({ API_KEY: `env-${"k".repeat(40)}` });
    await ensureBootstrap();

    const res = await app.handle(
      new Request("http://localhost/v1/whoami", { headers: { "x-api-key": `env-${"j".repeat(40)}` } }),
    );
    expect(res.status).toBe(401);
  });

  test("a setting the environment owns cannot be changed here", async () => {
    // Accepting it silently would leave the console showing a value the
    // deployment overrides, which is the whole failure the precedence rule
    // exists to prevent.
    await setupEnv({ SERVER_TIMEZONE: "UTC" });
    const res = await finish({ serverTimezone: "Europe/London" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("settings after setup", () => {
  test("can still be changed, which the setup screen alone cannot do", async () => {
    // The setup token is spent the moment it is used, so without an
    // authenticated route the instance name could only ever be chosen during
    // the first minute of the instance's life.
    const minted = await finish({ instanceName: "first" });
    const { apiKey } = (await minted.json()) as { apiKey: string };

    const res = await app.handle(
      new Request("http://localhost/admin/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ instanceName: "Second Name" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ instanceName: { value: "Second-Name", source: "database" } });
  });

  test("need a credential", async () => {
    const res = await app.handle(new Request("http://localhost/admin/v1/settings"));
    expect(res.status).toBe(401);
  });

  test("still refuse a value the environment owns", async () => {
    await setupEnv({ SERVER_TIMEZONE: "UTC" });
    const minted = await finish({ instanceName: "first" });
    const { apiKey } = (await minted.json()) as { apiKey: string };

    const res = await app.handle(
      new Request("http://localhost/admin/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ serverTimezone: "Europe/London" }),
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the first project", () => {
  test("is created from a name, with the slug derived", async () => {
    const res = await finish({ instanceName: "demo", projectName: "Acme Ltd." });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { project: { slug: string; displayName: string } | null };
    expect(body.project, "setup accepted a project name and created nothing").not.toBeNull();
    expect(body.project).toMatchObject({ slug: "acme-ltd", displayName: "Acme Ltd." });
  });

  test("an explicit slug wins over the derived one", async () => {
    const res = await finish({ projectName: "Acme Ltd.", projectSlug: "acme" });
    const body = (await res.json()) as { project: { slug: string } | null };
    expect(body.project?.slug).toBe("acme");
  });

  test("is optional: the credential is the part that cannot wait", async () => {
    // An operator who only wants a key gets one, and adds projects later.
    const res = await finish({ instanceName: "demo" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { apiKey: string | null; project: null };
    expect(body.apiKey).not.toBeNull();
    expect(body.project).toBeNull();
  });

  test("a name with no usable slug is refused while the token is still good", async () => {
    // Refused before the key is minted, so the operator can correct the name
    // and try again rather than being left with a spent token and no project.
    const res = await finish({ projectName: "→→→" });
    // 422, which is what this app answers for a value it understood and
    // refused — as opposed to a body it could not parse.
    expect(res.status).toBe(422);

    const retry = await finish({ projectName: "Acme" });
    expect(retry.status, "the failed attempt spent the setup token").toBe(201);
  });

  test("a slug already taken leaves no half-finished setup behind", async () => {
    // The failure the earlier ordering could not survive: a slug collision is
    // only discoverable by attempting the write, so it happens after the
    // settings have been handed to the database. Everything now goes in one
    // transaction, and this is the test that says so — it fails if the writes
    // are unwrapped, because the instance name persists.
    await ProjectStore.create({ slug: "taken", displayName: "Already here" });

    const res = await finish({ instanceName: "should not survive", projectName: "Taken" });
    expect(res.status, "a duplicate slug was accepted").toBeGreaterThanOrEqual(400);

    // The settings half of the same request must be gone with it.
    const settings = await status();
    expect(
      (settings as { settings?: Record<string, { value?: string }> }).settings?.instanceName?.value,
    ).not.toBe("should not survive");

    // And no key was minted, so the instance is still unconfigured and the
    // token still works — the operator can pick another name and continue.
    expect(settings).toMatchObject({ configured: false });

    const retry = await finish({ instanceName: "second try", projectName: "Fresh" });
    expect(retry.status, "the failed attempt spent the token or wedged the instance").toBe(201);
  });

  test("nothing creates a project on its own any more", async () => {
    // A project called "Default" was created on every boot, because the
    // operator's key had to live in an environment. It does not any more.
    await ensureBootstrap();
    const state = await ensureBootstrap();
    expect(state.projectId, "a project was conjured with nobody asking for one").toBeNull();
  });
});
