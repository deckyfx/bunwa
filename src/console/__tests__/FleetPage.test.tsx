/**
 * The operator's device screen, and the confirmation in front of it.
 *
 * This screen carries the one irreversible button in the console: retiring a
 * device destroys credentials and message history, and the number has to be
 * paired again from the phone. The project screen's release can be undone by
 * claiming again; this cannot.
 *
 * Untested until now, and the API paths underneath it were verified while the
 * React never was — so nothing checked that the confirmation is actually in
 * front of the destructive call, or that the warning tells the operator how
 * many tenants they are about to cut off.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { FleetDevice } from "../store/fleet";

let listResolver: () => Promise<{ data: FleetDevice[] | null; error: { status: number } | null }> = () =>
  Promise.resolve({ data: [], error: null });
/** Device ids the console asked to retire. Empty is the assertion for a declined confirm. */
let retired: string[] = [];
let retireResolver: () => Promise<{ error: { status: number } | null }> = () =>
  Promise.resolve({ error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    admin: {
      v1: {
        devices: Object.assign(
          (params: { deviceId: string }) => ({
            delete: () => {
              retired.push(params.deviceId);
              return retireResolver();
            },
          }),
          { get: () => listResolver() },
        ),
      },
    },
  }),
  anonymous: () => ({}),
}));

const { FleetPage } = await import("../pages/FleetPage");
const { useFleet } = await import("../store/fleet");
const { useNotice } = await import("../store/notice");
const { useSession } = await import("../store/session");

const row = (over: Partial<FleetDevice> = {}): FleetDevice =>
  ({
    deviceId: "dev-1",
    msisdn: "+628123456789",
    state: "connected",
    stateReason: null,
    lastSeenAt: null,
    enginePoolId: "fake-1",
    heldBy: [],
    ...over,
  }) as unknown as FleetDevice;

const holder = (projectName: string, alias: string) => ({
  projectId: `p-${projectName}`,
  projectName,
  environmentSlug: "production",
  alias,
  status: "active",
});

/** What the operator was asked, and what they answered. */
let asked: string[] = [];
const answerConfirm = (answer: boolean) => {
  globalThis.confirm = (message?: string) => {
    asked.push(message ?? "");
    return answer;
  };
};

beforeEach(() => {
  asked = [];
  retired = [];
  answerConfirm(true);
  retireResolver = () => Promise.resolve({ error: null });
  useSession.setState({ apiKey: "admin-key", identity: null, error: null, busy: false, revision: 0 });
  useFleet.setState({ devices: null, error: null, busy: false });
  useNotice.setState({ message: null, tone: "good" });
});

afterEach(cleanup);

describe("what the operator can see", () => {
  test("names every project holding a number", async () => {
    // The one thing a tenant key cannot answer, and the reason this screen
    // exists: retiring a shared number is only an informed act if you can see
    // who it is shared with.
    listResolver = () =>
      Promise.resolve({
        data: [row({ heldBy: [holder("Beta", "otp"), holder("Gamma", "alerts")] })],
        error: null,
      });

    render(<FleetPage />);

    // Read per list item rather than per string: a holder is a project, an
    // environment and the alias that project knows the number by, and it is
    // the three together that identify it. Asserting the words separately
    // would pass with them shuffled across different rows.
    const holders = await screen.findAllByRole("listitem");
    expect(holders.map((li) => li.textContent)).toEqual(["Beta/productionotp", "Gamma/productionalerts"]);
  });

  test("says so when nobody holds it", async () => {
    // An empty cell reads as missing data, and a paired device no project
    // holds is the one most worth retiring.
    listResolver = () => Promise.resolve({ data: [row({ heldBy: [] })], error: null });

    render(<FleetPage />);
    await screen.findByText("nobody");
  });
});

describe("retiring", () => {
  test("does nothing at all if the confirmation is declined", async () => {
    listResolver = () => Promise.resolve({ data: [row()], error: null });
    answerConfirm(false);

    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("button", { name: "retire" }));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(retired, "a declined confirmation still destroyed the device").toHaveLength(0);
    expect(useNotice.getState().message, "a declined retirement announced itself").toBeNull();
  });

  test("warns how many tenants lose the number", async () => {
    // The count is the part that makes this a decision rather than a click.
    listResolver = () =>
      Promise.resolve({ data: [row({ heldBy: [holder("Beta", "otp"), holder("Gamma", "alerts")] })], error: null });

    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("button", { name: "retire" }));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0], "the warning did not say anyone was still using it").toMatch(/still used by 2 project/);
  });

  test("retires and says so once confirmed", async () => {
    listResolver = () => Promise.resolve({ data: [row()], error: null });

    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("button", { name: "retire" }));

    await waitFor(() => expect(retired).toEqual(["dev-1"]));
    await waitFor(() => {
      expect(useNotice.getState().message).toMatch(/\+628123456789 retired/);
    });
  });

  test("a refused retirement is not announced as one", async () => {
    // The notice is the only thing the operator reads. Saying "retired" after
    // a 500 would tell them credentials were destroyed when they were not.
    listResolver = () => Promise.resolve({ data: [row()], error: null });
    retireResolver = () => Promise.resolve({ error: { status: 500 } });

    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("button", { name: "retire" }));

    await waitFor(() => expect(useFleet.getState().error).not.toBeNull());
    expect(useNotice.getState().message, "a failed retirement was announced as done").toBeNull();
  });
});
