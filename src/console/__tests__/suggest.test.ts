/**
 * Suggesting an instance name.
 *
 * The suggestion has one hard requirement: whatever it produces must survive
 * the server's normaliser. A suggestion that fails validation is worse than no
 * button, because it puts a value in the box that looks accepted.
 */
import { describe, expect, test } from "bun:test";

import { normaliseInstanceName } from "../../stores/settings-store";
import { suggestInstanceName } from "../lib/suggest";

describe("what it derives from", () => {
  test("the first label of a real hostname", () => {
    // "wa.grande.example.com" is a deployment called "wa" at a company whose
    // name is on every other install too — and the whole string does not fit
    // the 24 characters WhatsApp shows.
    expect(suggestInstanceName("wa.grande.example.com")).toBe("wa");
    expect(suggestInstanceName("grande-pos.internal")).toBe("grande-pos");
  });

  test("not localhost, which identifies a machine and not a deployment", () => {
    expect(suggestInstanceName("localhost")).toMatch(/^bunwa-[a-z0-9]{4}$/);
  });

  test("not a bare IP, for the same reason", () => {
    expect(suggestInstanceName("192.168.1.40")).toMatch(/^bunwa-[a-z0-9]{4}$/);
  });

  test("two installs on one machine do not collide", () => {
    // Which is exactly the case where telling them apart matters.
    const names = new Set(Array.from({ length: 20 }, () => suggestInstanceName("localhost")));
    expect(names.size).toBeGreaterThan(1);
  });
});

describe("whatever it produces", () => {
  test("survives the server's normaliser unchanged", () => {
    // The property that matters. A suggestion the server would rewrite means
    // the operator saw one name and got another.
    for (const host of ["wa.grande.example.com", "localhost", "192.168.1.40", "Grande_POS.local", ""]) {
      const suggested = suggestInstanceName(host);
      expect(normaliseInstanceName(suggested), host).toBe(suggested);
    }
  });

  test("is never empty", () => {
    // An empty box is what the button exists to avoid.
    expect(suggestInstanceName("...").length).toBeGreaterThan(0);
    expect(suggestInstanceName("!!!").length).toBeGreaterThan(0);
  });
});
