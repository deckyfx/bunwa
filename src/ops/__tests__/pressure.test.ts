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
import { ProjectStore } from "../../stores/project-store";
import { PRESSURE_GUIDANCE, recordBusyRetry, resetBusyWindow, samplePressure } from "../pressure";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

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
  restoreEnv();
});

describe("a quiet system", () => {
  test("reports zeros rather than nulls or absent fields", async () => {
    const p = await samplePressure(database);
    expect(p.busyRetriesPerMinute).toBe(0);
    expect(p.queue).toEqual({ pending: 0, oldestPendingAgeMs: null, oldestOverdueMs: null, dead: 0 });
    expect(p.pools).toEqual([]);
  });

  test("reports a real database size", async () => {
    // A PRAGMA names its result column after itself. Aliasing it wrong returned
    // 0, which reads as "no growth" rather than "not measured" — a metric worse
    // than none, because it is quietly reassuring.
    expect((await samplePressure(database)).databaseBytes).toBeGreaterThan(0);
  });

  test("counts the WAL, where an unchecked disk actually fills", async () => {
    // The blind spot this metric had: a reader holding a transaction open
    // blocks checkpointing, so writes pile into the -wal sidecar while the
    // main file barely moves. page_count measures only the main file, so the
    // reading stayed low in the one situation that fills a disk without any
    // table growing — measured at 20.5 MB reported against 62.7 MB on disk.
    const path = join(dir, "wal-growth.sqlite");
    const writer = createDatabase(path);
    await MigrationManager.runMigrations(writer);

    const before = (await samplePressure(writer)).databaseBytes;

    // A second connection pinning the read snapshot, so nothing checkpoints.
    const reader = createDatabase(path);
    reader.$client.exec("BEGIN");
    reader.$client.query("SELECT count(*) FROM projects").get();

    try {
      const blob = "x".repeat(4000);
      for (let i = 0; i < 400; i++) {
        await ProjectStore.create({ slug: `bulk-${i}`, displayName: blob }, writer);
      }

      const walBytes = Bun.file(`${path}-wal`).size;
      expect(walBytes).toBeGreaterThan(0);

      const after = (await samplePressure(writer)).databaseBytes;
      // The growth must be visible, and it must account for the sidecar.
      expect(after).toBeGreaterThan(before);
      expect(after).toBeGreaterThanOrEqual(walBytes);
    } finally {
      reader.$client.exec("ROLLBACK");
      reader.$client.close();
      writer.$client.close();
    }
  });
});

describe("queue depth versus age", () => {
  test("distinguishes a burst from a backlog", async () => {
    // Depth alone is ambiguous: a burst and a stuck queue look identical. Age
    // is what separates "working hard" from "not draining".
    const now = new Date(1_000_000);
    await database.insert(deliveries).values([
      {
        environmentId, eventId: "e1", eventType: "message.received", payload: {},
        createdAt: new Date(now.getTime() - 5 * 60_000),
        nextAttemptAt: new Date(now.getTime() - 5 * 60_000),
      },
      {
        environmentId, eventId: "e2", eventType: "message.received", payload: {},
        createdAt: new Date(now.getTime() - 1_000),
        nextAttemptAt: new Date(now.getTime() - 1_000),
      },
    ]);

    const p = await samplePressure(database, now);
    expect(p.queue.pending).toBe(2);
    expect(p.queue.oldestPendingAgeMs).toBe(5 * 60_000);
    // Old enough to have crossed the "act" line, which is the point of the age.
    expect(p.queue.oldestPendingAgeMs!).toBeGreaterThanOrEqual(PRESSURE_GUIDANCE.oldestPendingAgeMs.act);
  });

  test("a queue stuck in backoff still reports its age", async () => {
    // The state this field exists to detect, and the one it used to miss.
    // Every delivery has failed repeatedly, so each nextAttemptAt sits in the
    // future; deriving the age from it clamped to 0 and reported the most
    // broken queue as the healthiest reading available.
    const now = new Date(2_000_000);
    await database.insert(deliveries).values([
      {
        environmentId, eventId: "b1", eventType: "message.received", payload: {},
        createdAt: new Date(now.getTime() - 30 * 60_000),
        nextAttemptAt: new Date(now.getTime() + 8 * 60_000),
        attemptCount: 7,
      },
    ]);

    const p = await samplePressure(database, now);
    expect(p.queue.pending).toBe(1);
    expect(p.queue.oldestPendingAgeMs).toBe(30 * 60_000);
    expect(p.queue.oldestPendingAgeMs!).toBeGreaterThanOrEqual(PRESSURE_GUIDANCE.oldestPendingAgeMs.act);
    // Not yet due, so nothing is overdue — the two signals disagree on
    // purpose, and only one of them means the queue is not draining.
    expect(p.queue.oldestOverdueMs).toBe(0);
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
    resetBusyWindow();
    for (let i = 0; i < 30; i++) recordBusyRetry();
    const p = await samplePressure(database);
    expect(p.busyRetriesPerMinute).toBeGreaterThan(25);
    expect(p.busyRetriesPerMinute).toBeLessThan(35);
  });

  test("a partial window does not extrapolate one retry into an alert", async () => {
    // The window rotates inside samplePressure, so the gap between a rotation
    // and the next sample can be milliseconds — two scrapers, or a health
    // check landing just after one. With a one-second floor on the
    // denominator, a single retry 200ms in reported 60.00/min: six times the
    // act threshold, from one event, on the number ADR-0005's trigger rests on.
    const now = new Date();
    resetBusyWindow();
    recordBusyRetry();

    const p = await samplePressure(database, now);
    expect(p.busyRetriesPerMinute).toBeLessThan(PRESSURE_GUIDANCE.busyRetriesPerMinute.act);
    // One retry in a window is one per window, not sixty.
    expect(p.busyRetriesPerMinute).toBeCloseTo(1, 2);
  });

  test("a partial window still surfaces real contention", async () => {
    // The floor must not hide a genuine burst: not extrapolating is not the
    // same as under-reporting.
    const now = new Date();
    resetBusyWindow();
    for (let i = 0; i < 100; i++) recordBusyRetry();

    const p = await samplePressure(database, now);
    expect(p.busyRetriesPerMinute).toBeGreaterThan(PRESSURE_GUIDANCE.busyRetriesPerMinute.act);
  });

  test("reading the rate does not change it", async () => {
    // Two scrapers, a health check, anything at all: sampling must not consume
    // what it reports. The first version reset inside GET /metrics, which any
    // unauthenticated caller could drive; the second moved the reset into
    // samplePressure, which only narrowed the window in which a second reader
    // saw 0 for a period it had every right to observe — while the comment
    // claimed the sampling was non-destructive.
    resetBusyWindow();
    for (let i = 0; i < 20; i++) recordBusyRetry();

    const first = (await samplePressure(database)).busyRetriesPerMinute;
    const second = (await samplePressure(database)).busyRetriesPerMinute;
    const third = (await samplePressure(database)).busyRetriesPerMinute;

    expect(first).toBeGreaterThan(0);
    expect(second, "a second scrape saw a different number").toBe(first);
    expect(third).toBe(first);
  });

  test("retries older than the window fall out of the rate", async () => {
    // Bounded history, not a total: the ring holds one slot per second and a
    // slot whose second has aged out reads as empty without anyone clearing it.
    resetBusyWindow();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    for (let i = 0; i < 50; i++) recordBusyRetry(longAgo);

    expect((await samplePressure(database)).busyRetriesPerMinute).toBe(0);
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
