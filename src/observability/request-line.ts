/**
 * How one request reads on a terminal.
 *
 * Two renderings of the same facts. The plain one goes to the file and to the
 * production JSON, where it is parsed; the painted one goes to a terminal,
 * where it is scanned. They must not be swapped: an escape code in the file is
 * noise a reader has to strip, and the file sink is asserted never to contain
 * one.
 *
 * The duration sits before the path because a path is the only part with no
 * bound on its length — with it last, the four short fields stay in a column
 * the eye can run down, and the long one trails off to the right where it does
 * not push anything out of alignment.
 */
import { ANSI, colourEnabled } from "./sinks";

export interface RequestLine {
  status: number;
  method: string;
  path: string;
  /** Null when the request was never timed — an unmatched route has no start. */
  durationMs: number | null;
}

/** Milliseconds past which a request stops looking ordinary. */
const SLOW_MS = 300;

/** And past which it is worth reading twice. */
const VERY_SLOW_MS = 1_000;

const paint = (codes: string, text: string): string => `${ANSI.ESC}[${codes}m${text}${ANSI.RESET}`;

/**
 * A status, coloured by what it means rather than by its digits.
 *
 * Background rather than foreground: the status is the field an operator scans
 * a wall of these for, and a block of colour is findable at a glance where a
 * tinted number is not.
 */
function paintStatus(status: number): string {
  const text = ` ${String(status)} `;
  if (status >= 500) return paint("97;41", text); // white on red
  if (status >= 400) return paint("30;43", text); // black on yellow
  if (status >= 300) return paint("30;46", text); // black on cyan
  return paint("30;42", text); // black on green
}

/**
 * The verb, coloured by how much it can change.
 *
 * A reader skimming for "what wrote something" should not have to read the
 * word: DELETE and POST are the ones worth noticing, and GET is the majority
 * of any log and therefore the one that should recede.
 */
function paintMethod(method: string): string {
  switch (method) {
    case "GET":
    case "HEAD":
      return paint("36", method); // cyan — the common, quiet case
    case "POST":
      return paint("32", method); // green
    case "PUT":
    case "PATCH":
      return paint("33", method); // yellow
    case "DELETE":
      return paint("31", method); // red
    default:
      return paint("35", method); // magenta, so an unexpected verb stands out
  }
}

/** A duration, coloured only once it is worth remarking on. */
function paintDuration(durationMs: number): string {
  const text = `${String(durationMs)}ms`;
  if (durationMs >= VERY_SLOW_MS) return paint("97;41", ` ${text} `); // white on red
  if (durationMs >= SLOW_MS) return paint("33", text); // yellow
  return paint("90", text); // dim: most requests are unremarkable
}

/**
 * `REQ 200 GET 12ms /v1/devices` — what the file and a collector receive.
 *
 * The duration is omitted rather than printed as zero when it was not
 * measured. "Not measured" and "took no time" are different claims, and `0ms`
 * on every unmatched route is the second one said wrongly.
 */
export function plainRequestLine({ status, method, path, durationMs }: RequestLine): string {
  const took = durationMs === null ? "" : ` ${String(durationMs)}ms`;
  return `REQ ${String(status)} ${method}${took} ${path}`;
}

/** The same line for a terminal, painted — or identical to the plain one if colour is off. */
export function paintedRequestLine(line: RequestLine): string {
  if (!colourEnabled()) return plainRequestLine(line);

  const took = line.durationMs === null ? "" : ` ${paintDuration(line.durationMs)}`;
  return `${ANSI.DIM}REQ${ANSI.RESET} ${paintStatus(line.status)} ${paintMethod(line.method)}${took} ${line.path}`;
}
