/**
 * Admin API — operator surface for projects, environments and keys.
 *
 * Behind `manage:projects`, which is the boundary the tenant model turns on: a
 * key holding it can see and create other tenants, and no project key may ever
 * do that.
 *
 * It was unauthenticated. An environment flag decided whether the surface
 * existed at all, and the comment here said session authentication was coming
 * — so on any deployment with ADMIN_API_ENABLED set, anyone who could reach
 * the port could create a project and mint a credential for it. Confirmed by
 * doing it: `POST /admin/v1/projects` with no headers answered 201.
 *
 * The flag stays, as a way to remove the surface entirely rather than as the
 * thing protecting it. A flag is a deployment decision; this is a credential
 * check, and the two are not substitutes.
 */
import { Elysia, t } from "elysia";

import { ApiKeyStore } from "../../stores/api-key-store";
import { requireApiKey, requireScope } from "../../auth/middleware";
import type { ApiKey } from "../../db/schema";
import { ValidationError } from "../../stores/errors";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { log } from "../../observability/logger";

export const adminRoutes = new Elysia({ prefix: "/admin/v1" })
  .use(requireApiKey)
  // Applied to every route in the plugin rather than repeated per handler. The
  // per-handler version is how one gets forgotten, and the one that gets
  // forgotten here mints credentials.
  .onBeforeHandle(({ auth, path }) => {
    requireScope(auth, "manage:projects", path);
  })
  .post(
    "/projects",
    async ({ body, set }) => {
      const project = await ProjectStore.create(body);
      set.status = 201;
      log.info("project created", { projectId: project.id, slug: project.slug });
      return project;
    },
    {
      body: t.Object({
        slug: t.String({ minLength: 3, maxLength: 40 }),
        displayName: t.String({ minLength: 1, maxLength: 200 }),
      }),
    },
  )

  .get("/projects", () => ProjectStore.list())

  .get("/projects/:projectId", ({ params }) => ProjectStore.requireById(params.projectId))

  .post(
    "/projects/:projectId/environments",
    async ({ params, body, set }) => {
      const environment = await EnvironmentStore.create({ projectId: params.projectId, ...body });
      set.status = 201;
      log.info("environment created", { projectId: params.projectId, environmentId: environment.id });
      return environment;
    },
    {
      body: t.Object({
        slug: t.String({ minLength: 3, maxLength: 40 }),
        kind: t.Optional(t.Union([t.Literal("live"), t.Literal("test")])),
      }),
    },
  )

  .get("/projects/:projectId/environments", ({ params }) => EnvironmentStore.listForProject(params.projectId))

  .post(
    "/projects/:projectId/environments/:environmentId/api-keys",
    async ({ params, body, set }) => {
      const { apiKey, plaintext } = await ApiKeyStore.create({
        projectId: params.projectId,
        environmentId: params.environmentId,
        label: body.label,
        scopes: body.scopes,
        ...(body.expiresAt === undefined ? {} : { expiresAt: parseExpiry(body.expiresAt) }),
      });
      set.status = 201;
      // The id is logged; the key is not, and there is no code path that could
      // log it — the plaintext exists only in this response.
      log.info("api key created", { environmentId: params.environmentId, apiKeyId: apiKey.id });
      return {
        ...redactKey(apiKey),
        // Shown once. There is no endpoint that can return it again.
        key: plaintext,
        warning: "This is the only time this key is shown. Store it now.",
      };
    },
    {
      body: t.Object({
        label: t.String({ minLength: 1, maxLength: 100 }),
        scopes: t.Array(t.String(), { default: [] }),
        expiresAt: t.Optional(t.String({ format: "date-time" })),
      }),
    },
  )

  .get("/projects/:projectId/environments/:environmentId/api-keys", async ({ params }) => {
    const keys = await ApiKeyStore.listForEnvironment(params.projectId, params.environmentId);
    return keys.map(redactKey);
  })

  .delete(
    "/projects/:projectId/environments/:environmentId/api-keys/:keyId",
    async ({ params }) => {
      const revoked = await ApiKeyStore.revoke(params.projectId, params.environmentId, params.keyId);
      log.info("api key revoked", { apiKeyId: revoked.id });
      return redactKey(revoked);
    },
  );

/**
 * Parse an expiry, refusing anything that is not a date.
 *
 * `new Date("nonsense")` is an Invalid Date, which stores as NaN and then
 * compares false against every check — producing a key that never expires
 * because its expiry was unreadable.
 */
function parseExpiry(raw: string): Date {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`expiresAt is not a valid date: "${raw}"`, "expiresAt");
  if (parsed.getTime() <= Date.now()) throw new ValidationError("expiresAt must be in the future", "expiresAt");
  return parsed;
}

/** Strip the hash before a key ever leaves the process. */
function redactKey(key: ApiKey): Omit<ApiKey, "keyHash"> {
  const { keyHash: _hash, ...safe } = key;
  return safe;
}
