/**
 * The claim flow over HTTP — §1.3's remaining surface.
 *
 * One call for an integrator: give us a number, get back one of three answers.
 * The interesting one is `active`, where a customer has already consented to
 * this project and nothing at all is asked of them.
 */
import { Elysia, t } from "elysia";

import { requireApiKey, requireScope } from "../../auth/middleware";
import { DeviceStore } from "../../stores/device-store";
import { problem } from "../server";
import type { EngineRegistry } from "../../engine/registry";
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
          let pool;
          try {
            pool = registry.choosePool("gowa", await DeviceStore.countByPool());
          } catch {
            try {
              pool = registry.choosePool("fake", await DeviceStore.countByPool());
            } catch {
              log.error("no engine pool has capacity; cannot start pairing");
              // 503 with Retry-After, not 404: the device exists and the
              // request is valid — the capacity to pair it does not, and a
              // caller should retry rather than treat it as a bad request.
              throw new UnavailableError("no engine has capacity to pair this device right now");
            }
          }
          await pool.engine.provision(result.device.id);
          // Recorded after provision succeeds, so a device is never counted
          // against a pool that failed to take it.
          await DeviceStore.assignPool(result.device.id, pool.id, pool.kind === "native" ? "native" : "gowa", result.device.id);
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
          message: "The phone holder has been asked to confirm. They reply on WhatsApp.",
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
    });
}
