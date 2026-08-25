/**
 * The claim screen.
 *
 * Focused on the async edge the reviewer found rather than the form: a claim
 * that resolves after the console has moved to another key must not report
 * itself, because the callback it fires reloads with the key its closure
 * captured — showing one project's data under another project's credential.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { ClaimScreen } from "../ClaimScreen";
import { api, type ClaimResult } from "../api";

const REAL = { claim: api.claim };

afterEach(() => {
  cleanup();
  (api as { claim: typeof api.claim }).claim = REAL.claim;
});

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+628123456789" } });
  fireEvent.change(screen.getByLabelText("Alias"), { target: { value: "otp-sender" } });
  fireEvent.click(screen.getByRole("button", { name: "claim" }));
}

const pendingResult: ClaimResult = {
  outcome: "pending_pairing",
  virtualDevice: { id: "vd1", alias: "otp-sender" },
  pairing: { method: "qr", qr: "BUNWA-QR", expiresAt: new Date(0).toISOString() },
};

describe("a claim that outlives its key does not report itself", () => {
  test("onClaimed is not called when the key changed mid-flight", async () => {
    let release: ((r: ClaimResult) => void) | undefined;
    (api as { claim: typeof api.claim }).claim = () =>
      new Promise<ClaimResult>((resolve) => {
        release = resolve;
      });

    let claimedCalls = 0;
    const view = render(<ClaimScreen apiKey="key-a" onClaimed={() => (claimedCalls += 1)} />);
    fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("button", { name: "claiming…" })).toBeDefined());

    // The console connects with a different key while the claim is in flight.
    view.rerender(<ClaimScreen apiKey="key-b" onClaimed={() => (claimedCalls += 1)} />);

    release?.(pendingResult);
    await Bun.sleep(50);

    expect(claimedCalls, "a stale claim reported itself under a new key").toBe(0);
    expect(screen.queryByText("New number")).toBeNull();
  });

  test("a claim under an unchanged key reports normally", async () => {
    // The guard must not break the ordinary path.
    (api as { claim: typeof api.claim }).claim = async () => pendingResult;

    let claimedCalls = 0;
    render(<ClaimScreen apiKey="key-a" onClaimed={() => (claimedCalls += 1)} />);
    fillAndSubmit();

    await waitFor(() => expect(screen.getByText("New number")).toBeDefined());
    expect(claimedCalls).toBe(1);
    // And the QR is drawn rather than dumped as text.
    expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeDefined();
  });
});
