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
/**
 * Window length seen for each bucket, to catch two limits sharing one.
 *
 * A row is identified by (subject, bucket, window_start), so two Limits using
 * the same bucket with different windows share rows whenever their windows
 * align. Reproduced: a 60s and a 2h limit on one bucket both wrote window_start
 * 0; the row kept the 60s expiry, the sweep collected it while the 2h window
 * was still open, and the next consume() returned allowed for a budget that
 * had already been spent.
 *
 * A bucket is the identity of a limit, so two windows for one bucket is a
 * configuration error rather than a case to support. Refused loudly here
 * rather than encoded into the primary key, which would need a table rebuild
 * to express something no caller should be doing.
 */
const bucketWindows = new Map<string, number>();

/** Reset the bucket registry. Tests define ad-hoc limits; production does not. */
export function resetBucketRegistry(): void {
  bucketWindows.clear();
}

function assertBucketIsStable(limit: Limit): void {
  const seen = bucketWindows.get(limit.bucket);
  if (seen === undefined) {
    bucketWindows.set(limit.bucket, limit.windowMs);
    return;
  }
  if (seen !== limit.windowMs) {
    throw new RangeError(
      `bucket "${limit.bucket}" is already using a ${seen}ms window; ` +
        `a second limit cannot reuse it with ${limit.windowMs}ms`,
    );
  }
}

export function consume(
  subject: string,
  limit: Limit,
  now: Date = new Date(),
  database: Database = db(),
): Decision {
  assertBucketIsStable(limit);
  const windowStart = new Date(Math.floor(now.getTime() / limit.windowMs) * limit.windowMs);
  const resetAt = new Date(windowStart.getTime() + limit.windowMs);

  const [row] = database.all<{ count: number }>(sql`
    INSERT INTO rate_limits (subject, bucket, window_start, expires_at, count)
    VALUES (${subject}, ${limit.bucket}, ${windowStart.getTime()}, ${resetAt.getTime()}, 1)
    ON CONFLICT (subject, bucket, window_start)
      -- expires_at can only grow. The claim this replaced — that reaching a
      -- row means the same alignment and therefore the same expiry — is false
      -- whenever one window is a multiple of another, and 2h is exactly 120
      -- times 60s, so their aligned starts coincide.
      --
      -- assertBucketIsStable catches that within a process, but it has no
      -- memory across a restart. Reproduced: a deploy narrowing "otp" from 60s
      -- to 2h wrote count onto the surviving 60s row, keeping its one-minute
      -- expiry; the sweep then collected a live 2h window and the next
      -- consume() started from zero.
      DO UPDATE SET count = count + 1, expires_at = MAX(rate_limits.expires_at, excluded.expires_at)
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
  // Guarded as well as consume. Skipping it here was reasoned as "peek does
  // not write, so it cannot corrupt a row" — true, and beside the point: a
  // mismatched window makes peek compute a different windowStart, read a
  // different row, and return remaining and resetAt for a window the caller is
  // not in. Those become the caller's Retry-After.
  assertBucketIsStable(limit);
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
 *
 * Deletes on the stored window end, not on windowStart against a fixed
 * retention. The previous form was correct only while every limit's window was
 * shorter than the retention — an invariant nothing enforced, on a function
 * that accepts any exported Limit. A window longer than the retention had its
 * live row deleted mid-window, and the next consume() restarted the count from
 * zero: a rate limiter that stops limiting precisely for the callers given the
 * longest windows.
 *
 * `olderThanMs` is a grace period after the window closes, not a guess at how
 * long a window lasts.
 */
export async function sweep(olderThanMs = 3_600_000, now: Date = new Date(), database: Database = db()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const removed = await database.delete(rateLimits).where(lt(rateLimits.expiresAt, cutoff)).returning();
  return removed.length;
}

/** Clear one subject's counters. For tests, and for an operator unblocking a caller. */
export async function reset(subject: string, database: Database = db()): Promise<void> {
  await database.delete(rateLimits).where(eq(rateLimits.subject, subject));
}
