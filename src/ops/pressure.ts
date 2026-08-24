/**
 * The four numbers that say when this architecture stops coping.
 *
 * ADR-0005 defers Postgres, a queue server and a second process until "a second
 * process needs the data". That is a sound trigger and a useless one on its
 * own, because nothing announces its arrival — you find out from a latency
 * complaint, which is late and comes with someone already annoyed.
 *
 * These are the signals that make the trigger observable. Deliberately four,
 * deliberately not a metrics stack: one JSON endpoint an operator can read, or
 * a scraper can poll, with no server to run.
 */
import { and, count as drizzleCount, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import { deliveries, devices, outboundMessages } from "../db/schema";

/** A counter that survives restarts is not needed here — trends are. */
let busyRetries = 0;
let busyRetriesSince = new Date();

/**
 * Record that SQLite made a writer wait.
 *
 * The most direct signal that one process is no longer enough: writers are
 * contending for a lock that only one of them can hold. Called from the busy
 * handler rather than inferred, because a retry that succeeded leaves no other
 * trace.
 */
export function recordBusyRetry(): void {
  busyRetries += 1;
}

export interface Pressure {
  /**
   * Whether the database answered at all.
   *
   * False means every count below is unknown rather than zero. An operator
   * reaching for this during a database incident is precisely who needs it,
   * and a 500 would tell them nothing they did not already suspect — while
   * zeros would actively mislead.
   */
  databaseReachable: boolean;

  /**
   * SQLITE_BUSY retries per minute.
   *
   * Above zero sustained means writers are contending. This is the number that
   * says "the single-writer assumption is now costing you", and it is the
   * trigger for the Postgres decision in ADR-0005.
   */
  busyRetriesPerMinute: number;

  /**
   * Deliveries waiting, and how old the oldest is.
   *
   * Depth alone is ambiguous — a burst looks like a backlog. Age is what
   * distinguishes them: a queue that is deep and young is working, a queue
   * with an old head is not draining, and only the second means the worker
   * cannot keep up.
   */
  queue: { pending: number; oldestPendingAgeMs: number | null; dead: number };

  /**
   * Send latency, split by where the time went.
   *
   * Total latency cannot tell you whether to change the database or the
   * engine. The split can: acceptance is our overhead, and the gap to the ack
   * is WhatsApp's.
   */
  send: { acceptedLastHour: number; unackedOlderThanMinute: number };

  /**
   * Devices held per engine pool, against capacity.
   *
   * What forces a second process, and with it every deferred decision in
   * ADR-0003 and ADR-0005 at once.
   */
  pools: Array<{ poolId: string; devices: number }>;

  /** Database file size, because a full disk is an outage with no warning. */
  databaseBytes: number;
}

/**
 * Sample the four signals.
 *
 * Every query is bounded and indexed; this runs on a scrape interval and must
 * not itself become the write contention it is measuring.
 */
export async function samplePressure(database?: Database, now: Date = new Date()): Promise<Pressure> {
  const elapsedMinutes = Math.max(1 / 60, (now.getTime() - busyRetriesSince.getTime()) / 60_000);
  const busyRetriesPerMinute = Number((busyRetries / elapsedMinutes).toFixed(2));

  try {
    // Resolved inside the try, not in a default parameter: opening the handle
    // is itself a thing that fails when the database is unreachable, and a
    // default argument is evaluated before any of this can catch it.
    return await sampleFromDatabase(database ?? db(), now, busyRetriesPerMinute);
  } catch {
    // Degraded rather than failed. The retry rate is process-local and still
    // meaningful — a spike in it is often *why* the database stopped
    // answering.
    return {
      databaseReachable: false,
      busyRetriesPerMinute,
      queue: { pending: 0, oldestPendingAgeMs: null, dead: 0 },
      send: { acceptedLastHour: 0, unackedOlderThanMinute: 0 },
      pools: [],
      databaseBytes: 0,
    };
  }
}

/** The part that needs a working database. */
async function sampleFromDatabase(
  database: Database,
  now: Date,
  busyRetriesPerMinute: number,
): Promise<Pressure> {
  const [pending] = await database
    .select({ n: drizzleCount(), oldest: sql<number | null>`MIN(${deliveries.nextAttemptAt})` })
    .from(deliveries)
    .where(eq(deliveries.state, "pending"));

  const [dead] = await database.select({ n: drizzleCount() }).from(deliveries).where(eq(deliveries.state, "dead"));

  const [accepted] = await database
    .select({ n: drizzleCount() })
    .from(outboundMessages)
    .where(gt(outboundMessages.acceptedAt, new Date(now.getTime() - 3_600_000)));

  const [unacked] = await database
    .select({ n: drizzleCount() })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.state, "accepted"),
        lt(outboundMessages.acceptedAt, new Date(now.getTime() - 60_000)),
      ),
    );

  const poolRows = await database
    .select({ poolId: devices.enginePoolId, n: drizzleCount() })
    .from(devices)
    .where(sql`${devices.enginePoolId} IS NOT NULL`)
    .groupBy(devices.enginePoolId);

  const oldestMs = pending?.oldest ?? null;

  return {
    databaseReachable: true,
    busyRetriesPerMinute,
    queue: {
      pending: Number(pending?.n ?? 0),
      oldestPendingAgeMs: oldestMs === null ? null : Math.max(0, now.getTime() - Number(oldestMs)),
      dead: Number(dead?.n ?? 0),
    },
    send: {
      acceptedLastHour: Number(accepted?.n ?? 0),
      unackedOlderThanMinute: Number(unacked?.n ?? 0),
    },
    pools: poolRows.map((r) => ({ poolId: String(r.poolId), devices: Number(r.n) })),
    databaseBytes: await databaseSize(database),
  };
}

/**
 * Page count times page size — cheaper than stat, and correct with WAL.
 *
 * A PRAGMA names its result column after itself, not `n`. Aliasing it wrong
 * returned 0, which is a plausible-looking answer for an empty database and
 * would have read as "no growth" rather than "not measured" — the kind of
 * metric that is worse than none.
 */
async function databaseSize(database: Database): Promise<number> {
  try {
    const [pages] = database.all<{ page_count: number }>(sql`PRAGMA page_count`);
    const [size] = database.all<{ page_size: number }>(sql`PRAGMA page_size`);
    return Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Thresholds worth acting on, and what each one means.
 *
 * Written down beside the numbers because a metric with no threshold is a
 * number nobody reads. These are starting points to be revised once there is
 * real traffic to compare against — the point is that the conversation happens
 * against evidence rather than at 3am.
 */
export const PRESSURE_GUIDANCE = {
  busyRetriesPerMinute: { warn: 1, act: 10, meaning: "writers are contending; see ADR-0005" },
  oldestPendingAgeMs: { warn: 30_000, act: 300_000, meaning: "the delivery worker is not keeping up" },
  unackedOlderThanMinute: { warn: 5, act: 50, meaning: "sends accepted but never acknowledged; a device may be silently offline" },
  devicesPerPool: { warn: 20, act: 25, meaning: "pool nearing capacity; a second process is next" },
} as const;

/** Reset the retry counter and its window. Called after each scrape. */
export function resetBusyWindow(now: Date = new Date()): void {
  busyRetries = 0;
  busyRetriesSince = now;
}

export { isNull };
