/**
 * Instance settings, and the identity WhatsApp is shown.
 *
 * Two things here are load-bearing rather than cosmetic. An environment
 * variable that was set explicitly must beat anything the console wrote, or a
 * screen quietly disagrees with the deployment. And a pairing code handshake
 * must present the Ubuntu platform string, because WhatsApp will not complete
 * one otherwise — a custom instance name turns pairing by code into a request
 * that never succeeds, with no error to explain it.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { browserIdentity } from "../../engine/baileys/socket";
import { ValidationError } from "../errors";
import {
  CLIENT_BROWSER,
  DEFAULT_INSTANCE_NAME,
  normaliseInstanceName,
  SettingsStore,
} from "../settings-store";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "SERVER_TIMEZONE"]);

let dir: string;
let database: Database;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-settings-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  delete Bun.env["SERVER_TIMEZONE"];
  resetConfig();
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
  resetConfig();
  resetDatabase();
});

describe("normalising an instance name", () => {
  test("spaces become hyphens rather than an error", () => {
    // The value is transmitted as one token during the handshake, so a space
    // cannot survive. Refusing "My Instance" teaches the operator nothing.
    expect(normaliseInstanceName("My Instance")).toBe("My-Instance");
  });

  test("a run of whitespace collapses to one separator", () => {
    expect(normaliseInstanceName("  My   Big   Instance ")).toBe("My-Big-Instance");
  });

  test("characters a client might mangle are dropped", () => {
    expect(normaliseInstanceName("gr@nde/pos (prod)")).toBe("grndepos-prod");
  });

  test("separators do not pile up or dangle", () => {
    expect(normaliseInstanceName("--my--instance--")).toBe("my-instance");
  });

  test("a name with nothing left is refused rather than silently emptied", () => {
    // An empty platform string would be accepted by the handshake and show as
    // a blank entry in the phone's device list.
    expect(() => normaliseInstanceName("!!! ???")).toThrow(ValidationError);
  });

  test("a name too long to display is refused rather than truncated", () => {
    // Truncation would cut mid-word and look like a bug on the phone.
    expect(() => normaliseInstanceName("a".repeat(25))).toThrow(ValidationError);
    expect(normaliseInstanceName("a".repeat(24))).toHaveLength(24);
  });

  test("what comes out is always safe to send", () => {
    // The property, rather than the examples: whatever goes in, no spaces
    // survive and nothing outside the safe set does either.
    for (const input of ["My Instance", "gr@nde pos", "a b\tc\nd", "..x..", "PROD-1.0"]) {
      const out = normaliseInstanceName(input);
      expect(out, input).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/);
    }
  });
});

describe("what WhatsApp is shown", () => {
  test("QR pairing carries the instance name", () => {
    // Rendered by the phone as "Google Chrome (my-instance)".
    expect(browserIdentity("qr", "my-instance")).toEqual(["my-instance", CLIENT_BROWSER, "1.0.0"]);
  });

  test("code pairing presents Ubuntu, whatever the name is", () => {
    // Not a preference. WhatsApp does not complete the pairing code handshake
    // otherwise, and the failure is silent — the code simply never works.
    const [platform] = browserIdentity("code", "my-instance");
    expect(platform).toBe("Ubuntu");
  });

  test("a resumed session is treated like QR", () => {
    // The phone fixed the label when the device was linked, so nothing sent
    // now changes it; using the same identity keeps the two paths from
    // diverging for no reason.
    expect(browserIdentity("resume", "my-instance")).toEqual(browserIdentity("qr", "my-instance"));
  });
});

describe("resolving a setting", () => {
  test("falls back to a default when nothing is set", () => {
    expect(SettingsStore.resolve("instanceName", database)).toEqual({
      value: DEFAULT_INSTANCE_NAME,
      source: "default",
    });
  });

  test("a stored value beats the default and says so", () => {
    SettingsStore.set("instanceName", "grande-pos", database);
    expect(SettingsStore.resolve("instanceName", database)).toEqual({
      value: "grande-pos",
      source: "database",
    });
  });

  test("writing normalises, so a bad value never reaches storage", () => {
    SettingsStore.set("instanceName", "Grande POS", database);
    expect(SettingsStore.stored("instanceName", database)).toBe("Grande-POS");
  });

  test("writing twice updates rather than conflicts", () => {
    SettingsStore.set("instanceName", "one", database);
    SettingsStore.set("instanceName", "two", database);
    expect(SettingsStore.resolve("instanceName", database).value).toBe("two");
  });

  test("an explicit environment variable beats the database", () => {
    // The rule the whole module exists for. Without it an operator changes a
    // value in the console, the environment overrides it, and nothing says so.
    SettingsStore.set("serverTimezone", "Europe/London", database);
    Bun.env["SERVER_TIMEZONE"] = "UTC";
    resetConfig();

    expect(SettingsStore.resolve("serverTimezone", database)).toEqual({
      value: "UTC",
      source: "environment",
    });
  });

  test("a defaulted environment variable does not", () => {
    // The distinction that makes the rule usable: SERVER_TIMEZONE always has a
    // value, so without knowing whether it was *set* the console could never
    // override it.
    SettingsStore.set("serverTimezone", "Europe/London", database);

    expect(SettingsStore.resolve("serverTimezone", database)).toEqual({
      value: "Europe/London",
      source: "database",
    });
  });

  test("an unknown timezone is refused at the boundary", () => {
    expect(() => SettingsStore.set("serverTimezone", "Mars/Olympus", database)).toThrow(ValidationError);
    expect(SettingsStore.stored("serverTimezone", database), "and nothing was written").toBeNull();
  });

  test("all() reports every key with its source", () => {
    SettingsStore.set("instanceName", "grande", database);
    expect(SettingsStore.all(database)).toEqual({
      instanceName: { value: "grande", source: "database" },
      serverTimezone: { value: "Asia/Jakarta", source: "default" },
    });
  });
});
