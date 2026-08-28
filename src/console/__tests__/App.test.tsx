/**
 * The shell's routing between screens.
 *
 * This file exists because of a bug that every component test missed. Finishing
 * setup flips `configured` to true, and the shell rendered the setup screen
 * only while it was false — so the panel showing the freshly minted key was
 * unmounted the instant the key existed. The operator never saw a credential
 * that cannot be shown again, and was locked out of the instance they had just
 * created.
 *
 * SetupPage's own tests all passed, because they render SetupPage directly.
 * The defect was entirely in the wiring between it and the shell, which is the
 * one thing a component test cannot see.
 */
import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let statusResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let submitResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let whoamiResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      whoami: { get: () => whoamiResolver() },
      settings: { get: () => Promise.resolve({ data: null, error: { status: 401 } }) },
      devices: { get: () => Promise.resolve({ data: [], error: null }) },
      chats: Object.assign(() => ({ messages: { get: () => Promise.resolve({ data: [], error: null }) } }), {
        get: () => Promise.resolve({ data: [], error: null }),
      }),
      deliveries: { get: () => Promise.resolve({ data: [], error: null }) },
      events: { ticket: { post: () => Promise.resolve({ data: null, error: { status: 401 } }) } },
    },
  }),
  anonymous: () => ({
    setup: Object.assign(
      { post: () => submitResolver() },
      { status: { get: () => statusResolver() } },
    ),
  }),
}));

const { App } = await import("../App");
const { useSetup } = await import("../store/setup");
const { useSession } = await import("../store/session");

const UNCONFIGURED = {
  data: {
    configured: false,
    canMintKey: true,
    apiKeySource: "none",
    settings: {
      instanceName: { value: "bunwa", source: "default" },
      serverTimezone: { value: "Asia/Jakarta", source: "default" },
    },
  },
  error: null,
};

beforeEach(() => {
  statusResolver = () => Promise.resolve(UNCONFIGURED);
  submitResolver = () =>
    Promise.resolve({
      data: {
        settings: UNCONFIGURED.data.settings,
        apiKey: "bw_live_default_thekey",
        apiKeySource: "database",
      },
      error: null,
    });
  whoamiResolver = () => Promise.resolve({ data: null, error: { status: 401 } });

  useSetup.setState({
    configured: null,
    canMintKey: false,
    apiKeySource: "none",
    settings: null,
    busy: false,
    error: null,
    mintedKey: null,
  });
  useSession.setState({ apiKey: "", identity: null, error: null, busy: false, revision: 0 });
});

afterEach(cleanup);

describe("choosing a screen", () => {
  test("an unconfigured instance gets setup, not a key form", async () => {
    render(<App />);
    expect(await screen.findByLabelText("Setup token")).toBeDefined();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  test("a configured instance gets the key form", async () => {
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });

    render(<App />);
    expect(await screen.findByLabelText("API key")).toBeDefined();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });
});

describe("the minted key survives the state change that produced it", () => {
  test("stays on screen after setup completes", async () => {
    // The bug. Finishing setup sets configured to true, and the shell showed
    // the setup screen only while it was false — so the key panel was
    // unmounted in the same render that created it.
    render(<App />);

    const token = await screen.findByLabelText("Setup token");
    (token as HTMLInputElement).value = "tok";
    token.dispatchEvent(new Event("input", { bubbles: true }));

    // Drive the store directly rather than through the form: the property
    // under test is what the shell renders for a given state, and going
    // through the form would also be testing the form.
    await useSetup.getState().submit("tok", { instanceName: "grande" });

    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });
  });

  test("is not competing with the key form underneath it", async () => {
    // Both would be on screen at once otherwise: configured is true, so the
    // connect card qualifies, while the key panel is still showing.
    render(<App />);
    await screen.findByLabelText("Setup token");

    await useSetup.getState().submit("tok", { instanceName: "grande" });

    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  test("gives way to the key form once dismissed", async () => {
    render(<App />);
    await screen.findByLabelText("Setup token");
    await useSetup.getState().submit("tok", { instanceName: "grande" });
    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });

    useSetup.getState().dismissKey();

    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toBeDefined();
    });
    expect(screen.queryByText("bw_live_default_thekey")).toBeNull();
  });
});
