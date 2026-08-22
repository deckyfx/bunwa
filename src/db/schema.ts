/**
 * Database schema.
 *
 * Rationale for every table lives in docs/04-data-model.md; this file is the
 * authoritative definition. Stage 1.1 covers the tenancy spine only —
 * projects, environments and API keys. Devices, virtual devices and consent
 * arrive in 1.3, and the delivery tables in 1.4.
 */
import { relations, sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const projectStatus = pgEnum("project_status", ["active", "suspended"]);
export const environmentKind = pgEnum("environment_kind", ["live", "test"]);
export const environmentStatus = pgEnum("environment_status", ["active", "suspended"]);

/** Shared audit columns. Every table carries them; none is nullable. */
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A tenant application, e.g. `grande`.
 *
 * `displayName` is customer-facing: it appears verbatim in the WhatsApp consent
 * message a phone holder receives, so it must be a name they recognise.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: projectStatus("status").notNull().default("active"),
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
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    kind: environmentKind("kind").notNull().default("test"),
    status: environmentStatus("status").notNull().default("active"),
    /** Rate limits, default event filter, retry policy, timezone. */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
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
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Argon2id hash of the plaintext key. Never the key itself. */
    keyHash: text("key_hash").notNull(),
    /** Leading characters, for identification in the dashboard and in logs. */
    keyPrefix: text("key_prefix").notNull(),
    /** Operator-facing name: "backend", "cron worker". */
    label: text("label").notNull(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
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
