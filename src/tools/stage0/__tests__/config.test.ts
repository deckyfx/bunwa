/**
 * Tests for the pure helpers in the stage 0 harness.
 *
 * These exist because both review passes found defects in this file, and the
 * sharpest one — masking a serialised payload corrupted JSON number literals
 * and aborted the run — would have been caught by a single assertion.
 */
import { describe, expect, test } from "bun:test";

import { maskPhone, maskDeep, stamp, flag, intOrThrow } from "../config";

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

  test("redacts free-text content but keeps its length", () => {
    // The harness studies payload shape, never message text — which belongs to
    // a third party who is not part of this project.
    const masked = maskDeep({
      body: "secret text",
      sender_display_name: "Papa",
      image: { caption: "hello", path: "statics/media/x.jpeg" },
    }) as Record<string, unknown>;
    expect(masked["body"]).toBe("<redacted 11 chars>");
    expect(masked["sender_display_name"]).toBe("<redacted 4 chars>");
    expect((masked["image"] as Record<string, unknown>)["caption"]).toBe("<redacted 5 chars>");
    // Structural fields survive — they are the thing being measured.
    expect((masked["image"] as Record<string, unknown>)["path"]).toBe("statics/media/x.jpeg");
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

describe("flag", () => {
  test("reads a value", () => {
    expect(flag("device", ["bun", "x", "--device", "stage0-b"])).toBe("stage0-b");
  });

  test("returns undefined when the flag is absent", () => {
    expect(flag("device", ["bun", "x"])).toBeUndefined();
  });

  test("rejects a trailing flag with no value", () => {
    // Previously fell through to the default, so the run measured the wrong device.
    expect(() => flag("device", ["bun", "x", "--device"])).toThrow("--device requires a value");
  });

  test("rejects an explicitly empty value", () => {
    // `--interval ""` previously returned "", which intOrThrow read as unset.
    expect(() => flag("interval", ["bun", "x", "--interval", ""])).toThrow(/non-empty/);
    expect(() => flag("interval", ["bun", "x", "--interval", "   "])).toThrow(/non-empty/);
  });

  test("rejects the next flag being consumed as the value", () => {
    // Previously `--outage --device x` set outage to the string "--device".
    expect(() => flag("outage", ["bun", "x", "--outage", "--device", "a"])).toThrow(/got the flag/);
  });
});

describe("intOrThrow", () => {
  test("uses the fallback when unset", () => {
    expect(intOrThrow(undefined, 60, "--outage")).toBe(60);
  });

  test("rejects non-numeric input", () => {
    expect(() => intOrThrow("abc", 60, "--outage")).toThrow(/must be an integer/);
  });

  test("rejects an env var that is set but empty", () => {
    expect(() => intOrThrow("", 3999, "SINK_PORT")).toThrow(/set but empty/);
  });

  test("rejects a whitespace-only value", () => {
    expect(() => intOrThrow("   ", 3999, "SINK_PORT")).toThrow(/set but empty/);
    expect(() => intOrThrow("\t", 3999, "SINK_PORT")).toThrow(/set but empty/);
  });

  test("rejects out-of-range input", () => {
    expect(() => intOrThrow("70000", 3999, "SINK_PORT")).toThrow(/between 1 and 65535/);
  });
});
