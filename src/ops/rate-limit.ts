/**
 * Rate limiting, per API key and per device.
 *
 * The threat here is not a hostile stranger — it is a loop in one of our own
 * applications. A caller that retries in a tight loop can exhaust a device's
 * send allowance in seconds, and the consequence is not a 429 in a log: it is
 * WhatsApp flagging or restricting a *customer's phone number*. That damage is
 * done to someone who never made the mistake and cannot undo it.
 *
 * A fixed window rather than a sliding one. It permits a burst at a boundary —
 * up to twice the limit across two adjacent windows — and in exchange it is one
 * row and one statement, with no per-request scan. For protecting a phone
 * number from a runaway loop, stopping it within a window is what matters; the
 * boundary burst is not the failure mode.
 */
import { and, eq, lt, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import { rateLimits } from "../db/schema";

/** A named limit: how many, over how long. */
export interface Limit {
  bucket: string;
  max: number;
  windowMs: number;
}

/**
 * The limits that apply.
 *
 * Sends are the one that protects a customer's number; the others protect the
 * service from a caller that is simply misbehaving.
 */
export const LIMITS = {
  /** Messages per device per minute. Well above legitimate OTP traffic. */
  send: { bucket: "send", max: 60, windowMs: 60_000 },
  /** Claims per environment per minute — each one may message a phone holder. */
  claim: { bucket: "claim", max: 10, windowMs: 60_000 },
  /** Everything else, per key. Generous: this is a backstop, not a quota. */
  request: { bucket: "request", max: 600, windowMs: 60_000 },
} as const satisfies Record<string, Limit>;

export interface Decision {
  allowed: boolean;
  /** How many remain in this window. */
  remaining: number;
  /** When the window resets, for Retry-After. */
  resetAt: Date;
}

/**
 * Consume one unit against a limit.
 *
 * The insert-or-increment is a single statement, so two concurrent requests
 * cannot both read a count below the limit and both proceed — the race that
 * makes a naive read-then-write limiter leak roughly one request per concurrent
 * caller, which is most of them under exactly the load that triggers it.
 */
export function consume(
  subject: string,
  limit: Limit,
  now: Date = new Date(),
  database: Database = db(),
): Decision {
  const windowStart = new Date(Math.floor(now.getTime() / limit.windowMs) * limit.windowMs);
  const resetAt = new Date(windowStart.getTime() + limit.windowMs);

  const [row] = database.all<{ count: number }>(sql`
    INSERT INTO rate_limits (subject, bucket, window_start, count)
    VALUES (${subject}, ${limit.bucket}, ${windowStart.getTime()}, 1)
    ON CONFLICT (subject, bucket, window_start)
      DO UPDATE SET count = count + 1
    RETURNING count
  `);

  const count = Number(row?.count ?? 1);
  return { allowed: count <= limit.max, remaining: Math.max(0, limit.max - count), resetAt };
}

/**
 * Read a limit without consuming.
 *
 * For reporting the state on a response that is being allowed anyway, so a
 * caller can back off before it is refused rather than after.
 */
export function peek(
  subject: string,
  limit: Limit,
  now: Date = new Date(),
  database: Database = db(),
): Decision {
  const windowStart = new Date(Math.floor(now.getTime() / limit.windowMs) * limit.windowMs);
  const [row] = database.all<{ count: number }>(
    sql`SELECT count FROM rate_limits WHERE subject = ${subject} AND bucket = ${limit.bucket} AND window_start = ${windowStart.getTime()}`,
  );
  const count = Number(row?.count ?? 0);
  return {
    allowed: count < limit.max,
    remaining: Math.max(0, limit.max - count),
    resetAt: new Date(windowStart.getTime() + limit.windowMs),
  };
}

/**
 * Delete windows that have closed.
 *
 * Without this the table grows by one row per subject per window for ever.
 * Called on a timer; nothing depends on it being prompt.
 */
export async function sweep(olderThanMs = 3_600_000, now: Date = new Date(), database: Database = db()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const removed = await database.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff)).returning();
  return removed.length;
}

/** Clear one subject's counters. For tests, and for an operator unblocking a caller. */
export async function reset(subject: string, database: Database = db()): Promise<void> {
  await database.delete(rateLimits).where(eq(rateLimits.subject, subject));
}

export { and };
