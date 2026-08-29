/**
 * HTTP surface behaviour.
 *
 * The probes and the error envelope are what an orchestrator and a support
 * engineer rely on, so they are pinned here rather than discovered in an
 * incident.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { createApp, problem, type Problem } from "../server";
import { paintedRequestLine, plainRequestLine } from "../../observability/request-line";
import { PRESSURE_GUIDANCE, type Pressure } from "../../ops/pressure";
import { resetConfig } from "../../config/env";
import { resetDatabase } from "../../db";
import { captureEnv } from "../../testing/env";

// A path under a file, so opening it fails — SQLite in :memory: always works,
// which would leave the unreachable-database branch untested.
const ENV = { NODE_ENV: "test", DATABASE_PATH: "/proc/version/nope.sqlite", LOG_LEVEL: "error" };

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(Object.keys(ENV));

beforeAll(() => {
  resetConfig();
  resetDatabase();
  for (const [k, v] of Object.entries(ENV)) Bun.env[k] = v;
});
afterAll(() => {
  resetConfig();
  resetDatabase();
  restoreEnv();
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
    const body = (await res.json()) as Problem;
    expect(body.type).toBe("https://bunwa.dev/errors/not-found");
    expect(body.status).toBe(404);
    expect(body.correlationId).toBeString();
    // The 404 path bypasses `derive`, so this header is easy to lose.
    expect(res.headers.get("x-correlation-id")).toBe(body.correlationId ?? null);
  });

  test("a 404 echoes a caller-supplied correlation id", async () => {
    const res = await get("/nope", { "x-correlation-id": "trace-me" });
    expect(res.headers.get("x-correlation-id")).toBe("trace-me");
    expect(((await res.json()) as Problem).correlationId).toBe("trace-me");
  });
});

describe("problem()", () => {
  test("omits absent optional members rather than emitting nulls", () => {
    const p = problem(403, "forbidden", "Forbidden");
    expect(p).toEqual({ type: "https://bunwa.dev/errors/forbidden", title: "Forbidden", status: 403 });
    expect("detail" in p).toBe(false);
  });
});

describe("GET /metrics", () => {
  test("reports the four pressure signals with their thresholds", async () => {
    // ADR-0005 defers Postgres until "a second process needs the data", which
    // only works if something says when that day arrives.
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pressure: Pressure;
      guidance: typeof PRESSURE_GUIDANCE;
      busyRetriesTotal: number;
    };
    expect(Object.keys(body.pressure)).toEqual(
      expect.arrayContaining(["databaseReachable", "busyRetriesPerMinute", "queue", "send", "pools", "databaseBytes"]),
    );
    // This fixture points at an unreachable database on purpose, and the
    // endpoint still answers — saying so, rather than reporting zeros or
    // failing. An operator reaching for metrics during a database incident is
    // exactly who needs this to work.
    expect(body.pressure.databaseReachable).toBe(false);
    // Thresholds travel with the numbers: a metric with no threshold is a
    // number nobody reads.
    for (const g of Object.values(body.guidance)) expect(g.meaning).toBeString();
  });

  test("needs no credential, and exposes counts rather than content", async () => {
    // An operator reaching for this mid-incident should not need a key, so it
    // must never carry tenant names, phone numbers or message bodies.
    const text = await (await get("/metrics")).text();
    expect(text).not.toMatch(/@s\.whatsapp\.net|\+62|grande/i);
  });
});

describe("the request log line", () => {
  // The file pins LOG_LEVEL at "error" so the rest of the suite stays quiet;
  // these two tests are about a line logged at info and debug, so they lower
  // the floor and put it back.
  beforeAll(() => {
    Bun.env["LOG_LEVEL"] = "debug";
    resetConfig();
  });
  afterAll(() => {
    Bun.env["LOG_LEVEL"] = ENV.LOG_LEVEL;
    resetConfig();
  });

  /** Console lines emitted while `fn` runs. */
  function capture(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    return fn()
      // onAfterResponse runs after handle() resolves — the line is written on
      // the tick after the response, not during it. Without this wait the
      // capture ends before the logger has said anything.
      .then(() => Bun.sleep(50))
      .then(() => lines)
      .finally(() => {
        console.log = origLog;
        console.error = origErr;
      });
  }

  test("reads as REQ status method path duration, not as a JSON blob", async () => {
    // One line per request is read far more often than it is parsed. The
    // previous form put the three things a reader wants behind the punctuation
    // of `request {"method":"GET",…}`.
    const lines = await capture(async () => {
      await app.handle(new Request("http://localhost/health"));
    });

    const line = lines.find((l) => l.includes("REQ "));
    expect(line, "no request line was logged").toBeDefined();
    expect(line).toMatch(/REQ 200 GET \d+ms \/health$/);
    expect(line, "the fields were repeated on the console as well").not.toContain("{");
  });

  test("an unmatched route claims no duration rather than claiming zero", async () => {
    // `derive` does not run for a route that matched nothing, so the start
    // time does not exist. "Not measured" and "took no time" are different
    // claims and 0ms on every 404 is the second one said wrongly.
    const lines = await capture(async () => {
      await app.handle(new Request("http://localhost/nope"));
    });

    const line = lines.find((l) => l.includes("REQ "));
    expect(line, "no request line was logged").toBeDefined();
    expect(line).toContain("REQ 404 GET /nope");
    expect(line, "it invented a duration for a request it never timed").not.toMatch(/\dms/);
  });

  test("the painted line and the plain one carry the same facts", () => {
    // The console gets colour and the file must never see it — the two
    // renderings are separate for that reason alone, so they have to be
    // checked against each other or they will drift apart silently.
    const line = { status: 200, method: "GET", path: "/v1/devices", durationMs: 12 };

    const plain = plainRequestLine(line);
    const painted = paintedRequestLine(line);
    // eslint-disable-next-line no-control-regex
    const stripped = painted.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();

    expect(plain).toBe("REQ 200 GET 12ms /v1/devices");
    expect(stripped, "the painted line says something different from the plain one").toBe(plain);
  });

  test("nothing painted can reach the file", () => {
    // The file sink is asserted elsewhere never to contain an escape code.
    // This is the other half: the value the file is given must not carry one
    // in the first place, whatever the terminal is doing.
    for (const status of [200, 301, 404, 500]) {
      const plain = plainRequestLine({ status, method: "DELETE", path: "/x", durationMs: 5_000 });
      expect(plain, `status ${String(status)} painted the plain line`).not.toContain("\u001b");
    }
  });
});
