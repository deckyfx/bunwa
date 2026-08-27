/**
 * The console shell.
 *
 * The test here is for retry: clearing project state before applying a new key
 * is right, but with an unchanged key `setKey` is a no-op, so nothing re-ran
 * and the console sat blank. That is the failure mode of the previous fix, not
 * of the original code.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { App } from "../App";
import { api } from "../api";

const REAL = { whoami: api.whoami, devices: api.devices, deliveries: api.deliveries };
const REAL_GLOBALS = {
  fetch: globalThis.fetch,
  EventSource: (globalThis as { EventSource?: unknown }).EventSource,
};

/** Never connects, so the stream cannot race the assertions. */
class SilentEventSource {
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => {
  cleanup();
  Object.assign(api, REAL);
  globalThis.fetch = REAL_GLOBALS.fetch;
  (globalThis as { EventSource?: unknown }).EventSource = REAL_GLOBALS.EventSource;
  try {
    localStorage.clear();
  } catch {
    /* not available in every environment */
  }
});

function connectWith(key: string) {
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "connect" }));
}

describe("switching keys", () => {
  test("a load still in flight cannot restore the previous project", async () => {
    // Asserts the property, not the line that provides it.
    //
    // A review asked for generation to be invalidated in the submit handler
    // before clearing state, describing a window between the clear and the
    // effect starting the replacement load. The increment is there and costs
    // nothing, but this test passes with it removed: load() already bumps
    // generation on entry, and React flushes the effect before fireEvent
    // returns, so the window does not open in practice. Two attempts to reach
    // it both passed either way.
    //
    // Kept as a regression net for the property — a future change that stopped
    // load() invalidating would fail here — and recorded as not covering the
    // specific line, rather than left implying it does.
    (globalThis as { EventSource?: unknown }).EventSource = SilentEventSource;
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    let release: ((v: { projectId: string; environmentId: string; scopes: string[] }) => void) | undefined;
    let calls = 0;
    (api as { whoami: typeof api.whoami }).whoami = () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      // The second key's request never settles, so anything on screen came
      // from the first.
      return new Promise(() => undefined);
    };
    (api as { devices: typeof api.devices }).devices = async () => [];
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [];

    render(<App />);
    connectWith("key-a");
    await waitFor(() => expect(calls).toBe(1));

    // Submitted directly rather than by clicking: while a load is in flight the
    // button reads "checking…", so the click helper cannot find it. That is
    // worth knowing on its own — this race is not reachable by clicking twice.
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key-b" } });
    fireEvent.submit(screen.getByLabelText("API key").closest("form")!);

    // Released immediately, without waiting for the replacement load to start.
    // That gap — state cleared, effect not yet run — is the window the guard
    // closes: without it generation has not moved, so this stale resolution
    // still satisfies current() and puts the old project back.
    release?.({ projectId: "proj-OLD", environmentId: "env-OLD", scopes: [] });
    await Bun.sleep(50);

    expect(
      screen.queryByText("proj-OLD / env-OLD"),
      "a superseded load restored the previous project",
    ).toBeNull();
  });
});

describe("retry with the same key", () => {
  test("submitting an unchanged key reloads rather than blanking the console", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = SilentEventSource;
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    let whoamiCalls = 0;
    (api as { whoami: typeof api.whoami }).whoami = async () => {
      whoamiCalls += 1;
      if (whoamiCalls === 1) throw new Error("transient");
      return { projectId: "proj-1", environmentId: "env-1", scopes: ["send:text"] };
    };
    (api as { devices: typeof api.devices }).devices = async () => [];
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [];

    render(<App />);

    // First attempt fails.
    connectWith("same-key");
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    // Same key again: this is the retry that used to do nothing.
    connectWith("same-key");
    await waitFor(() => expect(screen.getByText("proj-1 / env-1")).toBeDefined());
    expect(whoamiCalls, "resubmitting the same key did not reload").toBeGreaterThan(1);
  });
});
