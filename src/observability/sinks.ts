/**
 * Where log lines go: the console, and a file that rotates.
 *
 * Split from the logger so the decision about *what* to log stays separate
 * from *where* it lands. The console is for a person watching; the file is for
 * the question asked three days later.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { config, type LogLevel, type LogRotation } from "../config/env";
import { formatDate, formatDateTime, formatIso, serverTimezone } from "../time/format";

const ESC = "\u001b";

/**
 * ANSI styling for the console.
 *
 * Background only on warn and error: those are the two an operator scans for,
 * and colouring everything is the same as colouring nothing.
 */
const STYLE: Record<LogLevel, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[30;43m`,
  error: `${ESC}[97;41m`,
};

const DIM = `${ESC}[90m`;
const RESET = `${ESC}[0m`;

/**
 * Whether to colour at all.
 *
 * Off when the output is not a terminal, because escape codes in a piped log
 * are noise a reader has to strip — and the file sink must never contain them.
 * `NO_COLOR` is honoured because it is the convention operators already know.
 */
const useColour = (): boolean => Boolean(process.stdout.isTTY) && Bun.env["NO_COLOR"] === undefined;

/** The suffix that decides which file a line belongs in. */
function rotationSuffix(rotation: LogRotation, at: Date): string {
  if (rotation === "never") return "";

  const day = formatDate(at);
  if (rotation === "daily") return `.${day}`;
  if (rotation === "hourly") return `.${day}-${formatDateTime(at).slice(11, 13)}`;

  // Weekly: named for the Monday that starts the week, so the files sort and a
  // reader can tell at a glance which period one covers. Derived from the
  // rendered date rather than the Date's own fields, so the week boundary
  // falls where the server's timezone puts it and not where UTC does.
  const [year = 1970, month = 1, dayOfMonth = 1] = day.split("-").map(Number);
  const local = new Date(Date.UTC(year, month - 1, dayOfMonth));
  const weekday = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - weekday);
  return `.${local.toISOString().slice(0, 10)}-week`;
}

/**
 * The file a line written now belongs in.
 *
 * Computed per line rather than held open, so rotation happens by the clock
 * without a timer: the name simply changes when the period does. A long-lived
 * handle would keep writing to yesterday's file until something restarted the
 * process, which is the failure rotation exists to prevent.
 */
export function currentLogFile(at: Date = new Date()): string {
  const cfg = config();
  return join(cfg.logDir, `bunwa${rotationSuffix(cfg.logRotation, at)}.log`);
}

let ensuredDir: string | null = null;
let fileSinkBroken = false;

/** Create the log directory once per path. */
function ensureDir(dir: string): void {
  if (ensuredDir === dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  ensuredDir = dir;
}

/**
 * Append one line to the rotating file.
 *
 * Synchronous on purpose. An async write can be lost when the process exits,
 * and the lines most worth keeping are the ones written just before something
 * crashed. Failures disable the sink after a single warning: a full disk must
 * not turn logging into an outage, and must not print once per line either.
 */
export function writeToFile(line: string, at: Date = new Date()): void {
  if (fileSinkBroken) return;

  try {
    const cfg = config();
    ensureDir(cfg.logDir);
    appendFileSync(currentLogFile(at), `${line}\n`, "utf8");
  } catch (err) {
    fileSinkBroken = true;
    // Straight to stderr, not through the logger: routing a logging failure
    // back into the logger is how one becomes a loop.
    process.stderr.write(`log file sink disabled after a write error: ${String(err)}\n`);
  }
}

/** Re-enable the file sink and forget the created directory. For tests. */
export function resetFileSink(): void {
  fileSinkBroken = false;
  ensuredDir = null;
}

/**
 * One line, for a person.
 *
 * The same shape whether it is going to a terminal or to a file; only the
 * colour differs. A file that reads differently from the console is a file
 * nobody checks against what they just saw on screen.
 *
 * The timestamp is in the server's timezone rather than UTC, so it matches
 * both the dashboard and whatever a support answer will say. The date is
 * carried too: a terminal left open overnight, or a line pasted into a ticket,
 * is otherwise a time with no day attached.
 */
export function formatLine(
  level: LogLevel,
  at: Date,
  correlationId: string | undefined,
  message: string,
  rest: string,
  colour: boolean,
): string {
  const time = formatDateTime(at);
  const id = (correlationId ?? "--------").slice(0, 8);
  const label = level.toUpperCase().padEnd(5);

  if (!colour) {
    return `${time} ${label} [${id}] ${message}${rest === "" ? "" : ` ${rest}`}`;
  }

  const styledTail = rest === "" ? "" : ` ${DIM}${rest}${RESET}`;
  return (
    `${DIM}${time}${RESET} ` +
    `${STYLE[level]} ${label} ${RESET} ` +
    `${DIM}[${id}]${RESET} ` +
    `${message}${styledTail}`
  );
}

/** The line as the terminal should see it — coloured, unless it should not be. */
export const formatForConsole = (
  level: LogLevel,
  at: Date,
  correlationId: string | undefined,
  message: string,
  rest: string,
): string => formatLine(level, at, correlationId, message, rest, useColour());

/**
 * Whether a logfmt value can stand unquoted.
 *
 * Bare tokens are the readable case, so the set is as wide as the format
 * safely allows: anything with a space, an equals sign, a quote or a newline
 * must be quoted, or a parser will split the line in the wrong place.
 */
const BARE = /^[A-Za-z0-9._/:@+-]+$/;

/** One `key=value` pair, quoted and escaped only where it has to be. */
function pair(key: string, value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return `${key}=null`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  // JSON.stringify does the escaping — including newlines, which is what keeps
  // a stack trace on one line instead of becoming twenty unparseable ones.
  return `${key}=${BARE.test(text) && text !== "" ? text : JSON.stringify(text)}`;
}

/** How deep to flatten before giving up and encoding the rest as JSON. */
const MAX_DEPTH = 4;

/**
 * Nested objects become dotted keys: `error.message="upstream refused"`.
 *
 * Without this a logged Error arrives as one long JSON string inside a quoted
 * value — escaped quotes inside escaped quotes, unreadable by eye and needing
 * a second parse to query. Dotted keys are the convention logfmt consumers
 * already expect. Arrays stay JSON: their indices make poor key names.
 */
function flatten(fields: Record<string, unknown>, prefix = "", depth = 0): Array<[string, unknown]> {
  return Object.entries(fields).flatMap(([key, value]): Array<[string, unknown]> => {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    const nested =
      depth < MAX_DEPTH && typeof value === "object" && value !== null && !Array.isArray(value);

    return nested ? flatten(value as Record<string, unknown>, name, depth + 1) : [[name, value]];
  });
}

/**
 * The line as the file should see it: logfmt.
 *
 * `time=... level=info msg="..." key=value`, one event per line. Chosen over
 * JSON because the file is read by a person at least as often as by a machine,
 * and over a purely human line because logfmt is a format the tooling already
 * knows — Loki, Vector, Promtail, Splunk and Datadog all parse it without a
 * custom regex. Never coloured, whatever the terminal is doing: escape codes
 * in a file are a parse failure weeks after the run that produced them.
 *
 * The timestamp is RFC 3339 in the server's zone, so it carries its offset and
 * cannot be misread as UTC.
 */
export function formatForFile(
  level: LogLevel,
  at: Date,
  correlationId: string | undefined,
  message: string,
  fields: Record<string, unknown>,
): string {
  const parts = [
    pair("time", formatIso(at)),
    pair("level", level),
    pair("msg", message),
    pair("correlation_id", correlationId),
    ...flatten(fields).map(([k, v]) => pair(k, v)),
  ];
  return parts.filter((p) => p !== "").join(" ");
}

/** What the sinks are doing. Logged once at startup so it is in the file too. */
export function describeSinks(): Record<string, string> {
  const cfg = config();
  return {
    timezone: serverTimezone(),
    logDir: cfg.logDir,
    logRotation: cfg.logRotation,
    currentFile: currentLogFile(),
  };
}
