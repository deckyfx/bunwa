/**
 * Instance-wide settings, and where each one's value comes from.
 *
 * One rule governs all of them: **an explicitly set environment variable wins,
 * and the console shows that field locked.** Anything else would let a screen
 * disagree with the deployment that owns it — an operator changes a value, the
 * environment quietly overrides it, and nothing says so. The rule is the same
 * for every setting so there is nothing to remember per field.
 *
 * Values are text in the database; the accessors here own the parsing, so a
 * bad value is rejected when it is written rather than discovered by whatever
 * reads it next.
 */
import { eq } from "drizzle-orm";

import { config, isUsableTimezone } from "../config/env";
import { db, type Database } from "../db";
import { settings } from "../db/schema";
import { ValidationError } from "./errors";

/** Settings this instance knows about. */
export const SETTING_KEYS = ["instanceName", "serverTimezone"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Where a value came from, so the console can say so and lock the field. */
export type SettingSource = "environment" | "database" | "default";

export interface SettingValue {
  value: string;
  source: SettingSource;
}

/**
 * What WhatsApp shows when no name has been chosen.
 *
 * Deliberately not the product name alone: this appears in a list beside the
 * operator's other linked devices, and "bunwa" with nothing after it is what
 * every unconfigured install would be called.
 */
export const DEFAULT_INSTANCE_NAME = "bunwa";

/**
 * The browser half of the identity WhatsApp displays.
 *
 * Linked Devices renders `${browser} (${platform})`, and the platform slot is
 * where the instance name goes — so this constant is the "Google Chrome" in
 * "Google Chrome (my-instance)".
 */
export const CLIENT_BROWSER = "Google Chrome";

/**
 * Make an operator's typing usable as a WhatsApp platform string.
 *
 * Spaces are the reason this exists: the field is transmitted as a single
 * token during the handshake and a name with a space in it does not survive
 * the round trip. Rather than reject what someone typed, the spaces become
 * hyphens — the intent is obvious and refusing "My Instance" teaches nothing.
 *
 * Everything outside a conservative set is dropped for the same reason: this
 * value is displayed by a client we do not control, and the safe set is the
 * one that renders identically everywhere.
 */
export function normaliseInstanceName(raw: string): string {
  const collapsed = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    // A run of separators reads as a typo rather than a choice.
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  if (collapsed === "") {
    throw new ValidationError(
      "instance name must contain at least one letter or digit; it is shown in WhatsApp's linked devices list",
    );
  }

  // WhatsApp truncates a long platform string in the list, so the cap is here
  // rather than left to the display: a name that is cut off mid-word is worse
  // than one the operator was told to shorten.
  if (collapsed.length > 24) {
    throw new ValidationError(`instance name is too long after normalising (${collapsed.length}/24): ${collapsed}`);
  }

  return collapsed;
}

/** Read, write and resolve settings. */
export class SettingsStore {
  /** The stored value, ignoring any environment override. */
  static stored(key: SettingKey, database: Database = db()): string | null {
    const row = database.select().from(settings).where(eq(settings.key, key)).limit(1).all()[0];
    return row?.value ?? null;
  }

  /** Write a value, after the same validation the API applies. */
  static set(key: SettingKey, raw: string, database: Database = db()): string {
    const value = SettingsStore.validate(key, raw);
    const now = new Date();

    database
      .insert(settings)
      .values({ key, value, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();

    return value;
  }

  /** Reject a bad value at the boundary rather than on the way out. */
  static validate(key: SettingKey, raw: string): string {
    if (key === "instanceName") return normaliseInstanceName(raw);

    const zone = raw.trim();
    if (!isUsableTimezone(zone)) {
      throw new ValidationError(`not a timezone this runtime knows: ${zone}. Use an IANA name such as Asia/Jakarta.`);
    }
    return zone;
  }

  /**
   * The effective value and where it came from.
   *
   * The environment is checked first for every key, which is the rule this
   * module exists to keep in one place.
   */
  static resolve(key: SettingKey, database: Database = db()): SettingValue {
    if (key === "serverTimezone" && config().serverTimezoneFromEnv) {
      return { value: config().serverTimezone, source: "environment" };
    }

    const stored = SettingsStore.stored(key, database);
    if (stored !== null) return { value: stored, source: "database" };

    return {
      value: key === "instanceName" ? DEFAULT_INSTANCE_NAME : config().serverTimezone,
      source: "default",
    };
  }

  /** Every setting, for the console's settings screen. */
  static all(database: Database = db()): Record<SettingKey, SettingValue> {
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, SettingsStore.resolve(k, database)])) as Record<
      SettingKey,
      SettingValue
    >;
  }

  /** The name WhatsApp will show for this instance. */
  static instanceName(database: Database = db()): string {
    return SettingsStore.resolve("instanceName", database).value;
  }
}
