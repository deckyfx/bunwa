/**
 * Project-facing API.
 *
 * Every route here is authenticated by API key, and the tenant comes from that
 * key alone. §1.5 adds messaging; for now this proves the boundary works and
 * gives an integrator something to test their credentials against.
 */
import { Elysia, t } from "elysia";

import { requireApiKey, requireScope } from "../../auth/middleware";
import { DeliveryStore } from "../../stores/delivery-store";
import { WebhookStore } from "../../stores/webhook-store";
import { serverTimezone } from "../../time/format";

export const projectRoutes = new Elysia({ prefix: "/v1" })
  .use(requireApiKey)
  /**
   * Who am I?
   *
   * Returns what the presented key resolves to. Deliberately the first endpoint
   * an integrator hits: it confirms the credential works and shows exactly
   * which environment it acts on, before anything is sent to a real number.
   */
  .get("/whoami", ({ auth }) => ({
    projectId: auth.projectId,
    environmentId: auth.environmentId,
    scopes: auth.scopes,
    // The zone every timestamp the server renders is in. Returned here so the
    // console shows the same wall clock as the logs rather than the reader's
    // own — an operator in another country comparing a screen against a log
    // file must not be silently seven hours out.
    serverTimezone: serverTimezone(),
  }))

  /** Where this environment's events are delivered. The secret is never returned. */
  .get("/webhook", async ({ auth }) => WebhookStore.describe(auth.projectId, auth.environmentId))

  .put(
    "/webhook",
    async ({ auth, body, path }) => {
      requireScope(auth, "manage:webhook", path);
      return WebhookStore.upsert(auth.projectId, auth.environmentId, body);
    },
    {
      body: t.Object({
        url: t.String({ minLength: 1 }),
        secret: t.String({ minLength: 16, maxLength: 200 }),
        enabled: t.Optional(t.Boolean()),
        eventFilter: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
      }),
    },
  )

  /**
   * The delivery log.
   *
   * Exists because "did you send it?" is the question every webhook integration
   * eventually asks in anger, and answering it from logs is archaeology.
   */
  .get(
    "/deliveries",
    async ({ auth, query }) =>
      DeliveryStore.listForEnvironment(auth.projectId, auth.environmentId, query.limit ?? 50),
    { query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })) }) },
  )

  .get("/deliveries/:id/attempts", async ({ auth, params }) =>
    DeliveryStore.attemptsFor(auth.projectId, auth.environmentId, params.id),
  )

  .post("/deliveries/:id/replay", async ({ auth, params, path }) => {
    requireScope(auth, "manage:webhook", path);
    return DeliveryStore.replay(auth.projectId, auth.environmentId, params.id);
  });
