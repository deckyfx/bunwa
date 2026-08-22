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

/**
 * Fragments that make a field name a credential.
 *
 * Matched as substrings of the normalised key rather than as an exact set. The
 * exact-set version was patched twice — once for `accessToken`, once for
 * `clientSecret` — which is fixing instances of a class. Any name containing
 * one of these is masked, and the false positives that costs (a field merely
 * counting tokens) are cheaper than the leak they prevent.
 */
const SENSITIVE_FRAGMENTS = [
  "secret", "password", "passwd", "passphrase", "token", "credential",
  "authorization", "cookie", "privatekey", "apikey", "keyhash", "bearer",
  "sessionid", "signingkey",
];

/** Lowercase and strip separators, so client_secret and clientSecret agree. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a field name suggests it holds a credential. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

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
      Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) ? "***" : redact(v, depth + 1)]),
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
  /** Detail useful while diagnosing, and noise otherwise. Off in production. */
  debug: (message: string, fields?: Record<string, LogValue>) => emit("debug", message, fields),
  /** A thing the service did that an operator would expect to see. */
  info: (message: string, fields?: Record<string, LogValue>) => emit("info", message, fields),
  /** Degraded but serving — something a human should look at, not tonight. */
  warn: (message: string, fields?: Record<string, LogValue>) => emit("warn", message, fields),
  /**
   * Failed, and someone needs to know.
   *
   * The error is a separate parameter rather than a field so it can be
   * unwrapped — name, message, stack and the whole `cause` chain — instead of
   * serialising to the useless `{}` a bare Error produces in JSON.
   */
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
