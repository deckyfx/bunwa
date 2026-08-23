/**
 * The delivery worker.
 *
 * Claims due deliveries, attempts them, and applies the retry and circuit
 * policy. In-process for now: with one process there is nothing to coordinate,
 * and moving it out is the same trigger as moving off SQLite (ADR-0005).
 */
import { eq, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import { environmentWebhooks } from "../db/schema";
import { DeliveryStore } from "../stores/delivery-store";
import { log, withContext } from "../observability/logger";
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_PROBE_AFTER_MS, circuitAllows, nextAttemptAt } from "./backoff";
import { send, type SendOptions } from "./sender";

export interface WorkerOptions extends SendOptions {
  /** How many deliveries to attempt per tick. */
  batchSize?: number;
  /** Cap per environment within a tick, so one backlog cannot fill the batch. */
  maxPerEnvironment?: number;
  /** How often to look for due work. */
  intervalMs?: number;
  database?: Database;
}

/**
 * Run one pass. Returns how many deliveries were attempted.
 *
 * Exported separately from the loop so tests can drive it deterministically
 * rather than waiting on a timer.
 */
export async function runOnce(options: WorkerOptions = {}): Promise<number> {
  const database = options.database ?? db();
  const now = new Date();
  const batchSize = options.batchSize ?? 20;
  const perEnvironment = options.maxPerEnvironment ?? Math.max(1, Math.floor(batchSize / 4));

  // Over-claim, then cap per environment. claimDue orders globally by due time,
  // so one environment with a long backlog would otherwise fill every batch and
  // no other tenant would be served at all until it drained.
  const claimed = await DeliveryStore.claimDue(batchSize * 4, now, database);
  const seenPerEnvironment = new Map<string, number>();
  const due = claimed.filter((item) => {
    const count = seenPerEnvironment.get(item.delivery.environmentId) ?? 0;
    if (count >= perEnvironment) return false;
    seenPerEnvironment.set(item.delivery.environmentId, count + 1);
    return true;
  }).slice(0, batchSize);

  // claimDue only selects; nothing is marked, so the surplus stays due and is
  // simply re-selected next pass. That is correct rather than a leak — but it
  // is worth stating, because "claim" implies a lease and this is not one.
  // If it ever becomes one, everything filtered out here must be released.

  let attempted = 0;
  for (const item of due) {
    const [webhook] = await database
      .select()
      .from(environmentWebhooks)
      .where(eq(environmentWebhooks.environmentId, item.delivery.environmentId))
      .limit(1);
    // Deferred rather than skipped. `claimDue` orders globally by
    // nextAttemptAt, so leaving a blocked environment's rows due meant its
    // twenty oldest deliveries filled every batch and no other tenant was
    // served at all until the circuit closed.
    if (webhook === undefined) {
      // Terminal, not deferred. The join in claimDue requires a webhook row, so
      // reaching here means it was deleted mid-pass — there is nowhere to send
      // this and retrying forever would hide that rather than surface it.
      await DeliveryStore.recordAttempt(
        item.delivery.id,
        { ok: false, statusCode: null, error: "no webhook is configured for this environment", durationMs: 0 },
        { state: "dead", nextAttemptAt: null },
        database,
      );
      log.warn("delivery dead-lettered: webhook removed", { deliveryId: item.delivery.id });
      continue;
    }
    if (!circuitAllows(webhook.circuitState, webhook.circuitOpenedAt, now)) {
      await DeliveryStore.defer(item.delivery.id, new Date(now.getTime() + CIRCUIT_PROBE_AFTER_MS), database);
      continue;
    }

    attempted += 1;
    const body = JSON.stringify(item.delivery.payload);

    // Each delivery gets the event id as its correlation id, so the send, its
    // retries and the original event all join up in the log.
    const outcome = await withContext({ correlationId: item.delivery.eventId }, () =>
      send(item.url, body, item.secret, options),
    );

    if (outcome.ok) {
      await DeliveryStore.recordAttempt(item.delivery.id, outcome, { state: "delivered", nextAttemptAt: null }, database);
      await closeCircuit(item.delivery.environmentId, database);
      log.debug("delivered", { deliveryId: item.delivery.id, statusCode: outcome.statusCode });
      continue;
    }

    const attemptCount = item.delivery.attemptCount + 1;
    const retryAt = nextAttemptAt(attemptCount, item.maxAttempts, now);
    await DeliveryStore.recordAttempt(
      item.delivery.id,
      outcome,
      retryAt === null ? { state: "dead", nextAttemptAt: null } : { state: "pending", nextAttemptAt: retryAt },
      database,
    );
    await recordFailure(item.delivery.environmentId, now, database);

    if (retryAt === null) {
      // Dead-lettered, not lost: the row and its attempts remain, and the
      // dashboard can replay it.
      log.warn("delivery dead-lettered", {
        deliveryId: item.delivery.id,
        attempts: attemptCount,
        statusCode: outcome.statusCode,
      });
    }
  }

  return attempted;
}

/** A success closes the circuit and clears the failure run. */
async function closeCircuit(environmentId: string, database: Database): Promise<void> {
  await database
    .update(environmentWebhooks)
    .set({ circuitState: "closed", circuitOpenedAt: null, consecutiveFailures: 0, updatedAt: new Date() })
    .where(eq(environmentWebhooks.environmentId, environmentId));
}

/** A failure advances the run and may open the circuit. */
async function recordFailure(environmentId: string, now: Date, database: Database): Promise<void> {
  const [updated] = await database
    .update(environmentWebhooks)
    .set({ consecutiveFailures: sql`${environmentWebhooks.consecutiveFailures} + 1`, updatedAt: now })
    .where(eq(environmentWebhooks.environmentId, environmentId))
    .returning();

  if (updated !== undefined && updated.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    // circuitOpenedAt is advanced on *every* failure while open, not only on
    // the transition. Setting it once meant the probe window elapsed and never
    // re-armed: sixty seconds after opening, the breaker let every delivery
    // through again and stayed that way however hard the target kept failing.
    await database
      .update(environmentWebhooks)
      .set({ circuitState: "open", circuitOpenedAt: now, updatedAt: now })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    if (updated.circuitState !== "open") {
      log.warn("webhook circuit opened", { environmentId, consecutiveFailures: updated.consecutiveFailures });
    }
  }
}

/**
 * Start the loop.
 *
 * Returns a stop function that **awaits the pass in flight**. Stopping only
 * future scheduling let shutdown call process.exit while a webhook request or
 * a state update was still running — the delivery would be recorded as
 * attempted, or not recorded at all, depending on where it was cut.
 */
export function startWorker(options: WorkerOptions = {}): () => Promise<void> {
  const interval = options.intervalMs ?? 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      inFlight = runOnce(options).then(() => undefined);
      await inFlight;
    } catch (err) {
      // A failed pass must not kill the loop: the next tick may succeed, and a
      // dead worker silently stops every tenant's delivery.
      log.error("delivery worker pass failed", err);
    }
    // Self-scheduling rather than setInterval: a pass can exceed the interval,
    // and overlapping passes would attempt the same delivery twice.
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };

  timer = setTimeout(() => void tick(), interval);
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    // Swallowed: a pass that fails during shutdown has already been logged, and
    // rejecting here would stop the rest of the shutdown from running.
    await inFlight.catch(() => undefined);
  };
}
