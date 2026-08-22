/**
 * Logger behaviour that matters for security and for support.
 *
 * Redaction and correlation-id handling are the two things that are painful to
 * discover are broken: the first leaks a credential into a log aggregator, the
 * second makes an incident unsearchable.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { log, withContext, currentCorrelationId, sanitiseCorrelationId } from "../logger";
import { resetConfig } from "../../config/env";

/** Capture stdout/stderr for the duration of one call. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

const ENV = { NODE_ENV: "production", DATABASE_PATH: ":memory:", LOG_LEVEL: "debug" };

beforeEach(() => {
  resetConfig();
  for (const [k, v] of Object.entries(ENV)) Bun.env[k] = v;
});
afterEach(() => {
  resetConfig();
  for (const k of Object.keys(ENV)) delete Bun.env[k];
});

describe("redaction", () => {
  test("masks credential-shaped field names", () => {
    const [line] = capture(() => log.info("auth", { apiKey: "bw_live_secret", userId: "u1" }));
    expect(line).toContain('"apiKey":"***"');
    expect(line).not.toContain("bw_live_secret");
    expect(line).toContain('"userId":"u1"');
  });

  test("masks nested credentials", () => {
    const [line] = capture(() => log.info("cfg", { webhook: { url: "https://x", secret: "shh" } }));
    expect(line).not.toContain("shh");
    expect(line).toContain('"secret":"***"');
    expect(line).toContain("https://x");
  });

  test("redacts credentials placed in the request context", () => {
    // Context fields were spread unredacted, so a credential put where one is
    // most likely to be put — the request context — reached the log verbatim.
    const lines = capture(() =>
      withContext({ correlationId: "c1", apiKey: "LEAKED" } as never, () => log.info("x")),
    );
    expect(lines[0]).not.toContain("LEAKED");
    expect(lines[0]).toContain('"correlationId":"c1"');
  });

  test("covers common credential aliases", () => {
    const [line] = capture(() => log.info("y", { accessToken: "a", refreshToken: "b", cookie: "c" }));
    expect(line).not.toContain('"a"');
    expect(line).not.toContain('"b"');
    expect(line).not.toContain('"c"');
  });

  test("does not recurse without bound", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) cursor = (cursor["next"] = {}) as Record<string, unknown>;
    expect(() => capture(() => log.info("deep", deep as never))).not.toThrow();
  });
});

describe("correlation id", () => {
  test("attaches to every line inside the context", () => {
    const lines = capture(() => withContext({ correlationId: "abc123" }, () => log.info("one")));
    expect(lines[0]).toContain('"correlationId":"abc123"');
  });

  test("is readable from inside the context and absent outside", () => {
    expect(currentCorrelationId()).toBeUndefined();
    withContext({ correlationId: "xyz" }, () => expect(currentCorrelationId()).toBe("xyz"));
  });
});

describe("sanitiseCorrelationId", () => {
  test("accepts a plausible id", () => {
    expect(sanitiseCorrelationId("01J8-abc_def:1.2")).toBe("01J8-abc_def:1.2");
  });

  test("rejects absent, empty and oversized values", () => {
    expect(sanitiseCorrelationId(null)).toBeUndefined();
    expect(sanitiseCorrelationId("  ")).toBeUndefined();
    expect(sanitiseCorrelationId("x".repeat(129))).toBeUndefined();
  });

  test("rejects log-injection attempts", () => {
    // A newline in an echoed header lets a caller forge log lines.
    expect(sanitiseCorrelationId('a"\n{"level":"error"')).toBeUndefined();
    expect(sanitiseCorrelationId("a b")).toBeUndefined();
  });
});

describe("levels", () => {
  test("suppresses lines below the configured floor", () => {
    resetConfig();
    Bun.env["LOG_LEVEL"] = "warn";
    expect(capture(() => log.info("quiet"))).toHaveLength(0);
    expect(capture(() => log.warn("loud"))).toHaveLength(1);
  });

  test("serialises an error with its cause", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    const [line] = capture(() => log.error("failed", err));
    expect(line).toContain('"message":"outer"');
    expect(line).toContain('"message":"inner"');
  });
});
