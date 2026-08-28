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
const { useSetup, resetSetupRequests } = await import("../store/setup");
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
  // One test simulates a request that never answers, which would otherwise
  // hold the store's dedupe guard for every test after it.
  resetSetupRequests();
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

describe("a credential left over from a database that no longer exists", () => {
  test("is discarded when the instance reports no keys", async () => {
    // Browser storage outlives the database. A key from two purges ago was
    // still being presented: two 401s per page load, two "api key rejected"
    // warnings in the server log, and an error banner accusing a credential
    // the operator had never typed — all while the setup screen was loading.
    localStorage.setItem("bunwa.apiKey", "bw_test_grande_stale");
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");

    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });
    expect(localStorage.getItem("bunwa.apiKey")).toBeNull();
  });

  test("is not presented to the server first", async () => {
    // The point is that the request is never made, not that its failure is
    // handled: a 401 in the log is the operator's first impression of an
    // instance they have not finished setting up.
    let asked = 0;
    whoamiResolver = () => {
      asked += 1;
      return Promise.resolve({ data: null, error: { status: 401 } });
    };
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");
    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });

    expect(asked).toBe(0);
  });

  test("discarding it leaves no error to explain", async () => {
    // There is nothing for the operator to act on: the key is gone because the
    // instance it belonged to is gone.
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");
    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });

    expect(useSession.getState().error).toBeNull();
  });

  test("a stored key is still checked when the instance does have keys", async () => {
    // The guard must not become "never trust storage": that would make every
    // refresh a fresh login.
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
    whoamiResolver = () =>
      Promise.resolve({
        data: { projectId: "p", environmentId: "e", scopes: [], serverTimezone: "UTC" },
        error: null,
      });
    useSession.setState({ apiKey: "bw_live_default_good" });

    render(<App />);

    await waitFor(() => {
      expect(useSession.getState().identity).not.toBeNull();
    });
  });
});
