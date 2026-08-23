/**
 * Rules over HTTP, including the dry run.
 *
 * The dry run is the point of the whole surface. A rule engine that can only be
 * tested by messaging a real customer is one nobody will dare change, so
 * evaluation is pure and this endpoint runs exactly the same code the live path
 * runs — not an approximation of it.
 */
import { Elysia, t } from "elysia";

import { requireApiKey, requireScope, type AuthContext } from "../../auth/middleware";
import { evaluate } from "../../rules/evaluate";
import { prepareRule, type RuleDefinition } from "../../rules/schema";
import { RuleStore, toDefinition } from "../../stores/rule-store";
import { NotFoundError } from "../../stores/errors";
import { db } from "../../db";
import { virtualDevices } from "../../db/schema";
import { and, eq, or } from "drizzle-orm";
import { log } from "../../observability/logger";

const conditionSchema = t.Object({
  field: t.String({ minLength: 1, maxLength: 120 }),
  op: t.String({ minLength: 1, maxLength: 20 }),
  value: t.Optional(t.Any()),
});

const ruleSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 80 }),
  enabled: t.Optional(t.Boolean()),
  priority: t.Optional(t.Integer({ minimum: 0, maximum: 10_000 })),
  stopOnMatch: t.Optional(t.Boolean()),
  match: t.Object({
    all: t.Optional(t.Array(conditionSchema)),
    any: t.Optional(t.Array(conditionSchema)),
    none: t.Optional(t.Array(conditionSchema)),
  }),
  actions: t.Array(t.Any(), { minItems: 1 }),
});

/** Resolve a binding by id or alias, scoped to the caller's environment. */
async function bindingFor(auth: AuthContext, ref: string): Promise<string> {
  const [row] = await db()
    .select({ id: virtualDevices.id })
    .from(virtualDevices)
    .where(
      and(
        eq(virtualDevices.environmentId, auth.environmentId),
        or(eq(virtualDevices.id, ref), eq(virtualDevices.alias, ref)),
      ),
    )
    .limit(1);
  if (row === undefined) throw new NotFoundError(`device "${ref}" not found`);
  return row.id;
}

function definitionFrom(body: typeof ruleSchema.static): RuleDefinition {
  return {
    name: body.name,
    enabled: body.enabled ?? true,
    priority: body.priority ?? 100,
    stopOnMatch: body.stopOnMatch ?? false,
    match: body.match as RuleDefinition["match"],
    actions: body.actions as RuleDefinition["actions"],
  };
}

export const ruleRoutes = new Elysia({ prefix: "/v1" })
  .use(requireApiKey)

  .get("/devices/:ref/rules", async ({ auth, params }) =>
    RuleStore.list(auth.environmentId, await bindingFor(auth, params.ref)),
  )

  .post(
    "/devices/:ref/rules",
    async ({ auth, params, body, set, path }) => {
      requireScope(auth, "manage:rules", path);
      const binding = await bindingFor(auth, params.ref);
      const created = await RuleStore.create(auth.environmentId, binding, definitionFrom(body));
      set.status = 201;
      log.info("rule created", { virtualDeviceId: binding, name: created.name });
      return created;
    },
    { body: ruleSchema },
  )

  .put(
    "/devices/:ref/rules/:id",
    async ({ auth, params, body, path }) => {
      requireScope(auth, "manage:rules", path);
      const binding = await bindingFor(auth, params.ref);
      return RuleStore.update(auth.environmentId, binding, params.id, definitionFrom(body));
    },
    { body: ruleSchema },
  )

  .delete("/devices/:ref/rules/:id", async ({ auth, params, path }) => {
    requireScope(auth, "manage:rules", path);
    const binding = await bindingFor(auth, params.ref);
    await RuleStore.remove(auth.environmentId, binding, params.id);
    return { deleted: true };
  })

  /**
   * Evaluate a rule against a sample event without doing anything.
   *
   * `actionsExecuted` is always empty and there is no code path that could
   * populate it: the endpoint calls the evaluator, which cannot send, write or
   * reach an engine. That is why the guarantee is worth making — it rests on
   * the shape of the code rather than on a flag being read correctly.
   */
  .post(
    "/devices/:ref/rules/:id/test",
    async ({ auth, params, body }) => {
      const binding = await bindingFor(auth, params.ref);
      const stored = (await RuleStore.list(auth.environmentId, binding)).find((r) => r.id === params.id);
      if (stored === undefined) throw new NotFoundError(`rule ${params.id} not found`);

      // Prepared here rather than reusing the stored compile, so a pattern that
      // has become unsafe is reported by the dry run instead of at runtime.
      const prepared = prepareRule({ ...toDefinition(stored), enabled: true });
      const result = evaluate({
        event: body.event as Record<string, unknown>,
        rules: [prepared],
        chainDepth: 0,
      });

      return {
        matched: result.matched.includes(stored.name),
        captures: result.actions[0]?.captures ?? {},
        actionsPlanned: result.actions.map((a) => a.action),
        // Always empty. Nothing was sent.
        actionsExecuted: [] as never[],
        patternTimedOut: result.timedOut.includes(stored.name),
      };
    },
    { body: t.Object({ event: t.Any() }) },
  );
