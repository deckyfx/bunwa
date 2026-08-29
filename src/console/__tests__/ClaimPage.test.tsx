/**
 * The claim screen's ending.
 *
 * The QR is the easy half. The hard half is that a scanned code looks exactly
 * like an unscanned one, so without this the operator scans, nothing changes,
 * and claiming again is the reasonable next move — which starts a second
 * pairing for a device already pairing.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";

import type { VirtualDevice } from "../store/devices";

let claimResolver: () => Promise<unknown> = () => Promise.resolve({ data: {}, error: null });
let devicesResolver: () => Promise<{ data: VirtualDevice[] | null; error: null }> = () =>
  Promise.resolve({ data: [], error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      devices: Object.assign(() => ({}), {
        get: () => devicesResolver(),
        claim: { post: () => claimResolver() },
      }),
    },
  }),
  anonymous: () => ({}),
}));

const { ClaimPage } = await import("../pages/ClaimPage");
const { useClaim } = await import("../store/claim");
const { useDevices } = await import("../store/devices");
const { useNotice } = await import("../store/notice");
const { useRoute } = await import("../store/route");
const { useSession } = await import("../store/session");

const device = (state: string): VirtualDevice =>
  ({
    virtualDeviceId: "vd1",
    alias: "otp-sender",
    status: "active",
    scopes: [],
    msisdn: "628111",
    deviceState: state,
    lastSeenAt: null,
  }) as unknown as VirtualDevice;

beforeEach(() => {
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useClaim.setState({ msisdn: "", alias: "", result: null, error: null, busy: false, pairing: null });
  useDevices.setState({ devices: null, error: null });
  useNotice.setState({ message: null, tone: "good" });
  // Where the operator actually is while a code is on screen. The default
  // section is already "devices", so starting there would let the navigation
  // assertion pass without anything having navigated.
  useRoute.setState({ route: { section: "claim", detail: null } });
  devicesResolver = () => Promise.resolve({ data: [], error: null });
});

describe("after the code is scanned", () => {
  test("says it is waiting, then announces the device and leaves for Devices", async () => {
    useClaim.setState({ pairing: { virtualDeviceId: "vd1", alias: "otp-sender" } });
    devicesResolver = () => Promise.resolve({ data: [device("pairing")], error: null });

    render(<ClaimPage />);

    // While the code is outstanding the screen says so, because a used QR and
    // an unused one look identical.
    await screen.findByText(/Waiting for the scan/);
    expect(useRoute.getState().route.section).not.toBe("devices");

    // The device connects; the event stream bumps the revision.
    devicesResolver = () => Promise.resolve({ data: [device("connected")], error: null });
    await act(async () => {
      useSession.getState().bumpRevision();
    });

    await waitFor(() => {
      expect(useNotice.getState().message, "the operator was moved with no explanation").toBe(
        "otp-sender is connected.",
      );
    });
    expect(useRoute.getState().route.section).toBe("devices");
    expect(useClaim.getState().pairing, "it kept watching a finished pairing").toBeNull();
  }, 10_000);

  test("a different device connecting does not end this claim", async () => {
    useClaim.setState({ pairing: { virtualDeviceId: "vd1", alias: "otp-sender" } });
    devicesResolver = () =>
      Promise.resolve({ data: [{ ...device("connected"), virtualDeviceId: "other" }], error: null });

    render(<ClaimPage />);
    await act(async () => {
      useSession.getState().bumpRevision();
    });
    await act(async () => {
      await Bun.sleep(50);
    });

    expect(useNotice.getState().message, "someone else's device ended this claim").toBeNull();
    expect(useClaim.getState().pairing).not.toBeNull();
  }, 10_000);
});
