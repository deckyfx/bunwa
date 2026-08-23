/**
 * The two security properties of delivery.
 *
 * Webhook targets are chosen by tenants, so every delivery is an outbound
 * request to an address a customer controls; and every payload is signed,
 * because a receiver that cannot tell bunwa from anyone else has no useful
 * authentication at all.
 */
import { describe, expect, test } from "bun:test";

import { validateWebhookTarget, isAddressAllowed } from "../target";
import { sign, verify, DEFAULT_TOLERANCE_SECONDS } from "../signature";
import { nextAttemptAt, circuitAllows, BACKOFF_SECONDS } from "../backoff";
import { ValidationError } from "../../stores/errors";

describe("webhook target validation", () => {
  test("accepts an ordinary https endpoint", () => {
    expect(validateWebhookTarget("https://hooks.example.com/wa").hostname).toBe("hooks.example.com");
  });

  test("refuses the cloud metadata address", () => {
    // The canonical SSRF target: credentials for the whole account.
    expect(() => validateWebhookTarget("http://169.254.169.254/latest/meta-data/")).toThrow(ValidationError);
    expect(() => validateWebhookTarget("https://169.254.169.254/")).toThrow(/private or loopback/);
  });

  test("refuses loopback and private ranges", () => {
    for (const host of ["https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://172.16.0.1/x"]) {
      expect(() => validateWebhookTarget(host)).toThrow(/private or loopback/);
    }
  });

  test("refuses an IPv4 address smuggled inside IPv6, in either spelling", () => {
    // WHATWG URL rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so a check that
    // only understands the dotted form lets the hex one straight through.
    expect(() => validateWebhookTarget("https://[::ffff:127.0.0.1]/x")).toThrow(/private or loopback/);
    expect(() => validateWebhookTarget("https://[::ffff:7f00:1]/x")).toThrow(/private or loopback/);
    expect(() => validateWebhookTarget("https://[::ffff:a9fe:a9fe]/x")).toThrow(/private or loopback/); // 169.254.169.254
    expect(() => validateWebhookTarget("https://[::1]/x")).toThrow(/private or loopback/);
  });

  test("a mapped address that is genuinely public is still allowed", () => {
    // The guard must not become "refuse everything shaped like v6".
    expect(validateWebhookTarget("https://[::ffff:5db8:d822]/x").protocol).toBe("https:"); // 93.184.216.34
  });

  test("refuses local-by-convention host names before DNS is consulted", () => {
    for (const host of ["https://localhost/x", "https://db.internal/x", "https://metadata.google.internal/x"]) {
      expect(() => validateWebhookTarget(host)).toThrow(ValidationError);
    }
  });

  test("refuses non-http schemes", () => {
    expect(() => validateWebhookTarget("file:///etc/passwd")).toThrow(/http or https/);
    expect(() => validateWebhookTarget("gopher://x/1")).toThrow(/http or https/);
  });

  test("refuses plain http and embedded credentials", () => {
    expect(() => validateWebhookTarget("http://hooks.example.com/x")).toThrow(/must use https/);
    expect(() => validateWebhookTarget("https://user:pw@hooks.example.com/x")).toThrow(/must not contain credentials/);
  });

  test("allows the blocked cases only under an explicit development policy", () => {
    expect(validateWebhookTarget("http://localhost:3999/hook", { allowInsecure: true }).port).toBe("3999");
  });

  test("isAddressAllowed guards the post-DNS check", () => {
    // validateWebhookTarget covers literals; this covers what a name resolves to.
    expect(isAddressAllowed("93.184.216.34")).toBe(true);
    expect(isAddressAllowed("169.254.169.254")).toBe(false);
    expect(isAddressAllowed("127.0.0.1")).toBe(false);
    expect(isAddressAllowed("not-an-address")).toBe(false);
  });
});

describe("signatures", () => {
  const body = JSON.stringify({ hello: "world" });

  test("round-trips", () => {
    expect(verify(body, sign(body, "shh"), "shh")).toEqual({ valid: true });
  });

  test("rejects a tampered body", () => {
    expect(verify('{"hello":"evil"}', sign(body, "shh"), "shh").valid).toBe(false);
  });

  test("rejects the wrong secret", () => {
    expect(verify(body, sign(body, "shh"), "other").valid).toBe(false);
  });

  test("rejects a replay outside the tolerance window", () => {
    // gowa signs the body alone, so a captured payload stays valid forever.
    // The timestamp is inside the signed material precisely to stop that.
    const old = new Date(Date.now() - (DEFAULT_TOLERANCE_SECONDS + 60) * 1000);
    expect(verify(body, sign(body, "shh", old), "shh")).toEqual({ valid: false, reason: "stale" });
  });

  test("rejects a timestamp from the future as readily as an old one", () => {
    const ahead = new Date(Date.now() + (DEFAULT_TOLERANCE_SECONDS + 60) * 1000);
    expect(verify(body, sign(body, "shh", ahead), "shh").reason).toBe("stale");
  });

  test("rejects a signature whose timestamp was edited", () => {
    // Signed at a fixed earlier time so the replacement always differs. The
    // previous version guarded the assertion with `if (forged !== header)`,
    // which meant a same-second run asserted nothing at all and still passed.
    const signedAt = new Date(Date.now() - 60_000);
    const header = sign(body, "shh", signedAt);
    const forged = header.replace(/^t=\d+/, `t=${Math.floor(Date.now() / 1000)}`);
    expect(forged).not.toBe(header);
    expect(verify(body, forged, "shh").valid).toBe(false);
  });

  test("rejects malformed headers rather than throwing", () => {
    for (const bad of [null, "", "garbage", "t=abc,v1=x", "v1=only"]) {
      expect(verify(body, bad, "shh").valid).toBe(false);
    }
  });
});

describe("retry policy", () => {
  test("backs off across the documented schedule", () => {
    const now = new Date(0);
    // Deterministic: mid-jitter, so the assertion is about the schedule.
    const at = (n: number) => nextAttemptAt(n, 8, now, () => 0.5)!.getTime() / 1000;
    expect(at(1)).toBeCloseTo(BACKOFF_SECONDS[0]!, 0);
    expect(at(5)).toBeCloseTo(BACKOFF_SECONDS[4]!, 0);
  });

  test("returns null once attempts are exhausted", () => {
    expect(nextAttemptAt(8, 8)).toBeNull();
  });

  test("jitters, so a recovered target is not hit in lockstep", () => {
    const now = new Date(0);
    const low = nextAttemptAt(5, 8, now, () => 0)!.getTime();
    const high = nextAttemptAt(5, 8, now, () => 1)!.getTime();
    expect(high).toBeGreaterThan(low);
  });

  test("an open circuit blocks until the probe interval elapses", () => {
    const opened = new Date(0);
    expect(circuitAllows("open", opened, new Date(1_000))).toBe(false);
    expect(circuitAllows("open", opened, new Date(61_000))).toBe(true);
    expect(circuitAllows("closed", null)).toBe(true);
    expect(circuitAllows("half_open", opened, new Date(1_000))).toBe(true);
  });
});

describe("address blocking gaps found by review", () => {
  test("the whole fe80::/10 link-local range is blocked, not just fe80:", () => {
    // febf::1 reaches the same place; matching only the fe80: prefix let the
    // rest of the range straight through.
    for (const host of ["https://[fe80::1]/x", "https://[fe90::1]/x", "https://[febf::1]/x"]) {
      expect(() => validateWebhookTarget(host)).toThrow(/private or loopback/);
    }
  });

  test("IPv4-compatible IPv6 addresses are decoded, not waved through", () => {
    // ::7f00:1 is 127.0.0.1 without the ffff marker.
    expect(() => validateWebhookTarget("https://[::7f00:1]/x")).toThrow(/private or loopback/);
    expect(() => validateWebhookTarget("https://[::a9fe:a9fe]/x")).toThrow(/private or loopback/);
  });

  test("a trailing dot does not evade the local-name check", () => {
    // "localhost." is a fully qualified form of the same name.
    for (const host of ["https://localhost./x", "https://metadata.google.internal./x"]) {
      expect(() => validateWebhookTarget(host)).toThrow(/local host name/);
    }
  });

  test("ordinary public IPv6 is still allowed", () => {
    expect(validateWebhookTarget("https://[2606:4700::1111]/x").protocol).toBe("https:");
  });
});
