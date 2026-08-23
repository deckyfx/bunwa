/**
 * Sending — §1.5, and the endpoint the whole system exists to serve.
 *
 * One route, discriminated by `type`, covering the six v1 message types.
 * Idempotency is mandatory rather than optional: the primary traffic is OTP,
 * where a duplicate is a second code in the customer's chat and a lost one is
 * a failed login.
 */
import { Elysia, t } from "elysia";
import { and, eq, or } from "drizzle-orm";

import { requireApiKey, requireScope, type AuthContext } from "../../auth/middleware";
import { db } from "../../db";
import { devices, virtualDevices, type VirtualDevice } from "../../db/schema";
import type { EngineRegistry } from "../../engine/registry";
import { EngineError, type SendAction } from "../../engine/types";
import { IdempotencyStore } from "../../stores/idempotency-store";
import { MessageStore } from "../../stores/message-store";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "../../stores/errors";
import { log } from "../../observability/logger";

/** Media a caller may reference. A URL is preferred; it avoids buffering twice. */
const mediaSchema = t.Union([
  t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) }),
  t.Object({ base64: t.String({ minLength: 1 }), mimeType: t.String({ minLength: 1, maxLength: 100 }) }),
]);

const sendSchema = t.Union([
  t.Object({ type: t.Literal("text"), to: t.String({ minLength: 3 }), text: t.String({ minLength: 1, maxLength: 4096 }) }),
  t.Object({ type: t.Literal("image"), to: t.String({ minLength: 3 }), media: mediaSchema, caption: t.Optional(t.String({ maxLength: 1024 })) }),
  t.Object({
    type: t.Literal("document"),
    to: t.String({ minLength: 3 }),
    media: mediaSchema,
    filename: t.String({ minLength: 1, maxLength: 255 }),
    caption: t.Optional(t.String({ maxLength: 1024 })),
  }),
  t.Object({ type: t.Literal("link"), to: t.String({ minLength: 3 }), url: t.String({ minLength: 1, maxLength: 2048 }), caption: t.Optional(t.String({ maxLength: 1024 })) }),
  t.Object({ type: t.Literal("audio"), to: t.String({ minLength: 3 }), media: mediaSchema, voiceNote: t.Optional(t.Boolean()) }),
  t.Object({ type: t.Literal("video"), to: t.String({ minLength: 3 }), media: mediaSchema, caption: t.Optional(t.String({ maxLength: 1024 })) }),
]);

/**
 * Resolve a virtual device by id or alias, within the caller's environment.
 *
 * Scoped by environment in the query itself. Resolving first and checking
 * ownership afterwards is the shape that leaks — one forgotten check and a
 * caller reaches another tenant's device.
 */
async function resolveDevice(auth: AuthContext, ref: string): Promise<{ binding: VirtualDevice; deviceId: string }> {
  const [row] = await db()
    .select({ binding: virtualDevices, deviceId: devices.id })
    .from(virtualDevices)
    .innerJoin(devices, eq(virtualDevices.deviceId, devices.id))
    .where(
      and(
        eq(virtualDevices.environmentId, auth.environmentId),
        or(eq(virtualDevices.id, ref), eq(virtualDevices.alias, ref)),
      ),
    )
    .limit(1);

  if (row === undefined) throw new NotFoundError(`device "${ref}" not found`);

  if (row.binding.status !== "active") {
    // 409 rather than 404: it exists and the caller may use it soon, which is
    // a different remedy from "you asked for the wrong thing".
    throw new ConflictError(
      `device "${ref}" is ${row.binding.status}; it cannot send until it is active`,
    );
  }
  return row;
}

export function messageRoutes(registry: EngineRegistry) {
  return new Elysia({ prefix: "/v1" })
    .use(requireApiKey)

    .post(
      "/devices/:ref/messages",
      async ({ auth, params, body, headers, set, path }) => {
        requireScope(auth, body.type === "text" ? "send:text" : "send:media", path);

        // Mandatory. Optional idempotency is idempotency nobody uses, and the
        // caller who needs it most is the one retrying a timeout at 3am.
        const key = headers["idempotency-key"];
        if (key === undefined || key.trim() === "") {
          throw new ValidationError("Idempotency-Key header is required for sends", "Idempotency-Key");
        }
        const requestHash = IdempotencyStore.hashRequest({ ref: params.ref, ...body });

        const replayed = await IdempotencyStore.lookup(auth.environmentId, key, requestHash);
        if (replayed !== null) {
          set.status = replayed.statusCode;
          // Marked so a caller can tell a replay from a fresh send, which
          // matters when reconciling their own retry logic.
          set.headers["idempotent-replay"] = "true";
          return replayed.response;
        }

        const { binding, deviceId } = await resolveDevice(auth, params.ref);

        const pool = registry.list().find((p) => p.engine.kind !== undefined);
        if (pool === undefined) throw new UnavailableError("no engine is available to send this message");

        let result;
        try {
          result = await pool.engine.send(deviceId, body as SendAction);
        } catch (err) {
          if (err instanceof EngineError && !err.retryable) {
            throw new ValidationError(err.message);
          }
          // Retryable failures are surfaced as 503 so the caller retries with
          // the same idempotency key rather than treating it as rejected.
          throw new UnavailableError(
            err instanceof Error ? err.message : "the engine could not accept this message",
          );
        }

        const recorded = await MessageStore.recordAccepted({
          virtualDeviceId: binding.id,
          environmentId: auth.environmentId,
          engineMessageId: result.messageId,
          type: body.type,
          recipient: body.to,
        });

        const response = {
          messageId: recorded.id,
          // "accepted", never "sent". The engine took it; WhatsApp has not
          // acknowledged it, and for up to 203 seconds after a silent drop the
          // engine cannot tell the difference (docs/12).
          state: recorded.state,
          acceptedAt: recorded.acceptedAt.toISOString(),
        };

        set.status = 202;
        await IdempotencyStore.record(auth.environmentId, key, requestHash, { statusCode: 202, response });
        log.info("message accepted", { virtualDeviceId: binding.id, type: body.type });
        return response;
      },
      { body: sendSchema },
    )

    /** The state of one send, for a caller reconciling a delivery. */
    .get("/devices/:ref/messages/:id", async ({ auth, params }) => {
      await resolveDevice(auth, params.ref);
      const message = await MessageStore.findForEnvironment(auth.environmentId, params.id);
      return {
        messageId: message.id,
        state: message.state,
        acceptedAt: message.acceptedAt.toISOString(),
        ackedAt: message.ackedAt?.toISOString() ?? null,
      };
    });
}
