/**
 * Database schema (SQLite).
 *
 * Rationale for every table lives in docs/04-data-model.md; this file is the
 * authoritative definition. Stage 1 covers the tenancy spine only — projects,
 * environments and API keys. Devices, virtual devices and consent arrive in
 * 1.3, delivery tables in 1.4.
 *
 * SQLite for now, Postgres when a second process needs the data — see
 * docs/adr/0005-postgres-over-sqlite.md. The column choices below keep that
 * move mechanical: no SQLite-only types, JSON stored as text rather than as a
 * driver-specific column, and timestamps as epoch milliseconds.
 */
import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
