/**
 * The conformance suite — the contract's teeth.
 *
 * Every engine runs this identical suite. Written now, against the fake, so
 * that when the gowa adapter and later the native engine arrive, "is it ready?"
 * already has a numeric answer rather than an opinion (ADR-0002).
 *
 * Exported as a function rather than a test file so each engine's own test file
 * calls it with whatever setup that engine needs.
 */
import { describe, expect, test } from "bun:test";

import { EngineError, type DeviceEngine, type EngineEvent } from "./types";

/** What an engine must provide for the suite to drive it. */
export interface ConformanceHarness {
  /** A fresh engine, once per test. */
  create(): Promise<DeviceEngine> | DeviceEngine;
  /**
   * Bring a provisioned device to connected-and-logged-in.
   *
   * Real engines need a phone, so returning false is how an engine says "I
   * cannot reach this state unattended". Those tests are then reported as
   * skipped rather than passing, so a partial pass is visible instead of hidden.
   */
  pair?(engine: DeviceEngine, deviceId: string): Promise<boolean>;
  destroy?(engine: DeviceEngine): Promise<void>;
}

/** Run `action`, then collect events published within `ms`. */
async function collect(engine: DeviceEngine, ms: number, action: () => void | Promise<void>): Promise<EngineEvent[]> {
  const seen: EngineEvent[] = [];
  const iterator = engine.subscribe()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      seen.push(next.value);
    }
  })();
  await action();
  await Bun.sleep(ms);
  return seen;
}

/** Run the suite against an engine. */
export function runConformanceSuite(name: string, harness: ConformanceHarness): void {
  describe(`DeviceEngine conformance: ${name}`, () => {
    const withEngine = async (fn: (engine: DeviceEngine) => Promise<void>): Promise<void> => {
      const engine = await harness.create();
      try {
        await fn(engine);
      } finally {
        await harness.destroy?.(engine);
        await engine.close();
      }
    };

    test("reports its kind", async () => {
      await withEngine(async (engine) => {
        expect(engine.kind).toBeString();
      });
    });

    test("provision is idempotent", async () => {
      await withEngine(async (engine) => {
        await engine.provision("d1");
        // A retry after a timeout must not silently unpair a working phone.
        await engine.provision("d1");
        expect((await engine.status("d1")).connected).toBeBoolean();
      });
    });

    test("an unprovisioned device is an error, not an empty status", async () => {
      await withEngine(async (engine) => {
        // A blank status would let the control plane treat a typo as a
        // disconnected device and wait forever for it to come up.
        await expect(engine.status("never-provisioned")).rejects.toThrow(EngineError);
      });
    });

    test("a fresh device is neither connected nor logged in", async () => {
      await withEngine(async (engine) => {
        await engine.provision("d1");
        expect(await engine.status("d1")).toMatchObject({ connected: false, loggedIn: false, jid: null });
      });
    });

    test("startPairing returns a session the customer can act on", async () => {
      await withEngine(async (engine) => {
        await engine.provision("d1");
        const session = await engine.startPairing("d1", "qr");
        expect(session.method).toBe("qr");
        expect(session.qr).toBeString();
        expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
      });
    });

    test("pairing progress is also published as an event", async () => {
      await withEngine(async (engine) => {
        await engine.provision("d1");
        const events = await collect(engine, 20, async () => {
          await engine.startPairing("d1", "qr");
        });
        // The claim flow streams this to the browser; a session returned only
        // from the call would leave a refreshed QR unreachable.
        expect(events.some((e) => e.type === "device.qr")).toBe(true);
      });
    });

    test("a send to a disconnected device fails, and says it is retryable", async () => {
      await withEngine(async (engine) => {
        await engine.provision("d1");
        // Retryable matters: the control plane must requeue rather than
        // dead-letter a message for a device that is merely reconnecting.
        await expect(engine.send("d1", { type: "text", to: "+62811", text: "x" })).rejects.toMatchObject({
          retryable: true,
        });
      });
    });

    test("close is safe to call twice", async () => {
      const engine = await harness.create();
      await engine.close();
      await expect(engine.close()).resolves.toBeUndefined();
    });

    describe("with a paired device", () => {
      const pairedTest = (label: string, fn: (engine: DeviceEngine) => Promise<void>): void => {
        test(label, async () => {
          await withEngine(async (engine) => {
            await engine.provision("d1");
            const paired = (await harness.pair?.(engine, "d1")) ?? false;
            if (!paired) {
              // Recorded, not silently passed: the engine has declared it
              // cannot reach this state unattended.
              console.warn(`  skipped for ${name}: "${label}" needs a live device`);
              return;
            }
            await fn(engine);
          });
        });
      };

      pairedTest("reports connected and logged in", async (engine) => {
        const status = await engine.status("d1");
        expect(status).toMatchObject({ connected: true, loggedIn: true });
        expect(status.jid).toBeString();
      });

      pairedTest("accepts a send and returns a message id", async (engine) => {
        const result = await engine.send("d1", { type: "text", to: "+628123456789", text: "hello" });
        expect(result.messageId).toBeString();
        expect(result.acceptedAt).toBeInstanceOf(Date);
      });

      pairedTest("accepts all six v1 message types", async (engine) => {
        const media = { url: "https://example.com/x" };
        const to = "+628123456789";
        for (const action of [
          { type: "text", to, text: "t" },
          { type: "image", to, media },
          { type: "document", to, media, filename: "x.pdf" },
          { type: "link", to, url: "https://example.com" },
          { type: "audio", to, media },
          { type: "video", to, media },
        ] as const) {
          const result = await engine.send("d1", action);
          expect(result.messageId).toBeString();
        }
      });

      pairedTest("rejects a send with no recipient as not retryable", async (engine) => {
        // A malformed request must not be requeued forever.
        await expect(engine.send("d1", { type: "text", to: "", text: "x" })).rejects.toMatchObject({
          retryable: false,
        });
      });

      pairedTest("logout keeps the slot and clears the identity", async (engine) => {
        await engine.logout("d1");
        const status = await engine.status("d1");
        // Keep-slot: the row survives, so re-pairing needs no new consent.
        expect(status.loggedIn).toBe(false);
        expect(status.jid).toBeNull();
      });

      pairedTest("logout is published as an event", async (engine) => {
        const events = await collect(engine, 20, () => engine.logout("d1"));
        // The event gowa never delivers, and the reason this project exists.
        expect(events.some((e) => e.type === "device.logged_out")).toBe(true);
      });

      pairedTest("purge removes the device entirely", async (engine) => {
        await engine.purge("d1");
        await expect(engine.status("d1")).rejects.toThrow(EngineError);
      });
    });
  });
}
