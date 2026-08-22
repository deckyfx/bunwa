/**
 * Tests for the pure helpers in the stage 0 harness.
 *
 * These exist because both review passes found defects in this file, and the
 * sharpest one — masking a serialised payload corrupted JSON number literals
 * and aborted the run — would have been caught by a single assertion.
 */
import { describe, expect, test } from "bun:test";

import { maskPhone, maskDeep, stamp } from "../config";

describe("maskPhone", () => {
  test("masks an international number inside a JID", () => {
    expect(maskPhone("6281914773295@s.whatsapp.net")).toBe("62…95@s.whatsapp.net");
  });

  test("masks a national-format number with no country code", () => {
    // Regression: the original pattern required nine digits, so this reached disk in full.
    expect(maskPhone("81234567")).toBe("81…67");
  });

  test("leaves short digit runs alone", () => {
    expect(maskPhone("12345")).toBe("12345");
  });

  test("masks every occurrence, not just the first", () => {
    expect(maskPhone("from 628123456789 to 628987654321")).toBe("from 62…89 to 62…21");
  });
});

describe("maskDeep", () => {
  test("preserves number literals", () => {
    // Regression: masking JSON.stringify output rewrote `1712345678901` to
    // `17…01`, so JSON.parse threw and the send loop aborted part-way.
    const masked = maskDeep({ ts: 1712345678901, phone: "628123456789" }) as Record<string, unknown>;
    expect(masked["ts"]).toBe(1712345678901);
    expect(masked["phone"]).toBe("62…89");
  });

  test("round-trips through JSON unchanged in shape", () => {
    const input = { code: "SUCCESS", ok: true, n: 42, nested: { phone: "628123456789" }, list: ["628123456789", 7] };
    const masked = maskDeep(input);
    expect(() => JSON.parse(JSON.stringify(masked))).not.toThrow();
    expect(JSON.parse(JSON.stringify(masked))).toEqual({
      code: "SUCCESS", ok: true, n: 42, nested: { phone: "62…89" }, list: ["62…89", 7],
    });
  });

  test("passes null and undefined through", () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep(undefined)).toBeUndefined();
  });
});

describe("stamp", () => {
  test("formats as HH:MM:SS.mmm", () => {
    expect(stamp(new Date("2026-08-22T10:28:03.123Z"))).toBe("10:28:03.123");
  });
});
