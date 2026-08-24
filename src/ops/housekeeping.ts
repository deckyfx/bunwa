/**
 * Periodic work nothing else owns.
 *
 * Three jobs that were each written during stage 1 and never scheduled — the
 * functions existed, the tests passed, and nothing called them. Two of those
 * were tables growing without bound; the third was the check that turns a
 * silent send failure into an event, which is the whole answer to a measured
 * 203-second window in which gowa reports a device connected while it cannot
 * deliver (docs/12).
 *
 * A defined-but-uncalled sweep is worse than no sweep, because the code reads
 * as though the problem is handled.
 */
import { and, eq, lt } from "drizzle-orm";

import { db, type Database } from "../db";
import { outboundMessages, virtualDevices } from "../db/schema";
import { DeliveryStore } from "../stores/delivery-store";
import { IdempotencyStore } from "../stores/idempotency-store";
import { MessageStore, ACK_TIMEOUT_MS } from "../stores/message-store";
import { EVENT_SCHEMA_VERSION } from "../events/schema";
import { sweep as sweepRateLimits } from "./rate-limit";
import { log } from "../observability/logger";

export interface HousekeepingResult {
  idempotencyKeysRemoved: number;
  rateLimitRowsRemoved: number;
  messagesMarkedUndelivered: number;
}

/**
 * Raise `message.undelivered` for sends that were accepted and never acked.
 *
 * This is the one that matters. A send returning 202 means the engine took the
 * message, and for up to 203 seconds after a silent disconnect that says
 * nothing about whether WhatsApp did. Without this the API reports success, the
 * OTP never arrives, and nothing anywhere reports a problem — the customer
 * finds out, and the project finds out from the customer.
 */
export async function sweepUnacked(
  database: Database = db(),
  now: Date = new Date(),
): Promise<number> {
  const stale = await MessageStore.findUnacked(ACK_TIMEOUT_MS, now, 500, database);
  if (stale.length === 0) return 0;

  for (const message of stale) {
    await MessageStore.markUndelivered(message.environmentId, message.id, database);

    // Delivered as an event, not only recorded. A project that sent an OTP
    // needs to hear that it did not arrive while it can still act — resend, or
    // fall back to another channel.
    const [binding] = await database
      .select({ alias: virtualDevices.alias })
      .from(virtualDevices)
      .where(eq(virtualDevices.id, message.virtualDeviceId))
      .limit(1);

    await DeliveryStore.enqueue(
      message.environmentId,
      {
        schema: EVENT_SCHEMA_VERSION,
        id: `undelivered-${message.id}`,
        type: "message.undelivered",
        occurred_at: now.toISOString(),
        environment: { id: message.environmentId, slug: "" },
        project: { id: "", slug: "" },
        data: {
          message_id: message.id,
          engine_message_id: message.engineMessageId,
          virtual_device: binding?.alias ?? null,
          accepted_at: message.acceptedAt.toISOString(),
          waited_ms: now.getTime() - message.acceptedAt.getTime(),
        },
        meta: { origin: "bunwa" },
      },
      database,
    );
  }

  log.warn("messages accepted but never acknowledged", { count: stale.length });
  return stale.length;
}

/** Run every job once. Exported so a test can drive it without a timer. */
export async function runHousekeeping(
  database: Database = db(),
  now: Date = new Date(),
): Promise<HousekeepingResult> {
  const [idempotencyKeysRemoved, rateLimitRowsRemoved, messagesMarkedUndelivered] = await Promise.all([
    IdempotencyStore.sweep(database, now),
    sweepRateLimits(3_600_000, now, database),
    sweepUnacked(database, now),
  ]);

  return { idempotencyKeysRemoved, rateLimitRowsRemoved, messagesMarkedUndelivered };
}

/** How often to run. Frequent enough that an undelivered OTP is noticed quickly. */
export const HOUSEKEEPING_INTERVAL_MS = 30_000;

/**
 * Start the loop. Returns a function that stops it and awaits the pass in flight.
 *
 * Self-scheduling rather than setInterval: a pass can exceed the interval, and
 * two overlapping passes would both try to mark the same message undelivered
 * and enqueue the event twice.
 */
export function startHousekeeping(
  database: Database = db(),
  intervalMs = HOUSEKEEPING_INTERVAL_MS,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    inFlight = runHousekeeping(database).catch((err: unknown) => {
      // A failed pass must not kill the loop: the next one may succeed, and a
      // dead housekeeper is silent by nature.
      log.error("housekeeping pass failed", err);
    });
    await inFlight;
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  timer = setTimeout(() => void tick(), intervalMs);

  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await inFlight;
  };
}

export { and, lt, outboundMessages };
