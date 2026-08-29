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

    const whoami = await app.handle(
      new Request("http://localhost/v1/whoami", { headers: { "x-api-key": apiKey } }),
    );
    expect(whoami.status).toBe(200);
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

    const whoami = await app.handle(
      new Request("http://localhost/v1/whoami", { headers: { "x-api-key": key } }),
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
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ instanceName: "Second Name" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ instanceName: { value: "Second-Name", source: "database" } });
  });

  test("need a credential", async () => {
    const res = await app.handle(new Request("http://localhost/v1/settings"));
    expect(res.status).toBe(401);
  });

  test("still refuse a value the environment owns", async () => {
    await setupEnv({ SERVER_TIMEZONE: "UTC" });
    const minted = await finish({ instanceName: "first" });
    const { apiKey } = (await minted.json()) as { apiKey: string };

    const res = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ serverTimezone: "Europe/London" }),
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
