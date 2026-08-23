/**
 * The bridge from engine events to control-plane state and tenant webhooks.
 *
 * Without this the engine talks to nobody: a device could pair and its binding
 * would stay `pending_pairing` for ever, and `device.logged_out` — the event
 * this project exists to deliver — would be produced by the adapter and then
 * dropped on the floor.
 *
 * Deliberately the only place engine events cause writes. Scattering that
 * across route handlers is how a state machine ends up with two owners.
 */
import { and, eq } from "drizzle-orm";

import { db, type Database } from "../db";
import { devices, environments, projects, virtualDevices } from "../db/schema";
import { DeliveryStore } from "../stores/delivery-store";
import { MessageStore } from "../stores/message-store";
import { EVENT_SCHEMA_VERSION, type EventEnvelope, type EventType } from "../events/schema";
import { log, withContext } from "../observability/logger";
import type { DeviceEngine, EngineEvent } from "./types";

/** Handle one engine event: update state, then fan out to entitled tenants. */
export async function handleEngineEvent(
  event: EngineEvent,
  database: Database = db(),
  engineKind = "unknown",
): Promise<void> {
  switch (event.type) {
    case "device.connected":
      await onConnected(event.deviceId, event.jid, event.pushName, database);
      break;
    case "device.logged_out":
      await onLoggedOut(event.deviceId, database);
      break;
    case "device.disconnected":
      await setState(event.deviceId, "disconnected", event.reason, database);
      break;
    case "device.degraded":
      await setState(event.deviceId, "degraded", event.lastError, database);
      break;
    case "message.ack":
      await MessageStore.recordAck(event.messageId, event.status, database);
      break;
    default:
      break;
  }

  await fanOut(event, engineKind, database);
}

/**
 * A device finished pairing.
 *
 * Activates bindings that were waiting on the scan — only `pending_pairing`.
 * A `pending_consent` binding is waiting on a person, not a socket, and
 * activating it here would hand a project access the phone holder never gave.
 */
async function onConnected(
  deviceId: string,
  jid: string,
  pushName: string | null,
  database: Database,
): Promise<void> {
  const now = new Date();
  await database
    .update(devices)
    .set({ state: "connected", jid, pushName, lastConnectedAt: now, lastSeenAt: now, updatedAt: now })
    .where(eq(devices.id, deviceId));

  await database
    .update(virtualDevices)
    .set({ status: "active", activatedAt: now, updatedAt: now })
    .where(and(eq(virtualDevices.deviceId, deviceId), eq(virtualDevices.status, "pending_pairing")));
}

/** The customer unlinked. Keep-slot: the row and its bindings survive. */
async function onLoggedOut(deviceId: string, database: Database): Promise<void> {
  await database
    .update(devices)
    .set({ state: "logged_out", jid: null, updatedAt: new Date() })
    .where(eq(devices.id, deviceId));
}

async function setState(
  deviceId: string,
  state: "disconnected" | "degraded",
  reason: string,
  database: Database,
): Promise<void> {
  await database
    .update(devices)
    .set({ state, stateReason: reason, updatedAt: new Date() })
    .where(eq(devices.id, deviceId));
}

/**
 * Deliver an event to every environment entitled to see it.
 *
 * Resolved from the device outward, never from the environment inward: an event
 * cannot reach a tenant with no active binding, because no query would find
 * them.
 */
async function fanOut(event: EngineEvent, engineKind: string, database: Database): Promise<void> {
  const bindings = await database
    .select({
      environmentId: virtualDevices.environmentId,
      environmentSlug: environments.slug,
      projectId: environments.projectId,
      // Joined so the envelope can name the project. An empty slug left
      // consumers unable to identify the tenant from documented metadata.
      projectSlug: projects.slug,
      alias: virtualDevices.alias,
      virtualDeviceId: virtualDevices.id,
    })
    .from(virtualDevices)
    .innerJoin(environments, eq(virtualDevices.environmentId, environments.id))
    .innerJoin(projects, eq(environments.projectId, projects.id))
    .where(and(eq(virtualDevices.deviceId, event.deviceId), eq(virtualDevices.status, "active")));

  for (const binding of bindings) {
    const envelope: EventEnvelope = {
      schema: EVENT_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      type: event.type as EventType,
      occurred_at: new Date().toISOString(),
      environment: { id: binding.environmentId, slug: binding.environmentSlug },
      project: { id: binding.projectId, slug: binding.projectSlug },
      data: { virtualDeviceId: binding.virtualDeviceId, alias: binding.alias, ...withoutGlobalIds(event) },
      // The engine that produced it, passed in rather than hard-coded — the
      // control plane must not name one implementation.
      meta: { engine: engineKind, origin: "engine" },
    };
    await DeliveryStore.enqueue(binding.environmentId, envelope, database);
  }
}

/**
 * Strip identifiers a tenant must not receive.
 *
 * `deviceId` is bunwa's global id, replaced above by the binding's. Inbound
 * messages carry no sender display name by contract — the engine type has no
 * field for it — so the phone holder's address book cannot leak here even by
 * accident.
 */
function withoutGlobalIds(event: EngineEvent): Record<string, unknown> {
  const { deviceId: _global, type: _type, ...rest } = event as Record<string, unknown> & { deviceId: string };
  return rest;
}

/**
 * Consume an engine's event stream until it closes.
 *
 * Each event is handled in its own logging context, so an event and the
 * deliveries it produces share one correlation id.
 */
export function startEngineConsumer(engine: DeviceEngine, database: Database = db()): () => Promise<void> {
  let stopped = false;

  // Retained rather than discarded, so shutdown can await it. Dropping the task
  // let process.exit run while an event was mid-write — the delivery half
  // enqueued, the state half not.
  const task = (async () => {
    for await (const event of engine.subscribe()) {
      if (stopped) return;
      try {
        await withContext({ correlationId: crypto.randomUUID() }, () =>
          handleEngineEvent(event, database, engine.kind),
        );
      } catch (err) {
        // One bad event must not end the stream: dropping the rest would stop
        // every tenant learning anything about any device again.
        log.error("failed to handle engine event", err, { eventType: event.type });
      }
    }
  })();

  return async () => {
    stopped = true;
    await task.catch(() => undefined);
  };
}
