/**
 * The pressure signals.
 *
 * ADR-0005 defers Postgres until "a second process needs the data", which is a
 * sound trigger and a useless one on its own — nothing announces its arrival.
 * These are what make it observable, so the tests are mostly about whether a
 * number would actually tell you something on the day it matters.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { deliveries, devices, outboundMessages, environments, projects, virtualDevices } from "../../db/schema";
import { resetConfig } from "../../config/env";
import { PRESSURE_GUIDANCE, recordBusyRetry, resetBusyWindow, samplePressure } from "../pressure";

let dir: string;
let database: Database;
let environmentId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-pressure-"));
  resetConfig();
  resetDatabase();
  resetBusyWindow();
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

describe("a quiet system", () => {
  test("reports zeros rather than nulls or absent fields", async () => {
    const p = await samplePressure(database);
    expect(p.busyRetriesPerMinute).toBe(0);
    expect(p.queue).toEqual({ pending: 0, oldestPendingAgeMs: null, dead: 0 });
    expect(p.pools).toEqual([]);
  });

  test("reports a real database size", async () => {
    // A PRAGMA names its result column after itself. Aliasing it wrong returned
    // 0, which reads as "no growth" rather than "not measured" — a metric worse
    // than none, because it is quietly reassuring.
    expect((await samplePressure(database)).databaseBytes).toBeGreaterThan(0);
  });
});

describe("queue depth versus age", () => {
  test("distinguishes a burst from a backlog", async () => {
    // Depth alone is ambiguous: a burst and a stuck queue look identical. Age
    // is what separates "working hard" from "not draining".
    const now = new Date(1_000_000);
    await database.insert(deliveries).values([
      { environmentId, eventId: "e1", eventType: "message.received", payload: {}, nextAttemptAt: new Date(now.getTime() - 5 * 60_000) },
      { environmentId, eventId: "e2", eventType: "message.received", payload: {}, nextAttemptAt: new Date(now.getTime() - 1_000) },
    ]);

    const p = await samplePressure(database, now);
    expect(p.queue.pending).toBe(2);
    expect(p.queue.oldestPendingAgeMs).toBe(5 * 60_000);
    // Old enough to have crossed the "act" line, which is the point of the age.
    expect(p.queue.oldestPendingAgeMs!).toBeGreaterThanOrEqual(PRESSURE_GUIDANCE.oldestPendingAgeMs.act);
  });

  test("counts dead letters separately from pending work", async () => {
    await database.insert(deliveries).values({
      environmentId, eventId: "e3", eventType: "message.received", payload: {},
      nextAttemptAt: new Date(), state: "dead",
    });
    const p = await samplePressure(database);
    expect(p.queue.dead).toBe(1);
    expect(p.queue.pending).toBe(0);
  });
});

describe("sends accepted but never acknowledged", () => {
  test("counts only those old enough to be suspicious", async () => {
    // The signal for the 203-second blind window: gowa reports a device
    // connected while it cannot deliver, so acceptance keeps succeeding and
    // nothing arrives.
    const now = new Date(2_000_000);
    const [device] = await database.insert(devices).values({ msisdn: "+628123456789" }).returning();
    const [binding] = await database
      .insert(virtualDevices)
      .values({ environmentId, deviceId: device!.id, alias: "a", status: "active" })
      .returning();

    await database.insert(outboundMessages).values([
      { virtualDeviceId: binding!.id, environmentId, engineMessageId: "m1", type: "text", recipient: "+1", acceptedAt: new Date(now.getTime() - 5 * 60_000) },
      { virtualDeviceId: binding!.id, environmentId, engineMessageId: "m2", type: "text", recipient: "+1", acceptedAt: new Date(now.getTime() - 1_000) },
    ]);

    const p = await samplePressure(database, now);
    expect(p.send.unackedOlderThanMinute).toBe(1);
    expect(p.send.acceptedLastHour).toBe(2);
  });
});

describe("pool occupancy", () => {
  test("groups devices by the pool holding them", async () => {
    // What forces a second process, and with it every deferred decision in
    // ADR-0003 and ADR-0005 at once.
    await database.insert(devices).values([
      { msisdn: "+628100000001", enginePoolId: "pool-1" },
      { msisdn: "+628100000002", enginePoolId: "pool-1" },
      { msisdn: "+628100000003", enginePoolId: "pool-2" },
      { msisdn: "+628100000004" },
    ]);
    const pools = (await samplePressure(database)).pools.sort((a, b) => a.poolId.localeCompare(b.poolId));
    expect(pools).toEqual([
      { poolId: "pool-1", devices: 2 },
      { poolId: "pool-2", devices: 1 },
    ]);
  });
});

describe("busy retries", () => {
  test("are reported as a rate, not a total", async () => {
    // A total grows for ever and stops meaning anything. A rate is comparable
    // between scrapes, which is what makes a trend visible.
    resetBusyWindow(new Date(Date.now() - 60_000));
    for (let i = 0; i < 30; i++) recordBusyRetry();
    const p = await samplePressure(database);
    expect(p.busyRetriesPerMinute).toBeGreaterThan(25);
    expect(p.busyRetriesPerMinute).toBeLessThan(35);
  });

  test("reset clears the window", async () => {
    for (let i = 0; i < 10; i++) recordBusyRetry();
    resetBusyWindow();
    expect((await samplePressure(database)).busyRetriesPerMinute).toBe(0);
  });
});

describe("guidance", () => {
  test("every signal has a threshold and a plain-language meaning", () => {
    // A metric with no threshold is a number nobody reads.
    for (const [name, g] of Object.entries(PRESSURE_GUIDANCE)) {
      expect(g.warn).toBeLessThan(g.act);
      expect(g.meaning.length).toBeGreaterThan(20);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
