/**
 * Deriving lifecycle events from polled status.
 *
 * gowa publishes no lifecycle event over its webhook at all — proven end to
 * end in docs/12: unlinking a phone produced DEVICE_LOGGED_OUT on its internal
 * socket, nothing at the webhook sink, and gowa's own counter confirmed no
 * lifecycle forward was ever attempted. So the adapter manufactures them, and
 * polling is the source of truth rather than the fallback.
 *
 * Kept as a pure function over (previous, observed) so the state machine can be
 * tested exhaustively without a poller, a clock or a socket.
 */
import type { DeviceStatus, EngineEvent } from "../types";

/** What the reconciler remembers between polls. */
export interface DeviceMemory {
  connected: boolean;
  loggedIn: boolean;
  /**
   * The last JID this device was known by.
   *
   * Carried because (false,false) is ambiguous without it: a device that never
   * paired and a device the customer just unlinked look identical, and only one
   * of them is a `device.logged_out`.
   */
  lastKnownJid: string | null;
  /** Consecutive failed polls, for deciding when to give up. */
  failedPolls: number;
  disconnectedSince: Date | null;
}

export const INITIAL_MEMORY: DeviceMemory = {
  connected: false,
  loggedIn: false,
  lastKnownJid: null,
  failedPolls: 0,
  disconnectedSince: null,
};

/** Failed polls before a device is called degraded rather than disconnected. */
export const DEGRADED_AFTER_FAILED_POLLS = 5;

export interface Reconciliation {
  memory: DeviceMemory;
  events: EngineEvent[];
}

/**
 * Compare an observation against memory and emit what changed.
 *
 * Emits only on transition. Polling produces the same answer repeatedly, and a
 * reconciler that emitted per poll would flood every tenant's webhook with
 * duplicates of a state that never changed.
 */
export function reconcile(
  deviceId: string,
  memory: DeviceMemory,
  observed: DeviceStatus | null,
  now: Date = new Date(),
): Reconciliation {
  // A failed poll is not an observation. Treating it as "disconnected" would
  // report every device offline whenever gowa restarts.
  if (observed === null) {
    const failedPolls = memory.failedPolls + 1;
    if (failedPolls === DEGRADED_AFTER_FAILED_POLLS) {
      return {
        memory: { ...memory, failedPolls },
        events: [{ type: "device.degraded", deviceId, attempts: failedPolls, lastError: "engine unreachable" }],
      };
    }
    return { memory: { ...memory, failedPolls }, events: [] };
  }

  const events: EngineEvent[] = [];
  const next: DeviceMemory = {
    connected: observed.connected,
    loggedIn: observed.loggedIn,
    lastKnownJid: observed.jid ?? memory.lastKnownJid,
    failedPolls: 0,
    disconnectedSince: memory.disconnectedSince,
  };

  const wasUsable = memory.connected && memory.loggedIn;
  const isUsable = observed.connected && observed.loggedIn;

  if (!wasUsable && isUsable) {
    if (memory.disconnectedSince !== null) {
      events.push({
        type: "device.recovered",
        deviceId,
        downtimeMs: now.getTime() - memory.disconnectedSince.getTime(),
      });
    }
    events.push({
      type: "device.connected",
      deviceId,
      jid: observed.jid ?? memory.lastKnownJid ?? "",
      pushName: observed.pushName,
    });
    next.disconnectedSince = null;
  }

  if (wasUsable && !isUsable) {
    // The distinction that matters, and the one gowa's list `state` cannot
    // make: credentials gone is a logout the customer performed; socket gone
    // with credentials intact is a drop that will recover on its own.
    if (!observed.loggedIn && memory.lastKnownJid !== null) {
      events.push({ type: "device.logged_out", deviceId, reason: "remote_logout" });
      next.lastKnownJid = null;
    } else {
      events.push({ type: "device.disconnected", deviceId, reason: "socket lost", willRetry: true });
    }
    next.disconnectedSince = now;
  }

  // Logged out while already disconnected: the drop was reported, the logout
  // that followed still must be.
  if (!wasUsable && !isUsable && memory.loggedIn && !observed.loggedIn && memory.lastKnownJid !== null) {
    events.push({ type: "device.logged_out", deviceId, reason: "remote_logout" });
    next.lastKnownJid = null;
  }

  return { memory: next, events };
}
