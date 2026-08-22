/**
 * Structured logging with a correlation id carried across the request path.
 *
 * Every line is JSON in production so it can be queried, and human-readable in
 * development so it can be read. The correlation id is the thread that makes a
 * support question — "what happened to this send?" — one query rather than a
 * timestamp hunt, and it is the same id returned to the caller in an error body.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { config, type LogLevel } from "../config/env";

/** Ordering used to decide whether a line clears the configured floor. */
const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Values a log field may hold. Deliberately narrow: no functions, no classes. */
export type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

/** Fields attached to every line emitted inside a given context. */
export interface LogContext {
  correlationId: string;
  [key: string]: LogValue;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Keys whose values are replaced before a line is emitted. */
const REDACT = new Set([
  "apikey", "api_key", "authorization", "password", "passwd", "secret",
  "token", "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "bearer", "credential", "credentials", "privatekey", "private_key",
  "webhooksecret", "webhook_secret", "keyhash", "key_hash",
  "challengetoken", "challenge_token", "sessionid", "session_id", "cookie",
]);

/**
 * Replace the value of any field whose name suggests a credential.
 *
 * Redaction is by key rather than by value pattern: a value-based rule cannot
 * tell a token from an id, whereas a caller who names a field `secret` has told
 * us what it is.
 */
function redact(value: LogValue, depth = 0): LogValue {
  if (depth > 6) return "<max depth>";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, REDACT.has(k.toLowerCase()) ? "***" : redact(v, depth + 1)]),
    );
  }
  return value;
}

/** Serialise an error without losing its cause chain. */
function describeError(err: unknown): LogValue {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack === undefined ? {} : { stack: err.stack }),
      ...(err.cause === undefined ? {} : { cause: describeError(err.cause) }),
    };
  }
  return String(err);
}

/** Emit one line, if it clears the configured severity floor. */
function emit(level: LogLevel, message: string, fields: Record<string, LogValue> = {}): void {
  const cfg = config();
  if (SEVERITY[level] < SEVERITY[cfg.logLevel]) return;

  // Context fields are redacted too. They were not, and a credential placed in
  // a request context — precisely where one is most likely to be put — reached
  // the log verbatim while a directly-logged one was masked.
  const context = storage.getStore();
  const line: Record<string, LogValue> = {
    level,
    time: new Date().toISOString(),
    message,
    ...(redact(context ?? {}) as Record<string, LogValue>),
    ...(redact(fields) as Record<string, LogValue>),
  };

  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (cfg.isProduction) {
    out(JSON.stringify(line));
    return;
  }
  // Development: one readable line, with the correlation id kept short.
  const rawId = line["correlationId"];
  const id = typeof rawId === "string" ? rawId.slice(0, 8) : "--------";
  const rest = Object.entries(line).filter(([k]) => !["level", "time", "message", "correlationId"].includes(k));
  const time = typeof line["time"] === "string" ? line["time"] : new Date().toISOString();
  out(`${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${id}] ${message}` +
      (rest.length ? ` ${JSON.stringify(Object.fromEntries(rest))}` : ""));
}

/**
 * The application logger.
 *
 * Exists so that every line the service emits is queryable in aggregate and
 * carries the correlation id a support question starts from. Call it rather
 * than console: console output has no level, no context and no redaction.
 */
export const log = {
  debug: (message: string, fields?: Record<string, LogValue>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, LogValue>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, LogValue>) => emit("warn", message, fields),
  error: (message: string, err?: unknown, fields?: Record<string, LogValue>) =>
    emit("error", message, { ...fields, ...(err === undefined ? {} : { error: describeError(err) }) }),
};

/**
 * Run `fn` with these fields attached to every line it emits.
 *
 * The mechanism that makes a correlation id useful: set once per request at the
 * edge, and every log line beneath it — including inside awaited calls several
 * layers down — carries it without being passed one.
 */
export function withContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The correlation id of the current context, if there is one.
 *
 * For code that must put the id somewhere other than a log line — an error
 * body, an outbound header — without threading it through its own signature.
 */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Accept a caller-supplied correlation id only if it is plausibly one.
 *
 * The value is echoed in logs and error bodies, so an unvalidated header is a
 * log-injection and unbounded-memory vector.
 */
export function sanitiseCorrelationId(candidate: string | null | undefined): string | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}
