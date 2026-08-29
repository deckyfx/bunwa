/**
 * API keys.
 *
 * Authentication reads through here, so this is the hottest security path in
 * the service. Two rules it must never bend: the plaintext is returned exactly
 * once and never stored, and a key that is revoked or expired authenticates
 * nothing regardless of how valid its hash is.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  bootstrapPrefix,
  DUMMY_KEY_HASH,
  generateApiKey,
  isBootstrapCandidate,
  prefixOf,
  verifyApiKey,
} from "../auth/api-key";
import { db, type Database } from "../db";
import { apiKeys, environments, projects, type ApiKey } from "../db/schema";
import { NotFoundError, ValidationError } from "./errors";
import { log } from "../observability/logger";

/** What authentication resolves a presented key to. */
/**
 * A key that authenticated, and what it turned out to be.
 *
 * A union rather than nullable fields, so a caller cannot read a tenant off an
 * admin key by forgetting to check. The middleware narrows this once and hands
 * each route the half it needs — which is why no project handler gained a null
 * case when admin keys stopped having a tenant.
 */
export type ResolvedKey =
  | {
      level: "tenant";
      apiKey: ApiKey;
      environmentId: string;
      projectId: string;
      scopes: string[];
    }
  | {
      level: "admin";
      apiKey: ApiKey;
      scopes: string[];
    };

/**
 * Most candidates one prefix may select before the rest are ignored.
 *
 * One is expected. Anything more is a collision or a probe, and each candidate
 * costs an Argon2id verification.
 */
const MAX_PREFIX_CANDIDATES = 5;

/**
 * Why a credential was turned away — in the log, never in the response.
 *
 * The API answers 401 for every failure on purpose: revoked, unknown, expired
 * and malformed must be indistinguishable to a caller, or probing tells an
 * attacker which guesses were close. That property costs the operator the one
 * thing they need when a key they believe is correct is refused, and the log
 * is where it can be paid back without giving anything away — reading it
 * already requires access the attacker does not have.
 *
 * The prefix is logged because it is stored in the clear and is designed to
 * identify a key; the presented secret never is. The length is, because
 * "pasted with a trailing character" and "pasted the wrong thing entirely" are
 * the two commonest causes and the length separates them.
 */
type RejectionReason =
  | "malformed"
  | "no-key-with-this-prefix"
  | "prefix-matched-but-secret-did-not"
  | "revoked"
  | "expired"
  | "tenant-not-active"
  | "tenant-key-without-environment";

function reject(reason: RejectionReason, prefix: string | null, presented: string): void {
  log.warn("api key rejected", {
    reason,
    prefix,
    presentedLength: presented.length,
    hint: HINTS[reason],
  });
}

/** What an operator should check first, for each way this fails. */
const HINTS: Record<RejectionReason, string> = {
  malformed:
    "not shaped like a key this instance issues (bw_live_<project>_<secret>) and too short to be an API_KEY from the environment; check for a truncated paste",
  "no-key-with-this-prefix":
    "the key is well-formed but no row matches it; it was issued by a different database, or this one has been replaced since",
  "prefix-matched-but-secret-did-not":
    "a key with this prefix exists but the secret does not match; check for a partial paste or trailing whitespace",
  revoked: "this key was revoked",
  expired: "this key is past its expiry",
  "tenant-not-active": "the key is valid but its project or environment is suspended",
  "tenant-key-without-environment":
    "a tenant key with no environment, which should not exist: the column is nullable only so an admin key can have no tenant. Refused rather than promoted — treating it as an admin key would turn a broken row into instance-wide access",
};

export class ApiKeyStore {
  /**
   * Mint a credential that acts on the instance rather than inside a project.
   *
   * Separate from `create` because the two take different inputs and mean
   * different things: this one names no environment, and could not, since an
   * admin key has no tenant. Keeping them apart is what stops an admin key
   * being minted by forgetting an argument.
   *
   * The key reads `bw_live_admin_…`, so a listing and a log line say what it
   * is without anyone looking it up. A project whose slug is literally "admin"
   * would produce the same shape — cosmetic only, since resolution is by hash
   * and the level is a column, not a naming convention.
   */
  static async createAdmin(
    input: { label: string; scopes: string[]; expiresAt?: Date },
    database: Database = db(),
  ): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const label = input.label.trim();
    if (label === "") throw new ValidationError("label is required", "label");

    const generated = await generateApiKey({ projectSlug: "admin", kind: "live" });

    const [created] = await database
      .insert(apiKeys)
      .values({
        level: "admin",
        environmentId: null,
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        label,
        scopes: input.scopes,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");

    return { apiKey: created, plaintext: generated.plaintext };
  }

  /**
   * Mint a key that acts inside one environment of one project.
   *
   * The tenant counterpart to `createAdmin`: this one names the environment it
   * belongs to, and that environment is the whole of what the key can reach.
   * Every key a project issues comes from here — `createAdmin` exists for the
   * instance-level credential alone, and is deliberately not reachable by
   * passing something unusual to this method.
   *
   * The plaintext in the return value is the only copy that will ever exist.
   *
   * @throws NotFoundError if the environment does not belong to the project
   */
  static async create(
    input: { projectId: string; environmentId: string; label: string; scopes: string[]; expiresAt?: Date },
    database: Database = db(),
  ): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const label = input.label.trim();
    if (label === "") throw new ValidationError("label is required", "label");

    const [row] = await database
      .select({ envId: environments.id, projectSlug: projects.slug, kind: environments.kind })
      .from(environments)
      .innerJoin(projects, eq(environments.projectId, projects.id))
      .where(and(eq(environments.id, input.environmentId), eq(environments.projectId, input.projectId)))
      .limit(1);
    if (row === undefined) throw new NotFoundError(`environment ${input.environmentId} not found`);

    const generated = await generateApiKey({ projectSlug: row.projectSlug, kind: row.kind });

    const [created] = await database
      .insert(apiKeys)
      .values({
        level: "tenant",
        environmentId: row.envId,
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        label,
        scopes: input.scopes,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");

    return { apiKey: created, plaintext: generated.plaintext };
  }

  /**
   * Resolve a presented key to its environment, or null.
   *
   * Null covers every failure — malformed, unknown, revoked, expired, or
   * belonging to a suspended tenant — so a caller cannot accidentally
   * distinguish them and turn this into an enumeration oracle.
   */
  /** @crossTenant Authentication itself: the credential is what establishes scope. */
  static async resolve(presented: string, database: Database = db()): Promise<ResolvedKey | null> {
    // A key this system minted is indexed by its own readable prefix; one an
    // operator supplied through API_KEY is indexed by a derived value, because
    // it does not carry our shape. Both are index selectors only — whichever
    // row is selected still has to verify.
    const prefix = prefixOf(presented) ?? (isBootstrapCandidate(presented) ? bootstrapPrefix(presented) : null);
    // Reject shape before touching the database: an unparseable credential must
    // not become a query on attacker-controlled text.
    if (prefix === null) {
      reject("malformed", null, presented);
      return null;
    }

    // Capped. The prefix includes six characters of the secret, so a legitimate
    // request selects one row; a large result set means someone is probing, and
    // an uncapped query would have this loop run Argon2id once per row.
    const candidates = await database
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, prefix))
      .limit(MAX_PREFIX_CANDIDATES);

    if (candidates.length === 0) {
      // Verify against a dummy hash anyway. Returning here without hashing
      // makes an unknown prefix measurably faster than a known one, which tells
      // an attacker when a prefix guess is correct.
      await verifyApiKey(presented, await DUMMY_KEY_HASH);
      reject("no-key-with-this-prefix", prefix, presented);
      return null;
    }

    for (const candidate of candidates) {
      // Verify before checking validity, so a revoked key and an unknown one
      // take indistinguishable time for an attacker probing prefixes.
      const matches = await verifyApiKey(presented, candidate.keyHash);
      if (!matches) continue;
      if (!this.isUsable(candidate)) {
        reject(candidate.revokedAt !== null ? "revoked" : "expired", prefix, presented);
        return null;
      }

      // An admin key has no tenant to check, and no environment to be
      // suspended with. It authenticates on its own validity alone.
      if (candidate.level === "admin") {
        return { level: "admin", apiKey: candidate, scopes: candidate.scopes };
      }

      // A tenant key with no environment is a row that should not exist —
      // the column is nullable only for the admin case. Refused rather than
      // treated as an admin key, which would promote a broken row.
      if (candidate.environmentId === null) {
        reject("tenant-key-without-environment", prefix, presented);
        return null;
      }

      const [env] = await database
        .select({ projectId: environments.projectId, envStatus: environments.status, projectStatus: projects.status })
        .from(environments)
        .innerJoin(projects, eq(environments.projectId, projects.id))
        .where(eq(environments.id, candidate.environmentId))
        .limit(1);
      // A suspended project or environment authenticates nothing, whatever the
      // key's own state says.
      if (env === undefined || env.envStatus !== "active" || env.projectStatus !== "active") {
        reject("tenant-not-active", prefix, presented);
        return null;
      }

      return {
        level: "tenant",
        apiKey: candidate,
        environmentId: candidate.environmentId,
        projectId: env.projectId,
        scopes: candidate.scopes,
      };
    }

    reject("prefix-matched-but-secret-did-not", prefix, presented);
    return null;
  }

  /** Whether a key is neither revoked nor expired. */
  static isUsable(key: ApiKey, now: Date = new Date()): boolean {
    if (key.revokedAt !== null) return false;
    if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return false;
    return true;
  }

  /**
   * Record that a key was used.
   *
   * Deliberately not awaited on the request path — a write per request would
   * put authentication behind the database's write lock, and an approximate
   * last-used time is worth more than the latency it would cost to be exact.
   */
  static touch(id: string, environmentId: string | null, database: Database = db()): void {
    // Rejection handled rather than swallowed silently: an unhandled rejection
    // in Bun can terminate the process, and losing the service because a
    // last-used timestamp failed to write would be an absurd way to go down.
    void database
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      // The id here came from a row this process just authenticated, so it is
      // already proven — but the predicate costs nothing and keeps the rule
      // "every mutation names its tenant" true without exceptions to remember.
      // An admin key has no environment, so the tenant predicate cannot apply
      // to it. The rule it enforces — "every mutation names its tenant" — is
      // about reaching another tenant's rows, and a key with no tenant has
      // none to reach: the id alone is the whole scope of the update.
      .where(
        environmentId === null
          ? and(eq(apiKeys.id, id), isNull(apiKeys.environmentId))
          : and(eq(apiKeys.id, id), eq(apiKeys.environmentId, environmentId)),
      )
      .catch((err: unknown) => {
        log.warn("failed to record api key use", { error: err instanceof Error ? err.message : String(err) });
      });
  }

  /**
   * Every key in one environment.
   *
   * Joined through environments rather than filtered on the key's own column:
   * that join *is* the tenant boundary here, and a caller supplying another
   * project's environment id gets nothing rather than someone else's keys.
   * Never returns a hash or a plaintext — only what a dashboard may show.
   */
  static async listForEnvironment(
    projectId: string,
    environmentId: string,
    database: Database = db(),
  ): Promise<ApiKey[]> {
    // Joined through environments so a caller cannot list another project's keys
    // by supplying its environment id.
    const rows = await database
      .select({ key: apiKeys })
      .from(apiKeys)
      .innerJoin(environments, eq(apiKeys.environmentId, environments.id))
      .where(and(eq(apiKeys.environmentId, environmentId), eq(environments.projectId, projectId)));
    return rows.map((r) => r.key);
  }

  /** Revocation takes effect immediately; there is no cache to invalidate. */
  static async revoke(
    projectId: string,
    environmentId: string,
    id: string,
    database: Database = db(),
  ): Promise<ApiKey> {
    const existing = await this.listForEnvironment(projectId, environmentId, database);
    const target = existing.find((k) => k.id === id);
    if (target === undefined) throw new NotFoundError(`api key ${id} not found`);

    // The ownership check above is a separate read with an await between it and
    // this statement. A predicate that is not on the statement is not enforced
    // by the database, so the environment is repeated here — and `isNull`
    // makes revocation idempotent rather than silently re-stamping a key that
    // was already revoked, which would move its revokedAt forward and lose when
    // it actually happened.
    const [updated] = await database
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.environmentId, environmentId), isNull(apiKeys.revokedAt)))
      .returning();
    if (updated === undefined) throw new NotFoundError(`api key ${id} not found`);
    return updated;
  }
}
