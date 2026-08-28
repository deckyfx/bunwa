/**
 * The deliveries store.
 *
 * The property worth keeping from the component this replaced: a second click
 * on a row already in flight must not send a second webhook. That was found by
 * a reviewer after the first version tracked only the most recent id, which
 * re-enabled the first row while its request was still going.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

const replayCalls: string[] = [];
let replayResolver: () => Promise<unknown> = () => Promise.resolve({ data: {}, error: null });
let listResolver: () => Promise<unknown> = () => Promise.resolve({ data: [], error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      deliveries: Object.assign(
        (params: { id: string }) => ({
          replay: {
            post: () => {
              replayCalls.push(params.id);
              return replayResolver();
            },
          },
        }),
        { get: () => listResolver() },
      ),
    },
  }),
  anonymous: () => ({}),
}));

const { useDeliveries } = await import("../store/deliveries");
const { useSession } = await import("../store/session");

const delivery = (id: string) => ({
  id,
  eventType: "message.received",
  state: "failed",
  attemptCount: 3,
  createdAt: new Date(0),
  deliveredAt: null,
  environmentId: "e1",
  eventId: "ev1",
  nextAttemptAt: new Date(0),
  payload: {},
  updatedAt: new Date(0),
});

beforeEach(() => {
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useDeliveries.setState({ deliveries: null, replaying: new Set(), error: null });
  replayCalls.length = 0;
  replayResolver = () => Promise.resolve({ data: {}, error: null });
});

describe("replaying", () => {
  test("sends one request", async () => {
    listResolver = () => Promise.resolve({ data: [delivery("d1")], error: null });
    await useDeliveries.getState().replay("d1");
    expect(replayCalls).toEqual(["d1"]);
  });

  test("a second click while one is in flight is refused", async () => {
    // A replay is a webhook the consumer receives again. Two is a duplicate at
    // the far end, not a retry.
    let release: ((v: unknown) => void) | undefined;
    replayResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const first = useDeliveries.getState().replay("d1");
    await useDeliveries.getState().replay("d1");

    expect(replayCalls, "a duplicate replay was sent").toEqual(["d1"]);

    release?.({ data: {}, error: null });
    await first;
  });

  test("two different rows may replay at once", async () => {
    // The first fix tracked one id, so starting a second row re-enabled the
    // first while it was still sending.
    let releases: ((v: unknown) => void)[] = [];
    replayResolver = () =>
      new Promise((resolve) => {
        releases.push(resolve);
      });

    const a = useDeliveries.getState().replay("d1");
    const b = useDeliveries.getState().replay("d2");

    expect(useDeliveries.getState().replaying.has("d1")).toBe(true);
    expect(useDeliveries.getState().replaying.has("d2")).toBe(true);

    releases.forEach((release) => {
      release({ data: {}, error: null });
    });
    await Promise.all([a, b]);
    releases = [];

    expect(useDeliveries.getState().replaying.size).toBe(0);
  });
});

describe("replaying with no credential", () => {
  test("does not suppress the delivery once a key arrives", async () => {
    // `inFlight` is only ever cleared in the `finally`, and the empty-key guard
    // returns before the `try`. Marking the id before that guard therefore
    // suppressed the delivery for the life of the page: no request, no error,
    // no busy row — the button simply stopped working, and only for whoever
    // had happened to click it while signed out.
    useSession.setState({ apiKey: "" });
    await useDeliveries.getState().replay("d1");
    expect(replayCalls, "a replay was sent with no credential").toEqual([]);

    // Now sign in and try the same row again. It must go through.
    useSession.setState({ apiKey: "key-a" });
    await useDeliveries.getState().replay("d1");
    expect(replayCalls, "the row was permanently suppressed by the signed-out click").toEqual(["d1"]);
  });

  test("a second click while one is genuinely in flight is still refused", async () => {
    // The property the guard exists for, kept: suppression must survive the
    // reordering above.
    useSession.setState({ apiKey: "key-a" });
    let release: (() => void) | undefined;
    replayResolver = () =>
      new Promise((resolve) => {
        release = () => resolve({ data: {}, error: null });
      });

    const first = useDeliveries.getState().replay("d2");
    await useDeliveries.getState().replay("d2");
    expect(replayCalls.filter((id) => id === "d2"), "the same delivery was replayed twice").toEqual([
      "d2",
    ]);

    release?.();
    await first;
  });
});
