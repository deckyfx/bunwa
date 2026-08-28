/**
 * Device management.
 *
 * The actions here disturb a real customer's device, so the things worth
 * proving are that they call what they say they call, that a failure is shown
 * rather than swallowed, and that re-pairing renders a scannable QR rather
 * than sending the operator back to the claim screen.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { Devices } from "../Devices";
import { api, ApiError, type VirtualDevice } from "../api";

const REAL = { logoutDevice: api.logoutDevice, repairDevice: api.repairDevice };

afterEach(() => {
  cleanup();
  Object.assign(api, REAL);
});

const device: VirtualDevice = {
  virtualDeviceId: "vd1",
  alias: "otp-sender",
  status: "active",
  scopes: ["send:text"],
  msisdn: "+628123456789",
  deviceState: "connected",
};

describe("the device table", () => {
  test("shows both the binding status and the connection state", async () => {
    // They answer different questions and disagree exactly when something is
    // wrong, which is when an operator is looking.
    render(<Devices apiKey="k" devices={[device]} onChanged={() => undefined} />);
    expect(screen.getByText("active")).toBeDefined();
    expect(screen.getByText("connected")).toBeDefined();
    await Promise.resolve();
  });

  test("says so plainly when there are none", () => {
    render(<Devices apiKey="k" devices={[]} onChanged={() => undefined} />);
    expect(screen.getByText(/None yet/)).toBeDefined();
  });
});

describe("logging out", () => {
  test("calls the endpoint and refreshes", async () => {
    let loggedOut: string | null = null;
    let refreshed = false;
    (api as { logoutDevice: typeof api.logoutDevice }).logoutDevice = async (_k, ref) => {
      loggedOut = ref;
      return null;
    };

    render(<Devices apiKey="k" devices={[device]} onChanged={() => (refreshed = true)} />);
    fireEvent.click(screen.getByRole("button", { name: "log out" }));

    await waitFor(() => expect(loggedOut).toBe("otp-sender"));
    expect(refreshed).toBe(true);
  });

  test("a failure is shown, not swallowed", async () => {
    (api as { logoutDevice: typeof api.logoutDevice }).logoutDevice = async () => {
      throw new ApiError("Device is busy", 409, "try again shortly");
    };

    render(<Devices apiKey="k" devices={[device]} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "log out" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Device is busy"));
  });
});

describe("re-pairing", () => {
  test("renders the QR inline rather than navigating away", async () => {
    // The number is already this project's, so re-claiming it would be the
    // wrong flow and would reopen a consent question already answered.
    (api as { repairDevice: typeof api.repairDevice }).repairDevice = async () => ({
      pairing: { method: "qr", qr: "REPAIR-QR", expiresAt: new Date(0).toISOString() },
    });

    render(<Devices apiKey="k" devices={[device]} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "re-pair" }));

    await waitFor(() => expect(screen.getByText(/Re-pair otp-sender/)).toBeDefined());
    expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeDefined();
  });

  test("both buttons are disabled while one is working", async () => {
    // Two engine actions racing on the same device is the sort of thing that
    // leaves it in a state neither call intended.
    let release: (() => void) | undefined;
    (api as { repairDevice: typeof api.repairDevice }).repairDevice = () =>
      new Promise((resolve) => {
        release = () => resolve({ pairing: { method: "qr", qr: "X", expiresAt: "" } });
      });

    render(<Devices apiKey="k" devices={[device]} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "re-pair" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "log out" }) as HTMLButtonElement).disabled).toBe(true),
    );
    // The button that started the work, too. Asserting only the *other* one
    // would pass against a guard that disables everything except the action in
    // progress — which is the one most likely to be double-clicked.
    //
    // Found by its busy label: it relabels to "starting…" while working, so
    // querying for "re-pair" here finds nothing and the assertion would fail
    // for a reason that has nothing to do with disabling.
    expect((screen.getByRole("button", { name: "starting…" }) as HTMLButtonElement).disabled).toBe(true);
    release?.();
  });
});
