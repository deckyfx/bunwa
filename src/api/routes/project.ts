/**
 * Project-facing API.
 *
 * Every route here is authenticated by API key, and the tenant comes from that
 * key alone. §1.5 adds messaging; for now this proves the boundary works and
 * gives an integrator something to test their credentials against.
 */
import { Elysia } from "elysia";

import { requireApiKey } from "../../auth/middleware";

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
  }));
