/**
 * Shutdown must not deadlock.
 *
 * The process could not be killed. Consumers are stopped before engines, and a
 * consumer stops by calling `iterator.return()` — which does not resume a
 * generator parked at an `await`. The iterator waited for the engine to close,
 * the shutdown waited for the iterator, and three Ctrl-C did nothing.
 *
 * Only a live engine showed it: the conformance suite closes the engine, which
 * takes the other path out of the loop.
 */
import { describe, expect, test } from "bun:test";

import { BaileysAdapter } from "../adapter";
import { StubSocket } from "./stub-socket";

describe("an idle subscriber", () => {
  test("can be returned without the engine being closed first", async () => {
    const engine = new BaileysAdapter({ openSocket: () => Promise.resolve(new StubSocket()) });
    const iterator = engine.subscribe()[Symbol.asyncIterator]();

    // Park it: nothing has been emitted, so next() is waiting.
    const parked = iterator.next();
    await Bun.sleep(20);

    // This is what a consumer's stop() does, and what used to hang for ever.
    const returned = await Promise.race([
      iterator.return?.().then(() => "returned"),
      Bun.sleep(1_000).then(() => "TIMED OUT"),
    ]);
    expect(returned, "iterator.return() did not resolve").toBe("returned");

    const settled = await Promise.race([
      parked.then(() => "settled"),
      Bun.sleep(1_000).then(() => "TIMED OUT"),
    ]);
    expect(settled, "the parked next() never settled").toBe("settled");

    await engine.close();
  }, 15_000);

  test("finishes when the engine closes, for the other path out", async () => {
    const engine = new BaileysAdapter({ openSocket: () => Promise.resolve(new StubSocket()) });
    const iterator = engine.subscribe()[Symbol.asyncIterator]();
    const parked = iterator.next();

    await Bun.sleep(20);
    await engine.close();

    const result = await Promise.race([parked, Bun.sleep(1_000).then(() => "TIMED OUT" as const)]);
    expect(result).not.toBe("TIMED OUT");
  }, 15_000);

  test("a second subscriber does not displace the first", async () => {
    // The single notify slot this replaced was overwritten by whoever parked
    // last, so the displaced subscriber waited for ever.
    //
    // The stream is a queue, not a broadcast: one consumer per engine
    // (see the composition root), and the event *bus* is what fans out to
    // tenants. So two subscribers share the events rather than each getting
    // every one — this asserts neither is stranded, not that both see the
    // same event.
    const socket = new StubSocket();
    const engine = new BaileysAdapter({ openSocket: () => Promise.resolve(socket) });
    await engine.provision("d1");

    const a = engine.subscribe()[Symbol.asyncIterator]().next();
    const b = engine.subscribe()[Symbol.asyncIterator]().next();
    await Bun.sleep(20);

    // Two events, because two subscribers each take one from the queue.
    await engine.startPairing("d1", "qr");
    socket.becomeConnected();

    const both = await Promise.race([
      Promise.all([a, b]).then(() => "both served"),
      Bun.sleep(2_000).then(() => "one was left parked"),
    ]);
    expect(both).toBe("both served");

    await engine.close();
  }, 15_000);
});

describe("two iterators on one subscription", () => {
  test("returning one does not end the other", async () => {
    // `done` and the wake slot were created once per subscribe() and shared by
    // every iterator it handed out, so breaking out of one `for await` ended
    // all of them — and a second parked next() overwrote the first's resolve,
    // stranding it. Both are silent: the surviving consumer simply stops
    // receiving events and nothing reports why.
    const engine = new BaileysAdapter({ openSocket: () => Promise.resolve(new StubSocket()) });
    const stream = engine.subscribe();
    const first = stream[Symbol.asyncIterator]();
    const second = stream[Symbol.asyncIterator]();

    // Park both. With one shared slot the second push displaced the first.
    const parkedFirst = first.next();
    const parkedSecond = second.next();
    await Bun.sleep(20);

    // End only the first, the way a consumer's stop() does.
    await first.return?.();

    const firstSettled = await Promise.race([
      parkedFirst.then((r) => (r.done === true ? "done" : "value")),
      Bun.sleep(1_000).then(() => "TIMED OUT"),
    ]);
    expect(firstSettled, "the returned iterator did not settle").toBe("done");

    // The second must still be waiting rather than finished.
    const secondStillParked = await Promise.race([
      parkedSecond.then(() => "settled"),
      Bun.sleep(200).then(() => "still waiting"),
    ]);
    expect(secondStillParked, "returning one iterator ended the other").toBe("still waiting");

    // And it must still be wakeable, which is the half a shared wake slot lost.
    await engine.close();
    const secondSettled = await Promise.race([
      parkedSecond.then(() => "settled"),
      Bun.sleep(1_000).then(() => "TIMED OUT"),
    ]);
    expect(secondSettled, "the surviving iterator was never woken").toBe("settled");
  }, 15_000);
});
