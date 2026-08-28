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
/** How often the log file rolls over. */
export const LOG_ROTATIONS = ["hourly", "daily", "weekly", "never"] as const;
export type LogRotation = (typeof LOG_ROTATIONS)[number];

/**
 * Read one of a fixed set of values.
 *
 * Refuses anything else rather than falling back: a misspelled rotation that
 * silently became "daily" would look correct in every config dump while doing
 * something the operator did not ask for.
 */
function enumerated<T extends string>(
  source: Record<string, string | undefined>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase() as T;
  if (!allowed.includes(value)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(", ")}, got ${raw}`);
  }
  return value;
}

/**
 * Whether this runtime can actually format in that zone.
 *
 * Asked of Intl rather than checked against a list, because the list that
 * matters is the one the process has.
 */
export function isUsableTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

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
   * The timezone every rendered date is expressed in.
   *
   * One setting rather than each formatter choosing, because a log line, a
   * console timestamp and a support answer that disagree by seven hours are
   * worse than any of them being in UTC. Stored timestamps stay UTC — this
   * governs presentation only.
   */
  readonly serverTimezone: string;
  /**
   * Whether SERVER_TIMEZONE was set explicitly, as opposed to defaulted.
   *
   * Settings that an operator can also change in the console need to know the
   * difference: an explicit environment value wins and the field is shown
   * locked, whereas a default is only a starting point the console may
   * override. Without this the two are indistinguishable and the console would
   * silently disagree with the deployment.
   */
  readonly serverTimezoneFromEnv: boolean;

  /**
   * How often the log file rolls over.
   *
   * A single growing file is the disk filling by another route, and the one
   * thing nobody notices until it happens.
   */
  readonly logRotation: LogRotation;

  /** Where rotated log files are written. */
  readonly logDir: string;

  /**
   * Devices per engine pool. Bounds the blast radius of one pool failing.
   *
   * ADR-0003 set this bound when a pool was a separate container, so the
   * operating system enforced it. The engine runs in this process now, which
   * makes the bound one on sockets rather than on containers — still worth
   * having, and no longer the isolation the ADR described.
   */
  readonly enginePoolCapacity: number;

  /**
   * Key for encrypting WhatsApp credentials at rest, or null if none is set.
   *
   * Required by the engine that stores credentials rather than by production as
   * such: with BAILEYS_ENABLED off nothing in this process holds WhatsApp
   * credentials, so there is nothing to encrypt. Null is therefore permitted
   * anywhere that flag is off, and AuthStateStore still refuses to write
   * without it, so no configuration puts account-takeover material in the
   * clear.
   */
  readonly credentialEncryptionKey: string | null;

  /** Whether to register the in-process Baileys engine. Opt-in; see ADR-0009. */
  readonly baileysEnabled: boolean;

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
    this.enginePoolCapacity = integer(source, "ENGINE_POOL_CAPACITY", 25, 1, 500);

    // Validated against the runtime's own database rather than a list we would
    // have to maintain: Intl knows every zone this process can actually
    // format, so an accepted value is one that works.
    this.serverTimezoneFromEnv = (source["SERVER_TIMEZONE"] ?? "").trim() !== "";
    this.serverTimezone = optional(source, "SERVER_TIMEZONE", "Asia/Jakarta");
    if (!isUsableTimezone(this.serverTimezone)) {
      throw new ConfigError(
        `SERVER_TIMEZONE is not a timezone this runtime knows: ${this.serverTimezone}. Use an IANA name such as Asia/Jakarta.`,
      );
    }

    this.logRotation = enumerated(source, "LOG_ROTATION", LOG_ROTATIONS, "daily");
    this.logDir = optional(source, "LOG_DIR", "./data/logs");

    // WhatsApp credentials are encrypted at rest; this is the key.
    //
    // Read here, enforced below against the engine that needs it. An earlier
    // version demanded it of every production deployment and said so in three
    // places; the enforcement changed and two of the comments did not, which
    // is how an operator ends up following a policy the code stopped having.
    const credentialKey = source["CREDENTIAL_ENCRYPTION_KEY"];
    const suppliedKey = credentialKey === undefined || credentialKey.trim() === "" ? null : credentialKey.trim();

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

    // Whether to hold WhatsApp sockets in this process at all.
    //
    // Off by default. The adapter passes its conformance suite against a stub,
    // which proves it satisfies the contract and not that Baileys behaves as
    // the stub does — that needs a real device. Until then a deployment opts
    // in deliberately rather than being upgraded into it.
    this.baileysEnabled = boolean(source, "BAILEYS_ENABLED", false);

    // Required by the engine that stores credentials, not by production as
    // such. The first version demanded it of every production deployment and
    // CI caught the flaw: back when gowa held the credentials, a container
    // running without the engine held none of its own, so the key would have
    // been a barrier protecting nothing — and the failure was a container that
    // refused to start rather than a warning anyone could act on. The engine
    // changed; the shape of the mistake is what this comment is keeping.
    //
    // The engine that does store them still cannot start without it, and
    // AuthStateStore refuses to write without it whatever the mode, so there
    // is no path that puts account-takeover material in the clear.
    if (this.baileysEnabled && suppliedKey === null) {
      throw new ConfigError(
        "BAILEYS_ENABLED requires CREDENTIAL_ENCRYPTION_KEY: this engine keeps WhatsApp credentials in the database and will not write them in the clear. Generate one with `openssl rand -hex 32`.",
      );
    }
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
      serverTimezone: this.serverTimezone,
      logRotation: this.logRotation,
      logDir: this.logDir,
      database: this.databasePath,
      migrateStrict: this.migrateStrict,
      runtimeDir: this.runtimeDir,
      adminApiEnabled: this.adminApiEnabled,
      allowInsecureWebhookTargets: this.allowInsecureWebhookTargets,
      baileysEnabled: this.baileysEnabled,
      // Never the key itself, only whether one is present. describe() is
      // written to the application log at every start.
      credentialEncryptionKey: this.credentialEncryptionKey === null ? "(unset)" : "(set)",
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
