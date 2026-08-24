/**
 * Retry schedule.
 *
 * Separated from the worker so the policy is readable and testable on its own —
 * the schedule is the part an operator asks about during an incident, and the
 * part a consumer needs to know when deciding how long to stay broken.
 */

/**
 * Delays before each retry.
 *
 * With the default of eight attempts only the first seven delays apply, so a
 * delivery is abandoned about 36 minutes after it was queued — not the three
 * hours the full list suggests.
 */
export const BACKOFF_SECONDS = [1, 2, 5, 15, 60, 300, 1800, 7200] as const;

/**
 * When to try again after `attemptCount` failures, or null when exhausted.
 *
 * Jitter is applied because every delivery for a destination that just came
 * back fails at the same instant and would otherwise retry in lockstep,
 * arriving as a thundering herd on a service that is still recovering.
 */
export function nextAttemptAt(
  attemptCount: number,
  maxAttempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date | null {
  if (attemptCount >= maxAttempts) return null;
  const base = BACKOFF_SECONDS[Math.min(attemptCount - 1, BACKOFF_SECONDS.length - 1)] ?? 7200;
  // ±20%, so a burst of failures spreads out rather than re-converging.
  const jittered = base * (0.8 + random() * 0.4);
  return new Date(now.getTime() + Math.round(jittered * 1000));
}

/** Consecutive failures before a destination's circuit opens. */
export const CIRCUIT_FAILURE_THRESHOLD = 20;

/** How long an open circuit waits before letting one probe through. */
export const CIRCUIT_PROBE_AFTER_MS = 60_000;

/**
 * Whether a destination should be attempted now.
 *
 * An open circuit stops bunwa spending its worker on a target that is reliably
 * failing, which otherwise starves every other tenant's queue.
 */
export function circuitAllows(
  state: "closed" | "open" | "half_open",
  openedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (state === "closed" || state === "half_open") return true;
  if (openedAt === null) return true;
  return now.getTime() - openedAt.getTime() >= CIRCUIT_PROBE_AFTER_MS;
}
