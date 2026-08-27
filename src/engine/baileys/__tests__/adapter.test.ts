/**
 * Reconnect behaviour.
 *
 * The conformance suite covers the contract; this covers the policy, which is
 * where an in-process engine differs from an HTTP client. Retrying the wrong
 * disconnect is how a number gets restricted, and not retrying the right one
 * strands a working device for ever.
 */
import { describe, expect, test } from "bun:test";

import { BaileysAdapter } from "../adapter";
import { StubSocket } from "./stub-socket";

/** Drain events for a moment, then stop. */
async function drain(engine: BaileysAdapter, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const iterator = engine.subscribe()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      seen.push(next.value.type);
    }
  })();
  await Bun.sleep(ms);
  return seen;
}

describe("a socket that fails to open", () => {
  test("is retried rather than abandoned", async () => {
    // The timer clears itself before calling connect(), so a rejected open
    // used to end the retries permanently — the device stayed disconnected
    // with nothing scheduled, which is the one case where retrying is
    // obviously right.
    let attempts = 0;
    const engine = new BaileysAdapter({
      openSocket: () => {
        attempts += 1;
        if (attempts === 1) return Promise.resolve(new StubSocket());
        if (attempts < 4) return Promise.reject(new Error("no route to host"));
        return Promise.resolve(new StubSocket());
      },
    });

    await engine.provision("d1");
    await engine.startPairing("d1", "qr");

    // Drop the socket, which schedules a reconnect that will fail twice.
    const first = attempts;
    await drain(engine, 10);
    (engine as unknown as { sessions: Map<string, { handle: StubSocket | null }> }).sessions
      .get("d1")!
      .handle?.emit({ kind: "disconnected", reason: "transient", recoverable: true });

    await Bun.sleep(3_500);
    expect(attempts, "a failed open ended the retries").toBeGreaterThan(first + 1);

    await engine.close();
  }, 20_000);
});

describe("a disconnect that must not be retried", () => {
  test("a logged-out device is not reconnected", async () => {
    // Retrying credentials WhatsApp has already rejected is how a number gets
    // restricted rather than how it comes back.
    let attempts = 0;
    const socket = new StubSocket();
    const engine = new BaileysAdapter({
      openSocket: () => {
        attempts += 1;
        return Promise.resolve(socket);
      },
    });

    await engine.provision("d1");
    await engine.startPairing("d1", "qr");
    const afterPairing = attempts;

    const events = await drain(engine, 10);
    socket.emit({ kind: "disconnected", reason: "logged_out", recoverable: false });
    await Bun.sleep(2_500);

    expect(attempts, "a logged-out device was reconnected").toBe(afterPairing);
    expect(events).toContain("device.logged_out");

    await engine.close();
  }, 20_000);

  test("a replaced session is not fought over", async () => {
    // 440 means another client holds the session. Reconnecting fights it.
    let attempts = 0;
    const socket = new StubSocket();
    const engine = new BaileysAdapter({
      openSocket: () => {
        attempts += 1;
        return Promise.resolve(socket);
      },
    });

    await engine.provision("d1");
    await engine.startPairing("d1", "qr");
    const afterPairing = attempts;

    socket.emit({ kind: "disconnected", reason: "replaced", recoverable: false });
    await Bun.sleep(2_500);

    expect(attempts, "a replaced session was reconnected").toBe(afterPairing);
    await engine.close();
  }, 20_000);
});
