/**
 * The console's live connection.
 *
 * The interesting behaviour is not that it connects — it is what it reports
 * when an attempt has been superseded. A stream that says "stale" while a
 * healthy replacement is running is worse than one that says nothing, because
 * the banner tells the developer to distrust data that is actually current.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

import { useEventStream } from "../useEventStream";

/**
 * Everything this file replaces on globalThis, captured once.
 *
 * Restoring one and forgetting another is how a leak reaches a later file:
 * bun test shares a process, so a SilentEventSource left installed here is the
 * EventSource every subsequent test sees. The same shape as the patched static
 * that produced two unrelated failures in the control-plane suite — restored as
 * a set rather than individually, so adding a stub means adding it here.
 */
const REAL_GLOBALS = {
  fetch: globalThis.fetch,
  EventSource: (globalThis as { EventSource?: unknown }).EventSource,
};

afterEach(() => {
  cleanup();
  globalThis.fetch = REAL_GLOBALS.fetch;
  (globalThis as { EventSource?: unknown }).EventSource = REAL_GLOBALS.EventSource;
});

/** A minimal EventSource that never connects, so nothing races the assertions. */
class SilentEventSource {
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

function Probe({ apiKey }: { apiKey: string }) {
  const state = useEventStream({ apiKey, onEvent: () => undefined });
  return <output>{state}</output>;
}

describe("a superseded attempt does not describe the live one", () => {
  test("a ticket request that rejects after the key changed leaves state alone", async () => {
    // The sequence: key A mints a ticket, the request hangs, the key changes to
    // B, cleanup marks the first attempt cancelled, and only then does A's
    // request reject. Before the guard, its catch set "stale" — over the top of
    // whatever B was doing.
    // Held in an object so TypeScript cannot narrow it to `never` across the
    // executor callback, which is what a bare `let` does here.
    const pending: { reject: ((e: Error) => void) | undefined } = { reject: undefined };
    let calls = 0;

    // `unknown` first: a stub cannot satisfy every member of typeof fetch
    // (preconnect among them), and widening through unknown is honest about
    // that rather than pretending the shapes overlap.
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, rej) => {
          pending.reject = rej;
        });
      }
      // The replacement attempt: never resolves either, so the only thing that
      // can move state is the abandoned first attempt.
      return await new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;

    (globalThis as { EventSource?: unknown }).EventSource = SilentEventSource;

    const view = render(<Probe apiKey="key-a" />);
    await waitFor(() => expect(screen.getByText("connecting")).toBeDefined());

    // Supersede it, and wait for the replacement to have actually started —
    // a fixed sleep proves nothing about ordering, so the test could pass with
    // the regression present simply because the timings fell the right way.
    view.rerender(<Probe apiKey="key-b" />);
    await waitFor(() => expect(calls).toBe(2));

    // Now the abandoned request fails.
    if (pending.reject === undefined) throw new Error("the first request never started");
    pending.reject(new Error("abandoned"));
    await Bun.sleep(50);

    expect(
      screen.queryByText("stale"),
      "an abandoned attempt reported stale over the live connection",
    ).toBeNull();
  });

  test("overflow schedules a reconnect rather than staying stale for ever", async () => {
    // close() stops onerror firing, so overflow was terminal: the console sat
    // stale until the page was reloaded. A backgrounded tab reaches overflow on
    // its own — the bus drops a subscriber after twenty pending envelopes.
    let ticketRequests = 0;
    globalThis.fetch = (async () => {
      ticketRequests += 1;
      return new Response(JSON.stringify({ ticket: `t${String(ticketRequests)}` }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Captures the overflow listener so the test can fire it.
    const listeners = new Map<string, () => void>();
    class OverflowingEventSource {
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      addEventListener(type: string, fn: () => void): void {
        listeners.set(type, fn);
      }
      close(): void {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = OverflowingEventSource;

    render(<Probe apiKey="key-a" />);
    // The listener, not the ticket count. A ticket having been requested says
    // nothing about registration having finished, and `?.()` on a missing
    // listener is a silent no-op — the test would then pass having fired
    // nothing at all.
    await waitFor(() => expect(listeners.has("stream.overflow")).toBe(true));

    const overflow = listeners.get("stream.overflow");
    if (overflow === undefined) throw new Error("no overflow listener was registered");
    overflow();
    await waitFor(() => expect(screen.getByText("stale")).toBeDefined());

    // The reconnect is delayed on purpose; overflow means this client could not
    // keep up, so retrying instantly invites the same outcome.
    await waitFor(() => expect(ticketRequests).toBeGreaterThan(1), { timeout: 8_000 });
  }, 15_000);

  test("no key means idle, not connecting", async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    render(<Probe apiKey="" />);
    await waitFor(() => expect(screen.getByText("idle")).toBeDefined());
  });
});
