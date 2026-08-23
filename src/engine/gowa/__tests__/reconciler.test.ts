/**
 * The state machine that turns polled status into lifecycle events.
 *
 * This is where the project's headline finding is repaid: gowa delivers no
 * lifecycle event by webhook, so every `device.logged_out` a tenant receives is
 * produced here. If this is wrong, the feature does not exist.
 */
import { describe, expect, test } from "bun:test";

import { reconcile, INITIAL_MEMORY, DEGRADED_AFTER_FAILED_POLLS, type DeviceMemory } from "../reconciler";
import type { DeviceStatus } from "../../types";

const status = (connected: boolean, loggedIn: boolean, jid: string | null = null): DeviceStatus => ({
  connected,
  loggedIn,
  jid,
  pushName: null,
});

const paired: DeviceMemory = {
  connected: true,
  loggedIn: true,
  lastKnownJid: "628123@s.whatsapp.net",
  failedPolls: 0,
  disconnectedSince: null,
  degraded: false,
};

describe("transitions", () => {
  test("emits nothing when nothing changed", () => {
    // Polling gives the same answer repeatedly; emitting per poll would flood
    // every tenant's webhook with duplicates of a state that never moved.
    const { events } = reconcile("d1", paired, status(true, true, "628123@s.whatsapp.net"));
    expect(events).toHaveLength(0);
  });

  test("first connection emits device.connected", () => {
    const { events, memory } = reconcile("d1", INITIAL_MEMORY, status(true, true, "628123@s.whatsapp.net"));
    expect(events).toEqual([
      { type: "device.connected", deviceId: "d1", jid: "628123@s.whatsapp.net", pushName: null },
    ]);
    expect(memory.lastKnownJid).toBe("628123@s.whatsapp.net");
  });

  test("a socket drop with credentials intact is a disconnect, not a logout", () => {
    // (false, true) — the state observed live when the container's network was
    // cut. It recovers on its own and must not be reported as the customer
    // unlinking.
    const { events } = reconcile("d1", paired, status(false, true, "628123@s.whatsapp.net"));
    expect(events).toEqual([
      { type: "device.disconnected", deviceId: "d1", reason: "socket lost", willRetry: true },
    ]);
  });

  test("credentials gone with a known JID is a logout", () => {
    // The event this whole project exists to deliver.
    const { events, memory } = reconcile("d1", paired, status(false, false));
    expect(events).toEqual([{ type: "device.logged_out", deviceId: "d1", reason: "remote_logout" }]);
    // Cleared so the same logout is not reported again on the next poll.
    expect(memory.lastKnownJid).toBeNull();
  });

  test("a device that never paired is not reported as logged out", () => {
    // (false,false) is ambiguous without the JID: never-paired and
    // just-unlinked look identical, and only one is an event.
    const { events } = reconcile("d1", INITIAL_MEMORY, status(false, false));
    expect(events).toHaveLength(0);
  });

  test("a logout that follows an already-reported drop is still reported", () => {
    const dropped: DeviceMemory = { ...paired, connected: false, disconnectedSince: new Date() };
    const { events } = reconcile("d1", dropped, status(false, false));
    expect(events.map((e) => e.type)).toEqual(["device.logged_out"]);
  });

  test("recovery reports how long it was down", () => {
    const downSince = new Date(Date.now() - 5_000);
    const dropped: DeviceMemory = { ...paired, connected: false, disconnectedSince: downSince };
    const { events } = reconcile("d1", dropped, status(true, true, "628123@s.whatsapp.net"));
    expect(events.map((e) => e.type)).toEqual(["device.recovered", "device.connected"]);
    const recovered = events[0] as { downtimeMs: number };
    expect(recovered.downtimeMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe("degradation", () => {
  test("a device that degrades and then answers reports recovery", async () => {
    // Previously the booleans were unchanged when it answered, so no branch
    // ran, failedPolls reset silently, and the tenant told the device was in
    // trouble was never told it was fine again.
    let memory = paired;
    for (let i = 0; i < DEGRADED_AFTER_FAILED_POLLS; i++) memory = reconcile("d1", memory, null).memory;
    expect(memory.degraded).toBe(true);

    const { events, memory: after } = reconcile("d1", memory, status(true, true, "628123@s.whatsapp.net"));
    expect(events.map((e) => e.type)).toContain("device.recovered");
    expect(after.degraded).toBe(false);
  });

  test("recovery is reported once, not on every later poll", () => {
    let memory = paired;
    for (let i = 0; i < DEGRADED_AFTER_FAILED_POLLS; i++) memory = reconcile("d1", memory, null).memory;
    const first = reconcile("d1", memory, status(true, true, "628123@s.whatsapp.net"));
    const second = reconcile("d1", first.memory, status(true, true, "628123@s.whatsapp.net"));
    expect(second.events).toHaveLength(0);
  });
});

describe("failed polls", () => {
  test("a failed poll is not an observation", () => {
    // Treating it as "disconnected" would report every device offline whenever
    // gowa restarts.
    const { events, memory } = reconcile("d1", paired, null);
    expect(events).toHaveLength(0);
    expect(memory.connected).toBe(true);
    expect(memory.failedPolls).toBe(1);
  });

  test("persistent failure eventually degrades the device, once", () => {
    let memory = paired;
    const emitted: string[] = [];
    for (let i = 0; i < DEGRADED_AFTER_FAILED_POLLS + 3; i++) {
      const result = reconcile("d1", memory, null);
      memory = result.memory;
      emitted.push(...result.events.map((e) => e.type));
    }
    expect(emitted.filter((t) => t === "device.degraded")).toHaveLength(1);
  });

  test("a successful poll clears the failure run", () => {
    const shaky: DeviceMemory = { ...paired, failedPolls: 3 };
    const { memory } = reconcile("d1", shaky, status(true, true, "628123@s.whatsapp.net"));
    expect(memory.failedPolls).toBe(0);
  });
});
