/**
 * In-process fan-out of tenant events, for anything watching live.
 *
 * Engine events already reach tenants one way: `fanOut` builds an envelope per
 * active binding and enqueues it for durable webhook delivery. The dashboard
 * needs the same envelopes, immediately, without a webhook round trip — so this
 * publishes them a second way rather than inventing a second shape.
 *
 * Deliberately not durable and deliberately not the delivery queue. A browser
 * that was not connected missed nothing it cannot re-fetch, whereas a webhook
 * that was not delivered is a promise broken. Conflating the two would either
 * make the queue lossy or make the stream a second thing to guarantee.
 */
import type { EventEnvelope } from "./schema";

/**
 * How many envelopes may wait for one subscriber before it is cut loose.
 *
 * A browser on a stalled connection must not become backpressure on the engine
 * consumer, which is the loop every tenant depends on. Twenty is generous for a
 * console and small enough that a hung reader is noticed rather than absorbed.
 */
const MAX_PENDING = 20;

/** Why a subscription ended, for the stream to tell the client honestly. */
export type BusCloseReason = "closed" | "overflow";

export interface Subscription {
  /** Envelopes for this environment, oldest first. Ends when the subscription closes. */
  events: AsyncIterable<EventEnvelope>;
  /** Why it ended. Null while still open. */
  reason(): BusCloseReason | null;
  /**
   * Detach this subscriber and release what the bus holds for it.
   *
   * The bus keeps a per-subscriber buffer, so a transport that goes away
   * without saying so leaves the bus filling a queue nobody will ever read —
   * until the cap trips and it is dropped as overflow, which is indistinguishable
   * from a consumer that was merely slow. Callers close on disconnect so the
   * release is immediate and the reason is honest.
   *
   * Safe to call twice: the SSE route calls it from the abort listener, the
   * loop's finally, and the stream's cancel, and any of the three can win.
   */
  close(): void;
}

interface Waiter {
  pending: EventEnvelope[];
  resolve: (() => void) | null;
  closed: BusCloseReason | null;
}

/**
 * Subscribers per environment.
 *
 * Keyed by environment because that is the boundary every other part of this
 * system is scoped to. A subscriber is handed envelopes that `fanOut` already
 * decided its tenant may see, so this never re-derives entitlement — the one
 * place that decision lives is the join in `fanOut`, and duplicating it here is
 * how the two would drift.
 */
const waiters = new Map<string, Set<Waiter>>();

/**
 * Hand an envelope to everyone watching that environment.
 *
 * Synchronous and non-blocking on purpose: this is called from the engine
 * consumer loop, and a subscriber that cannot keep up is that subscriber's
 * problem. Overflowing one closes it rather than slowing everyone.
 */
export function publish(environmentId: string, envelope: EventEnvelope): void {
  const set = waiters.get(environmentId);
  if (set === undefined) return;

  for (const waiter of set) {
    if (waiter.closed !== null) continue;

    if (waiter.pending.length >= MAX_PENDING) {
      // Closed, not silently trimmed. A console showing stale data as though it
      // were live is worse than one showing a disconnect — it cannot tell that
      // it missed the event it was waiting for.
      waiter.closed = "overflow";
      // Dropped here rather than left for the iterator's finally. That finally
      // only runs if someone is iterating, and the subscriber most likely to
      // overflow is the one that stopped — so relying on it kept the waiter,
      // its twenty envelopes and the environment entry for the life of the
      // process. Verified before fixing: subscriberCount stayed at 1.
      waiter.pending.length = 0;
      waiter.resolve?.();
      waiter.resolve = null;
      set.delete(waiter);
      if (set.size === 0) waiters.delete(environmentId);
      continue;
    }

    waiter.pending.push(envelope);
    waiter.resolve?.();
    waiter.resolve = null;
  }
}

/**
 * Start watching one environment.
 *
 * Exists so a console can show what is happening now without polling, which
 * docs/07 rules out explicitly: polling alongside SSE is how a UI ends up
 * debugging ghosts. The view is bounded and scoped to the environment the
 * caller already proved it may see, and it carries the same envelopes the
 * webhook receives rather than a second shape that could disagree with them.
 */
export function subscribe(environmentId: string): Subscription {
  const waiter: Waiter = { pending: [], resolve: null, closed: null };
  let set = waiters.get(environmentId);
  if (set === undefined) {
    set = new Set();
    waiters.set(environmentId, set);
  }
  set.add(waiter);

  function detach(): void {
    const current = waiters.get(environmentId);
    if (current === undefined) return;
    current.delete(waiter);
    // Removed when empty, or the map grows one entry per environment ever seen
    // and never shrinks — a slow leak that only shows up under real tenancy.
    if (current.size === 0) waiters.delete(environmentId);
  }

  return {
    events: {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (waiter.pending.length > 0) yield waiter.pending.shift()!;
            if (waiter.closed !== null) return;
            await new Promise<void>((resolve) => {
              waiter.resolve = resolve;
            });
          }
        } finally {
          // Runs on break, throw and return alike, so a client that disconnects
          // mid-iteration is unsubscribed rather than left in the set.
          waiter.closed ??= "closed";
          detach();
        }
      },
    },
    reason: () => waiter.closed,
    close() {
      if (waiter.closed === null) waiter.closed = "closed";
      waiter.resolve?.();
      waiter.resolve = null;
      detach();
    },
  };
}

/** Subscriber count for an environment. Exported for tests and /metrics. */
export function subscriberCount(environmentId: string): number {
  return waiters.get(environmentId)?.size ?? 0;
}

/** Drop every subscriber. For shutdown, and for test isolation. */
export function resetBus(): void {
  for (const set of waiters.values()) {
    for (const waiter of set) {
      waiter.closed ??= "closed";
      waiter.resolve?.();
      waiter.resolve = null;
    }
  }
  waiters.clear();
}
