/**
 * Rate limiting.
 *
 * What this protects is not the server — it is a customer's phone number. A
 * loop in one of our own applications can exhaust a device's send allowance in
 * seconds, and WhatsApp restricts the number, not the caller.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { LIMITS, consume, peek, reset, resetBucketRegistry, sweep, type Limit } from "../rate-limit";

let dir: string;
let database: Database;

const tiny: Limit = { bucket: "test", max: 3, windowMs: 1000 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-rl-"));
  resetConfig();
  resetDatabase();
  // Module-level state, so it outlives a test unless cleared. A leaked
  // monkey-patched static caused two unrelated failures earlier on this
  // branch; the same shape of leak here would make a test's verdict depend on
  // which tests ran before it.
  resetBucketRegistry();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);
});

afterEach(() => {
  try {
    database.$client.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  for (const k of ["NODE_ENV", "LOG_LEVEL", "RUNTIME_DIR", "DATABASE_PATH"]) delete Bun.env[k];
});

describe("consume", () => {
  test("allows up to the limit and then refuses", () => {
    const now = new Date(10_000);
    for (let i = 1; i <= 3; i++) {
      const d = consume("key-1", tiny, now, database);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(3 - i);
    }
    expect(consume("key-1", tiny, now, database).allowed).toBe(false);
  });

  test("subjects are counted separately", () => {
    const now = new Date(10_000);
    for (let i = 0; i < 3; i++) consume("key-1", tiny, now, database);
    // One caller exhausting its allowance must not throttle another tenant.
    expect(consume("key-2", tiny, now, database).allowed).toBe(true);
  });

  test("buckets are counted separately", () => {
    const now = new Date(10_000);
    for (let i = 0; i < 3; i++) consume("key-1", tiny, now, database);
    expect(consume("key-1", { ...tiny, bucket: "other" }, now, database).allowed).toBe(true);
  });

  test("the window resets", () => {
    const first = new Date(10_000);
    for (let i = 0; i < 3; i++) consume("key-1", tiny, first, database);
    expect(consume("key-1", tiny, first, database).allowed).toBe(false);

    const next = new Date(first.getTime() + tiny.windowMs);
    expect(consume("key-1", tiny, next, database).allowed).toBe(true);
  });

  test("reports when the window resets, for Retry-After", () => {
    const d = consume("key-1", tiny, new Date(10_500), database);
    // Windows are aligned, not relative to first use, so the reset is
    // predictable and two callers in the same window share it.
    expect(d.resetAt.getTime()).toBe(11_000);
  });

  test("counts without a read-then-write race", () => {
    // A naive limiter reads the count, compares, then writes — and two callers
    // that read the same value both proceed. Under the load that triggers a
    // limit, that leaks roughly one request per concurrent caller.
    const now = new Date(10_000);
    const decisions = Array.from({ length: 10 }, () => consume("key-1", tiny, now, database));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);

    const [row] = database.all<{ count: number }>(sql`SELECT count FROM rate_limits WHERE subject = 'key-1'`);
    expect(Number(row!.count)).toBe(10);
  });

  test("survives a restart, because the count is not in memory", async () => {
    const now = new Date(10_000);
    for (let i = 0; i < 3; i++) consume("key-1", tiny, now, database);
    database.$client.close();

    // A caller that has just been throttled retries; an in-memory counter would
    // hand them a fresh allowance on every deploy.
    database = createDatabase(join(dir, "t.sqlite"));
    expect(consume("key-1", tiny, now, database).allowed).toBe(false);
  });
});

describe("peek", () => {
  test("reports state without consuming", () => {
    const now = new Date(10_000);
    consume("key-1", tiny, now, database);
    expect(peek("key-1", tiny, now, database).remaining).toBe(2);
    expect(peek("key-1", tiny, now, database).remaining).toBe(2);
  });
});

describe("housekeeping", () => {
  test("sweep removes closed windows and leaves the current one", async () => {
    const old = new Date(0);
    const now = new Date(7_200_000);
    consume("key-1", tiny, old, database);
    consume("key-1", tiny, now, database);

    expect(await sweep(3_600_000, now, database)).toBe(1);
    expect(peek("key-1", tiny, now, database).remaining).toBe(2);
  });

  test("reset clears one subject", async () => {
    const now = new Date(10_000);
    for (let i = 0; i < 3; i++) consume("key-1", tiny, now, database);
    await reset("key-1", database);
    expect(consume("key-1", tiny, now, database).allowed).toBe(true);
  });
});

describe("the configured limits", () => {
  test("sends are capped well above legitimate OTP traffic", () => {
    // High enough that no real caller notices, low enough that a tight loop is
    // stopped within a minute rather than after a few thousand messages.
    expect(LIMITS.send.max).toBeGreaterThanOrEqual(30);
    expect(LIMITS.send.max).toBeLessThanOrEqual(120);
  });

  test("claims are capped much lower, because each one may message a person", () => {
    expect(LIMITS.claim.max).toBeLessThan(LIMITS.send.max);
  });
});

describe("the sweep must not delete a window that is still open", () => {
  test("a live window longer than the retention survives", async () => {
    // consume() takes any Limit, and the sweep used to delete by windowStart
    // against a fixed one-hour retention. A two-hour window beginning at 0 was
    // therefore deleted at 3_600_001 while still live, and the next consume()
    // started counting from zero — the limiter silently stopped limiting for
    // exactly the callers given the longest windows.
    const long: Limit = { bucket: "long", max: 2, windowMs: 7_200_000 };

    const first = consume("subject-long", long, new Date(0), database);
    expect(first.allowed).toBe(true);
    const second = consume("subject-long", long, new Date(1_000), database);
    expect(second.allowed).toBe(true);
    // Budget spent: the window holds 2.
    expect(consume("subject-long", long, new Date(2_000), database).allowed).toBe(false);

    // Past the old fixed retention, but the window does not close until
    // 7_200_000. The row must survive.
    await sweep(3_600_000, new Date(3_600_001), database);

    expect(
      consume("subject-long", long, new Date(3_600_002), database).allowed,
      "the live window was swept and the limit reset",
    ).toBe(false);
  });

  test("a closed window is still collected once its grace has passed", async () => {
    // The sweep must still do its job, or the table grows without bound.
    const short: Limit = { bucket: "short", max: 5, windowMs: 60_000 };
    consume("subject-short", short, new Date(0), database);

    // Window closes at 60_000; swept with an hour of grace after that.
    expect(await sweep(3_600_000, new Date(60_000 + 3_600_001), database)).toBeGreaterThan(0);
  });
});

describe("one bucket cannot carry two different windows", () => {
  // Reproduced before the guard existed: a 60s and a 2h limit sharing a bucket
  // both wrote window_start 0. The row kept the 60s expiry, the sweep collected
  // it while the 2h window was still open, and the next consume() allowed a
  // budget that had already been spent.
  test("a second window on the same bucket is refused", () => {
    const short: Limit = { bucket: "collide", max: 5, windowMs: 60_000 };
    const long: Limit = { bucket: "collide", max: 2, windowMs: 7_200_000 };

    expect(consume("s", short, new Date(0), database).allowed).toBe(true);
    expect(() => consume("s", long, new Date(0), database)).toThrow(RangeError);
  });

  test("the same bucket with the same window is fine", () => {
    // The guard must not reject ordinary repeated use.
    const limit: Limit = { bucket: "stable", max: 3, windowMs: 60_000 };
    expect(consume("s", limit, new Date(0), database).allowed).toBe(true);
    expect(consume("s", limit, new Date(1), database).allowed).toBe(true);
  });

});
