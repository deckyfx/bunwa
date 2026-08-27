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
import { formatDate, formatDateTime, serverTimezone } from "../time/format";

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
 * A styled line for a person reading a terminal.
 *
 * The timestamp is in the server's timezone rather than UTC, so it matches
 * both the dashboard and whatever a support answer will say. The date is
 * carried too: a terminal left open overnight, or a line pasted into a ticket,
 * is otherwise a time with no day attached.
 */
export function formatForConsole(
  level: LogLevel,
  at: Date,
  correlationId: string | undefined,
  message: string,
  rest: string,
): string {
  const time = formatDateTime(at);
  const id = (correlationId ?? "--------").slice(0, 8);
  const label = level.toUpperCase().padEnd(5);
  const tail = rest === "" ? "" : ` ${rest}`;

  if (!useColour()) {
    return `${time} ${label} [${id}] ${message}${tail}`;
  }

  const styledTail = rest === "" ? "" : ` ${DIM}${rest}${RESET}`;
  return (
    `${DIM}${time}${RESET} ` +
    `${STYLE[level]} ${label} ${RESET} ` +
    `${DIM}[${id}]${RESET} ` +
    `${message}${styledTail}`
  );
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
