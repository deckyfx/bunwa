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
import { formatIso } from "../time/format";
import { formatForConsole, formatForFile, writeToFile } from "./sinks";

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

/**
 * Strip credentials embedded in a string value.
 *
 * Key-based redaction cannot see these: `{ url: "postgres://u:pw@host/db" }`
 * has an innocuous field name and a password in the value, and driver errors
 * routinely quote the whole connection string in their message and stack.
 */
export function scrubValue(value: string): string {
  return value
    // scheme://user:password@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1***:***@")
    // Authorization: Bearer <token>, and bare "token=..." style pairs.
    // No minimum length: a four-character token is still a credential, and the
    // threshold was only ever a guess at what looked token-shaped.
    .replace(/\b(bearer|basic)\s+\S+/gi, "$1 ***")
    .replace(/\b(api[-_]?key|token|secret|password|passwd)\s*[=:]\s*("?)[^\s"&,;]+\2/gi, "$1=***");
}

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
  if (typeof value === "string") return scrubValue(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) ? "***" : redact(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * How deep a cause chain is followed before it is cut.
 *
 * Lower than redact()'s cap on purpose. Both bounds stop a cyclic chain, but
 * whichever fires first writes the marker — and "max cause depth" tells an
 * operator the error wrapping looped, where redaction's generic marker does
 * not. A chain deeper than three is already unusual.
 */
const MAX_CAUSE_DEPTH = 3;

/** Serialise an error without losing its cause chain. */
function describeError(err: unknown, depth = 0): LogValue {
  // Capped like redact(). An error whose cause chain loops — which a retry
  // wrapper can produce by re-wrapping the error it caught — would otherwise
  // recurse until the stack gives out, taking the process down from a log line.
  if (depth > MAX_CAUSE_DEPTH) return "<max cause depth>";
  if (err instanceof Error) {
    return {
      name: err.name,
      // Scrubbed: a driver error quotes the connection string it failed on,
      // and the stack repeats it.
      message: scrubValue(err.message),
      ...(err.stack === undefined ? {} : { stack: scrubValue(err.stack) }),
      ...(err.cause === undefined ? {} : { cause: describeError(err.cause, depth + 1) }),
    };
  }
  return scrubValue(String(err));
}

/**
 * Fields the logger owns. A caller can never set them, from context or from a
 * call site.
 *
 * Declared as a list rather than handled case by case, because handling them
 * case by case is how this went wrong twice: `level`, `time` and `message`
 * were protected after a review, and `correlationId` was not, so it remained
 * overwritable by the very next call. Anything added here is protected
 * everywhere, and the test that asserts so is driven from this list.
 */
export const CANONICAL_FIELDS = ["level", "time", "message", "correlationId"] as const;

/** Drop any key the logger owns, so caller data cannot shadow it. */
function withoutCanonical(fields: Record<string, LogValue>): Record<string, LogValue> {
  return Object.fromEntries(
    Object.entries(fields).filter(([k]) => !(CANONICAL_FIELDS as readonly string[]).includes(k)),
  );
}

/** Emit one line, if it clears the configured severity floor. */
/**
 * How a line should be rendered where a person reads it.
 *
 * `summarised` means the message already says what the fields say, so the
 * console prints the message alone. The fields still reach the file and the
 * production JSON, because those are parsed rather than read — a request line
 * wants `status=404` as a queryable key and a person wants "REQ 404 GET /nope",
 * and printing both to a terminal is the same fact twice.
 *
 * Only for lines whose message is genuinely a summary of its fields. Anywhere
 * else this hides detail from the one sink a human is actually looking at.
 */
interface EmitOptions {
  summarised?: boolean;
  /**
   * What the terminal shows instead of `message`.
   *
   * The file and the production JSON always get `message`, which is why colour
   * can live here at all: an escape code reaches a terminal and nothing else.
   * Putting it in `message` would paint the file, which the sink is asserted
   * never to be.
   */
  consoleMessage?: string;
}

function emit(
  level: LogLevel,
  message: string,
  fields: Record<string, LogValue> = {},
  options: EmitOptions = {},
): void {
  const cfg = config();
  if (SEVERITY[level] < SEVERITY[cfg.logLevel]) return;

  // Context fields are redacted too. They were not, and a credential placed in
  // a request context — precisely where one is most likely to be put — reached
  // the log verbatim while a directly-logged one was masked.
  const context = storage.getStore();
  const at = new Date();
  const line: Record<string, LogValue> = {
    // Caller data first and stripped of canonical keys; the logger's own values
    // last. Both guards are deliberate: the strip stops a caller shadowing a
    // field, and the ordering stops it even if the strip is ever weakened.
    ...withoutCanonical(redact(context ?? {}) as Record<string, LogValue>),
    ...withoutCanonical(redact(fields) as Record<string, LogValue>),
    level,
    // Rendered in the server's timezone and carrying its offset, so the line
    // reads the same as the dashboard while staying unambiguous to a parser.
    time: formatIso(at),
    message,
    ...(context === undefined ? {} : { correlationId: context.correlationId }),
  };

  const rawId = line["correlationId"];
  const id = typeof rawId === "string" ? rawId : undefined;
  const extra = Object.entries(line).filter(([k]) => !(CANONICAL_FIELDS as readonly string[]).includes(k));
  const rest =
    extra.length === 0 || options.summarised === true ? "" : JSON.stringify(Object.fromEntries(extra));

  // The file gets logfmt: readable by eye, and parsed out of the box by the
  // tooling that would be pointed at it. The fields go in as a record rather
  // than a pre-rendered blob, so each becomes its own queryable key.
  writeToFile(formatForFile(level, at, id, message, Object.fromEntries(extra)), at);

  const out = level === "error" || level === "warn" ? console.error : console.log;

  // Production stdout stays JSON: it is scraped by a collector, not read.
  if (cfg.isProduction) {
    out(JSON.stringify(line));
    return;
  }

  out(formatForConsole(level, at, id, options.consoleMessage ?? message, rest));
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
  /**
   * A line whose message already summarises its own fields.
   *
   * The console prints the message alone; the file and the production JSON
   * still get every field. For request logging, where "REQ 200 GET /devices"
   * is what a person wants and `status=200 path=/devices` is what a query
   * wants, and repeating both in a terminal helps nobody.
   */
  summary: (
    level: LogLevel,
    message: string,
    fields?: Record<string, LogValue>,
    consoleMessage?: string,
  ) => emit(level, message, fields, { summarised: true, consoleMessage }),
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
 * Accept a caller-supplied correlation id only if it is plausibly one.
 *
 * The value is echoed into logs and into error bodies, so an unvalidated header
 * is a log-injection and unbounded-memory vector.
 */
export function sanitiseCorrelationId(candidate: string | null | undefined): string | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Run `fn` with these fields attached to every line it emits.
 *
 * The mechanism that makes a correlation id useful: set once per request at the
 * edge, and every log line beneath it — including inside awaited calls several
 * layers down — carries it without being passed one.
 */
export function withContext<T>(context: LogContext, fn: () => T): T {
  // Validated here as well as at the HTTP edge, because this is exported: a
  // caller can reach it directly, and the id is echoed into every log line and
  // into error bodies. An unvalidated one is a log-injection vector.
  const correlationId = sanitiseCorrelationId(context.correlationId);
  if (correlationId === undefined) {
    throw new Error("withContext requires a correlation id of 1-128 characters from [A-Za-z0-9._:-]");
  }
  return storage.run({ ...context, correlationId }, fn);
}

/**
 * Attach these fields to everything the current request goes on to emit.
 *
 * The same mechanism as withContext, without a callback to wrap. Elysia owns
 * the server, so there is no fetch handler left to put the request inside —
 * `derive` runs per request and this sets the store for the rest of it.
 *
 * Validated identically: this is exported, the id is echoed into log lines and
 * error bodies, and an unvalidated one is a log-injection vector.
 */
export function enterContext(context: LogContext): void {
  const correlationId = sanitiseCorrelationId(context.correlationId);
  if (correlationId === undefined) {
    throw new Error("enterContext requires a correlation id of 1-128 characters from [A-Za-z0-9._:-]");
  }
  storage.enterWith({ ...context, correlationId });
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

