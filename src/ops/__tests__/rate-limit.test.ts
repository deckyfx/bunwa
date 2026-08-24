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
import { LIMITS, consume, peek, reset, sweep, type Limit } from "../rate-limit";

let dir: string;
let database: Database;

const tiny: Limit = { bucket: "test", max: 3, windowMs: 1000 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-rl-"));
  resetConfig();
  resetDatabase();
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
