/**
 * Logger behaviour that matters for security and for support.
 *
 * Redaction and correlation-id handling are the two things that are painful to
 * discover are broken: the first leaks a credential into a log aggregator, the
 * second makes an incident unsearchable.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import {
  log, withContext, currentCorrelationId, sanitiseCorrelationId, isSensitiveKey, scrubValue,
  CANONICAL_FIELDS,
  type LogValue,
} from "../logger";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfig } from "../../config/env";
import { resetFileSink } from "../sinks";
import { captureEnv } from "../../testing/env";

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

// Production, because that is the mode with JSON output — and production now
// requires a credential encryption key, so this supplies one. Without it every
// test here fails inside config() rather than on anything about logging.
const ENV = {
  NODE_ENV: "production",
  DATABASE_PATH: ":memory:",
  LOG_LEVEL: "debug",
  CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
};

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(Object.keys(ENV));

beforeEach(() => {
  resetConfig();
  for (const [k, v] of Object.entries(ENV)) Bun.env[k] = v;
});
afterEach(() => {
  resetConfig();
  restoreEnv();
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

  test("masks compound credential names in any casing", () => {
    // Patched twice as an alias list — accessToken, then clientSecret — before
    // being generalised to substring matching. These pin the class, not cases.
    const [line] = capture(() =>
      log.info("z", { clientSecret: "A", client_secret: "B", SigningKey: "C", refresh_token: "D" }),
    );
    for (const leaked of ['"A"', '"B"', '"C"', '"D"']) expect(line).not.toContain(leaked);
  });

  test("leaves deliberately visible fields alone", () => {
    // keyPrefix exists to be shown in dashboards and logs; over-redaction would
    // make the identification it is for impossible.
    const [line] = capture(() => log.info("v", { keyPrefix: "bw_live_grande_", correlationId: "c" }));
    expect(line).toContain("bw_live_grande_");
    expect(isSensitiveKey("keyPrefix")).toBe(false);
    expect(isSensitiveKey("correlationId")).toBe(false);
    expect(isSensitiveKey("clientSecret")).toBe(true);
  });

  test("does not recurse without bound", () => {
    const deep: Record<string, LogValue> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) cursor = (cursor["next"] = {}) as Record<string, LogValue>;
    expect(() => capture(() => log.info("deep", deep))).not.toThrow();
  });
});

describe("value-level redaction", () => {
  test("masks credentials embedded in a url value", () => {
    // Key-based redaction cannot see this: an innocuous field name, a password
    // in the value.
    const [line] = capture(() => log.info("x", { url: "postgres://alice:hunter2@db/x" }));
    expect(line).not.toContain("hunter2");
    expect(line).toContain("***:***@db/x");
  });

  test("masks credentials quoted inside an error message and stack", () => {
    // Driver errors routinely echo the connection string they failed on.
    const [line] = capture(() => log.error("y", new Error("connect failed for postgres://bob:s3cret@db/x")));
    expect(line).not.toContain("s3cret");
  });

  test("masks bearer tokens and key=value pairs", () => {
    const [line] = capture(() => log.info("z", { header: "Authorization: Bearer abcdef0123456789" }));
    expect(line).not.toContain("abcdef0123456789");
  });

  test("masks short credentials, which are still credentials", () => {
    // The previous version required 8 characters for a bearer token and 4 for a
    // key=value pair — thresholds that were guesses at what looks token-shaped.
    expect(scrubValue("Bearer abc")).toBe("Bearer ***");
    expect(scrubValue("token=xy")).toBe("token=***");
    expect(scrubValue("api_key: q")).toBe("api_key=***");
  });

  test("leaves ordinary strings untouched", () => {
    expect(scrubValue("https://example.com/webhooks/inbound")).toBe("https://example.com/webhooks/inbound");
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

describe("caller data cannot forge a line", () => {
  // Driven from CANONICAL_FIELDS rather than listing cases: protecting them one
  // at a time is how correlationId stayed overwritable after level, time and
  // message were fixed. A new canonical field is covered the moment it is added.
  for (const field of CANONICAL_FIELDS) {
    test(`a caller field named ${field} cannot overwrite the real one`, () => {
      const [line] = capture(() =>
        withContext({ correlationId: "real-id" }, () =>
          log.warn("the real message", { [field]: "FORGED" } as never),
        ),
      );
      expect(line).not.toContain("FORGED");
    });

    // correlationId is excluded here deliberately: the context is precisely
    // where it is meant to be set, and withContext validates it on the way in.
    // The other canonical fields have no legitimate source in a context.
    if (field !== "correlationId") {
      test(`a context field named ${field} cannot overwrite the real one either`, () => {
        const [line] = capture(() =>
          withContext({ correlationId: "real-id", [field]: "FORGED" } as never, () => log.warn("real")),
        );
        expect(line).not.toContain("FORGED");
      });
    }
  }

  test("the surviving values are the logger's own", () => {
    const [line] = capture(() =>
      withContext({ correlationId: "real-id" }, () =>
        log.warn("real message", { level: "debug", correlationId: "other" } as never),
      ),
    );
    expect(line).toContain('"level":"warn"');
    expect(line).toContain('"message":"real message"');
    expect(line).toContain('"correlationId":"real-id"');
  });
});

describe("withContext validation", () => {
  test("rejects an id that would inject into the log", () => {
    expect(() => withContext({ correlationId: 'a"\n{"level":"error"' }, () => 0)).toThrow(/correlation id/);
  });

  test("rejects an empty or oversized id", () => {
    expect(() => withContext({ correlationId: "" }, () => 0)).toThrow(/correlation id/);
    expect(() => withContext({ correlationId: "x".repeat(129) }, () => 0)).toThrow(/correlation id/);
  });

  test("accepts a valid id and normalises surrounding whitespace", () => {
    expect(withContext({ correlationId: " abc-123 " }, () => currentCorrelationId())).toBe("abc-123");
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

describe("a looping cause chain", () => {
  test("is cut rather than exhausting the stack", () => {
    // A retry wrapper that re-wraps the error it caught can produce a cycle.
    // Recursing until the stack gives out would take the process down from a
    // log line, which is an absurd way to lose a service.
    const inner: Error & { cause?: unknown } = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    inner.cause = outer;

    const [line] = capture(() => log.error("cyclic", outer));
    expect(line).toContain("max cause depth");
    expect(line).toContain("outer");
  });
});

describe("the file sink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bunwa-logger-"));
    Bun.env["LOG_DIR"] = dir;
    Bun.env["SERVER_TIMEZONE"] = "Asia/Jakarta";
    resetConfig();
    resetFileSink();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetFileSink();
  });

  /** Everything written to the log directory during this test, as lines. */
  const written = (): string[] =>
    readdirSync(dir)
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
      .filter((l) => l !== "");

  test("writes logfmt", () => {
    // Asserted through the logger rather than by calling the formatter, because
    // the regression to guard against is the logger handing the file the wrong
    // thing — which a test that formats its own line would never see.
    capture(() => log.info("device paired", { deviceId: "d1" }));

    const [line = ""] = written();
    // RFC 3339 with the configured offset, so the file cannot be misread as UTC.
    expect(line).toMatch(/^time=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00 /);
    expect(line).toContain("level=info");
    // Quoted because it contains a space; a bare value would end the pair early.
    expect(line).toContain('msg="device paired"');
    // Its own key, not buried in a blob, which is the point of the format.
    expect(line).toContain("deviceId=d1");
  });

  test("quotes only what would otherwise break the parse", () => {
    capture(() => log.info("m", { bare: "abc-1.2/x", spaced: "two words", quoted: 'say "hi"', n: 3, ok: true }));

    const [line = ""] = written();
    expect(line, "a bare token stays bare, which is what keeps it readable").toContain("bare=abc-1.2/x");
    expect(line).toContain('spaced="two words"');
    expect(line, "an embedded quote is escaped, not dropped").toContain('quoted="say \\"hi\\""');
    expect(line, "numbers and booleans are unquoted so a parser types them").toContain("n=3 ");
    expect(line).toContain("ok=true");
  });

  test("one event stays one line, even with a stack trace", () => {
    // A multi-line value would otherwise become several unparseable lines, and
    // an error is exactly the entry most worth reading.
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at one\n    at two";
    capture(() => log.error("boom", err));

    const lines = written();
    expect(lines, "a newline inside a value must not split the record").toHaveLength(1);
    expect(lines[0]).toContain("at one");
    // Flattened rather than one JSON blob, so each part is its own key.
    expect(lines[0]).toContain('error.message=kaboom');
    expect(lines[0], "the newline is escaped rather than literal").not.toContain("\n    at");
  });

  test("stays readable in production, where the console is JSON", () => {
    // The two sinks diverge on purpose: stdout is scraped, the file is read.
    const [consoleLine] = capture(() => log.info("started"));
    expect(consoleLine, "console").toMatch(/^\{/);
    expect(written()[0], "file").not.toMatch(/^\{/);
  });

  test("redaction applies to the file too", () => {
    // The file outlives the terminal, so a credential reaching it is the worse
    // of the two leaks.
    capture(() => log.info("auth", { apiKey: "bw_live_secret" }));
    const [line] = written();
    expect(line).not.toContain("bw_live_secret");
  });

  test("carries no escape codes", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      capture(() => log.error("boom"));
      expect(written()[0]).not.toContain("\u001b");
    } finally {
      if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", original);
    }
  });

  test("nested fields become dotted keys rather than a nested blob", () => {
    // A blob would need a second parse to query, and reads as escaped quotes
    // inside escaped quotes.
    capture(() => log.info("webhook", { target: { host: "example.com", attempt: 2 } }));

    const [line = ""] = written();
    expect(line).toContain("target.host=example.com");
    expect(line).toContain("target.attempt=2");
  });
});
