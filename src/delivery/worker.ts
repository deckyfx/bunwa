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
import { CIRCUIT_FAILURE_THRESHOLD, circuitAllows, nextAttemptAt } from "./backoff";
import { send, type SendOptions } from "./sender";

export interface WorkerOptions extends SendOptions {
  /** How many deliveries to attempt per tick. */
  batchSize?: number;
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
  const due = await DeliveryStore.claimDue(options.batchSize ?? 20, now, database);

  let attempted = 0;
  for (const item of due) {
    const [webhook] = await database
      .select()
      .from(environmentWebhooks)
      .where(eq(environmentWebhooks.environmentId, item.delivery.environmentId))
      .limit(1);
    if (webhook === undefined) continue;

    // An open circuit stops the worker spending itself on a target that is
    // reliably failing, which would otherwise starve every other tenant.
    if (!circuitAllows(webhook.circuitState, webhook.circuitOpenedAt, now)) continue;

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

  if (updated !== undefined && updated.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && updated.circuitState !== "open") {
    await database
      .update(environmentWebhooks)
      .set({ circuitState: "open", circuitOpenedAt: now, updatedAt: now })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    log.warn("webhook circuit opened", { environmentId, consecutiveFailures: updated.consecutiveFailures });
  }
}

/** Start the loop. Returns a function that stops it. */
export function startWorker(options: WorkerOptions = {}): () => void {
  const interval = options.intervalMs ?? 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runOnce(options);
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
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
