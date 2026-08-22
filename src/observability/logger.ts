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
  "apikey", "api_key", "authorization", "password", "secret", "token",
  "webhook_secret", "key_hash", "challenge_token",
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

  const context = storage.getStore();
  const line = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context ?? {}),
    ...(redact(fields) as Record<string, LogValue>),
  };

  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (cfg.isProduction) {
    out(JSON.stringify(line));
    return;
  }
  // Development: one readable line, with the correlation id kept short.
  const id = typeof line["correlationId"] === "string" ? line["correlationId"].slice(0, 8) : "--------";
  const rest = Object.entries(line).filter(([k]) => !["level", "time", "message", "correlationId"].includes(k));
  out(`${line.time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${id}] ${message}` +
      (rest.length ? ` ${JSON.stringify(Object.fromEntries(rest))}` : ""));
}

export const log = {
  debug: (message: string, fields?: Record<string, LogValue>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, LogValue>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, LogValue>) => emit("warn", message, fields),
  error: (message: string, err?: unknown, fields?: Record<string, LogValue>) =>
    emit("error", message, { ...fields, ...(err === undefined ? {} : { error: describeError(err) }) }),
};

/** Run `fn` with these fields attached to every line it emits. */
export function withContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The correlation id of the current context, if there is one. */
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
