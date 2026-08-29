/**
 * The log sinks.
 *
 * The failures worth catching here are the quiet ones: a file that keeps being
 * written after the period rolled, escape codes baked into a file something
 * else has to parse, and a disk error that turns logging into an outage.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { resetTimeFormatters } from "../../time/format";
import { currentLogFile, formatForConsole, resetFileSink, writeToFile } from "../sinks";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "SERVER_TIMEZONE", "LOG_ROTATION", "LOG_DIR", "NO_COLOR"]);

/** The byte every ANSI sequence starts with. */
const ESC = "\u001b";

let dir: string;
let restoreTty: (() => void) | undefined;

/**
 * Pretend the output is a terminal.
 *
 * Without this the colour branch is never executed under `bun test`, whose
 * stdout is a pipe — so the styling would be shipped entirely unverified.
 */
const asTerminal = () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  restoreTty = () => {
    if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", original);
  };
};

const configure = (rotation: string, zone = "Asia/Jakarta") => {
  Bun.env["LOG_ROTATION"] = rotation;
  Bun.env["LOG_DIR"] = dir;
  Bun.env["SERVER_TIMEZONE"] = zone;
  resetConfig();
  resetTimeFormatters();
  resetFileSink();
};

beforeEach(() => {
  Bun.env["NODE_ENV"] = "test";
  dir = mkdtempSync(join(tmpdir(), "bunwa-logs-"));
  configure("daily");
});

afterEach(() => {
  restoreTty?.();
  restoreTty = undefined;
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetTimeFormatters();
  resetFileSink();
});

const nameAt = (iso: string) => currentLogFile(new Date(iso)).slice(dir.length + 1);

describe("rotation picks the file by the clock", () => {
  test("daily rolls at local midnight, not UTC midnight", () => {
    // 16:59Z and 17:01Z are either side of midnight in Jakarta. A rotation
    // that used the Date's UTC fields would put both in the same file and then
    // roll seven hours late, every day.
    expect(nameAt("2026-03-10T16:59:00Z")).toBe("bunwa.2026-03-10.log");
    expect(nameAt("2026-03-10T17:01:00Z")).toBe("bunwa.2026-03-11.log");
  });

  test("hourly rolls on the hour", () => {
    configure("hourly");
    expect(nameAt("2026-03-10T01:59:00Z")).toBe("bunwa.2026-03-10-08.log");
    expect(nameAt("2026-03-10T02:01:00Z")).toBe("bunwa.2026-03-10-09.log");
  });

  test("weekly names the file for the Monday that starts the week", () => {
    configure("weekly");
    // 2026-03-10 is a Tuesday; 2026-03-16 is the following Monday.
    expect(nameAt("2026-03-10T04:00:00Z")).toBe("bunwa.2026-03-09-week.log");
    expect(nameAt("2026-03-15T04:00:00Z"), "Sunday belongs to the week before").toBe("bunwa.2026-03-09-week.log");
    expect(nameAt("2026-03-16T04:00:00Z")).toBe("bunwa.2026-03-16-week.log");
  });

  test("never keeps one file forever", () => {
    configure("never");
    expect(nameAt("2026-03-10T04:00:00Z")).toBe("bunwa.log");
    expect(nameAt("2027-11-02T04:00:00Z")).toBe("bunwa.log");
  });
});

describe("writing", () => {
  test("creates the directory and appends line by line", () => {
    const at = new Date("2026-03-10T04:00:00Z");
    writeToFile('{"a":1}', at);
    writeToFile('{"a":2}', at);
    expect(readFileSync(currentLogFile(at), "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });

  test("a rolled period writes a new file and leaves the old one intact", () => {
    writeToFile("before", new Date("2026-03-10T16:59:00Z"));
    writeToFile("after", new Date("2026-03-10T17:01:00Z"));
    expect(readFileSync(join(dir, "bunwa.2026-03-10.log"), "utf8")).toBe("before\n");
    expect(readFileSync(join(dir, "bunwa.2026-03-11.log"), "utf8")).toBe("after\n");
  });

  test("a broken sink is disabled rather than thrown from", () => {
    // A log directory that cannot be created is a disk or permissions problem.
    // It must not become an exception on the request path that produced it.
    Bun.env["LOG_DIR"] = "/proc/version/nope";
    resetConfig();
    resetFileSink();
    expect(() => writeToFile("x")).not.toThrow();
    expect(() => writeToFile("y"), "and stays quiet afterwards").not.toThrow();
  });
});

describe("console styling", () => {
  test("carries no escape codes when the output is not a terminal", () => {
    // Which is what a piped or redirected run looks like — and bun test's own.
    const line = formatForConsole("error", new Date("2026-03-10T04:05:06Z"), "abcdef0123", "boom", "");
    expect(line).not.toContain(ESC);
    expect(line).toBe("2026-03-10 11:05:06 ERROR [abcdef01] boom");
  });

  test("renders the time in the configured zone", () => {
    configure("daily", "UTC");
    // Same instant as the Jakarta case above, which reads 2026-03-10 11:05:06.
    expect(formatForConsole("info", new Date("2026-03-10T04:05:06Z"), undefined, "hi", "")).toContain(
      "2026-03-10 04:05:06",
    );
  });

  test("colours the line when the output is a terminal", () => {
    asTerminal();
    const line = formatForConsole("error", new Date("2026-03-10T04:05:06Z"), "abcdef0123", "boom", "");
    expect(line).toContain(ESC);
    // The text still reads correctly with the codes stripped, which is what a
    // pager or a screen reader will see.
    expect(line.replace(/\u001b\[[0-9;]*m/g, "")).toBe("2026-03-10 11:05:06  ERROR  [abcdef01] boom");
  });

  test("NO_COLOR is honoured even on a terminal", () => {
    asTerminal();
    Bun.env["NO_COLOR"] = "1";
    expect(formatForConsole("error", new Date(), "abcdef0123", "boom", "")).not.toContain(ESC);
  });

  test("what reaches the file is never styled", () => {
    // The file is parsed, not read. An escape code in it is a parse failure
    // weeks after the run that produced it.
    asTerminal();
    const at = new Date("2026-03-10T04:00:00Z");
    writeToFile(JSON.stringify({ level: "error", message: "boom" }), at);
    expect(readFileSync(currentLogFile(at), "utf8")).not.toContain(ESC);
  });

  test("a missing correlation id keeps the column width", () => {
    // So the message column stays aligned whether or not a line is in a request.
    const withId = formatForConsole("info", new Date(), "abcdef0123", "m", "");
    const without = formatForConsole("info", new Date(), undefined, "m", "");
    expect(without.indexOf("m")).toBe(withId.indexOf("m"));
  });
});
