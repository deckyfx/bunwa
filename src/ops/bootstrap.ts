/**
 * Making a blank database usable.
 *
 * A fresh install has no project, no environment and no key, so every
 * authenticated route answers 401 and the console has nothing to show but a
 * form it cannot satisfy. This module decides what exists on first run and
 * reports what the console should ask for.
 *
 * Two ways in, and the precedence between them is the same rule as every other
 * setting: `API_KEY` in the environment wins. When it is set the credential is
 * fixed by whatever created the deployment, and the setup screen does not
 * offer to mint another. When it is not, the setup screen mints one and shows
 * it once.
 */
import { and, eq } from "drizzle-orm";

import { apiKeys, environments, projects } from "../db/schema";
import { ALL_SCOPES } from "../auth/scopes";
import { bootstrapPrefix } from "../auth/api-key";
import { config } from "../config/env";
import { db, type Database } from "../db";
import { EnvironmentStore } from "../stores/environment-store";
import { log } from "../observability/logger";
import { ProjectStore } from "../stores/project-store";
import { SettingsStore } from "../stores/settings-store";
import { setServerTimezone } from "../time/format";

/** The tenant a single-instance deployment operates as. */
export const DEFAULT_PROJECT_SLUG = "default";
export const DEFAULT_ENVIRONMENT_SLUG = "production";

/** Label on the key row that mirrors `API_KEY`, so its origin is obvious. */
export const BOOTSTRAP_KEY_LABEL = "API_KEY (environment)";

/** Where the instance stands, as the setup screen needs to see it. */
export interface InstanceState {
  /** True once a credential exists that someone could actually present. */
  configured: boolean;
  /** Where that credential comes from, or none yet. */
  apiKeySource: "environment" | "database" | "none";
  projectId: string | null;
  environmentId: string | null;
}

/** Find the single-instance project and environment, if they exist yet. */
async function findDefaults(
  database: Database,
): Promise<{ projectId: string; environmentId: string } | null> {
  const [row] = await database
    .select({ projectId: projects.id, environmentId: environments.id })
    .from(projects)
    .innerJoin(environments, eq(environments.projectId, projects.id))
    .where(and(eq(projects.slug, DEFAULT_PROJECT_SLUG), eq(environments.slug, DEFAULT_ENVIRONMENT_SLUG)))
    .limit(1);

  return row ?? null;
}

/** Create the single-instance project and environment, or return the existing. */
async function ensureDefaults(database: Database): Promise<{ projectId: string; environmentId: string }> {
  const existing = await findDefaults(database);
  if (existing !== null) return existing;

  const project = await ProjectStore.create(
    { slug: DEFAULT_PROJECT_SLUG, displayName: "Default" },
    database,
  );
  const environment = await EnvironmentStore.create(
    // Explicitly live. The store defaults to "test", which is the right
    // default for an environment someone is adding to an existing project and
    // the wrong one for the only environment a single-instance deployment has
    // — every key it ever mints would read `bw_test_`, and the prefix is meant
    // to be the thing that stops a test credential being mistaken for a real
    // one at a glance.
    { projectId: project.id, slug: DEFAULT_ENVIRONMENT_SLUG, kind: "live" },
    database,
  );

  log.info("created the default project and environment", {
    projectId: project.id,
    environmentId: environment.id,
  });
  return { projectId: project.id, environmentId: environment.id };
}

/**
 * Register `API_KEY` as a real key row.
 *
 * It has to be a row rather than a special case in the auth path, because a
 * stream ticket references the key that minted it — a synthetic id would fail
 * that foreign key, and the console's own event stream is the first thing to
 * hit it. Being a row also means it is revocable and traceable like any other.
 *
 * Idempotent: the derived prefix is stable for a given key, so a restart
 * recognises the row it wrote last time. Changing `API_KEY` leaves the old row
 * behind revoked rather than deleted, so a key that was in use remains
 * auditable.
 */
async function registerEnvKey(database: Database, environmentId: string, presented: string): Promise<void> {
  const prefix = bootstrapPrefix(presented);

  const existing = await database
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.environmentId, environmentId)))
    .limit(1);

  if (existing[0] !== undefined) {
    // Already registered, and possibly revoked by hand. Un-revoking on restart
    // would make revocation useless for the one key an operator cannot rotate
    // without a redeploy, so it is left exactly as found.
    return;
  }

  const now = new Date();
  await database.insert(apiKeys).values({
    environmentId,
    keyHash: await Bun.password.hash(presented, { algorithm: "argon2id" }),
    keyPrefix: prefix,
    label: BOOTSTRAP_KEY_LABEL,
    scopes: [...ALL_SCOPES],
    createdAt: now,
    updatedAt: now,
  });

  log.info("registered the API_KEY from the environment", { environmentId, scopes: ALL_SCOPES.length });
}

/**
 * Whether any usable credential exists.
 *
 * Deliberately "any key at all", not "a key we created": an operator who added
 * one through the admin API has configured this instance just as much as the
 * setup screen would have.
 */
async function hasAnyKey(database: Database, environmentId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.environmentId, environmentId))
    .limit(1);
  return row !== undefined;
}

/**
 * Bring the instance to a state the console can work with, and report it.
 *
 * Called once at boot. Creating the project and environment eagerly — even
 * with no key — means the setup screen has somewhere to put one, and means the
 * blank-slate path is exercised on every fresh start rather than only when
 * someone reaches the screen.
 */
export async function ensureBootstrap(database: Database = db()): Promise<InstanceState> {
  const { projectId, environmentId } = await ensureDefaults(database);

  const envKey = config().apiKey;
  if (envKey !== null) await registerEnvKey(database, environmentId, envKey);

  // Settings resolve against the database, so this is the first point at which
  // a stored timezone can take effect. Anything logged before now used the
  // environment's, which is the only value available that early.
  setServerTimezone(SettingsStore.resolve("serverTimezone", database).value);

  const configured = envKey !== null || (await hasAnyKey(database, environmentId));

  return {
    configured,
    apiKeySource: envKey !== null ? "environment" : configured ? "database" : "none",
    projectId,
    environmentId,
  };
}
