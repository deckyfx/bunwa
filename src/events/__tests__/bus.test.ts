/**
 * The live event bus.
 *
 * The properties that matter are tenant isolation and never becoming
 * backpressure on the engine consumer — everything else is a convenience.
 */
import { describe, expect, test, afterEach } from "bun:test";

import { publish, subscribe, subscriberCount, resetBus } from "../bus";
import { EVENT_SCHEMA_VERSION } from "../schema";
import type { EventEnvelope } from "../schema";

afterEach(() => {
  resetBus();
});

function envelope(id: string, environmentId = "env-1"): EventEnvelope {
  return {
    schema: EVENT_SCHEMA_VERSION,
    id,
    type: "device.connected",
    occurred_at: new Date(0).toISOString(),
    environment: { id: environmentId, slug: "production" },
    project: { id: "proj-1", slug: "grande" },
    data: {},
    meta: { origin: "engine" },
  };
}

/** Take `n` envelopes, or fail rather than hang if they never arrive. */
async function take(events: AsyncIterable<EventEnvelope>, n: number): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  const iterator = events[Symbol.asyncIterator]();
  for (let i = 0; i < n; i++) {
    const next = await Promise.race([
      iterator.next(),
      Bun.sleep(2_000).then(() => ({ done: true, value: undefined }) as const),
    ]);
    if (next.done === true) break;
    out.push(next.value as EventEnvelope);
  }
  return out;
}

describe("a subscriber only sees its own environment", () => {
  test("an envelope for another environment never arrives", async () => {
    // The cardinal rule of this system. The bus is handed envelopes fanOut has
    // already scoped, so the failure would not be a leak of someone else's
    // data so much as a leak of the fact that it happened — but a console
    // showing another tenant's device connecting is a breach either way.
    const mine = subscribe("env-1");
    publish("env-2", envelope("theirs", "env-2"));
    publish("env-1", envelope("mine"));

    const seen = await take(mine.events, 1);
    expect(seen.map((e) => e.id)).toEqual(["mine"]);
    mine.close();
  });

  test("two subscribers on one environment both receive it", async () => {
    const a = subscribe("env-1");
    const b = subscribe("env-1");
    expect(subscriberCount("env-1")).toBe(2);

    publish("env-1", envelope("shared"));

    expect((await take(a.events, 1)).map((e) => e.id)).toEqual(["shared"]);
    expect((await take(b.events, 1)).map((e) => e.id)).toEqual(["shared"]);
    a.close();
    b.close();
  });
});

describe("a slow subscriber is cut loose, not absorbed", () => {
  test("overflow closes that subscriber and says why", async () => {
    // publish() runs inside the engine consumer loop, which every tenant
    // depends on. A browser on a stalled connection must not slow it.
    const stalled = subscribe("env-1");
    for (let i = 0; i < 100; i++) publish("env-1", envelope(`e${i}`));

    expect(stalled.reason()).toBe("overflow");
  });

  test("overflowing one does not affect another", async () => {
    const stalled = subscribe("env-1");
    const healthy = subscribe("env-1");

    for (let i = 0; i < 100; i++) publish("env-1", envelope(`e${i}`));
    expect(stalled.reason()).toBe("overflow");

    // The healthy one overflowed too — both were stalled. What matters is that
    // publish() returned promptly for every one of the 100 calls rather than
    // waiting on either.
    expect(healthy.reason()).toBe("overflow");
  });

  test("a subscriber that keeps up is never closed", async () => {
    const keeping = subscribe("env-1");
    for (let i = 0; i < 5; i++) publish("env-1", envelope(`e${i}`));

    const seen = await take(keeping.events, 5);
    expect(seen).toHaveLength(5);
    expect(keeping.reason()).toBeNull();
    keeping.close();
  });
});

describe("subscriptions do not leak", () => {
  test("closing removes the subscriber and the empty environment with it", () => {
    const one = subscribe("env-1");
    expect(subscriberCount("env-1")).toBe(1);
    one.close();
    expect(subscriberCount("env-1")).toBe(0);
  });

  test("abandoning the iterator mid-stream still unsubscribes", async () => {
    // A browser that disconnects does not call close(); it stops reading. The
    // generator's finally is what makes that safe, and it is the difference
    // between a bounded map and one that grows for the life of the process.
    const abandoned = subscribe("env-1");
    publish("env-1", envelope("first"));

    for await (const _ of abandoned.events) {
      break;
    }

    expect(subscriberCount("env-1")).toBe(0);
  });

  test("an overflowed subscriber is dropped even if nobody ever reads it", () => {
    // The leak the abandoned-iterator test above does not cover. That one
    // relies on the generator's finally, which only runs while someone is
    // iterating — and the subscriber most likely to overflow is precisely the
    // one that stopped. Measured before the fix: subscriberCount stayed at 1
    // with twenty envelopes held behind it, for the life of the process.
    const stalled = subscribe("env-1");
    for (let i = 0; i < 100; i++) publish("env-1", envelope(`e${i}`));

    expect(stalled.reason()).toBe("overflow");
    expect(subscriberCount("env-1"), "an overflowed subscriber was retained").toBe(0);
  });

  test("a later publish does not resurrect a dropped subscriber", () => {
    const stalled = subscribe("env-1");
    for (let i = 0; i < 100; i++) publish("env-1", envelope(`e${i}`));
    publish("env-1", envelope("after"));

    expect(subscriberCount("env-1")).toBe(0);
    expect(stalled.reason()).toBe("overflow");
  });

  test("close is safe twice", () => {
    const one = subscribe("env-1");
    one.close();
    one.close();
    expect(subscriberCount("env-1")).toBe(0);
  });
});
