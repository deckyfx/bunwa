/**
 * The fake engine against the shared contract.
 *
 * Run here first so the suite is exercised before the adapter it exists to
 * judge is written — a conformance suite that has never passed anything proves
 * nothing about the next thing it runs against.
 */
import { runConformanceSuite } from "../conformance";
import { FakeEngine } from "../fake";
import type { DeviceEngine } from "../types";

runConformanceSuite("FakeEngine", {
  create: () => new FakeEngine(),
  pair: async (engine: DeviceEngine, deviceId: string) => {
    (engine as FakeEngine).completePairing(deviceId, "628123456789@s.whatsapp.net", "Test");
    return true;
  },
});
