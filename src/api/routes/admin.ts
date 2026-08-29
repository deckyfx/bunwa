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
import { EngineRegistry } from "../../engine/registry";
import { requireAdminKey, requireScope } from "../../auth/middleware";
import { SettingsStore, type SettingKey } from "../../stores/settings-store";
import { retireDevice } from "../../ops/retire-device";
import { serverTimezone, setServerTimezone } from "../../time/format";
import { isProjectScope, PROJECT_SCOPES } from "../../auth/scopes";
import type { ApiKey } from "../../db/schema";
import { ValidationError } from "../../stores/errors";
import { DeviceStore } from "../../stores/device-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { log } from "../../observability/logger";
import { config } from "../../config/env";
import { problem } from "../server";

/**
 * The instance surface.
 *
 * A factory rather than a value because retiring a device has to reach the
 * engine that holds its socket — the same reason `deviceRoutes` is one. The
 * registry is passed in rather than imported so a test can drive these routes
 * against a stub engine instead of opening a WhatsApp connection.
 */
export const adminRoutes = (registry: EngineRegistry) =>
  new Elysia({ prefix: "/admin/v1" })
  /*
   * The flag is enforced here rather than by mounting conditionally.
   *
   * `.use(enabled ? adminRoutes : new Elysia())` makes the app type a union of
   * "these routes exist" and "they do not", and Eden then sees neither — the
   * console's typed client had no `admin` on it at all. That is the same
   * mistake the device and message routes were fixed for, in the same file,
   * with a comment explaining it.
   *
   * 404 rather than 403: a disabled surface should be indistinguishable from
   * one that was never built, and it answers before authentication so that
   * turning the flag off does not turn the endpoint into a credential oracle.
   */
  .onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname;
    // onRequest, not onBeforeHandle. requireApiKey is a `derive`, and derive
    // runs before beforeHandle — so a beforeHandle check answered 401 on a
    // disabled surface instead of 404, which is exactly the credential oracle
    // this ordering exists to avoid. Caught by the one pre-existing test.
    if (!path.startsWith("/admin/")) return undefined;
    if (config().adminApiEnabled) return undefined;

    set.status = 404;
    return new Response(
      JSON.stringify(problem(404, "not-found", "Not Found", "the admin API is not enabled on this deployment", path)),
      { status: 404, headers: { "content-type": "application/problem+json" } },
    );
  })
  // An admin key, not a tenant key with a scope on it.
  //
  // These routes create projects and mint credentials for them, so the
  // question is what the caller *is* before it is what they may do. A tenant
  // key is refused here even if it somehow carries `manage:projects` — which
  // is the difference between a scope check and a level check, and the reason
  // the operator credential is no longer also a credential that can send
  // messages as a project.
  .use(requireAdminKey)
  /**
   * Who this admin key is, as the console needs to know it.
   *
   * The mirror of `/v1/whoami` for a credential with no tenant. The console
   * asks one of the two depending on which it holds, and the answer decides
   * which sections it offers — so a key that cannot reach a screen is not
   * shown one.
   *
   * Above the scope guard deliberately: identifying yourself is what every
   * admin key may do, and a key limited to fewer scopes still has to be able
   * to find out what it is. It discloses nothing the caller did not present.
   */
  .get("/whoami", ({ admin }) => ({
    level: "admin" as const,
    scopes: admin.scopes,
    serverTimezone: serverTimezone(),
  }))

  // Applied to every route below rather than repeated per handler. The
  // per-handler version is how one gets forgotten, and the one that gets
  // forgotten here mints credentials.
  //
  // Below `/whoami` and `/settings` on purpose: identifying yourself needs no
  // scope, and settings answer to `manage:instance` rather than to this one.
  .onBeforeHandle(({ admin, path }) => {
    requireScope(admin, "manage:projects", path);
  })
  /**
   * Instance settings, and where each value comes from.
   *
   * Authenticated, unlike the setup screen's copy: setup answers before a
   * credential exists and closes once one does, so without this the instance
   * name could only ever be chosen during first run and never corrected.
   *
   * On the admin surface, behind `manage:instance`. These are not any
   * tenant's settings — there is one instance name and one server timezone,
   * shared by every project on the deployment — so they sat on the project
   * routes only because that was where the console could reach them. A scope
   * check was doing the work a level check should have been doing.
   */
  .get("/settings", ({ admin, path }) => {
    requireScope(admin, "manage:instance", path);
    return SettingsStore.all();
  })

  .put(
    "/settings",
    ({ body, path, admin }) => {
      // `manage:instance`, not `manage:devices`. This writes values that are
      // one per process: the instance name reaches WhatsApp through the
      // Baileys handshake and is what every other project's number is listed
      // under, and setServerTimezone below mutates the zone every rendered
      // timestamp uses, logs included. A tenant holding an ordinary project
      // key was able to do both to every other tenant on the deployment.
      requireScope(admin, "manage:instance", path);

      // Everything is checked before anything is written.
      //
      // One pass that validated and wrote as it went left a valid instance
      // name persisted and a rejected timezone unwritten, then answered 400 —
      // so the caller was told the request failed while half of it had already
      // taken effect, and the console showed a name it had been told was not
      // saved.
      const pending: Array<{ setting: SettingKey; value: string }> = [];
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value.trim() === "") continue;
        const setting = key as SettingKey;

        if (SettingsStore.resolve(setting).source === "environment") {
          // Refused rather than ignored: silently dropping it leaves the
          // console showing a value the deployment overrides, which is the
          // failure the precedence rule exists to prevent.
          throw new ValidationError(`${setting} is set in the environment and cannot be changed here`, setting);
        }

        // Throws on a bad value, before any write has happened.
        pending.push({ setting, value: SettingsStore.validate(setting, value) });
      }

      for (const { setting, value } of pending) {
        const applied = SettingsStore.set(setting, value);
        // Rendering reads a cached zone, so a write that did not update it
        // would take effect only after a restart.
        if (setting === "serverTimezone") setServerTimezone(applied);
        log.info("setting changed", { setting, value: applied });
      }

      return SettingsStore.all();
    },
    {
      body: t.Object({
        instanceName: t.Optional(t.String({ maxLength: 200 })),
        serverTimezone: t.Optional(t.String({ maxLength: 100 })),
      }),
    },
  )

  /**
   * Every device on the instance, and which projects are using it.
   *
   * The fleet view. A project key sees the numbers bound to its own
   * environment; only a credential outside every tenant can answer "who else
   * has this number?" — which is the question that decides what retiring one
   * actually costs.
   */
  .get("/devices", () => DeviceStore.listAll())

  /**
   * Retire a device, whoever is using it.
   *
   * The operator's version of release, and deliberately not the same
   * operation. A project letting go of a shared number unsubscribes and leaves
   * it working for everyone else; an operator doing this is saying the number
   * itself is finished — so it unlinks from WhatsApp, destroys the credentials
   * and Signal keys, erases the history, and revokes every project's binding.
   *
   * There is no "unless someone is using it" here on purpose. An operator can
   * see who holds it before pressing this, and a retire that quietly declined
   * because a tenant still had a binding would be a button that does nothing
   * in the case it exists for.
   */
  .delete(
    "/devices/:deviceId",
    async ({ params, set }) => {
      const holders = await DeviceStore.projectsHolding(params.deviceId);
      for (const projectId of holders) {
        await DeviceStore.revokeConsent(params.deviceId, projectId, "operator");
      }

      const retired = await retireDevice(params.deviceId, registry);

      log.info("device retired by operator", {
        deviceId: params.deviceId,
        revokedFrom: holders.length,
        hadSession: retired.hadSession,
      });

      set.status = 200;
      return {
        outcome: "retired" as const,
        revokedFrom: holders.length,
        hadSession: retired.hadSession,
        messagesErased: retired.messagesErased,
      };
    },
    { params: t.Object({ deviceId: t.String() }) },
  )

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
      // Project scopes only. Without this the boundary manage:projects
      // establishes has a door in it: an operator creating a tenant could hand
      // it a credential able to create further tenants and rename the
      // deployment, by passing a string. Instance scopes are granted by
      // minting an operator key and by nothing else.
      const forbidden = body.scopes.filter((scope) => !isProjectScope(scope));
      if (forbidden.length > 0) {
        throw new ValidationError(
          `a project key may only hold project scopes; refused: ${forbidden.join(", ")}. ` +
            `Allowed: ${PROJECT_SCOPES.join(", ")}.`,
          "scopes",
        );
      }

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
