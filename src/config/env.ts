/**
 * Typed, validated environment configuration.
 *
 * Every value is read once at construction and validated there, so a
 * misconfigured deployment fails at boot with a precise message rather than at
 * the first request with a confusing one. Nothing here falls back silently: an
 * absent optional value takes a documented default, but a value that is present
 * and malformed is an error.
 */

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

/**
 * Read a required variable.
 *
 * A variable set to an empty string is a mistake, not an omission — treating it
 * as unset is how a deployment ends up running with a default nobody chose.
 */
function required(source: Record<string, string | undefined>, key: string): string {
  const raw = source[key];
  if (raw === undefined) throw new ConfigError(`${key} is required`);
  if (raw.trim() === "") throw new ConfigError(`${key} is set but empty`);
  return raw;
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
  readonly databaseUrl: string;
  /** Fail to start when migrations are pending, rather than auto-applying. */
  readonly migrateStrict: boolean;

  constructor(source: Record<string, string | undefined> = Bun.env) {
    this.nodeEnv = oneOf(source, "NODE_ENV", NODE_ENVS, "development");
    this.port = integer(source, "PORT", 3000, 1, 65535);
    this.host = optional(source, "HOST", "0.0.0.0");
    this.logLevel = oneOf(source, "LOG_LEVEL", LOG_LEVELS, this.nodeEnv === "production" ? "info" : "debug");
    this.databaseUrl = required(source, "DATABASE_URL");
    // Production must never silently mutate a schema; development may.
    this.migrateStrict = optional(source, "MIGRATE_STRICT", this.nodeEnv === "production" ? "true" : "false") === "true";
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

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
      database: redactUrl(this.databaseUrl),
      migrateStrict: this.migrateStrict,
    };
  }
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
