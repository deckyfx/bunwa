/**
 * The claim flow over HTTP — §1.3's remaining surface.
 *
 * One call for an integrator: give us a number, get back one of three answers.
 * The interesting one is `active`, where a customer has already consented to
 * this project and nothing at all is asked of them.
 */
import { Elysia, t } from "elysia";

import { requireApiKey, requireScope, requireWithinLimit } from "../../auth/middleware";
import { LIMITS } from "../../ops/rate-limit";
import { DeviceStore } from "../../stores/device-store";
import { problem } from "../server";
import type { EngineRegistry } from "../../engine/registry";
import { EngineError } from "../../engine/types";
import { currentCorrelationId, log } from "../../observability/logger";
import { UnavailableError } from "../../stores/errors";

/**
 * Build the device routes.
 *
 * The registry is injected rather than imported so tests can drive a fake
 * engine, and so a deployment can hold several pools without this module
 * knowing how they are chosen.
 */
export function deviceRoutes(registry: EngineRegistry) {
  return new Elysia({ prefix: "/v1" })
    .use(requireApiKey)

    /**
     * Claim a phone number for this environment.
     *
     * Returns the outcome rather than a device: the caller's next step differs
     * completely between "show this QR", "you are ready" and "we have messaged
     * the customer", and flattening that into one shape would hide it.
     */
    .post(
      "/devices/claim",
      async ({ auth, body, set, path }) => {
        requireScope(auth, "manage:devices", path);

        // Limited per environment. Each claim of an already-paired number
        // sends a WhatsApp message to a real person; an unbounded loop here
        // is not a service problem, it is harassment.
        requireWithinLimit(`env:${auth.environmentId}`, LIMITS.claim, path);

        const result = await DeviceStore.claim({
          environmentId: auth.environmentId,
          msisdn: body.msisdn,
          alias: body.alias,
          scopes: body.scopes ?? [],
        });

        // The virtual device id, never the global device id: two tenants
        // sharing a phone must not be able to correlate through a shared
        // identifier.
        const base = {
          virtualDeviceId: result.virtualDevice.id,
          alias: result.virtualDevice.alias,
          status: result.virtualDevice.status,
        };

        if (result.outcome === "active") {
          set.status = 200;
          log.info("claim satisfied by existing consent", { environmentId: auth.environmentId });
          return { outcome: result.outcome, ...base };
        }

        // 201 for a device being created here, 202 for one that exists and is
        // waiting on a human. docs/06 documents both, and a single 201 for the
        // pair told an integrator that a resource was created when in fact
        // nothing will happen until a phone holder replies.
        set.status = result.outcome === "awaiting_confirmation" ? 202 : 201;

        if (result.outcome === "pending_pairing") {
          // Pairing starts here, not in the store: the store owns consent, the
          // engine owns sockets, and mixing them is what makes an engine hard
          // to replace.
          // Capacity-aware rather than "the first one": pools are bounded so
          // that one failing takes a known number of devices with it, and
          // always filling pool zero would defeat that.
          // Counted once, outside the attempts. It was inside both, so a
          // database failure here was caught by the same handler as "no pool
          // has capacity" and reported to the caller as a capacity problem —
          // a 503 telling them to retry, for a fault retrying cannot fix.
          const assigned = await DeviceStore.countByPool();

          // No engine named here. The route used to ask for "gowa" and fall
          // back to "fake", which made adding an engine an edit to an API
          // route and left a Baileys-only deployment unable to pair at all.
          // Preference is registration order, decided in the composition root.
          //
          // Only EngineError means "no pool with room". Anything else is a
          // fault in choosing rather than an absence of capacity, and must not
          // be answered with a 503 telling the caller to retry.
          let pool;
          try {
            pool = registry.chooseAny(assigned);
          } catch (err) {
            if (!(err instanceof EngineError)) throw err;
            log.error("no engine pool has capacity; cannot start pairing");
            // 503 with Retry-After, not 404: the device exists and the request
            // is valid — the capacity to pair it does not, and a caller should
            // retry rather than treat it as a bad request.
            throw new UnavailableError("no engine has capacity to pair this device right now");
          }
          await pool.engine.provision(result.device.id);
          // Recorded after provision succeeds, so a device is never counted
          // against a pool that failed to take it.
          // The pool's own kind, recorded as-is. There is no translation
          // layer any more: the row says which engine holds the device.
          await DeviceStore.assignPool(result.device.id, pool.id, pool.kind, result.device.id);
          const session = await pool.engine.startPairing(result.device.id, body.pairingMethod ?? "qr");
          return {
            outcome: result.outcome,
            ...base,
            pairing: {
              method: session.method,
              ...(session.qr === undefined ? {} : { qr: session.qr }),
              ...(session.pairCode === undefined ? {} : { pairCode: session.pairCode }),
              expiresAt: session.expiresAt.toISOString(),
            },
          };
        }

        log.info("claim awaiting phone holder confirmation", { environmentId: auth.environmentId });
        return {
          outcome: result.outcome,
          ...base,
          // The challenge token is deliberately absent. It is the phone
          // holder's to present, and returning it would let the project confirm
          // on their behalf — which is the entire thing consent prevents.
          //
          // The wording says what actually happens. It used to read "The phone
          // holder has been asked to confirm", and nobody was asked: the
          // consent row and its token are created, DeviceStore.respondToConsent exists
          // and is tested, and nothing sends the WhatsApp message or parses a
          // reply. An API that states an action it does not take is worse than
          // one that admits a gap, because the caller stops looking for the
          // problem. Tracked in todo.txt; stage 1 exit criterion 2 is unmet
          // until it is wired.
          message:
            "This number belongs to another project. Consent is recorded as pending, but the confirmation request is not yet delivered — an operator must approve it.",
          consentDelivery: "not_implemented" as const,
        };
      },
      {
        body: t.Object({
          msisdn: t.String({ minLength: 5, maxLength: 20 }),
          alias: t.String({ minLength: 1, maxLength: 60 }),
          scopes: t.Optional(t.Array(t.String())),
          pairingMethod: t.Optional(t.Union([t.Literal("qr"), t.Literal("code")])),
        }),
      },
    )

    /** This environment's virtual devices. */
    .get("/devices", async ({ auth }) => DeviceStore.listForEnvironment(auth.environmentId))

    /**
     * One binding, by id or alias.
     *
     * Documented in docs/06 and reached by every integrator polling a claim to
     * see whether the customer has replied yet — without it the claim flow has
     * no completion signal short of waiting for a webhook.
     */
    .get("/devices/:ref", async ({ auth, params, set, path }) => {
      const binding = await DeviceStore.findBinding(auth.environmentId, params.ref);
      if (binding === null) {
        set.status = 404;
        // Indistinguishable from "exists but is not yours", deliberately:
        // telling the two apart leaks the existence of other tenants' devices.
        return problem(404, "not-found", "Device not found", undefined, path, currentCorrelationId());
      }
      return {
        virtualDeviceId: binding.virtualDevice.id,
        alias: binding.virtualDevice.alias,
        status: binding.virtualDevice.status,
        scopes: binding.virtualDevice.scopes,
        msisdn: binding.device.msisdn,
        deviceState: binding.device.state,
        lastSeenAt: binding.device.lastSeenAt,
      };
    })

    /**
     * Unlink the device from WhatsApp, keeping the slot.
     *
     * Keeping the slot is the point: the binding and its consent survive, so
     * re-pairing the same number needs no fresh confirmation from the phone
     * holder. A purge would be the other thing, and it is not this.
     */
    .post(
      "/devices/:ref/logout",
      async ({ auth, params, set, path }) => {
        requireScope(auth, "manage:devices", path);

        const binding = await DeviceStore.findBinding(auth.environmentId, params.ref);
        if (binding === null) {
          set.status = 404;
          return problem(404, "not-found", "Device not found", undefined, path, currentCorrelationId());
        }

        const poolId = await DeviceStore.poolIdFor(binding.device.id);
        if (poolId === null) {
          // Never paired, so there is no session to end. Idempotent rather
          // than an error: the caller asked for it to be logged out and it is.
          set.status = 204;
          return null;
        }

        await registry.get(poolId).engine.logout(binding.device.id);
        set.status = 204;
        return null;
      },
      { params: t.Object({ ref: t.String() }) },
    )

    /**
     * Start pairing again for a device that already exists.
     *
     * The recovery path for a device that was logged out remotely, or whose
     * QR expired before anyone scanned it. Distinct from claiming: the number
     * is already this project's, so there is no consent question to reopen.
     */
    .post(
      "/devices/:ref/repair",
      async ({ auth, params, set, path }) => {
        requireScope(auth, "manage:devices", path);
        // Same budget as a claim. Each attempt can put a QR in front of a
        // person, and an unbounded loop here is how a device gets hammered.
        requireWithinLimit(`env:${auth.environmentId}`, LIMITS.claim, path);

        const binding = await DeviceStore.findBinding(auth.environmentId, params.ref);
        if (binding === null) {
          set.status = 404;
          return problem(404, "not-found", "Device not found", undefined, path, currentCorrelationId());
        }

        const poolId = await DeviceStore.poolIdFor(binding.device.id);
        if (poolId === null) {
          set.status = 409;
          return problem(
            409,
            "never-paired",
            "Device has no engine",
            "this device has never been paired; claim it instead",
            path,
            currentCorrelationId(),
          );
        }

        const pool = registry.get(poolId);
        await pool.engine.provision(binding.device.id);
        const session = await pool.engine.startPairing(binding.device.id, "qr");

        return {
          virtualDeviceId: binding.virtualDevice.id,
          pairing: {
            method: session.method,
            ...(session.qr === undefined ? {} : { qr: session.qr }),
            ...(session.pairCode === undefined ? {} : { pairCode: session.pairCode }),
            expiresAt: session.expiresAt.toISOString(),
          },
        };
      },
      { params: t.Object({ ref: t.String() }) },
    );
}
