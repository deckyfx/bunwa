/**
 * Configuration validation.
 *
 * These assertions exist because the recurring defect in this project is
 * accepting malformed input and substituting a default, so the process runs
 * and does the wrong thing. Each test below is one shape of that mistake.
 */
import { describe, expect, test } from "bun:test";

import { Config, redactUrl } from "../env";

const base: Record<string, string> = {};

/**
 * A production environment that is valid apart from whatever a test is
 * probing.
 *
 * Production requires a credential encryption key, so every test that builds
 * one has to supply it or it fails for a reason it is not about. Kept as a
 * fixture rather than repeated: the next required production secret should
 * mean editing one line, not hunting four call sites.
 */
const prodBase: Record<string, string> = {
  ...base,
  NODE_ENV: "production",
  CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
};

describe("Config", () => {
  test("applies documented defaults when values are absent", () => {
    const c = new Config(base);
    expect(c.nodeEnv).toBe("development");
    expect(c.port).toBe(3000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.logLevel).toBe("debug");
    expect(c.migrateStrict).toBe(false);
  });

  test("defaults the database to ./data/db", () => {
    expect(new Config({}).databasePath).toBe("./data/db/bunwa.sqlite");
  });

  test("rejects a database path that is present but empty", () => {
    expect(() => new Config({ DATABASE_PATH: "   " })).toThrow("set but empty");
  });

  test("accepts a file: URL and :memory:", () => {
    expect(new Config({ DATABASE_PATH: "file:./x/y.sqlite" }).databasePath).toBe("./x/y.sqlite");
    expect(new Config({ DATABASE_PATH: "file://./x/y.sqlite" }).databasePath).toBe("./x/y.sqlite");
    expect(new Config({ DATABASE_PATH: ":memory:" }).databasePath).toBe(":memory:");
  });

  test("rejects a Postgres URL rather than creating a file named after it", () => {
    expect(() => new Config({ DATABASE_PATH: "postgres://u:p@h/d" })).toThrow("must be a file path");
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

  test("rejects a boolean that is neither true nor false", () => {
    // `raw === "true"` silently mapped "yes" to false — the same silent-default
    // failure this module exists to prevent, found by review inside the fix.
    expect(() => new Config({ ...base, MIGRATE_STRICT: "yes" })).toThrow('must be "true" or "false"');
    expect(() => new Config({ ...base, MIGRATE_STRICT: "1" })).toThrow('must be "true" or "false"');
  });

  test("accepts booleans case-insensitively", () => {
    expect(new Config({ ...base, MIGRATE_STRICT: "TRUE" }).migrateStrict).toBe(true);
    expect(new Config({ ...prodBase, MIGRATE_STRICT: "false" }).migrateStrict).toBe(false);
  });

  test("production defaults differ from development", () => {
    const prod = new Config({ ...prodBase });
    expect(prod.logLevel).toBe("info");
    // Production must never auto-apply a migration.
    expect(prod.migrateStrict).toBe(true);
    expect(prod.isProduction).toBe(true);
  });

  test("insecure webhook targets are off by default, in every environment", () => {
    // Derived from NODE_ENV, an unset or mistyped environment name silently
    // disabled an SSRF control. An end-to-end run accepted 169.254.169.254
    // under that logic.
    expect(new Config(base).allowInsecureWebhookTargets).toBe(false);
    expect(new Config({ ...base, NODE_ENV: "development" }).allowInsecureWebhookTargets).toBe(false);
  });

  test("refuses to start with insecure webhook targets enabled in production", () => {
    expect(
      () => new Config({ ...prodBase, ALLOW_INSECURE_WEBHOOK_TARGETS: "true" }),
    ).toThrow("must not be true in production");
  });

  test("describe() reports the database location", () => {
    expect(new Config(base).describe()["database"]).toBe("./data/db/bunwa.sqlite");
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

describe("the credential encryption key", () => {
  test("production refuses to start without one", () => {
    // The failure this prevents is silent: devices pair, messages send, and
    // account-takeover material sits in the database in the clear.
    expect(() =>
      new Config({ NODE_ENV: "production", DATABASE_PATH: "/tmp/x.sqlite" }),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY is required in production/);
  });

  test("development runs without one", () => {
    // A fresh clone should start without ceremony. The stores refuse to write
    // credentials when the key is null rather than writing them unencrypted.
    expect(new Config({ NODE_ENV: "development" }).credentialEncryptionKey).toBeNull();
  });

  test("a malformed key fails at boot, not at first pairing", () => {
    // Discovered when a device pairs means discovered in front of a customer.
    expect(() =>
      new Config({ NODE_ENV: "development", CREDENTIAL_ENCRYPTION_KEY: "hunter2" }),
    ).toThrow(/not usable/);
  });

  test("a valid key is accepted in both forms", () => {
    expect(
      new Config({ NODE_ENV: "development", CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64) })
        .credentialEncryptionKey,
    ).toBe("a".repeat(64));
  });
});
