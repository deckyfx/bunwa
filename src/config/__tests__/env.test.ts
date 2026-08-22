/**
 * Configuration validation.
 *
 * These assertions exist because the recurring defect in this project is
 * accepting malformed input and substituting a default, so the process runs
 * and does the wrong thing. Each test below is one shape of that mistake.
 */
import { describe, expect, test } from "bun:test";

import { Config, ConfigError, redactUrl } from "../env";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/bunwa" };

describe("Config", () => {
  test("applies documented defaults when values are absent", () => {
    const c = new Config(base);
    expect(c.nodeEnv).toBe("development");
    expect(c.port).toBe(3000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.logLevel).toBe("debug");
    expect(c.migrateStrict).toBe(false);
  });

  test("requires DATABASE_URL", () => {
    expect(() => new Config({})).toThrow(ConfigError);
    expect(() => new Config({})).toThrow("DATABASE_URL is required");
  });

  test("rejects a required value that is present but empty", () => {
    expect(() => new Config({ DATABASE_URL: "   " })).toThrow("set but empty");
  });

  test("rejects an optional value that is present but empty", () => {
    // Silently defaulting here is how a process ends up bound to a host nobody chose.
    expect(() => new Config({ ...base, HOST: "" })).toThrow("set but empty");
  });

  test("rejects a non-integer port rather than coercing it", () => {
    expect(() => new Config({ ...base, PORT: "3000abc" })).toThrow("must be an integer");
    expect(() => new Config({ ...base, PORT: "3.5" })).toThrow("must be an integer");
  });

  test("rejects an out-of-range port", () => {
    expect(() => new Config({ ...base, PORT: "70000" })).toThrow("between 1 and 65535");
    expect(() => new Config({ ...base, PORT: "0" })).toThrow("between 1 and 65535");
  });

  test("rejects an unknown enum value", () => {
    expect(() => new Config({ ...base, NODE_ENV: "staging" })).toThrow("must be one of");
    expect(() => new Config({ ...base, LOG_LEVEL: "verbose" })).toThrow("must be one of");
  });

  test("production defaults differ from development", () => {
    const prod = new Config({ ...base, NODE_ENV: "production" });
    expect(prod.logLevel).toBe("info");
    // Production must never auto-apply a migration.
    expect(prod.migrateStrict).toBe(true);
    expect(prod.isProduction).toBe(true);
  });

  test("describe() never leaks database credentials", () => {
    const described = new Config(base).describe();
    expect(JSON.stringify(described)).not.toContain("p@");
    expect(described["database"]).toBe("postgres://***:***@localhost:5432/bunwa");
  });
});

describe("redactUrl", () => {
  test("masks username and password", () => {
    expect(redactUrl("postgres://alice:hunter2@db:5432/x")).toBe("postgres://***:***@db:5432/x");
  });

  test("leaves a credential-free url intact", () => {
    expect(redactUrl("postgres://db:5432/x")).toBe("postgres://db:5432/x");
  });

  test("never echoes an unparseable value, which may itself be a secret", () => {
    expect(redactUrl("not a url")).toBe("<unparseable>");
  });
});
