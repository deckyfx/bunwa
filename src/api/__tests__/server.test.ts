/**
 * HTTP surface behaviour.
 *
 * The probes and the error envelope are what an orchestrator and a support
 * engineer rely on, so they are pinned here rather than discovered in an
 * incident.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { createApp, problem } from "../server";
import { resetConfig } from "../../config/env";
import { resetDatabase } from "../../db";

// A path under a file, so opening it fails — SQLite in :memory: always works,
// which would leave the unreachable-database branch untested.
const ENV = { NODE_ENV: "test", DATABASE_PATH: "/proc/version/nope.sqlite", LOG_LEVEL: "error" };

beforeAll(() => {
  resetConfig();
  resetDatabase();
  for (const [k, v] of Object.entries(ENV)) Bun.env[k] = v;
});
afterAll(() => {
  resetConfig();
  resetDatabase();
  for (const k of Object.keys(ENV)) delete Bun.env[k];
});

const app = createApp();
const get = (path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));

describe("GET /health", () => {
  test("reports liveness without touching any dependency", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe("ok");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test("stays healthy while the database is unreachable", async () => {
    // A liveness probe that fails on a database blip gets the container
    // restarted for a fault a restart cannot fix.
    expect((await get("/health")).status).toBe(200);
  });
});

describe("GET /readyz", () => {
  test("reports not ready when the database is unreachable", async () => {
    const res = await get("/readyz");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { status: string; checks: { database: { ok: boolean } } };
    expect(body.status).toBe("not_ready");
    expect(body.checks.database.ok).toBe(false);
  });

  test("does not echo the driver error to an unauthenticated caller", async () => {
    // The message names host, port, database and role. It belongs in the log.
    const text = await (await get("/readyz")).text();
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("error");
  });
});

describe("correlation id", () => {
  test("echoes a valid caller-supplied id", async () => {
    const res = await get("/health", { "x-correlation-id": "req-abc-123" });
    expect(res.headers.get("x-correlation-id")).toBe("req-abc-123");
  });

  test("generates one when the caller supplies none", async () => {
    const id = (await get("/health")).headers.get("x-correlation-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("replaces an injection attempt rather than echoing it", async () => {
    const res = await get("/health", { "x-correlation-id": "bad id with spaces" });
    expect(res.headers.get("x-correlation-id")).not.toBe("bad id with spaces");
    expect(res.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("errors", () => {
  test("unknown routes return an RFC 9457 problem document", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("https://bunwa.dev/errors/not-found");
    expect(body["status"]).toBe(404);
    expect(body["correlationId"]).toBeString();
    // The 404 path bypasses `derive`, so this header is easy to lose.
    expect(res.headers.get("x-correlation-id")).toBe(String(body["correlationId"]));
  });

  test("a 404 echoes a caller-supplied correlation id", async () => {
    const res = await get("/nope", { "x-correlation-id": "trace-me" });
    expect(res.headers.get("x-correlation-id")).toBe("trace-me");
    expect(((await res.json()) as Record<string, unknown>)["correlationId"]).toBe("trace-me");
  });
});

describe("problem()", () => {
  test("omits absent optional members rather than emitting nulls", () => {
    const p = problem(403, "forbidden", "Forbidden");
    expect(p).toEqual({ type: "https://bunwa.dev/errors/forbidden", title: "Forbidden", status: 403 });
    expect("detail" in p).toBe(false);
  });
});
