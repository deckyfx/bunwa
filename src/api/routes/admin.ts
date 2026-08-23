/**
 * Admin API — operator surface for projects, environments and keys.
 *
 * Session-authenticated in the finished system; unauthenticated for now, and
 * mounted only when explicitly enabled, so that gap cannot reach a deployment
 * by accident.
 */
import { Elysia, t } from "elysia";

import { ApiKeyStore } from "../../stores/api-key-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { log } from "../../observability/logger";

export const adminRoutes = new Elysia({ prefix: "/admin/v1" })
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
        ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
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

/** Strip the hash before a key ever leaves the process. */
function redactKey(key: { keyHash: string } & Record<string, unknown>) {
  const { keyHash: _hash, ...safe } = key;
  return safe;
}
