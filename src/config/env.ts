/**
 * Typed, validated environment configuration.
 *
 * Every value is read once at construction and validated there, so a
 * misconfigured deployment fails at boot with a precise message rather than at
 * the first request with a confusing one. Nothing here falls back silently: an
 * absent optional value takes a documented default, but a value that is present
 * and malformed is an error.
 */

import { keyFromSecret } from "../crypto/secret-box";

/** Runtime mode. Controls logging format and migration strictness. */
export type NodeEnv = "development" | "test" | "production";

/** Severity floor for structured logs. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"] as const;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"] as const;

/** Thrown for any configuration problem, so callers can distinguish it. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Read an optional variable, applying a default only when it is truly absent. */
function optional(source: Record<string, string | undefined>, key: string, fallback: string): string {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new ConfigError(`${key} is set but empty; unset it to use the default of "${fallback}"`);
  return raw;
}

/** Read an integer, rejecting anything that is not one rather than coercing. */
function integer(
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new ConfigError(`${key} is set but empty; unset it to use the default of ${fallback}`);
  // Number("12abc") is NaN but Number("") is 0 and Number(" 1 ") is 1 — parse
  // strictly so a typo cannot become a plausible-looking value.
  if (!/^-?\d+$/.test(raw.trim())) throw new ConfigError(`${key} must be an integer, got "${raw}"`);
  const value = Number(raw.trim());
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

/**
 * Read a boolean, accepting only the two spellings that mean something.
 *
 * `raw === "true"` silently maps "yes", "1" and "TRUE" to false — the exact
 * silent-default failure this module exists to prevent, and it was present here
 * until a reviewer pointed at it.
 */
function boolean(source: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${key} must be "true" or "false", got "${raw}"`);
}

/** Read a value constrained to a fixed set. */
function oneOf<T extends string>(
  source: Record<string, string | undefined>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!allowed.includes(value as T)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return value as T;
}

/**
 * Validated configuration for one process.
 *
 * Constructed from a plain record rather than reading `Bun.env` directly, so
 * tests can exercise validation without mutating global state.
 */
export class Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly databasePath: string;
  /** Fail to start when migrations are pending, rather than auto-applying. */
  readonly migrateStrict: boolean;
  /**
   * Writable directory for runtime state, chiefly the migrations materialised
   * out of the binary. Must be writable by the service user and is expected to
   * be ephemeral — nothing here is a source of truth.
   */
  readonly runtimeDir: string;
  /**
   * Whether to mount the admin API.
   *
   * Off by default because it currently has no authentication and can mint API
   * keys. Enabling it is a deliberate act, not a deployment oversight.
   */
  readonly adminApiEnabled: boolean;
  /**
   * Permit webhook targets that are plain http, or private/loopback addresses.
   *
   * Deliberately its own switch rather than derived from NODE_ENV. Deriving a
   * security posture from the environment name means an unset or mistyped
   * NODE_ENV silently disables an SSRF control — and "it was only meant for
   * development" is exactly how that reaches a deployment.
   */
  readonly allowInsecureWebhookTargets: boolean;
  /**
   * Where the colocated gowa engine listens.
   *
   * Null disables the engine entirely, which is the right default for a process
   * that only serves the admin API or runs migrations — registering a pool that
   * cannot answer would report every device degraded.
   */
  readonly gowaBaseUrl: string | null;
  /** Devices per engine pool. Bounds the blast radius of one pool failing. */
  readonly enginePoolCapacity: number;

  /**
   * Key for encrypting WhatsApp credentials at rest, or null outside production.
   *
   * Null is permitted in development so a fresh clone runs without ceremony;
   * the stores refuse to write credentials when it is null rather than writing
   * them unencrypted.
   */
  readonly credentialEncryptionKey: string | null;

  constructor(source: Record<string, string | undefined> = Bun.env) {
    this.nodeEnv = oneOf(source, "NODE_ENV", NODE_ENVS, "development");
    this.port = integer(source, "PORT", 3000, 1, 65535);
    this.host = optional(source, "HOST", "0.0.0.0");
    this.logLevel = oneOf(source, "LOG_LEVEL", LOG_LEVELS, this.nodeEnv === "production" ? "info" : "debug");
    // A filesystem path, not a URL. `file:` is accepted so the variable keeps
    // the conventional name and a Postgres-style value is not silently
    // misread as a relative path.
    this.databasePath = normaliseDatabasePath(optional(source, "DATABASE_PATH", "./data/db/bunwa.sqlite"));
    // Production must never silently mutate a schema; development may.
    this.migrateStrict = boolean(source, "MIGRATE_STRICT", this.nodeEnv === "production");
    this.runtimeDir = optional(source, "RUNTIME_DIR", ".runtime");
    this.adminApiEnabled = boolean(source, "ADMIN_API_ENABLED", false);
    if (this.adminApiEnabled && this.nodeEnv === "production") {
      // It mints API keys and has no authentication. "Not mounted by default"
      // is not enough for something whose accidental exposure hands out
      // credentials; refuse to start instead.
      throw new ConfigError(
        "ADMIN_API_ENABLED must not be true in production: the admin API can mint API keys and has no authentication yet",
      );
    }
    this.allowInsecureWebhookTargets = boolean(source, "ALLOW_INSECURE_WEBHOOK_TARGETS", false);
    const gowa = source["GOWA_BASE_URL"];
    this.gowaBaseUrl = gowa === undefined || gowa.trim() === "" ? null : gowa.trim();
    this.enginePoolCapacity = integer(source, "ENGINE_POOL_CAPACITY", 25, 1, 500);

    // WhatsApp credentials are encrypted at rest; this is the key.
    //
    // Production refuses to start without it rather than falling back to
    // plaintext. An optional secret is one that is absent in the deployment
    // that matters, and the failure would be silent — devices would pair,
    // messages would send, and the account-takeover material would simply be
    // sitting in the database in the clear.
    const credentialKey = source["CREDENTIAL_ENCRYPTION_KEY"];
    const suppliedKey = credentialKey === undefined || credentialKey.trim() === "" ? null : credentialKey.trim();

    if (suppliedKey === null && this.isProduction) {
      throw new ConfigError(
        "CREDENTIAL_ENCRYPTION_KEY is required in production: WhatsApp credentials are account-takeover material and must not be stored in the clear. Generate one with `openssl rand -hex 32`.",
      );
    }

    if (suppliedKey !== null) {
      try {
        // Validated at startup, not at first write. A malformed key discovered
        // when a device pairs is discovered in front of a customer.
        keyFromSecret(suppliedKey);
      } catch (err) {
        throw new ConfigError(`CREDENTIAL_ENCRYPTION_KEY is not usable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.credentialEncryptionKey = suppliedKey;
    if (this.allowInsecureWebhookTargets && this.isProduction) {
      throw new ConfigError("ALLOW_INSECURE_WEBHOOK_TARGETS must not be true in production");
    }
  }

  /**
   * Whether to apply production policy.
   *
   * Read where behaviour must be conservative rather than convenient: JSON log
   * output, and refusing to auto-apply a schema change. Prefer this to
   * comparing `nodeEnv` at the call site, so the policy lives in one place.
   */
  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  /**
   * Whether this process is running a test suite.
   *
   * For behaviour that must not fire under test — background timers, outbound
   * calls — rather than for changing what the code under test does.
   */
  get isTest(): boolean {
    return this.nodeEnv === "test";
  }

  /** Safe to log: the database URL's credentials are stripped. */
  describe(): Record<string, string | number | boolean> {
    return {
      nodeEnv: this.nodeEnv,
      port: this.port,
      host: this.host,
      logLevel: this.logLevel,
      database: this.databasePath,
      migrateStrict: this.migrateStrict,
      runtimeDir: this.runtimeDir,
      adminApiEnabled: this.adminApiEnabled,
      allowInsecureWebhookTargets: this.allowInsecureWebhookTargets,
      // Redacted: a base URL may carry basic-auth credentials for the engine,
      // and describe() is written to the application log at every start.
      gowa: this.gowaBaseUrl === null ? "(disabled)" : redactUrl(this.gowaBaseUrl),
      enginePoolCapacity: this.enginePoolCapacity,
    };
  }
}

/**
 * Resolve a SQLite location.
 *
 * Accepts a bare path, a `file:` URL, or `:memory:`. A `postgres://` value is
 * rejected outright rather than treated as a filename — that mistake would
 * silently create a database file named after the connection string.
 */
export function normaliseDatabasePath(raw: string): string {
  const value = raw.trim();
  if (value === ":memory:") return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("file://")) {
    throw new ConfigError(`DATABASE_PATH must be a file path or a file: URL, got "${raw}"`);
  }
  if (value.startsWith("file:")) {
    const withoutScheme = value.startsWith("file://") ? value.slice("file://".length) : value.slice("file:".length);
    if (withoutScheme.trim() === "") throw new ConfigError(`DATABASE_PATH has no path after "file:"`);
    return withoutScheme;
  }
  return value;
}

/** Strip credentials from a connection string so it can be logged. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    // An unparseable URL must never be echoed — it may itself be a credential.
    return "<unparseable>";
  }
}

let instance: Config | undefined;

/** The process-wide configuration, constructed on first use. */
export function config(): Config {
  instance ??= new Config();
  return instance;
}

/** Reset the memoised instance. Tests only. */
export function resetConfig(): void {
  instance = undefined;
}
