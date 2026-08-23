/**
 * The event envelope.
 *
 * One shape for every event from every engine, so a consumer written against
 * bunwa never learns which library is behind a device. Versioned in the payload
 * rather than the URL because a webhook consumer cannot negotiate a version at
 * request time — it receives what it is sent, and needs to know what it got.
 */

/** Bumped only for a breaking change to the envelope, never for a new type. */
export const EVENT_SCHEMA_VERSION = "bunwa.event/v1";

/** Every event type bunwa can emit. */
export const EVENT_TYPES = [
  // Lifecycle — the events gowa never delivers, and the reason for this project.
  "device.provisioned",
  "device.qr",
  "device.pair_code",
  "device.pairing_failed",
  "device.connected",
  "device.disconnected",
  "device.logged_out",
  "device.degraded",
  "device.recovered",
  "device.purged",
  // Consent
  "consent.requested",
  "consent.granted",
  "consent.denied",
  "consent.revoked",
  "virtualdevice.activated",
  "virtualdevice.suspended",
  // Messaging
  "message.received",
  "message.sent",
  "message.ack",
  "message.undelivered",
  // Informational; excluded from the default filter — bunwa never answers or
  // rejects a call, so a project opts in to hearing about them.
  "call.offer",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Types delivered unless an environment asks otherwise. */
export const DEFAULT_EVENT_FILTER: readonly EventType[] = EVENT_TYPES.filter((t) => t !== "call.offer");

export interface EventEnvelope {
  schema: typeof EVENT_SCHEMA_VERSION;
  /** Stable across retries. Consumers must deduplicate on it. */
  id: string;
  type: EventType;
  occurred_at: string;
  environment: { id: string; slug: string };
  project: { id: string; slug: string };
  data: Record<string, unknown>;
  meta: {
    /** Which engine produced it, for support rather than for branching. */
    engine?: string;
    correlation_id?: string;
    /**
     * Marks an event bunwa itself caused.
     *
     * Rules exclude these by default: without it, a rule that replies to a
     * message matches its own reply. Distinct from a message's `is_from_me`,
     * which is true for anything the phone holder sent from their own handset
     * and is not bunwa-originated at all.
     */
     origin?: "bunwa" | "engine";
  };
}

/** Whether a string names an event bunwa can emit. */
export function isEventType(candidate: string): candidate is EventType {
  return (EVENT_TYPES as readonly string[]).includes(candidate);
}

/**
 * Whether an environment's filter admits this type.
 *
 * A null filter means the documented default, not "everything": `call.offer`
 * has to be asked for, so a project that never considered calls does not start
 * receiving them because a device happened to ring.
 */
export function passesFilter(type: EventType, filter: string[] | null): boolean {
  if (filter === null) return DEFAULT_EVENT_FILTER.includes(type);
  return filter.includes(type);
}
