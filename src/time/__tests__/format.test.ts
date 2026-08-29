/**
 * Date rendering.
 *
 * The properties worth asserting are the ones whose failure is quiet: an
 * offset that is right in one season and wrong in the other, a cached
 * formatter that keeps using the first zone it saw, and a format that reads as
 * a different date depending on the reader.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { formatDate, formatDateTime, formatIso, formatTime, resetTimeFormatters, timezoneOffset } from "../format";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS, "SERVER_TIMEZONE"]);

/** 2026-01-15T04:30:00Z — 11:30 in Jakarta, which is UTC+7 all year. */
const WINTER = new Date("2026-01-15T04:30:00Z");
/** 2026-07-15T04:30:00Z — the same wall clock in Jakarta, six months later. */
const SUMMER = new Date("2026-07-15T04:30:00Z");

const inZone = (zone: string) => {
  Bun.env["SERVER_TIMEZONE"] = zone;
  resetConfig();
  resetTimeFormatters();
};

beforeEach(() => {
  Bun.env["NODE_ENV"] = "test";
  inZone("Asia/Jakarta");
});

afterEach(() => {
  resetConfig();
  resetTimeFormatters();
  restoreEnv();
});

describe("the configured zone is applied", () => {
  test("Jakarta is seven hours ahead of UTC", () => {
    expect(formatDateTime(WINTER)).toBe("2026-01-15 11:30:00");
  });

  test("a different zone gives a different wall clock for the same instant", () => {
    inZone("UTC");
    expect(formatDateTime(WINTER)).toBe("2026-01-15 04:30:00");
  });

  test("changing the zone is picked up rather than cached", () => {
    // The formatter is cached for cost, and a cache keyed on nothing would
    // keep formatting in whichever zone happened to be configured first.
    expect(formatDateTime(WINTER)).toBe("2026-01-15 11:30:00");
    inZone("America/New_York");
    expect(formatDateTime(WINTER)).toBe("2026-01-14 23:30:00");
  });
});

describe("the format itself", () => {
  test("is sortable and unambiguous", () => {
    // Not locale-shaped: 15/01/2026 reads as a different date to half the
    // world, and these strings end up in files people grep.
    expect(formatDateTime(WINTER)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("time and date are slices of the same rendering", () => {
    // So they can never disagree about which day it is.
    expect(formatTime(WINTER)).toBe("11:30:00");
    expect(formatDate(WINTER)).toBe("2026-01-15");
  });

  test("midnight does not roll the date backwards", () => {
    // 17:30Z is 00:30 the next day in Jakarta — the case an offset applied to
    // the time but not the date gets wrong.
    const lateUtc = new Date("2026-01-15T17:30:00Z");
    expect(formatDateTime(lateUtc)).toBe("2026-01-16 00:30:00");
  });
});

describe("the offset", () => {
  test("is carried in the ISO form", () => {
    expect(formatIso(WINTER)).toBe("2026-01-15T11:30:00+07:00");
  });

  test("is computed per instant, not assumed constant", () => {
    // Jakarta does not observe daylight saving, so both are +07:00 — but a
    // zone that does must not be an hour out for half the year, and would be
    // right in any test written only against one season.
    expect(timezoneOffset(WINTER)).toBe("+07:00");
    expect(timezoneOffset(SUMMER)).toBe("+07:00");

    inZone("Europe/London");
    expect(timezoneOffset(WINTER), "London in January").toBe("+00:00");
    expect(timezoneOffset(SUMMER), "London in July, under BST").toBe("+01:00");
  });

  test("a negative offset is signed correctly", () => {
    inZone("America/New_York");
    expect(timezoneOffset(WINTER)).toBe("-05:00");
  });
});
