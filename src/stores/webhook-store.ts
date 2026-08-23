/**
 * Webhook configuration for an environment.
 *
 * The target is tenant-supplied, so it is validated on the way in as well as
 * before every send: rejecting a bad URL at configuration time gives the
 * integrator an immediate, actionable error instead of a delivery that
 * silently never succeeds.
 */
import { eq } from "drizzle-orm";

import { validateWebhookTarget } from "../delivery/target";
import { config } from "../config/env";
import { db, type Database } from "../db";
import { environmentWebhooks, type EnvironmentWebhook } from "../db/schema";
import { EnvironmentStore } from "./environment-store";
import { isEventType } from "../events/schema";
import { NotFoundError, ValidationError } from "./errors";

/** A webhook as it may be shown. Never includes the secret. */
export interface WebhookView {
  url: string;
  enabled: boolean;
  eventFilter: string[] | null;
  maxAttempts: number;
  circuitState: EnvironmentWebhook["circuitState"];
  consecutiveFailures: number;
}

export class WebhookStore {
  static async upsert(
    projectId: string,
    environmentId: string,
    input: { url: string; secret: string; enabled?: boolean; eventFilter?: string[] | null },
    database: Database = db(),
  ): Promise<WebhookView> {
    await EnvironmentStore.requireById(projectId, environmentId, database);

    // The secret is the only thing standing between a receiver and a forged
    // payload. Validated here as well as at the route, because a store is
    // callable from anywhere and a weak secret is not something to discover
    // from a signature that was trivially reproduced.
    if (input.secret.trim().length < 16) {
      throw new ValidationError("webhook secret must be at least 16 characters", "secret");
    }

    // Opt-in only. Tying this to NODE_ENV would mean an unset environment name
    // silently disables the check — verified by an end-to-end run that happily
    // accepted https://169.254.169.254/ under the previous logic.
    validateWebhookTarget(input.url, { allowInsecure: config().allowInsecureWebhookTargets });

    if (input.eventFilter !== undefined && input.eventFilter !== null) {
      const unknown = input.eventFilter.filter((e) => !isEventType(e));
      if (unknown.length > 0) {
        // Silently ignoring an unknown type is how an integrator ends up
        // waiting for events that were never going to arrive.
        throw new ValidationError(`unknown event types: ${unknown.join(", ")}`, "eventFilter");
      }
    }

    const [current] = await database
      .select()
      .from(environmentWebhooks)
      .where(eq(environmentWebhooks.environmentId, environmentId))
      .limit(1);

    // A changed URL is a different destination, so the breaker state belongs to
    // the old one. Carrying it over would leave a fresh target blocked for the
    // failures of the address it replaced — exactly when an integrator is
    // fixing a broken webhook and needs it to work immediately.
    const targetChanged = current !== undefined && current.url !== input.url;
    const breakerReset = targetChanged
      ? { circuitState: "closed" as const, circuitOpenedAt: null, consecutiveFailures: 0 }
      : {};

    const values = {
      environmentId,
      url: input.url,
      secret: input.secret,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.eventFilter === undefined ? {} : { eventFilter: input.eventFilter }),
      ...breakerReset,
      updatedAt: new Date(),
    };

    const [saved] = await database
      .insert(environmentWebhooks)
      .values(values)
      .onConflictDoUpdate({ target: environmentWebhooks.environmentId, set: values })
      .returning();
    if (saved === undefined) throw new Error("upsert returned no row");
    return this.toView(saved);
  }

  static async describe(projectId: string, environmentId: string, database: Database = db()): Promise<WebhookView> {
    await EnvironmentStore.requireById(projectId, environmentId, database);
    const [found] = await database
      .select()
      .from(environmentWebhooks)
      .where(eq(environmentWebhooks.environmentId, environmentId))
      .limit(1);
    if (found === undefined) throw new NotFoundError("no webhook is configured for this environment");
    return this.toView(found);
  }

  /** Strip the secret. There is no code path that returns it. */
  private static toView(row: EnvironmentWebhook): WebhookView {
    return {
      url: row.url,
      enabled: row.enabled,
      eventFilter: row.eventFilter ?? null,
      maxAttempts: row.maxAttempts,
      circuitState: row.circuitState,
      consecutiveFailures: row.consecutiveFailures,
    };
  }
}
