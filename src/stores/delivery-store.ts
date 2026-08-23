/**
 * The delivery queue.
 *
 * Durable by construction: an event is written here before it is acknowledged,
 * so a crash between accepting and delivering loses nothing. gowa forwards
 * fire-and-forget with no retry and no record (docs/01), which is defensible
 * for a single-tenant tool and not for a proxy other businesses depend on.
 */
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import {
  deliveries,
  deliveryAttempts,
  environmentWebhooks,
  environments,
  type Delivery,
  type DeliveryAttempt,
} from "../db/schema";
import type { EventEnvelope } from "../events/schema";
import { passesFilter } from "../events/schema";
import { NotFoundError } from "./errors";

/** A delivery paired with everything needed to attempt it. */
export interface DueDelivery {
  delivery: Delivery;
  url: string;
  secret: string;
  maxAttempts: number;
}

export class DeliveryStore {
  /**
   * Queue an event for an environment, if its filter admits the type.
   *
   * Returns null when the event is filtered out or the environment has no
   * enabled webhook — both are ordinary, not errors.
   */
  static async enqueue(
    environmentId: string,
    event: EventEnvelope,
    database: Database = db(),
  ): Promise<Delivery | null> {
    const [webhook] = await database
      .select()
      .from(environmentWebhooks)
      .where(eq(environmentWebhooks.environmentId, environmentId))
      .limit(1);
    if (webhook === undefined || !webhook.enabled) return null;
    if (!passesFilter(event.type, webhook.eventFilter ?? null)) return null;

    // Idempotent on (eventId, environmentId): the same event offered twice —
    // by a retry upstream, or by two workers racing — must not become two
    // deliveries. onConflictDoNothing rather than a read-then-write, which
    // would have a window between the two.
    const [created] = await database
      .insert(deliveries)
      .values({
        environmentId,
        eventId: event.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    return created ?? null;
  }

  /**
   * Claim deliveries that are due.
   *
   * Ordered oldest-first so a backlog drains in the order it arrived rather
   * than starving its head.
   */
  static async claimDue(limit: number, now: Date = new Date(), database: Database = db()): Promise<DueDelivery[]> {
    const rows = await database
      .select({
        delivery: deliveries,
        url: environmentWebhooks.url,
        secret: environmentWebhooks.secret,
        maxAttempts: environmentWebhooks.maxAttempts,
        circuitState: environmentWebhooks.circuitState,
        circuitOpenedAt: environmentWebhooks.circuitOpenedAt,
      })
      .from(deliveries)
      .innerJoin(environmentWebhooks, eq(deliveries.environmentId, environmentWebhooks.environmentId))
      .where(and(eq(deliveries.state, "pending"), lte(deliveries.nextAttemptAt, now)))
      .orderBy(asc(deliveries.nextAttemptAt))
      .limit(limit);

    return rows.map((r) => ({
      delivery: r.delivery,
      url: r.url,
      secret: r.secret,
      maxAttempts: r.maxAttempts,
    }));
  }

  /** Record an attempt and its outcome, moving the delivery on. */
  static async recordAttempt(
    deliveryId: string,
    outcome: { ok: boolean; statusCode: number | null; error: string | null; durationMs: number },
    next: { state: Delivery["state"]; nextAttemptAt: Date | null },
    database: Database = db(),
  ): Promise<void> {
    await database.insert(deliveryAttempts).values({
      deliveryId,
      attemptedAt: new Date(),
      statusCode: outcome.statusCode,
      error: outcome.error,
      durationMs: outcome.durationMs,
    });

    await database
      .update(deliveries)
      .set({
        state: next.state,
        attemptCount: sql`${deliveries.attemptCount} + 1`,
        // Left at its previous value when there is no next attempt; the state
        // says whether it matters, and nulling it would lose when it last ran.
        ...(next.nextAttemptAt === null ? {} : { nextAttemptAt: next.nextAttemptAt }),
        ...(next.state === "delivered" ? { deliveredAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(deliveries.id, deliveryId));
  }

  /** Scoped by project: a caller cannot read another tenant's delivery log. */
  /**
   * Recent deliveries, newest first.
   *
   * Ascending under a fixed limit meant an environment with more than fifty
   * deliveries always saw the same fifty oldest rows — so the log could never
   * answer the question it exists for, which is about the delivery that just
   * failed.
   */
  static async listForEnvironment(
    projectId: string,
    environmentId: string,
    limit = 50,
    database: Database = db(),
  ): Promise<Delivery[]> {
    const rows = await database
      .select({ delivery: deliveries })
      .from(deliveries)
      .innerJoin(environments, eq(deliveries.environmentId, environments.id))
      .where(and(eq(deliveries.environmentId, environmentId), eq(environments.projectId, projectId)))
      // id as a tiebreak: several deliveries can share a millisecond.
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => r.delivery);
  }

  /**
   * Push a delivery's next attempt into the future without counting an attempt.
   *
   * For work the worker declined to try — an open circuit, a missing webhook.
   * Leaving the row due meant it was re-claimed every pass, filling the batch
   * and starving every other environment.
   */
  static async defer(deliveryId: string, until: Date, database: Database = db()): Promise<void> {
    await database
      .update(deliveries)
      .set({ nextAttemptAt: until, updatedAt: new Date() })
      .where(eq(deliveries.id, deliveryId));
  }

  static async attemptsFor(
    projectId: string,
    deliveryId: string,
    database: Database = db(),
  ): Promise<DeliveryAttempt[]> {
    const [owned] = await database
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(environments, eq(deliveries.environmentId, environments.id))
      .where(and(eq(deliveries.id, deliveryId), eq(environments.projectId, projectId)))
      .limit(1);
    if (owned === undefined) throw new NotFoundError(`delivery ${deliveryId} not found`);

    return database.select().from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, deliveryId));
  }

  /**
   * Return a dead delivery to the queue.
   *
   * The attempt count is reset so the replay gets the full schedule; the
   * attempt history is kept, because it is the record of why it died.
   */
  static async replay(projectId: string, deliveryId: string, database: Database = db()): Promise<Delivery> {
    const [owned] = await database
      .select({ delivery: deliveries })
      .from(deliveries)
      .innerJoin(environments, eq(deliveries.environmentId, environments.id))
      .where(and(eq(deliveries.id, deliveryId), eq(environments.projectId, projectId)))
      .limit(1);
    if (owned === undefined) throw new NotFoundError(`delivery ${deliveryId} not found`);

    const [updated] = await database
      .update(deliveries)
      .set({ state: "pending", attemptCount: 0, nextAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(deliveries.id, deliveryId))
      .returning();
    if (updated === undefined) throw new NotFoundError(`delivery ${deliveryId} not found`);
    return updated;
  }
}
