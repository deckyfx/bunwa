/**
 * Which shape of the server is running, and what changes because of it.
 *
 * The mode is not detected — it is decided by which entry point ran and then
 * carried. What is worth asserting is that it is carried honestly: that the
 * two builds disagree where they should, that the root address does something
 * useful in both, and that nothing reports "console" for a server that is not
 * serving one. A wrong answer here sends an operator debugging a blank page to
 * the wrong half of the system.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, createConsoleApp } from "../server";
import { createDatabase, resetDatabase } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import type { ConsolePage } from "../types";
import { clearSetupToken, issueSetupToken } from "../routes/setup";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "ADMIN_API_ENABLED"]);

let dir: string;

/**
 * A stand-in for the bundled page.
 *
 * The real import is a build instruction Bun resolves at bundle time, not
 * something a test can construct. Elysia only has to hand it back, so a
 * Response is a faithful enough stand-in for "the console is mounted" —
 * and these tests are about the mode, not about what the page contains.
 */
const FAKE_PAGE = new Response("<!doctype html><title>console</title>", {
  headers: { "content-type": "text/html" },
}) as unknown as ConsolePage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-mode-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  resetConfig();
  await MigrationManager.runMigrations(createDatabase(join(dir, "t.sqlite")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetDatabase();
});

const get = (app: { handle: (r: Request) => Promise<Response> }, path: string, headers?: Record<string, string>) =>
  app.handle(new Request(`http://localhost${path}`, headers === undefined ? undefined : { headers }));

describe("the headless build", () => {
  test("says so on the liveness probe", async () => {
    // Reported because the alternative is probing /app and interpreting a 404.
    const body = (await (await get(createApp(), "/health")).json()) as { mode: string };
    expect(body.mode).toBe("headless");
  });

  test("answers the root rather than 404ing it", async () => {
    // Someone opening the root of a headless deployment should learn what this
    // is, not be told the address does not exist.
    const res = await get(createApp(), "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("headless");
  });

  test("does not redirect the root to a page it cannot serve", async () => {
    // The failure this pins: sharing a root route between the two shapes would
    // bounce a headless instance to /app, which answers 404 — a redirect into
    // a dead end.
    const res = await get(createApp(), "/");
    expect(res.headers.get("location")).toBeNull();
  });

  test("explains what /app would be", async () => {
    const res = await get(createApp(), "/app");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("console");
  });
});

describe("the console build", () => {
  test("says so on the liveness probe", async () => {
    const body = (await (await get(createConsoleApp(undefined, FAKE_PAGE), "/health")).json()) as { mode: string };
    expect(body.mode).toBe("console");
  });

  test("sends the root to /app", async () => {
    const res = await get(createConsoleApp(undefined, FAKE_PAGE), "/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });

  test("redirects temporarily, not permanently", async () => {
    // A 301 is cached by the browser indefinitely, so an instance later run
    // headless would keep bouncing / to a page that no longer exists — with no
    // way to clear it short of the operator's own cache.
    const res = await get(createConsoleApp(undefined, FAKE_PAGE), "/");
    expect(res.status).not.toBe(301);
  });

  test("its root route beats the headless one underneath it", async () => {
    // Both plugins declare `/`, and the console's is mounted second. If
    // precedence went the other way the console build would serve the headless
    // notice at its own front door.
    const res = await get(createConsoleApp(undefined, FAKE_PAGE), "/");
    expect(res.status).toBe(302);
  });
});

describe("the mode on the request context", () => {
  test("is available to handlers without an import", async () => {
    // The reason it is a decoration rather than a module-level value: a
    // handler whose right answer differs between builds can read it from the
    // context it already has.
    const probe = createApp().get("/probe", ({ serverMode }) => ({ serverMode }));
    expect(await (await get(probe, "/probe")).json()).toEqual({ serverMode: "headless" });
  });

  test("follows the build rather than a default", async () => {
    const probe = createConsoleApp(undefined, FAKE_PAGE).get("/probe", ({ serverMode }) => ({ serverMode }));
    expect(await (await get(probe, "/probe")).json()).toEqual({ serverMode: "console" });
  });
});

describe("credentials do not depend on the console being served", () => {
  test("setup mints a key in headless mode", async () => {
    // The console is where an operator would normally finish setup, so it is
    // worth pinning that the headless build is not quietly a build you cannot
    // get a credential out of. Everything but the screen is the same app.
    //
    // The admin surface is mounted because the key setup mints is an admin
    // key, so identifying it means reaching that surface — which is itself the
    // point of the test: a headless deployment still gets a working operator
    // credential.
    Bun.env["ADMIN_API_ENABLED"] = "true";
    resetConfig();

    const app = createApp();
    const token = issueSetupToken();

    const res = await app.handle(
      new Request("http://localhost/setup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-setup-token": token },
        body: JSON.stringify({ instanceName: "headless-box" }),
      }),
    );

    expect(res.status).toBe(201);
    const { apiKey } = (await res.json()) as { apiKey: string };

    const whoami = await get(app, "/admin/v1/whoami", { "x-api-key": apiKey });
    expect(whoami.status, "and the key it minted authenticates").toBe(200);

    clearSetupToken();
  });

  test("the admin surface works headless too", async () => {
    // Projects and their keys are managed over HTTP, so a deployment with no
    // console is not a deployment with no tenancy.
    Bun.env["ADMIN_API_ENABLED"] = "true";
    resetConfig();

    const app = createApp();
    const token = issueSetupToken();
    const setup = (await (
      await app.handle(
        new Request("http://localhost/setup", {
          method: "POST",
          headers: { "content-type": "application/json", "x-setup-token": token },
          body: JSON.stringify({ instanceName: "headless-box" }),
        }),
      )
    ).json()) as { apiKey: string };

    const res = await app.handle(
      new Request("http://localhost/admin/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": setup.apiKey },
        body: JSON.stringify({ slug: "acme", displayName: "Acme" }),
      }),
    );

    expect(res.status).toBe(201);
    clearSetupToken();
  });
});
