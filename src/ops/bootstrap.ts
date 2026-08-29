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
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { apiKeys, environments, projects } from "../db/schema";
import { ALL_SCOPES } from "../auth/scopes";
import { bootstrapPrefix } from "../auth/api-key";
import { config } from "../config/env";
import { db, type Database } from "../db";
import { withTransaction } from "../db/transaction";
import { log } from "../observability/logger";
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

/**
 * The project and environment the CLI acts in, if one exists yet.
 *
 * Still keyed on the `default` slug, which is now a convention rather than a
 * guarantee: nothing creates it, so an instance set up through the console has
 * whatever the operator named instead and this returns null. Callers that need
 * a tenant must say which one.
 */
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
async function registerEnvKey(database: Database, presented: string): Promise<void> {
  const prefix = bootstrapPrefix(presented);

  // Every bootstrap row. Identified by label rather than by an environment:
  // this key has none. The prefix is derived from the key itself, so it is
  // stable for a given API_KEY and changes the moment the variable does —
  // which is what makes the registration idempotent across restarts and a
  // rotation visible.
  const history = await database
    .select({
      prefix: apiKeys.keyPrefix,
      revokedAt: apiKeys.revokedAt,
      revokedReason: apiKeys.revokedReason,
    })
    .from(apiKeys)
    .where(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL));

  const live = history.filter((row) => row.revokedAt === null);

  // Nothing here compares two rows. Which registration is "current" was
  // inferred from row order first and from revocation timestamps second, and
  // both were questions SQLite does not promise to answer: rows that tie come
  // back in no defined order. Each rule below reads one row's own recorded
  // facts, so there is nothing left for a tie to decide.
  if (live.length === 1 && live[0]!.prefix === prefix) {
    // Registered, live, and the only one. Nothing to do.
    return;
  }

  if (live.length === 0) {
    // Every bootstrap key has been revoked. This one comes back only if it was
    // retired by a rotation; if a person disabled it, a restart must not undo
    // that. `superseded` is written by the supersede path below and by nothing
    // else, so a null reason means someone decided it deliberately.
    const disabledByHand = history.some(
      (row) => row.prefix === prefix && row.revokedAt !== null && row.revokedReason === null,
    );
    if (disabledByHand) return;
  }

  // Everything else registers, and the supersede below is what makes that
  // safe. Two cases reach here besides an ordinary rotation:
  //
  // A database written before rotation retired anything can hold several live
  // bootstrap rows, including one matching this key. Returning because one
  // matched left the others usable — admin keys with every scope, belonging to
  // API_KEY values the operator had already replaced. Falling through revokes
  // all of them and leaves exactly one, so the condition above holds from the
  // next boot onward.
  //
  // And a rollback: a key whose row a later rotation superseded is registered
  // again rather than left revoked, which is the whole point of recording why.

  // Falling through with an older row for this prefix is deliberate. Rotating
  // X → Y → X used to find X's superseded row, take it for an existing
  // registration and return, leaving the operator's key revoked and no way to
  // tell why: rolling a deployment back to a previous API_KEY silently locked
  // them out. A row that something newer superseded is history, not a
  // registration, so the key is registered again.
  //
  // The distinction is positional rather than recorded: a hand-revoked key is
  // still the newest bootstrap row, a superseded one is not.

  const now = new Date();

  // Hashed before anything is written. Argon2 is the slow, throwing part of
  // this function, and doing it after the revocation put a failure exactly
  // where it costs most.
  const keyHash = await Bun.password.hash(presented, { algorithm: "argon2id" });

  // Revocation and replacement together, or neither.
  //
  // Separately, a crash between them left the old key revoked and no new row
  // written — the operator locked out of their own instance by a restart, with
  // the only credential they had just been told was superseded.
  const superseded = await withTransaction(database, async (tx) => {
    // The previous API_KEY stops working here, which is what the docstring
    // above has always claimed and what the code did not do. Rotating the
    // variable registered the new key and left the old row active, so a
    // credential the operator believed they had replaced still authenticated —
    // and the only way to find it was to know it was there.
    //
    // Scoped to bootstrap rows by their label: keys minted through the console
    // or the CLI are not superseded by an environment variable changing.
    const revoked = await tx
      .update(apiKeys)
      // Marked as superseded, not merely revoked. This is the fact the next
      // boot reads to tell "API_KEY changed" from "a person disabled this".
      .set({ revokedAt: now, revokedReason: "superseded", updatedAt: now })
      .where(and(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL), isNull(apiKeys.revokedAt)))
      .returning({ prefix: apiKeys.keyPrefix });

    // Registered as an admin key, like the one setup mints.
    //
    // API_KEY and the setup screen are two ways to obtain the same thing — the
    // operator's credential — so they must produce the same kind of key.
    // Leaving this one a tenant credential would mean the powers you got
    // depended on which door you came through, and the one that made you a
    // tenant let you send WhatsApp messages as that project.
    await tx.insert(apiKeys).values({
      level: "admin",
      environmentId: null,
      keyHash,
      keyPrefix: prefix,
      label: BOOTSTRAP_KEY_LABEL,
      scopes: [...ALL_SCOPES],
      createdAt: now,
      updatedAt: now,
    });

    return revoked;
  });

  if (superseded.length > 0) {
    log.info("revoked the previous API_KEY registration", { revoked: superseded.length });
  }

  log.info("registered the API_KEY from the environment", { level: "admin", scopes: ALL_SCOPES.length });
}

/**
 * Whether any usable credential exists.
 *
 * Deliberately "any key at all", not "a key we created": an operator who added
 * one through the admin API has configured this instance just as much as the
 * setup screen would have.
 *
 * **Usable** is the load-bearing word, and it was not enforced. The row was
 * counted whatever its state, so revoking the only key — or letting it expire —
 * left this reporting a configured instance with nothing that can authenticate.
 * The console then shows a key form, every key is refused, and the setup screen
 * that exists to mint a replacement refuses to appear because setup is closed.
 * That is an instance locked out of itself by the one path meant to prevent it.
 */
async function hasAnyKey(database: Database): Promise<boolean> {
  const now = new Date();
  const [row] = await database
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        isNull(apiKeys.revokedAt),
        // Null expiry means it does not expire, which is the common case and
        // must not be read as "expired at the epoch".
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    )
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
  // No project is created here any more.
  //
  // One was, called "Default", because the operator's key had to live in an
  // environment and an environment needs a project. An admin key has no
  // tenant, so the reason is gone — and a project nobody asked for, named
  // after the fact that it had to exist, is worse than no project at all.
  // Setup names the first one; until then the instance simply has none.
  const existing = await findDefaults(database);

  const envKey = config().apiKey;
  if (envKey !== null) await registerEnvKey(database, envKey);

  // Settings resolve against the database, so this is the first point at which
  // a stored timezone can take effect. Anything logged before now used the
  // environment's, which is the only value available that early.
  setServerTimezone(SettingsStore.resolve("serverTimezone", database).value);

  const configured = envKey !== null || (await hasAnyKey(database));

  return {
    configured,
    apiKeySource: envKey !== null ? "environment" : configured ? "database" : "none",
    projectId: existing?.projectId ?? null,
    environmentId: existing?.environmentId ?? null,
  };
}
