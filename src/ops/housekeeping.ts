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
import { withTransaction } from "../db/transaction";
import { environments, outboundMessages, projects, virtualDevices } from "../db/schema";
import { DeliveryStore } from "../stores/delivery-store";
import { IdempotencyStore } from "../stores/idempotency-store";
import { MessageStore, ACK_TIMEOUT_MS } from "../stores/message-store";
import { EVENT_SCHEMA_VERSION } from "../events/schema";
import { sweep as sweepRateLimits } from "./rate-limit";
import { log } from "../observability/logger";

/** The tenant identity an event envelope must carry, resolved from one join. */
interface EnvelopeIdentity {
  environmentSlug: string;
  projectId: string;
  projectSlug: string;
}

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

  // Resolved once per environment rather than per message: a batch is usually
  // one environment's backlog, and the envelope needs the project identity that
  // only this join carries. Building it with empty slugs — as this first did —
  // hands the tenant an event they cannot attribute, the same fault already
  // fixed in the engine consumer's fan-out.
  const identities = new Map<string, EnvelopeIdentity | null>();
  async function identityFor(environmentId: string): Promise<EnvelopeIdentity | null> {
    const cached = identities.get(environmentId);
    if (cached !== undefined) return cached;

    const [row] = await database
      .select({
        environmentSlug: environments.slug,
        projectId: environments.projectId,
        projectSlug: projects.slug,
      })
      .from(environments)
      .innerJoin(projects, eq(environments.projectId, projects.id))
      .where(eq(environments.id, environmentId))
      .limit(1);

    const identity = row ?? null;
    identities.set(environmentId, identity);
    return identity;
  }

  let marked = 0;
  for (const message of stale) {
    try {
      const identity = await identityFor(message.environmentId);
      if (identity === null) {
        // The environment was deleted under the message. Nothing to notify.
        log.warn("skipping undelivered sweep for a missing environment", {
          messageId: message.id,
          environmentId: message.environmentId,
        });
        continue;
      }

      const [binding] = await database
        .select({ alias: virtualDevices.alias })
        .from(virtualDevices)
        .where(eq(virtualDevices.id, message.virtualDeviceId))
        .limit(1);

      // The state change and the event commit together. Marked-then-crashed
      // loses the event permanently, because the next pass filters the
      // undelivered state out and no later sweep can raise it.
      const transitioned = await withTransaction(database, async (tx) => {
        const changed = await MessageStore.markUndelivered(message.environmentId, message.id, tx);
        // An ack can land between the select and here. The update then matches
        // no row, and enqueuing anyway would report a delivered message as
        // undelivered.
        if (!changed) return false;

        await DeliveryStore.enqueue(
          message.environmentId,
          {
            schema: EVENT_SCHEMA_VERSION,
            id: `undelivered-${message.id}`,
            type: "message.undelivered",
            occurred_at: now.toISOString(),
            environment: { id: message.environmentId, slug: identity.environmentSlug },
            project: { id: identity.projectId, slug: identity.projectSlug },
            data: {
              message_id: message.id,
              engine_message_id: message.engineMessageId,
              virtual_device: binding?.alias ?? null,
              accepted_at: message.acceptedAt.toISOString(),
              waited_ms: now.getTime() - message.acceptedAt.getTime(),
            },
            meta: { origin: "bunwa" },
          },
          tx,
        );
        return true;
      });

      if (transitioned) marked++;
    } catch (err) {
      // Per message, so one failure does not abandon the rest of the batch —
      // every remaining OTP in it would otherwise stay silently unreported.
      log.error("failed to raise message.undelivered", err, { messageId: message.id });
    }
  }

  if (marked > 0) log.warn("messages accepted but never acknowledged", { count: marked });
  return marked;
}

/** Run every job once. Exported so a test can drive it without a timer. */
export async function runHousekeeping(
  database: Database = db(),
  now: Date = new Date(),
): Promise<HousekeepingResult> {
  // allSettled, not all: these jobs are independent, and Promise.all would
  // discard a successful undelivered sweep because an unrelated idempotency
  // sweep threw. The one that matters is the one whose result would be lost.
  const jobs = ["idempotency", "rateLimits", "unacked"] as const;
  const settled = await Promise.allSettled([
    IdempotencyStore.sweep(database, now),
    sweepRateLimits(3_600_000, now, database),
    sweepUnacked(database, now),
  ]);

  const [idempotencyKeysRemoved, rateLimitRowsRemoved, messagesMarkedUndelivered] = settled.map(
    (outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      log.error("housekeeping job failed", outcome.reason, { job: jobs[i] });
      return 0;
    },
  ) as [number, number, number];

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
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    inFlight = runHousekeeping(database)
      .then(() => undefined)
      .catch((err: unknown) => {
        // A failed pass must not kill the loop: the next one may succeed, and
        // a dead housekeeper is silent by nature.
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
