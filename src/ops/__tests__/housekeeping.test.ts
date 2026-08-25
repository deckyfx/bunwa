/**
 * Housekeeping.
 *
 * Every job here existed as a function during stage 1, passed its own tests,
 * and was never called. The tests below are therefore as much about *wiring* as
 * behaviour: a sweep that is defined and unscheduled is worse than no sweep,
 * because the code reads as though the problem is handled.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import {
  deliveries, environmentWebhooks, environments, devices, idempotencyKeys, outboundMessages, projects,
  virtualDevices,
} from "../../db/schema";
import { resetConfig } from "../../config/env";
import { consume, peek } from "../rate-limit";
import { runHousekeeping, startHousekeeping, sweepUnacked } from "../housekeeping";
import { IdempotencyStore } from "../../stores/idempotency-store";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let environmentId: string;
let bindingId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-hk-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const [project] = await database.insert(projects).values({ slug: "g", displayName: "G" }).returning();
  const [environment] = await database
    .insert(environments)
    .values({ projectId: project!.id, slug: "production" })
    .returning();
  environmentId = environment!.id;
  await database.insert(environmentWebhooks).values({
    environmentId,
    url: "https://hooks.example.com/x",
    secret: "a-sufficiently-long-secret",
  });

  const [device] = await database.insert(devices).values({ msisdn: "+628123456789" }).returning();
  const [binding] = await database
    .insert(virtualDevices)
    .values({ environmentId, deviceId: device!.id, alias: "otp-sender", status: "active" })
    .returning();
  bindingId = binding!.id;
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
  restoreEnv();
});

/** A send accepted `agoMs` ago and never acknowledged. */
async function acceptedSend(agoMs: number, now: Date, engineMessageId = "m1") {
  const [row] = await database
    .insert(outboundMessages)
    .values({
      virtualDeviceId: bindingId,
      environmentId,
      engineMessageId,
      type: "text",
      recipient: "+628999888777",
      acceptedAt: new Date(now.getTime() - agoMs),
    })
    .returning();
  return row!;
}

describe("sends accepted but never acknowledged", () => {
  test("become message.undelivered, delivered as an event", async () => {
    // The whole answer to the 203-second window: acceptance is not delivery,
    // and without this the API reports success while the OTP never arrives.
    const now = new Date(5_000_000);
    const message = await acceptedSend(5 * 60_000, now);

    expect(await sweepUnacked(database, now)).toBe(1);

    const [updated] = await database.select().from(outboundMessages).where(eq(outboundMessages.id, message.id));
    expect(updated!.state).toBe("undelivered");

    const queued = (await database.select().from(deliveries)).filter((d) => d.eventType === "message.undelivered");
    expect(queued).toHaveLength(1);
    const payload = queued[0]!.payload as {
      environment: { id: string; slug: string };
      project: { id: string; slug: string };
      data: { message_id: string; virtual_device: string | null };
    };
    expect(payload.data.message_id).toBe(message.id);
    expect(payload.data.virtual_device).toBe("otp-sender");

    // The tenant must be able to attribute the event. These were empty strings
    // at first, which is a payload a consumer cannot route.
    expect(payload.environment.slug).not.toBe("");
    expect(payload.project.id).not.toBe("");
    expect(payload.project.slug).not.toBe("");
  });

  test("leaves recent sends alone", async () => {
    // A send from two seconds ago has not failed, it is in flight.
    const now = new Date(5_000_000);
    await acceptedSend(2_000, now);
    expect(await sweepUnacked(database, now)).toBe(0);
  });

  test("does not raise the same message twice", async () => {
    // The state moves to undelivered, so a second pass finds nothing — which
    // matters because this runs every 30 seconds and a duplicate event would
    // reach the tenant's webhook.
    const now = new Date(5_000_000);
    await acceptedSend(5 * 60_000, now);
    expect(await sweepUnacked(database, now)).toBe(1);
    expect(await sweepUnacked(database, new Date(now.getTime() + 60_000))).toBe(0);
  });

  test("is marked as bunwa-originated, so no rule replies to it", async () => {
    const now = new Date(5_000_000);
    await acceptedSend(5 * 60_000, now);
    await sweepUnacked(database, now);
    const [queued] = await database.select().from(deliveries);
    expect((queued!.payload as { meta: { origin: string } }).meta.origin).toBe("bunwa");
  });
});

describe("runHousekeeping", () => {
  test("clears expired idempotency keys", async () => {
    const now = new Date(5_000_000);
    // Written directly with an old createdAt: reserve() takes `now` only to
    // judge expiry, and stamps the row from the schema default. Passing a past
    // date there produced a row created *now*, so the sweep found nothing —
    // and the test would have passed against a sweep that did not work.
    await database.insert(idempotencyKeys).values({
      environmentId,
      key: "old-key",
      requestHash: "hash",
      createdAt: new Date(now.getTime() - 48 * 3_600_000),
    });

    const result = await runHousekeeping(database, now);
    expect(result.idempotencyKeysRemoved).toBe(1);
  });

  test("leaves a live idempotency key alone", async () => {
    // The other direction matters more: sweeping a live key would let a retry
    // send a second OTP, which is the failure the table exists to prevent.
    const now = new Date(5_000_000);
    await database.insert(idempotencyKeys).values({
      environmentId,
      key: "fresh-key",
      requestHash: "hash",
      createdAt: new Date(now.getTime() - 60_000),
    });
    expect((await runHousekeeping(database, now)).idempotencyKeysRemoved).toBe(0);
  });

  test("clears closed rate-limit windows and leaves the current one", async () => {
    const now = new Date(7_200_000);
    consume("subject-1", { bucket: "b", max: 5, windowMs: 1000 }, new Date(0), database);
    consume("subject-1", { bucket: "b", max: 5, windowMs: 1000 }, now, database);

    const result = await runHousekeeping(database, now);
    expect(result.rateLimitRowsRemoved).toBe(1);
    // The live window survives, or a throttled caller gets a free reset.
    expect(peek("subject-1", { bucket: "b", max: 5, windowMs: 1000 }, now, database).remaining).toBe(4);
  });

  test("one failing job does not prevent the others", async () => {
    // These run together; a sweep that throws must not silently stop the sweep
    // that raises undelivered messages.
    //
    // The first version of this test named that behaviour and never caused a
    // failure, so it passed against Promise.all — an implementation with no
    // isolation whatsoever. A test that cannot fail for the reason it is named
    // after is worse than no test: it reports the guarantee as covered.
    const now = new Date(5_000_000);
    await acceptedSend(5 * 60_000, now);

    const realSweep = IdempotencyStore.sweep;
    (IdempotencyStore as { sweep: typeof IdempotencyStore.sweep }).sweep = () =>
      Promise.reject(new Error("boom"));
    try {
      const result = await runHousekeeping(database, now);
      expect(result.messagesMarkedUndelivered).toBe(1);
      expect(result.idempotencyKeysRemoved).toBe(0);
    } finally {
      (IdempotencyStore as { sweep: typeof IdempotencyStore.sweep }).sweep = realSweep;
    }
  });
});

describe("the loop refuses an interval that would make it spin", () => {
  // Every invalid value fails toward running constantly, not toward not
  // running: setTimeout treats NaN as 0 and clamps anything beyond a 32-bit
  // signed integer to 1ms. Measured — Infinity fires after 1ms with a
  // TimeoutOverflowWarning. A one-millisecond loop over three table sweeps is
  // a self-inflicted load with no upper bound.
  // 2_147_483_648 is the one that matters most: it is finite, so a guard that
  // only tests Number.isFinite lets it through, and it fires after 8ms.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    test(`refuses ${String(bad)}`, () => {
      expect(() => startHousekeeping(database, bad)).toThrow(RangeError);
    });
  }

  test("accepts a sane interval and stops cleanly", async () => {
    const stop = startHousekeeping(database, 30_000);
    await stop();
  });

  test("accepts the largest delay setTimeout actually honours", async () => {
    // The boundary must be inclusive: 2_147_483_647 is honoured, so rejecting
    // it would be the guard inventing its own limit.
    const stop = startHousekeeping(database, 2_147_483_647);
    await stop();
  });
});
