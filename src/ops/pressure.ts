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

import { db, pathOf, type Database } from "../db";
import { deliveries, devices, outboundMessages } from "../db/schema";

/** A counter that survives restarts is not needed here — trends are. */
let busyRetries = 0;
let busyRetriesSince = new Date();
/** Never reset. What a scraper should difference to get a rate it can trust. */
let busyRetriesTotal = 0;

/**
 * How long a contention window runs before it rolls.
 *
 * The window advances on elapsed time, never on being read. It used to reset
 * on every GET /metrics, which is unauthenticated: a second scraper, a health
 * check, or anyone at all could clear the count between samples and hold the
 * reported rate near zero while contention was real.
 */
const BUSY_WINDOW_MS = 60_000;

/**
 * Record that acquiring the write lock took measurably long.
 *
 * The most direct signal that one process is no longer enough: writers are
 * contending for a lock that only one of them can hold.
 *
 * This is a threshold on observed wait, not a count of SQLITE_BUSY events.
 * `PRAGMA busy_timeout` retries inside SQLite and exposes no handler to count,
 * so the only thing visible from out here is how long `BEGIN IMMEDIATE` took —
 * see LOCK_WAIT_THRESHOLD_MS in db/transaction.ts. A disk stall or a GC pause
 * crossing that threshold is counted too. ADR-0005's trigger depends on this
 * number, so it must not be read as an exact busy count.
 */
export function recordBusyRetry(): void {
  busyRetries += 1;
  busyRetriesTotal += 1;
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
  queue: {
    pending: number;
    /** Age of the oldest pending delivery, measured from when it was enqueued. */
    oldestPendingAgeMs: number | null;
    /** How far past its scheduled attempt the most overdue delivery is; 0 while merely backing off. */
    oldestOverdueMs: number | null;
    dead: number;
  };

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
  // Rolls on time rather than on read, so sampling is non-destructive and two
  // readers within one window agree.
  const elapsedMs = now.getTime() - busyRetriesSince.getTime();
  // Never extrapolate from a partial window. The floor used to be one second,
  // so a single retry sampled 200ms after a rotation reported 60.00/min —
  // six times PRESSURE_GUIDANCE.busyRetriesPerMinute.act, from one event. Two
  // scrapers polling a few hundred milliseconds apart were enough, and this
  // number is what ADR-0005's Postgres trigger rests on.
  //
  // Dividing by a whole window rather than by a tenth of one, which would
  // still report exactly the act threshold for that single retry. It hides
  // nothing real: 100 retries in ten seconds still reports 100/min.
  const elapsedMinutes = Math.max(BUSY_WINDOW_MS, elapsedMs) / 60_000;
  const busyRetriesPerMinute = Number((busyRetries / elapsedMinutes).toFixed(2));
  if (elapsedMs >= BUSY_WINDOW_MS) {
    busyRetries = 0;
    busyRetriesSince = now;
  }

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
      queue: { pending: 0, oldestPendingAgeMs: null, oldestOverdueMs: null, dead: 0 },
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
    .select({
      n: drizzleCount(),
      // Enqueue time, not next-attempt time. nextAttemptAt is in the future
      // for anything under exponential backoff, so a queue where every
      // delivery has failed repeatedly reported an age of 0 — the reading
      // that means "healthy" for the one state this field exists to detect.
      oldest: sql<number | null>`MIN(${deliveries.createdAt})`,
      // Kept separately because it answers a different question: how far past
      // due the most overdue delivery is, which is 0 while backoff is simply
      // waiting.
      mostOverdue: sql<number | null>`MIN(${deliveries.nextAttemptAt})`,
    })
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
  const mostOverdueMs = pending?.mostOverdue ?? null;

  return {
    databaseReachable: true,
    busyRetriesPerMinute,
    queue: {
      pending: Number(pending?.n ?? 0),
      oldestPendingAgeMs: oldestMs === null ? null : Math.max(0, now.getTime() - Number(oldestMs)),
      oldestOverdueMs: mostOverdueMs === null ? null : Math.max(0, now.getTime() - Number(mostOverdueMs)),
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
 * Bytes this database occupies on disk, sidecars included.
 *
 * `page_count * page_size` measures the main file only, and the comment here
 * used to claim that was "correct with WAL". It is not. Measured: a reader
 * holding a transaction open blocks checkpointing, and after 5000 inserts the
 * PRAGMA reported 20.5 MB while the main file held 4 KB and the -wal sidecar
 * held 62.7 MB. This signal exists to warn before the disk fills, and it was
 * blindest in the one situation that fills a disk without any table growing.
 *
 * A PRAGMA also names its result column after itself, not `n`. Aliasing it
 * wrong returned 0 — a plausible-looking answer for an empty database, reading
 * as "no growth" rather than "not measured".
 */
async function databaseSize(database: Database): Promise<number> {
  const path = pathOf(database);

  if (path !== undefined && path !== ":memory:") {
    // The -shm file is counted too: small and bounded, but real disk, and the
    // point of this number is what the filesystem sees.
    //
    // Bun.file().size rather than node:fs stat, per the project's preference
    // for Bun natives. Verified equivalent for what this needs: 0 for a
    // missing sidecar and for a path under a regular file, and byte-exact
    // against stat on a live 37MB WAL held open by a reader.
    const total = [path, `${path}-wal`, `${path}-shm`].reduce(
      (sum, file) => sum + Bun.file(file).size,
      0,
    );
    if (total > 0) return total;
  }

  // In-memory, or a handle whose path is unknown: the logical size is the only
  // answer available, and the right one when there is no file at all.
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

/**
 * Reset the retry counter and its window to a known state.
 *
 * No longer called after each scrape — that is what made GET /metrics
 * destructive, and samplePressure now rotates the window on elapsed time
 * instead. This remains only so a test can pin the window's start, which is
 * otherwise process-global state shared between test files.
 */
export function resetBusyWindow(now: Date = new Date()): void {
  busyRetries = 0;
  busyRetriesSince = now;
}

/** The monotonic total, for a scraper that would rather difference it itself. */
export function busyRetryTotal(): number {
  return busyRetriesTotal;
}

export { isNull };
