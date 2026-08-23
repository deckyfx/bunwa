/**
 * Database schema (SQLite).
 *
 * Rationale for every table lives in docs/04-data-model.md; this file is the
 * authoritative definition. It now covers the tenancy spine, devices, consent,
 * virtual devices, and the delivery queue with its attempt log.
 *
 * SQLite for now, Postgres when a second process needs the data — see
 * docs/adr/0005-postgres-over-sqlite.md. The column choices below keep that
 * move mechanical: no SQLite-only types, JSON stored as text rather than as a
 * driver-specific column, and timestamps as epoch milliseconds.
 */
import { relations, sql } from "drizzle-orm";

/** Anything that survives a JSON round trip. Used for stored bodies. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Shared audit columns. Every table carries them; none is nullable. */
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

/**
 * A tenant application, e.g. `grande`.
 *
 * `displayName` is customer-facing: it appears verbatim in the WhatsApp consent
 * message a phone holder receives, so it must be a name they recognise.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    ...timestamps,
  },
  (t) => [uniqueIndex("projects_slug_key").on(t.slug)],
);

/**
 * A deployment environment within a project.
 *
 * The environment, not the project, is the unit of configuration: it owns the
 * API keys, the webhook and the quotas. Consent, by contrast, is granted per
 * project and inherited by all of its environments — so onboarding a customer
 * to staging after production asks them nothing.
 */
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: ["live", "test"] }).notNull().default("test"),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    /** Rate limits, default event filter, retry policy, timezone. */
    settings: text("settings", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("environments_project_slug_key").on(t.projectId, t.slug),
    index("environments_project_idx").on(t.projectId),
  ],
);

/**
 * An API key, scoped to exactly one environment.
 *
 * Only the Argon2id hash and a short display prefix are stored; the plaintext
 * is returned once at creation and never again. The caller never states which
 * project or environment it is — that is derived from the key, which makes
 * cross-tenant access structurally impossible rather than a check that could be
 * forgotten.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Argon2id hash of the plaintext key. Never the key itself. */
    keyHash: text("key_hash").notNull(),
    /** Leading characters, for identification in the dashboard and in logs. */
    keyPrefix: text("key_prefix").notNull(),
    /** Operator-facing name: "backend", "cron worker". */
    label: text("label").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    // Lookup path for authentication: hash first, then validity is checked in code.
    uniqueIndex("api_keys_hash_key").on(t.keyHash),
    index("api_keys_environment_idx").on(t.environmentId),
    index("api_keys_prefix_idx").on(t.keyPrefix),
  ],
);

/**
 * A WhatsApp identity. **System-owned and global** — it belongs to no project.
 *
 * `msisdn` being unique is what makes "this phone is already paired, reuse it?"
 * a primary-key lookup rather than a heuristic, and that lookup is the whole
 * product: a customer pairs once, then grants access, instead of scanning a QR
 * per project.
 */
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** E.164. The system-wide identity of the device. */
    msisdn: text("msisdn").notNull(),
    jid: text("jid"),
    pushName: text("push_name"),
    engineKind: text("engine_kind", { enum: ["gowa", "native"] }).notNull().default("gowa"),
    enginePoolId: text("engine_pool_id"),
    /** The id *inside* that engine, which is not ours and may be reassigned. */
    engineDeviceId: text("engine_device_id"),
    state: text("state", {
      enum: ["unpaired", "pairing", "connected", "disconnected", "logged_out", "degraded", "deleted"],
    })
      .notNull()
      .default("unpaired"),
    stateReason: text("state_reason"),
    firstPairedAt: integer("first_paired_at", { mode: "timestamp_ms" }),
    lastConnectedAt: integer("last_connected_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("devices_msisdn_key").on(t.msisdn), index("devices_jid_idx").on(t.jid)],
);

/**
 * Consent, granted per (device, project).
 *
 * Per *project*, not per environment: a customer agrees to "Grande", not to
 * "Grande's staging". Asking once per environment would mean three
 * confirmations to onboard one product, which is the friction this system
 * exists to remove.
 */
export const deviceConsents = sqliteTable(
  "device_consents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "granted", "denied", "revoked", "expired"] })
      .notNull()
      .default("pending"),
    requestedByEnvironmentId: text("requested_by_environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    /** Single-use, carried in the WhatsApp message sent to the number itself. */
    challengeToken: text("challenge_token").notNull(),
    challengeSentAt: integer("challenge_sent_at", { mode: "timestamp_ms" }),
    respondedAt: integer("responded_at", { mode: "timestamp_ms" }),
    responseChannel: text("response_channel", { enum: ["whatsapp_reply", "dashboard", "operator"] }),
    /** Replying JID, message id, IP — what proves they agreed, months later. */
    evidence: text("evidence", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("device_consents_device_project_key").on(t.deviceId, t.projectId)],
);

/** Append-only. The record of what was agreed, and when, and by whom. */
export const consentEvents = sqliteTable(
  "consent_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    consentId: text("consent_id")
      .notNull()
      .references(() => deviceConsents.id, { onDelete: "cascade" }),
    action: text("action", {
      enum: ["requested", "challenge_sent", "granted", "denied", "revoked", "expired"],
    }).notNull(),
    actor: text("actor", { enum: ["phone_holder", "operator", "system"] }).notNull(),
    channel: text("channel", { enum: ["whatsapp_reply", "dashboard", "operator", "system"] }).notNull(),
    evidence: text("evidence", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("consent_events_consent_idx").on(t.consentId)],
);

/**
 * An environment's handle onto a device. The routing unit.
 *
 * A project addresses this id or its alias and never learns the global device
 * id, so two projects sharing one phone see unrelated identifiers and cannot
 * correlate their traffic.
 */
export const virtualDevices = sqliteTable(
  "virtual_devices",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    status: text("status", {
      enum: ["pending_pairing", "pending_consent", "active", "suspended", "revoked"],
    })
      .notNull()
      .default("pending_consent"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** If set, this binding only ever sees these chats. */
    jidAllowlist: text("jid_allowlist", { mode: "json" }).$type<string[] | null>(),
    jidDenylist: text("jid_denylist", { mode: "json" }).$type<string[]>().notNull().default([]),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("virtual_devices_environment_device_key").on(t.environmentId, t.deviceId),
    // Referenced by outbound_messages so a message's environment must match
    // its virtual device's. Two independent foreign keys only prove both rows
    // exist, which permits a row pairing environment A's device with
    // environment B's id — cross-tenant metadata, persisted.
    uniqueIndex("virtual_devices_id_environment_key").on(t.id, t.environmentId),
    uniqueIndex("virtual_devices_environment_alias_key").on(t.environmentId, t.alias),
    index("virtual_devices_device_idx").on(t.deviceId),
  ],
);

/**
 * Where an environment's events are delivered.
 *
 * One target per environment for now. When virtual devices arrive in §1.5 they
 * gain an optional override, which is why delivery rows below key on the
 * environment rather than on this table's id — the queue must not have to move
 * when the target does.
 */
export const environmentWebhooks = sqliteTable("environment_webhooks", {
  environmentId: text("environment_id")
    .primaryKey()
    .references(() => environments.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  /** Signing secret. Encrypted at rest is §2 work; it is never logged or returned. */
  secret: text("secret").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Null means every event this environment is entitled to. */
  eventFilter: text("event_filter", { mode: "json" }).$type<string[] | null>(),
  maxAttempts: integer("max_attempts").notNull().default(8),
  circuitState: text("circuit_state", { enum: ["closed", "open", "half_open"] }).notNull().default("closed"),
  circuitOpenedAt: integer("circuit_opened_at", { mode: "timestamp_ms" }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  ...timestamps,
});

/**
 * One event, queued for one destination.
 *
 * Persisted before it is acknowledged, so a crash between accepting an event
 * and delivering it loses nothing. Attempts live in their own table rather than
 * as a counter here, because "why did this customer not receive their event" is
 * a question about the attempts, not about the current state.
 */
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Stable across retries; consumers deduplicate on it. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, JsonValue>>().notNull(),
    state: text("state", { enum: ["pending", "delivered", "failed", "dead"] }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    // The worker's claim query: due work for a destination, oldest first.
    index("deliveries_due_idx").on(t.state, t.nextAttemptAt),
    index("deliveries_environment_idx").on(t.environmentId),
    uniqueIndex("deliveries_event_environment_key").on(t.eventId, t.environmentId),
  ],
);

/** One HTTP attempt. Kept so a delivery question is a query, not archaeology. */
export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("delivery_attempts_delivery_idx").on(t.deliveryId)],
);

/**
 * Replayed responses for idempotent requests.
 *
 * Scoped to the environment so a key reused between staging and production is
 * not a collision. `requestHash` guards the other direction: the same key with
 * a different body is a caller bug, and returning the first response would send
 * one message while reporting another.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    requestHash: text("request_hash").notNull(),
    /**
     * Null while the request is still in flight.
     *
     * The row is inserted *before* the side effect, so a crash or a concurrent
     * retry finds the reservation rather than an empty table and sends again.
     */
    response: text("response", { mode: "json" }).$type<Record<string, JsonValue>>(),
    statusCode: integer("status_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.key] }),
    index("idempotency_created_idx").on(t.createdAt),
  ],
);

/**
 * Messages bunwa has sent, and their delivery state.
 *
 * Kept because acceptance is not delivery: gowa reported a device connected for
 * 203 seconds after a silent drop (docs/12), so a send that returned a message
 * id proves only that the engine took it. The ack that arrives later — or does
 * not — is what says whether the OTP reached anyone.
 */
export const outboundMessages = sqliteTable(
  "outbound_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    virtualDeviceId: text("virtual_device_id")
      .notNull()
      .references(() => virtualDevices.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** The engine's id for the message, used to match acks. */
    engineMessageId: text("engine_message_id").notNull(),
    type: text("type", {
      enum: ["text", "image", "document", "link", "audio", "video"],
    }).notNull(),
    recipient: text("recipient").notNull(),
    state: text("state", { enum: ["accepted", "delivered", "read", "undelivered"] })
      .notNull()
      .default("accepted"),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }).notNull(),
    ackedAt: integer("acked_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.virtualDeviceId, t.environmentId],
      foreignColumns: [virtualDevices.id, virtualDevices.environmentId],
      name: "outbound_messages_binding_environment_fk",
    }).onDelete("cascade"),
    index("outbound_engine_message_idx").on(t.engineMessageId),
    index("outbound_environment_idx").on(t.environmentId),
    // Unacked sends are swept to message.undelivered, so this is a hot query.
    index("outbound_state_accepted_idx").on(t.state, t.acceptedAt),
  ],
);

/**
 * Automation rules, per virtual device.
 *
 * Per binding rather than per device: two projects sharing one phone must be
 * able to automate it differently, and neither should see the other's rules.
 * gowa's equivalent is a single global string shared by every device.
 */
export const rules = sqliteTable(
  "rules",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    virtualDeviceId: text("virtual_device_id")
      .notNull()
      .references(() => virtualDevices.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Lower runs first. */
    priority: integer("priority").notNull().default(100),
    stopOnMatch: integer("stop_on_match", { mode: "boolean" }).notNull().default(false),
    match: text("match", { mode: "json" }).$type<Record<string, JsonValue>>().notNull(),
    actions: text("actions", { mode: "json" }).$type<JsonValue[]>().notNull(),
    /** Incremented on edit, so a change is visible in an audit trail. */
    version: integer("version").notNull().default(1),
    /**
     * Set when a rule is disabled for exceeding its match budget.
     *
     * Recorded rather than silently flipping `enabled`, so an operator can see
     * why a rule stopped firing instead of assuming someone turned it off.
     */
    disabledReason: text("disabled_reason"),
    ...timestamps,
  },
  (t) => [
    // Same composite target as outbound_messages: two independent foreign keys
    // would permit a rule pairing one environment's binding with another's id.
    foreignKey({
      columns: [t.virtualDeviceId, t.environmentId],
      foreignColumns: [virtualDevices.id, virtualDevices.environmentId],
      name: "rules_binding_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("rules_binding_name_key").on(t.virtualDeviceId, t.name),
    index("rules_binding_priority_idx").on(t.virtualDeviceId, t.priority),
  ],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
}));

export const environmentsRelations = relations(environments, ({ one, many }) => ({
  project: one(projects, { fields: [environments.projectId], references: [projects.id] }),
  apiKeys: many(apiKeys),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  environment: one(environments, { fields: [apiKeys.environmentId], references: [environments.id] }),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type EnvironmentWebhook = typeof environmentWebhooks.$inferSelect;
export type NewEnvironmentWebhook = typeof environmentWebhooks.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceConsent = typeof deviceConsents.$inferSelect;
export type ConsentEvent = typeof consentEvents.$inferSelect;
export type VirtualDevice = typeof virtualDevices.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
