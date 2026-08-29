/**
 * The project device screen, and the sentence that says what release did.
 *
 * Releasing is two different operations wearing one button: if another project
 * holds the same number this unsubscribes and the number carries on; if it was
 * the last claim the device is unlinked and its data erased. The operator
 * cannot see which will happen before pressing it — they are not allowed to
 * know who else holds it — so the notice afterwards is the only thing that
 * tells them what they just did, and the two must not be confusable.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { VirtualDevice } from "../store/devices";

let listResolver: () => Promise<{ data: VirtualDevice[] | null; error: { status: number } | null }> = () =>
  Promise.resolve({ data: [], error: null });
let releaseResolver: () => Promise<{ data: unknown; error: { status: number } | null }> = () =>
  Promise.resolve({ data: { outcome: "released", stillHeldBy: 1 }, error: null });
/** Aliases the console asked to release. */
let released: string[] = [];

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      devices: Object.assign(
        (params: { ref: string }) => ({
          delete: () => {
            released.push(params.ref);
            return releaseResolver();
          },
        }),
        { get: () => listResolver() },
      ),
    },
  }),
  anonymous: () => ({}),
}));

const { DevicesPage } = await import("../pages/DevicesPage");
const { useDevices } = await import("../store/devices");
const { useNotice } = await import("../store/notice");
const { useSession } = await import("../store/session");

const device = (over: Partial<VirtualDevice> = {}): VirtualDevice =>
  ({
    virtualDeviceId: "vd-1",
    alias: "otp",
    status: "active",
    scopes: [],
    msisdn: "+628123456789",
    deviceState: "connected",
    lastSeenAt: null,
    ...over,
  }) as unknown as VirtualDevice;

beforeEach(() => {
  released = [];
  useSession.setState({ apiKey: "tenant-key", identity: null, error: null, busy: false, revision: 0 });
  useDevices.setState({ devices: null, error: null, busy: false });
  useNotice.setState({ message: null, tone: "good" });
  listResolver = () => Promise.resolve({ data: [device()], error: null });
});

afterEach(cleanup);

describe("releasing a number someone else also holds", () => {
  test("says the number carries on, and how many still have it", async () => {
    releaseResolver = () => Promise.resolve({ data: { outcome: "released", stillHeldBy: 2 }, error: null });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "release" }));

    await waitFor(() => expect(released).toEqual(["otp"]));
    await waitFor(() => {
      const message = useNotice.getState().message ?? "";
      expect(message, "the notice did not say the number survived").toMatch(/still in use by 2 other project/);
      // The word that would be wrong here. Telling an operator the number was
      // unlinked when two tenants are still sending on it is the failure this
      // whole two-outcome design exists to avoid.
      expect(message, "an unsubscribe was described as an erasure").not.toMatch(/erased|unlinked/);
    });
  });
});

describe("releasing the last claim on a number", () => {
  test("says the device is gone and its data erased", async () => {
    releaseResolver = () => Promise.resolve({ data: { outcome: "retired", stillHeldBy: 0 }, error: null });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "release" }));

    await waitFor(() => {
      const message = useNotice.getState().message ?? "";
      expect(message, "the irreversible outcome was not reported as one").toMatch(/unlinked and its data erased/);
      expect(message, "an erasure was described as still in use").not.toMatch(/still in use/);
    });
  });
});

describe("when it does not work", () => {
  test("a refused release is not announced as one", async () => {
    // The notice is the whole feedback channel. "Released" after a 500 tells
    // the operator a number is free when it is still bound.
    releaseResolver = () => Promise.resolve({ data: null, error: { status: 500 } });

    render(<DevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "release" }));

    await waitFor(() => expect(useDevices.getState().error).not.toBeNull());
    expect(useNotice.getState().message, "a failed release was announced as done").toBeNull();
  });

  test("an already-revoked binding cannot be released again", async () => {
    listResolver = () => Promise.resolve({ data: [device({ status: "revoked" })], error: null });

    render(<DevicesPage />);
    const button = await screen.findByRole("button", { name: "release" });
    expect((button as HTMLButtonElement).disabled, "a revoked binding offered release again").toBe(true);
  });
});
